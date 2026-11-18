// The approval window's plain-language summary (D808–D812): one headline ("{App} wants to send 0.1 NEAR to
// bob.testnet"), a few plain lines, the network fee, and the warnings for requests that let someone spend the user's
// tokens, built only from the request the popup decoded itself (decode/request.ts). Never from text the partner page
// supplies: the app's name is a placeholder part (`{ kind: 'app' }`) the page fills with the vault's app name, and every
// other value comes from the signed bytes. Values a partner chose (addresses, account ids, method names, token ids) are
// `code` parts, shown as text in mono; a string that isn't display-safe is never put in a summary.
//
// `explainable` is false when Journear can't say in plain words what the request does (an unknown contract function,
// raw bytes, typed data it can't summarise, a Soroban call that isn't a token transfer or approval, more steps than it
// lists): the summary then states the risk in plain words, red where the unreadable part could move value or control
// with no visible bound, amber otherwise (D810). The popup's technical details always start folded (the founder's
// decision, D810); the user can always open them. Nothing here replaces a fact, it only says it plainly first.
//
// Token amounts: only a token on Journear's reviewed list (known-tokens.ts, D860: Circle's USDC and EURC where Circle
// lists them, wrapped NEAR, the Stellar asset contracts) gets a symbol and decimals, with a line saying it is the real
// one. Any other token's amount is "N units of an unlisted token" with a line saying Journear can't tell what that is
// worth: a contract's own symbol() or decimals() is the contract's claim, never read.
import { isDisplaySafeLine } from '../display-safe.ts';
import { toHex } from '../bytes.ts';
import { KNOWN_TOKENS, type KnownTokenList, type TokenNetwork, knownSymbolOn, knownToken } from '../known-tokens.ts';
import { STELLAR_MAINNET_PASSPHRASE, evmChainInfo } from '../networks.ts';
import type { NearAction } from '../near/codec.ts';
import { isNearAccountId } from '../addresses.ts';
import { type ContractChain, DEMO_CHECK_IN_NAME, STELLAR_TESTNET_PASSPHRASE, verifiedContract } from '../verified-contracts.ts';
import { isDemoCheckInCall } from '../demo-check-in.ts';
import type { AbiValue } from './abi.ts';
import type { DecodedApproval } from './request.ts';
import type { DecodedEvmCall, DecodedEvmCallSite, DecodedEvmTx } from './evm.ts';
import { JsonNumber, type StrictJsonObject, parseStrictJson } from './json.ts';
import { nearCodeHash, nearHash58, nearKeyText, nearMethodName } from './near.ts';
import { MuxedAccount } from '@stellar/stellar-base';
import type { StellarContractCall, StellarInvocation, StellarOperation, StellarScVal } from './stellar.ts';
import type { TypedDataStruct, TypedDataValue } from '../typed-data.ts';

/**
 * One piece of a summary's text: plain words, the requesting app's name (filled in by the page from the vault's app
 * name), a value shown as code (an address, an account id, a contract), or a value in bold (a verified contract's name).
 */
export type SummaryPart = string | { readonly kind: 'app' } | { readonly kind: 'code'; readonly text: string; readonly role?: IdRole } | { readonly kind: 'strong'; readonly text: string };

/**
 * What an address, key or id in a sentence is: the page shows a long one by its short form in the sentence and
 * in full once, in its own labelled row ("To", "Who gets the permission", "Key", …). A code part without a role (a
 * method name, a token id, a sign-in domain, a network passphrase) is shown whole in the sentence, as before.
 */
export type IdRole = 'to' | 'from' | 'token' | 'collection' | 'spender' | 'permission' | 'owner' | 'key' | 'program' | 'account' | 'pool' | 'payer';
export type SummaryText = readonly SummaryPart[];

/** Why a warning is shown (stable, for tests and the page's classes). */
export type SummaryWarningCode =
  /** Journear can't explain the request in plain words. */
  | 'cannot_explain'
  /** A permission for someone else to spend a bounded amount of the user's tokens. */
  | 'spend_permission'
  /** A permission with no limit, or one so large it has no practical limit. */
  | 'unlimited_spend'
  /** A permission to move every item of an NFT collection (setApprovalForAll(true)). */
  | 'collection_operator'
  /** Typed data that calls itself Permit2 but isn't Permit2's contract. */
  | 'permit_lookalike'
  /** A new contract from code Journear can't read. */
  | 'contract_creation'
  /** A sign-in message for another site than the requesting page. */
  | 'sign_in_mismatch'
  /** Building the summary failed: the request is shown as unreadable. */
  | 'summary_failed'
  /** More steps than the summary lists, none of the left-out ones moving value. */
  | 'steps_not_listed'
  /** A control change, an approval or value to someone else that isn't in a line: named in its own red bullet. */
  | 'step_left_out'
  /** A NEAR call Journear doesn't recognise whose method name says it may move tokens (`transfer`, `withdraw`, …). */
  | 'may_move_tokens'
  /** Raw signing: Journear can't read what is signed at all. */
  | 'raw_signing'
  /** A sponsored EVM action that also sets the account up (its EIP-7702 authorization): the one-time setup note. */
  | 'account_setup'
  /** A relayed NEAR action that calls another account's contract: it acts as the user there. */
  | 'acts_as_you'
  /** A Stellar asset whose code is a listed token's (USDC) but whose issuer isn't the listed one: it may be a copy. */
  | 'token_lookalike';

export interface SummaryWarning {
  /** `danger`: red, the popup's strongest style; `warning`: amber. Both always visible, never folded. */
  readonly level: 'danger' | 'warning';
  readonly code: SummaryWarningCode;
  readonly text: SummaryText;
  /** One short line for this warning when it isn't the box's lead: its bullet. The full text otherwise. */
  readonly short?: SummaryText;
}

export interface ApprovalSummary {
  /** "{App} wants to …": the first thing the popup shows. */
  readonly headline: SummaryText;
  /** More plain lines (an amount in smallest units, what else a call sends, what a list of actions does). */
  readonly lines: readonly SummaryText[];
  /** The most the network fee can be, as a value ("up to 0.000042 ETH"), or null when the request costs no fee itself. */
  readonly fee: SummaryText | null;
  /** The network the request is bound to, as a value ("Sepolia (test network)"), when the request names one. NEAR's line is the page's. */
  readonly network: SummaryText | null;
  /**
   * A relayed NEAR action that takes none of the user's NEAR and that Journear sees
   * moving none of their tokens: the page then drops the "NEAR leaving your account: None of your NEAR…" row, which
   * only repeated the fee row. It says nothing about what a call does with what the user keeps at the contract (the
   * amber acts-as-you line does); the window never says such a request costs nothing.
   */
  readonly noNearLeaves?: true;
  readonly warnings: readonly SummaryWarning[];
  /** False when Journear can't say what the request does: a risk warning says so (the details still start folded). */
  readonly explainable: boolean;
  /**
   * The steps (operations or actions, by index) whose own line is in view: the headline of a single-step request, or
   * a visible grouped line. A bullet repeating such a step's control change is dropped by the page.
   */
  readonly shownSteps?: readonly number[];
}

export interface SummaryContext {
  /** The user's own address on the request's chain (the vault's: EIP-55, G… StrKey or the NEAR implicit account id). */
  readonly address: string;
  /** The partner page's origin, as the vault pinned it (a sign-in message's domain is compared with its host). */
  readonly parentOrigin?: string;
}

const APP = { kind: 'app' } as const;
const code = (text: string, role?: IdRole): SummaryPart => (role ? { kind: 'code', text, role } : { kind: 'code', text });
const strong = (text: string): SummaryPart => ({ kind: 'strong', text });

/**
 * A key, address or account id cut for a bullet, recognisably: a prefixed key keeps its prefix and the first and
 * last 4 characters ("ed25519:cGfH…izuN"); anything else longer than 16 characters its first 6 and last 4. The full
 * value is in the box's lead or in the details.
 */
export function shortId(text: string): string {
  const colon = text.indexOf(':');
  if (colon > 0 && colon < 12 && text.length - colon - 1 > 10) return `${text.slice(0, colon + 1)}${text.slice(colon + 1, colon + 5)}…${text.slice(-4)}`;
  return text.length > 16 ? `${text.slice(0, 6)}…${text.slice(-4)}` : text;
}

/** A readable NEAR account name (`stamps.testnet`): shown whole in a sentence, never cut. */
const NEAR_NAMED = /^(?=.{2,64}$)(?!0x)[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)+$/u;

/**
 * Whether a value in a sentence is shown by its short form, with the whole value in its own row: a long address,
 * key or id (what shortId cuts), never a readable NEAR name, which is shown whole as it is.
 */
export const isLongId = (text: string): boolean => shortId(text) !== text && !NEAR_NAMED.test(text);

/** Who a spender is, in a bullet: its whole address, after its name when verified, else marked "(not checked)". */
const spenderShort = (t: SummaryText): SummaryText => {
  const named = t.find((p) => typeof p !== 'string' && p.kind === 'strong');
  const c = t.find((p) => typeof p !== 'string' && p.kind === 'code');
  if (named && c) return [named, ' (', c, ')'];
  return c ? [c, ' (not checked)'] : t;
};

/** How strong a risk line is: red where the unreadable part could move value or control with no visible bound. */
export type RiskLevel = 'danger' | 'warning';

/**
 * The one shape of every "Journear can't check" line: what Journear can't do, an
 * optional short plain reason in brackets, the risk, and one ending. Red: "If you’re not sure, reject it."; amber:
 * "Approve only if you expected this from {App}." `reason` is Journear's own words, or parts with code values.
 */
export const RISK_END: Readonly<Record<RiskLevel, SummaryText>> = Object.freeze({ danger: ['If you’re not sure, reject it.'], warning: ['Approve only if you expected this from ', APP, '.'] });
const because = (reason?: string | SummaryText): SummaryText => (reason === undefined ? [] : [' (', ...(typeof reason === 'string' ? [reason] : reason), ')']);
const cannotCheck = (level: RiskLevel, code: SummaryWarningCode, reason: string | SummaryText | undefined, risk: string | null, short: SummaryText, what = 'Journear can’t check what this does'): SummaryWarning => ({
  level,
  code,
  text: [what, ...because(reason), '.', ...(risk ? [` ${risk}`] : []), ' ', ...RISK_END[level]],
  short,
});

/** The risk line of a request Journear can't explain, written for someone who doesn't know Web3. */
export const cannotTell = (level: RiskLevel, reason?: string): SummaryWarning =>
  cannotCheck(level, 'cannot_explain', reason, 'It could take your money or tokens.', ['Journear can’t check what it does', ...because(reason)]);

/** A message Journear can't read (not plain text): it can't say what signing it does. */
const unreadableMessage = (): SummaryWarning => cannotCheck('warning', 'cannot_explain', 'the message isn’t readable text', null, ['Journear can’t read the message']);

/**
 * Steps the summary's lines leave out: red when any of them moves or grants value or changes control, amber
 * otherwise. `n` is how many steps the request has; `hidden` how many aren't in a line.
 */
const stepsNotListed = (n: number, hidden: number, level: RiskLevel): SummaryWarning =>
  cannotCheck(
    level,
    'steps_not_listed',
    `it does ${n} things at once and not all are listed here`,
    level === 'danger' ? 'Some of the steps left out move money or tokens, or change who controls your account.' : null,
    [`${hidden} other ${hidden === 1 ? 'step isn’t' : 'steps aren’t'} listed here${level === 'danger' ? ' (some move money or tokens)' : ''}`],
    'Journear can’t check everything this does',
  );

/** The worse of two levels. */
const worse = (a: RiskLevel | null, b: RiskLevel): RiskLevel => (a === 'danger' || b === 'danger' ? 'danger' : 'warning');

/**
 * Allowances at or above this, of a token Journear doesn't know, have no practical limit: 10^27 of its smallest units is
 * a billion whole tokens even at 18 decimals, and below 2^96 (the max of a 96-bit balance, which some tokens use as
 * "unlimited"). For a pinned token the line is a trillion whole tokens (PINNED_UNLIMITED_WHOLE), more than its supply.
 */
export const PRACTICALLY_UNLIMITED = 10n ** 27n;
/** A pinned token's allowance above this many whole tokens has no practical limit. */
export const PINNED_UNLIMITED_WHOLE = 10n ** 12n;
/** Extra lines (what an authorization also allows) listed before "…and N more". */
export const MAX_SUMMARY_STEPS = 5;
/** At most this many lines say what a request with several steps does, grouped. */
export const MAX_GROUP_LINES = 4;

/** Permit2's canonical contract (the same address on every chain). */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const ZERO_ADDRESS = /^0x0{40}$/iu;
const UINT256_MAX = 2n ** 256n - 1n;
const UINT160_MAX = 2n ** 160n - 1n;
const I128_MAX = 2n ** 127n - 1n;

/** A decimal string with its whole part grouped by thousands: "1234567.5" → "1,234,567.5". */
export const groupDigits = (n: string): string => n.replace(/^(-?)(\d+)/u, (_, sign: string, whole: string) => sign + whole.replace(/\B(?=(\d{3})+$)/gu, ','));

/** Whether an amount leaves the user (shown rounded up) or reaches them (shown rounded down). */
export type AmountDirection = 'out' | 'in';
/** Amounts are shown with at most this many decimals; the exact figure is in the details. */
export const SHOWN_DECIMALS = 6;

/**
 * An amount as the summary shows it: exact when it has at most SHOWN_DECIMALS decimals; "less than 0.000001"
 * below that (never 0 for a non-zero amount); otherwise "about N", rounded up when it leaves the user and down when it
 * reaches them, so the shown figure never understates what goes or overstates what comes. Grouped by thousands.
 */
export function displayUnits(value: bigint, decimals: number, dir: AmountDirection = 'out'): string {
  if (value <= 0n || decimals <= SHOWN_DECIMALS) return groupDigits(formatTokenUnits(value, decimals));
  const step = 10n ** BigInt(decimals - SHOWN_DECIMALS);
  if (value < step) return dir === 'out' ? `less than ${formatTokenUnits(1n, SHOWN_DECIMALS)}` : `a tiny amount (less than ${formatTokenUnits(1n, SHOWN_DECIMALS)})`;
  const rem = value % step;
  if (rem === 0n) return groupDigits(formatTokenUnits(value, decimals));
  return `about ${groupDigits(formatTokenUnits(dir === 'out' ? value - rem + step : value - rem, decimals))}`;
}

/**
 * "up to {amount}" for a bound, read plainly: an amount below the shown precision is "less than 0.000001 …" (never "up to
 * less than"), and one rounded up ("about N", out) is "up to N" (the rounded-up figure is still an upper bound). `shown`
 * is displayUnits' text, with its unit after it.
 */
export function upTo(shown: string): SummaryText {
  if (shown.startsWith('less than ')) return [strong(shown)];
  return ['up to ', strong(shown.startsWith('about ') ? shown.slice('about '.length) : shown)];
}

/** A text as a sentence: one full stop at its end, never two (a line that already ends with one keeps it). */
const sentence = (t: SummaryText): SummaryText => {
  const last = t[t.length - 1];
  return typeof last === 'string' && /[.!?]$/u.test(last) ? t : [...t, '.'];
};

/** A NEAR amount as the summary shows it. */
export const nearDisplay = (yocto: bigint, dir: AmountDirection = 'out'): string => `${displayUnits(yocto, 24, dir)} NEAR`;

/** `value` with `decimals` decimal places, trailing zeros trimmed: formatTokenUnits(1500000n, 6) = "1.5". */
export function formatTokenUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = decimals === 0 ? '' : (abs % base).toString().padStart(decimals, '0').replace(/0+$/u, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

// ---- tokens and spenders ----

interface KnownToken {
  readonly symbol: string;
  readonly decimals: number;
}

/** A token (never a collectible) on Journear's reviewed list (known-tokens.ts) for exactly this id there, or null. */
const listedToken = (net: TokenNetwork, id: string, list: KnownTokenList = KNOWN_TOKENS): KnownToken | null => {
  const t = knownToken(net, id, list);
  return t && t.kind === 'token' ? t : null;
};

/** A token on the reviewed list for this EVM chain, by address (any case), or null: never a collectible. `list` is for tests. */
export const knownEvmToken = (chainId: number, address: string, list: KnownTokenList = KNOWN_TOKENS): KnownToken | null => listedToken({ kind: 'evm', chainId }, address, list);

/** A Stellar asset (`CODE:ISSUER`) or asset contract (C…) on the reviewed list for this network, exactly, or null. */
export const knownStellarToken = (networkPassphrase: string, id: string): KnownToken | null => listedToken({ kind: 'stellar', networkPassphrase }, id);

/** A NEAR token contract on the reviewed list for this network, exactly, or null. */
export const knownNearToken = (network: 'testnet' | 'mainnet', account: string): KnownToken | null => listedToken({ kind: 'near', network }, account);

/**
 * The line beside an amount of a listed token, with the token's id (whole in its row): the symbol is
 * Journear's, from its reviewed list, never the token's own claim.
 */
export const realTokenLine = (id: string, token: KnownToken): SummaryText => [`This is the real ${token.symbol} (`, code(id, 'token'), '), checked by Journear.'];

/**
 * A Stellar asset whose code is a listed token's on this network but whose issuer isn't the listed one. The code
 * is the asset's own (in the signed request, as every wallet shows it), not something read from a contract.
 */
const lookalikeToken = (symbol: string, asset: string): SummaryWarning => ({
  level: 'warning',
  code: 'token_lookalike',
  text: [`This is not the ${symbol} Journear knows (`, code(asset, 'token'), '). It may be a copy.'],
  short: [`Not the ${symbol} Journear knows: it may be a copy`],
});

/** The token lines and warnings of the Stellar request being summarised (set by stellarTx and stellarAuth). */
interface TokenNotes {
  readonly passphrase: string;
  readonly lines: SummaryText[];
  readonly warnings: SummaryWarning[];
}
let tokenNotes: TokenNotes | null = null;
const noteOnce = (into: SummaryText[], line: SummaryText): void => {
  const k = JSON.stringify(line);
  if (!into.some((x) => JSON.stringify(x) === k)) into.push(line);
};
/** Runs `f` with `notes` as the request's token notes (summaries are built synchronously, so one at a time). */
function withTokenNotes<T>(notes: TokenNotes, f: () => T): T {
  const before = tokenNotes;
  tokenNotes = notes;
  try {
    return f();
  } finally {
    tokenNotes = before;
  }
}

/** "5 USDC", or "1,000 units of an unlisted token" when the token isn't on the pinned list. */
function amountOf(amount: bigint, token: KnownToken | null, dir: AmountDirection = 'out'): SummaryText {
  return token ? [strong(`${displayUnits(amount, token.decimals, dir)} ${token.symbol}`)] : [strong(groupDigits(amount.toString())), ` ${units(amount)} of an unlisted token`];
}

/** "unit" or "units". */
const units = (n: bigint): string => (n === 1n ? 'unit' : 'units');

/**
 * The line under an amount of a token Journear doesn't know: it can't say what the units are worth, and what
 * to do. The token's address stays in view here.
 */
const unlistedLine = (amount: bigint | null, contract: string, nft = false): SummaryText => [
  'Journear doesn’t know this token (',
  code(contract, 'token'),
  amount === null ? '), so it can’t tell what these units are worth.' : `), so it can’t tell what ${groupDigits(amount.toString())} ${units(amount)} ${amount === 1n ? 'is' : 'are'} worth.`,
  ...(nft && amount !== null ? [` If it’s a collectible, this moves item no. ${amount} instead.`] : []),
  ' Check the amount in ',
  APP,
  ' first.',
];

/** Whether an allowance has no practical limit (see PRACTICALLY_UNLIMITED). */
const unlimited = (amount: bigint, token: KnownToken | null): boolean => amount >= PRACTICALLY_UNLIMITED || (token !== null && amount > PINNED_UNLIMITED_WHOLE * 10n ** BigInt(token.decimals));

/** "USDC", or "tokens from 0x… (an unlisted token)". */
function tokenName(contract: string, token: KnownToken | null): SummaryText {
  return token ? [token.symbol] : ['tokens from ', code(contract, 'token'), ' (an unlisted token)'];
}

/** For a listed token named by its symbol: which contract that is, so the contract is always in view. */
const tokenContractLine = (contract: string, token: KnownToken): SummaryText => realTokenLine(contract, token);

/** Who would be allowed to take: a verified contract by name, else its address, said to be unchecked. */
function spenderOf(chain: ContractChain | null, address: string): SummaryText {
  const v = chain ? verifiedContract(chain, address) : null;
  if (v) return [strong(v.name), ' (', code(address, 'spender'), ', checked by Journear)'];
  if (ZERO_ADDRESS.test(address)) return [code(address, 'spender'), ' (an address no one controls)'];
  return [code(address, 'spender'), ' (not checked by Journear)'];
}

/**
 * The warning for a permission to spend the user's tokens (ERC-20 approve and increaseAllowance, EIP-2612 and Permit2
 * signatures, a Soroban token's approve). The caller handles 0 (a revoke: no warning). At or above
 * PRACTICALLY_UNLIMITED (or the type's max): the red "no limit" warning; below it, the amber one with the amount.
 * `nftToo`: ERC-20's and ERC-721's approve share one selector, so for a token Journear doesn't know the amount may be
 * an NFT's item number.
 */
function spendWarning(spender: SummaryText, contract: string, token: KnownToken | null, amount: bigint, typeMax: bigint, opts: { more?: boolean; nftToo?: boolean; via?: string; once?: boolean; owner?: string } = {}): SummaryWarning {
  const via = opts.via ? ` ${opts.via}` : '';
  // `owner`: the tokens are someone else's (a Soroban approve `from` another account): never "your".
  const yours: SummaryText = opts.owner ? ['the ', ...tokenName(contract, token), ' held by ', code(opts.owner, 'owner')] : token ? [`your ${token.symbol}`] : ['your ', ...tokenName(contract, token)];
  if (unlimited(amount, token)) {
    const how = amount >= typeMax ? 'with no limit' : 'with no real limit';
    return {
      level: 'danger',
      code: 'unlimited_spend',
      text: ['This lets ', ...spender, ' take all ', ...yours, via, opts.once ? `, ${how}.` : `, now or later, ${how}.`, ' Approve only if you trust them completely.'],
      short: ['Lets ', ...spenderShort(spender), ' take all ', ...yours, via],
    };
  }
  const much: SummaryText = token && !opts.owner ? [strong(`${displayUnits(amount, token.decimals)} ${token.symbol}`), ' from your account'] : [strong(token ? displayUnits(amount, token.decimals) : groupDigits(amount.toString())), token ? ' of ' : ` ${units(amount)} of `, ...yours];
  const nft = opts.nftToo && !token ? [` If it’s a collectible, it lets them take your item no. ${amount} instead.`] : [];
  const bound: SummaryText = opts.more ? [' take a further ', ...much] : much[0] && typeof much[0] !== 'string' && much[0].kind === 'strong' ? [' take ', ...upTo(much[0].text), ...much.slice(1)] : [' take up to ', ...much];
  const lasts = opts.once ? [] : [' The permission lasts until they’ve used it all or you cancel it elsewhere.'];
  return { level: 'warning', code: 'spend_permission', text: ['This lets ', ...spender, ...bound, via, '.', ...lasts, ...nft], short: ['Lets ', ...spenderShort(spender), ` take ${opts.more ? 'a further ' : 'up to '}`, ...much, via] };
}

// ---- EVM ----

const abiAddr = (v: AbiValue | undefined): string | null => (v?.kind === 'address' ? v.value : null);
const abiUint = (v: AbiValue | undefined): bigint | null => (v?.kind === 'uint' ? v.value : null);
const abiBool = (v: AbiValue | undefined): boolean | null => (v?.kind === 'bool' ? v.value : null);
const sameEvm = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function evmNative(chainId: number, wei: bigint): string {
  const info = evmChainInfo(chainId);
  return info ? `${displayUnits(wei, 18)} ${info.nativeSymbol}` : `${displayUnits(wei, 18)} of this network’s coin`;
}

/** The network by its plain name ("Base Sepolia (test network)"); its number is in the details only. */
function evmNetwork(chainId: number): SummaryText {
  const info = evmChainInfo(chainId);
  return info ? [info.label] : ['a network Journear doesn’t know'];
}

/** "your account" when `address` is the user's, else the address as code. */
const evmWho = (address: string, me: string, role: IdRole = 'to'): SummaryText => (sameEvm(address, me) ? ['your account'] : [code(address, role)]);

interface Draft {
  headline: SummaryText;
  lines: SummaryText[];
  warnings: SummaryWarning[];
  explainable: boolean;
}

/** What evmCall reads of a call: an EVM transaction's (DecodedEvmTx) or a sponsored batch's (DecodedEvmCallSite). */
type EvmCallInput = { readonly to: string | null; readonly value: bigint; readonly data: string; readonly selector: string | null; readonly call: DecodedEvmCall | null };

/**
 * Journear's demo check-in (D854), in plain words: only for exactly the pinned contract on this chain, exactly
 * `checkIn()` and no value (isDemoCheckInCall); its name and address stay in view, as a verified contract's do.
 */
const demoCheckIn = (to: string, inBatch = false): Draft => ({
  headline: [APP, ' wants to check you in'],
  // In a batch the reassurance is about the check-in alone: the other steps say what they do.
  lines: [[inBatch ? 'This is Journear’s demo check-in. The check-in itself doesn’t move any money or tokens.' : 'This is Journear’s demo check-in. It doesn’t move any money or tokens.'], ['It uses ', strong(DEMO_CHECK_IN_NAME), ' (', code(to, 'program'), ', checked by Journear).']],
  warnings: [],
  explainable: true,
});

function evmCall(chainId: number, tx: EvmCallInput, me: string): Draft {
  const to = tx.to as string;
  const chain: ContractChain = { kind: 'evm', chainId };
  const lines: SummaryText[] = [];
  const warnings: SummaryWarning[] = [];
  const contract = code(to, 'program');
  // The same contract as a token or a collection: its row says so.
  const tokenCode = code(to, 'token');
  const collection = code(to, 'collection');
  // What the call sends with it: in the headline of a generic call, a line of its own otherwise.
  const sending: SummaryText = tx.value > 0n ? [', sending it ', strong(evmNative(chainId, tx.value))] : [];
  const valueLine: SummaryText | null = tx.value > 0n ? ['It also sends ', strong(evmNative(chainId, tx.value)), ' to the program.'] : null;
  const withoutValueLine = () => lines.filter((l) => l !== valueLine);
  const unknown = (reason: string): Draft => ({ headline: [APP, ' wants to use the program ', contract, ...sending], lines: withoutValueLine(), warnings: [cannotTell('danger', reason), ...warnings], explainable: false });
  if (valueLine) lines.push(valueLine);
  if (isDemoCheckInCall(chainId, to, tx.data, tx.value)) return demoCheckIn(to);
  const call = tx.call;
  if (!call) return unknown(tx.selector ? 'it asks for an action Journear doesn’t know' : 'it sends information Journear can’t read');
  const a = call.args;
  const token = knownEvmToken(chainId, to);
  if (token) lines.push(tokenContractLine(to, token));
  switch (call.signature) {
    case 'transfer(address,uint256)': {
      const recipient = abiAddr(a[0]) as string;
      const amount = abiUint(a[1]) as bigint;
      return {
        headline: [APP, ' wants to send ', ...amountOf(amount, token), ' to ', ...evmWho(recipient, me)],
        lines: token ? lines : [unlistedLine(amount, to), ...lines],
        warnings,
        explainable: true,
      };
    }
    case 'transferFrom(address,address,uint256)': {
      const from = abiAddr(a[0]) as string;
      const recipient = abiAddr(a[1]) as string;
      const amount = abiUint(a[2]) as bigint;
      return {
        // Rounded against the user: down when it reaches them from someone else, up otherwise.
        headline: [APP, ' wants to move ', ...amountOf(amount, token, !sameEvm(from, me) && sameEvm(recipient, me) ? 'in' : 'out'), ' from ', ...evmWho(from, me, 'from'), ' to ', ...evmWho(recipient, me)],
        lines: token ? lines : [unlistedLine(amount, to, true), ...lines],
        warnings,
        explainable: true,
      };
    }
    case 'approve(address,uint256)': {
      const spender = abiAddr(a[0]) as string;
      const amount = abiUint(a[1]) as bigint;
      if (amount === 0n) {
        // ERC-721 shares this selector and item 0 exists: for a contract Journear doesn't know, 0 may be an item, not a revoke.
        if (!token && !ZERO_ADDRESS.test(spender)) {
          warnings.push({ level: 'warning', code: 'spend_permission', short: ['May let ', code(spender, 'spender'), ' take your item no. 0 from ', tokenCode], text: ['If ', tokenCode, ' is a token, this cancels ', code(spender, 'spender'), '’s permission to take it. If it’s a collectible, this lets ', ...spenderOf(chain, spender), ' take your item no. 0.'] });
          return { headline: [APP, ' wants to change ', code(spender, 'spender'), '’s permission for ', tokenCode], lines, warnings, explainable: true };
        }
        return { headline: [APP, ' wants to cancel ', code(spender, 'permission'), '’s permission to take your ', ...tokenName(to, token)], lines, warnings, explainable: true };
      }
      warnings.push(spendWarning(spenderOf(chain, spender), to, token, amount, UINT256_MAX, { nftToo: true }));
      return { headline: [APP, ' wants you to let someone else spend your ', ...tokenName(to, token)], lines, warnings, explainable: true };
    }
    case 'increaseAllowance(address,uint256)': {
      const spender = abiAddr(a[0]) as string;
      const amount = abiUint(a[1]) as bigint;
      if (amount > 0n) warnings.push(spendWarning(spenderOf(chain, spender), to, token, amount, UINT256_MAX, { more: true }));
      return { headline: [APP, ' wants you to let someone else spend more of your ', ...tokenName(to, token)], lines, warnings, explainable: true };
    }
    case 'decreaseAllowance(address,uint256)': {
      const spender = abiAddr(a[0]) as string;
      return { headline: [APP, ' wants to lower ', code(spender, 'permission'), '’s permission to take your ', ...tokenName(to, token)], lines, warnings, explainable: true };
    }
    case 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)': {
      const owner = abiAddr(a[0]) as string;
      const spender = abiAddr(a[1]) as string;
      const amount = abiUint(a[2]) as bigint;
      if (sameEvm(owner, me) && amount > 0n) warnings.push(spendWarning(spenderOf(chain, spender), to, token, amount, UINT256_MAX));
      return { headline: [APP, ' wants to use a signed permission to take ', ...tokenName(to, token), ' held by ', ...evmWho(owner, me, 'owner')], lines, warnings, explainable: true };
    }
    case 'setApprovalForAll(address,bool)': {
      const operator = abiAddr(a[0]) as string;
      if (abiBool(a[1]) === false) return { headline: [APP, ' wants to cancel ', code(operator, 'permission'), '’s permission to take your collectibles from ', collection], lines, warnings, explainable: true };
      warnings.push({ level: 'danger', code: 'collection_operator', text: ['This lets ', ...spenderOf(chain, operator), ' take all your collectibles from ', collection, ', now or later, with no limit. Approve only if you trust them completely.'], short: ['Lets ', ...spenderShort(spenderOf(chain, operator)), ' take all your collectibles from ', collection] });
      return { headline: [APP, ' wants you to let someone else take all your collectibles from ', collection], lines, warnings, explainable: true };
    }
    case 'safeTransferFrom(address,address,uint256)':
    case 'safeTransferFrom(address,address,uint256,bytes)':
      return { headline: [APP, ' wants to send collectible no. ', strong((abiUint(a[2]) as bigint).toString()), ' from ', collection, ' from ', ...evmWho(abiAddr(a[0]) as string, me, 'from'), ' to ', ...evmWho(abiAddr(a[1]) as string, me)], lines, warnings, explainable: true };
    case 'safeTransferFrom(address,address,uint256,uint256,bytes)':
      return {
        headline: [APP, ' wants to send ', strong((abiUint(a[3]) as bigint).toString()), ' of collectible no. ', strong((abiUint(a[2]) as bigint).toString()), ' from ', collection, ' from ', ...evmWho(abiAddr(a[0]) as string, me, 'from'), ' to ', ...evmWho(abiAddr(a[1]) as string, me)],
        lines,
        warnings,
        explainable: true,
      };
    case 'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)': {
      const ids = a[2]?.kind === 'array' ? a[2].items.map(abiUint) : [];
      const amounts = a[3]?.kind === 'array' ? a[3].items.map(abiUint) : [];
      const headline: SummaryText = [APP, ` wants to send ${ids.length === 1 ? '1 kind' : `${ids.length} kinds`} of collectible from `, collection, ' from ', ...evmWho(abiAddr(a[0]) as string, me, 'from'), ' to ', ...evmWho(abiAddr(a[1]) as string, me)];
      // Each item and how many: in view up to five kinds (item ids as written, amounts grouped); more can't be listed.
      if (ids.length > MAX_SUMMARY_STEPS || ids.length !== amounts.length || ids.some((x) => x === null) || amounts.some((x) => x === null)) {
        return { headline, lines, warnings: [cannotTell('danger', 'it sends more kinds of collectible than Journear can list'), ...warnings], explainable: false };
      }
      const items: SummaryText[] = ids.map((id, i) => ['Collectible no. ', strong((id as bigint).toString()), ': ', strong(groupDigits((amounts[i] as bigint).toString()))]);
      return { headline, lines: [...items, ...lines], warnings, explainable: true };
    }
    case 'multicall(bytes[])':
    case 'multicall(uint256,bytes[])':
      return unknown('it bundles several actions Journear can’t read');
    case 'withdraw(uint256)':
      return { headline: [APP, ' wants to withdraw ', strong(groupDigits((abiUint(a[0]) as bigint).toString())), ` ${units(abiUint(a[0]) as bigint)} from the program `, contract, ...sending], lines: withoutValueLine(), warnings, explainable: true };
    default:
      // deposit(): named by the standard, but the contract decides what it does; what it sends is in the headline.
      return { headline: [APP, ' wants to use the program ', contract, ' (', code(call.name), ')', ...sending], lines: withoutValueLine(), warnings, explainable: true };
  }
}

function evmTx(chainId: number, tx: DecodedEvmTx, me: string): ApprovalSummary {
  const base = { fee: upTo(evmNative(chainId, tx.maxFeeWei)), network: evmNetwork(chainId) };
  if (tx.to === null) {
    return { ...base, headline: [APP, ' wants to create a new program'], lines: tx.value > 0n ? [['It also sends ', strong(evmNative(chainId, tx.value)), ' to the new program.']] : [], warnings: [{ ...cannotTell('warning', 'it creates a new program Journear can’t read'), code: 'contract_creation' }], explainable: false };
  }
  if (tx.data === '0x') return { ...base, headline: [APP, ' wants to send ', strong(evmNative(chainId, tx.value)), ' to ', ...evmWho(tx.to, me)], lines: [], warnings: [], explainable: true };
  return { ...base, ...evmCall(chainId, tx, me) };
}

// ---- sponsored EVM actions (D831, D850) ----
//
// A batch of calls Journear's relayer sends for the user (the network fee is Journear's), through the pinned EIP-7702
// delegate. Each call is summarised by evmCall, exactly as the same call in an ordinary transaction, with all of its
// warnings: a sponsored `approve(spender, unlimited)` is as alarming as an unsponsored one. What differs is said in
// plain words: the fee line, and the one-time setup note when the approval also signs the account's authorization.
// The calls carry no value (the subject decoder refuses any), so nothing is said about ETH leaving.

/** The fee line of a sponsored action (the founder's wording): "Network fee: none. Journear pays it for you." */
export const SPONSORED_FEE: SummaryText = Object.freeze(['none. Journear pays it for you.']) as SummaryText;

/** A network's own name for a sentence ("Base Sepolia"), without the network line's "(test network)". */
const chainName = (chainId: number): string => evmChainInfo(chainId)?.name ?? 'this network';

/**
 * The one-time setup note (amber): only when the approval also signs the account's EIP-7702 authorization.
 * Never the words "upgrade" or "smart account" (the founder's rule): what it does for the user, in their terms.
 */
export const accountSetupNote = (chainId: number): SummaryWarning => ({
  level: 'warning',
  code: 'account_setup',
  text: [`One-time setup: this also turns on free network fees for your account on ${chainName(chainId)}. Your address stays the same and you still approve every action.`],
  short: [`One-time setup: it also turns on free network fees for your account on ${chainName(chainId)} (your address stays the same)`],
});

/** "{App} wants to X…" (a call's headline) → "X…", its line in a batch. Any other shape throws (summarizeApproval's catch). */
function callLine(headline: SummaryText): SummaryText {
  const [app, first, ...rest] = headline;
  const lead = ' wants to ';
  if (app !== APP || typeof first !== 'string' || !first.startsWith(lead)) throw new Error('A call headline is "{App} wants to …"');
  const word = first.slice(lead.length);
  return word === '' ? rest : [word, ...rest];
}


const GRANTS: ReadonlySet<SummaryWarningCode> = new Set(['spend_permission', 'unlimited_spend', 'collection_operator']);

/**
 * One call of a batch as a step (D814's grouping): its line says everything its own summary says (the headline, or
 * for a grant its warning's bullet, which names the spender and the amount; then its extra lines, such as an amount in
 * smallest units), and two calls group only when their target and calldata are equal too. Order: value to others,
 * grants, contract calls (and every call Journear can't read), other value, moves to the user's own account, revokes.
 */
function sponsoredStep(chainId: number, c: DecodedEvmCallSite, d: Draft, me: string): Step {
  const grant = d.explainable ? d.warnings.find((w) => GRANTS.has(w.code)) : undefined;
  const head = grant?.short ?? callLine(d.headline);
  const text: SummaryText = d.lines.length === 0 ? head : [...sentence(head), ' ', ...d.lines.flatMap((l, i) => [...(i > 0 ? [' '] : []), ...sentence(l)])];
  const key = `${JSON.stringify(text)}|${c.to.toLowerCase()}|${c.data}`;
  const step = (order: number, value = true): Step => ({ text, value, order, key });
  if (isDemoCheckInCall(chainId, c.to, c.data, c.value)) return step(3, false);
  if (!d.explainable || !c.call) return step(3);
  if (grant) return step(2);
  const a = c.call.args;
  const toMe = (i: number) => {
    const who = abiAddr(a[i]);
    return who !== null && sameEvm(who, me);
  };
  switch (c.call.signature) {
    case 'transfer(address,uint256)':
      return step(toMe(0) ? 5 : 1);
    case 'transferFrom(address,address,uint256)':
    case 'safeTransferFrom(address,address,uint256)':
    case 'safeTransferFrom(address,address,uint256,bytes)':
    case 'safeTransferFrom(address,address,uint256,uint256,bytes)':
    case 'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)':
      return step(toMe(1) ? 5 : 1);
    case 'withdraw(uint256)':
      return step(4);
    case 'approve(address,uint256)':
    case 'decreaseAllowance(address,uint256)':
    case 'setApprovalForAll(address,bool)':
      // Here only as a take-back (a grant has its warning above): moves nothing.
      return step(6, false);
    default:
      return step(3);
  }
}

function sponsoredAction(decoded: Extract<DecodedApproval, { kind: 'evm_sponsored' }>, me: string): ApprovalSummary {
  const { chainId, calls } = decoded;
  const drafts = calls.map((c) => (calls.length > 1 && isDemoCheckInCall(chainId, c.to, c.data, c.value) ? demoCheckIn(c.to, true) : evmCall(chainId, c, me)));
  const warnings: SummaryWarning[] = [];
  let explainable = drafts.every((d) => d.explainable);
  let headline: SummaryText;
  const lines: SummaryText[] = [];
  let shownSteps: number[];
  if (drafts.length === 1) {
    // One call: exactly its own summary, as an ordinary transaction with that call gets.
    const d = drafts[0] as Draft;
    headline = d.headline;
    lines.push(...d.lines);
    warnings.push(...d.warnings);
    shownSteps = [0];
  } else {
    headline = [APP, ` wants to do ${drafts.length} things at once`];
    // The calls Journear can't read: one red line for the batch (D810), the call's own when it is the only kind.
    const tells = drafts.flatMap((d) => d.warnings.filter((w) => w.code === 'cannot_explain'));
    const distinct = new Set(tells.map((w) => JSON.stringify(w.text)));
    if (tells.length > 0) warnings.push(distinct.size === 1 ? (tells[0] as SummaryWarning) : cannotTell(tells.reduce<RiskLevel | null>((l, w) => worse(l, w.level), null) as RiskLevel, 'Journear can’t read part of it'));
    warnings.push(...drafts.flatMap((d) => d.warnings.filter((w) => w.code !== 'cannot_explain')));
    const g = groupSteps(calls.map((c, i) => sponsoredStep(chainId, c, drafts[i] as Draft, me)));
    shownSteps = g.shown;
    lines.push(...g.lines);
    warnings.push(...g.leftOut);
    if (g.hiddenRisk) {
      explainable = false;
      warnings.push(stepsNotListed(drafts.length, g.hidden, g.hiddenRisk));
    }
  }
  if (decoded.setup) warnings.push(accountSetupNote(chainId));
  return { headline, lines, fee: SPONSORED_FEE, network: evmNetwork(chainId), warnings, explainable, shownSteps };
}

// ---- EIP-712 typed data ----

type Fields = readonly { readonly name: string; readonly type: string }[];

const sameFields = (have: Fields | undefined, want: Fields): boolean => have !== undefined && have.length === want.length && have.every((f, i) => f.name === want[i]?.name && f.type === want[i]?.type);

const EIP2612_PERMIT: Fields = [
  { name: 'owner', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
];
const DAI_PERMIT: Fields = [
  { name: 'holder', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'expiry', type: 'uint256' },
  { name: 'allowed', type: 'bool' },
];
const PERMIT2_DETAILS: Fields = [
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint160' },
  { name: 'expiration', type: 'uint48' },
  { name: 'nonce', type: 'uint48' },
];
const PERMIT2_TOKEN_PERMISSIONS: Fields = [
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' },
];
const PERMIT2_SHAPES: Readonly<Record<string, { readonly fields: Fields; readonly sub: readonly [string, Fields] }>> = {
  PermitSingle: { fields: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }], sub: ['PermitDetails', PERMIT2_DETAILS] },
  PermitBatch: { fields: [{ name: 'details', type: 'PermitDetails[]' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }], sub: ['PermitDetails', PERMIT2_DETAILS] },
  PermitTransferFrom: { fields: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }], sub: ['TokenPermissions', PERMIT2_TOKEN_PERMISSIONS] },
  PermitBatchTransferFrom: { fields: [{ name: 'permitted', type: 'TokenPermissions[]' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }], sub: ['TokenPermissions', PERMIT2_TOKEN_PERMISSIONS] },
};

/** Permit2's witness transfers: the first four fields of each, then one `witness` field of the app's own type. */
const PERMIT2_WITNESS: Readonly<Record<string, Fields>> = {
  PermitWitnessTransferFrom: PERMIT2_SHAPES.PermitTransferFrom!.fields,
  PermitBatchWitnessTransferFrom: PERMIT2_SHAPES.PermitBatchTransferFrom!.fields,
};

const struct = (v: TypedDataValue | undefined): TypedDataStruct | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as TypedDataStruct) : null);
const str = (v: TypedDataValue | undefined): string | null => (typeof v === 'string' ? v : null);
const big = (v: TypedDataValue | undefined): bigint | null => (typeof v === 'bigint' ? v : null);

/**
 * Typed data that may grant spending without being a shape Journear checks: a permit-like name, or any struct with an
 * address field called `spender` or `operator`. Wide on purpose: it only adds a "may be" warning.
 */
function mayGrantSpending(types: Readonly<Record<string, Fields>>, primaryType: string, domainName: string | null): boolean {
  const named = /permit|allowance|approv/iu;
  if (named.test(primaryType) || named.test(domainName ?? '')) return true;
  return Object.entries(types).some(([name, fields]) => name !== 'EIP712Domain' && fields.some((f) => f.type === 'address' && /^(spender|operator)$/iu.test(f.name)));
}

function typedData(decoded: Extract<DecodedApproval, { kind: 'eip712' }>, me: string): ApprovalSummary {
  const { typedData: td, chainId } = decoded;
  const network: SummaryText | null = chainId === null ? null : evmNetwork(chainId);
  const chain: ContractChain | null = chainId === null ? null : { kind: 'evm', chainId };
  const domain = td.domain;
  const verifying = str(domain.verifyingContract);
  const base = { fee: null, network };
  const pt = td.primaryType;
  const warnings: SummaryWarning[] = [];
  const lines: SummaryText[] = [];
  const ownerLine = (owner: string) => {
    if (!sameEvm(owner, me)) lines.push(['The tokens it names belong to ', code(owner, 'owner'), ', not to your account.']);
  };

  // EIP-2612: the token's own Permit, signed for its contract (the domain's verifyingContract).
  const typeCount = Object.keys(td.types).length;
  if (pt === 'Permit' && verifying && typeCount === 2 && sameFields(td.types.Permit, EIP2612_PERMIT)) {
    const m = td.message;
    const spender = str(m.spender) as string;
    const value = big(m.value) as bigint;
    ownerLine(str(m.owner) as string);
    const token = chainId === null ? null : knownEvmToken(chainId, verifying);
    if (token) lines.push(tokenContractLine(verifying, token));
    if (value === 0n) return { ...base, headline: [APP, ' wants you to cancel ', code(spender, 'permission'), '’s permission to take your ', ...tokenName(verifying, token)], lines, warnings, explainable: true };
    warnings.push(spendWarning(spenderOf(chain, spender), verifying, token, value, UINT256_MAX));
    return { ...base, headline: [APP, ' wants you to let someone else spend your ', ...tokenName(verifying, token)], lines, warnings, explainable: true };
  }
  // DAI's permit: all or nothing.
  if (pt === 'Permit' && verifying && typeCount === 2 && sameFields(td.types.Permit, DAI_PERMIT)) {
    const m = td.message;
    const spender = str(m.spender) as string;
    ownerLine(str(m.holder) as string);
    const token = chainId === null ? null : knownEvmToken(chainId, verifying);
    if (token) lines.push(tokenContractLine(verifying, token));
    if (m.allowed !== true) return { ...base, headline: [APP, ' wants you to cancel ', code(spender, 'permission'), '’s permission to take your ', ...tokenName(verifying, token)], lines, warnings, explainable: true };
    warnings.push(spendWarning(spenderOf(chain, spender), verifying, token, UINT256_MAX, UINT256_MAX));
    return { ...base, headline: [APP, ' wants you to let someone else spend your ', ...tokenName(verifying, token)], lines, warnings, explainable: true };
  }
  // Permit2: its own domain (name "Permit2", Permit2's contract, no version), one of its four message shapes.
  const shape = Object.hasOwn(PERMIT2_SHAPES, pt) ? PERMIT2_SHAPES[pt] : undefined;
  const isPermit2Domain = domain.name === 'Permit2' && verifying !== null && sameEvm(verifying, PERMIT2_ADDRESS) && domain.version === undefined;
  if (shape && isPermit2Domain && sameFields(td.types[pt], shape.fields) && sameFields(td.types[shape.sub[0]], shape.sub[1]) && Object.keys(td.types).length === 3) {
    const m = td.message;
    const spender = spenderOf(chain, str(m.spender) as string);
    const allowance = pt === 'PermitSingle' || pt === 'PermitBatch';
    const entries = (allowance ? m.details : m.permitted) as TypedDataValue;
    const list = Array.isArray(entries) ? (entries as readonly TypedDataValue[]) : [entries];
    for (const e of list) {
      const s = struct(e) as TypedDataStruct;
      const tokenAddr = str(s.token) as string;
      const amount = big(s.amount) as bigint;
      const token = chainId === null ? null : knownEvmToken(chainId, tokenAddr);
      if (token) lines.push(tokenContractLine(tokenAddr, token));
      if (amount === 0n) lines.push(['It cancels the permission of ', ...spender, ' to take ', ...tokenName(tokenAddr, token), '.']);
      else warnings.push(spendWarning(spender, tokenAddr, token, amount, allowance ? UINT160_MAX : UINT256_MAX, allowance ? { via: 'through Permit2' } : { via: 'through Permit2, once', once: true }));
    }
    return { ...base, headline: [APP, ' wants you to let someone else spend your tokens through Permit2'], lines, warnings, explainable: true };
  }
  // Permit2's witness transfers: a certain one-time spend (said, with its tokens and amounts), plus a witness Journear
  // can't read, so the request stays unexplained and its details start open.
  const witness = Object.hasOwn(PERMIT2_WITNESS, pt) ? PERMIT2_WITNESS[pt] : undefined;
  const witnessFields = td.types[pt];
  if (witness && isPermit2Domain && witnessFields?.length === 5 && sameFields(witnessFields.slice(0, 4), witness) && sameFields(td.types.TokenPermissions, PERMIT2_TOKEN_PERMISSIONS)) {
    const m = td.message;
    const spender = spenderOf(chain, str(m.spender) as string);
    const entries = m.permitted as TypedDataValue;
    for (const e of Array.isArray(entries) ? (entries as readonly TypedDataValue[]) : [entries]) {
      const s = struct(e) as TypedDataStruct;
      const tokenAddr = str(s.token) as string;
      const amount = big(s.amount) as bigint;
      const token = chainId === null ? null : knownEvmToken(chainId, tokenAddr);
      if (amount > 0n) warnings.push(spendWarning(spender, tokenAddr, token, amount, UINT256_MAX, { via: 'through Permit2, once', once: true }));
    }
    return { ...base, headline: [APP, ' wants you to let someone else spend your tokens through Permit2, with extra information Journear can’t read'], lines, warnings: [cannotTell('warning', 'it carries extra information Journear can’t read'), ...warnings], explainable: false };
  }
  // Anything else: Journear can't explain it. Say so louder when it imitates a permit.
  if (domain.name === 'Permit2' && !isPermit2Domain) {
    warnings.push(
      cannotCheck('danger', 'permit_lookalike', undefined, 'It says it’s Permit2, a well-known way to let others take your tokens, but it isn’t the real one. It may be a scam.', ['Pretends to be Permit2: it may be a scam']),
    );
  } else if (mayGrantSpending(td.types, pt, str(domain.name))) {
    warnings.push(cannotCheck('warning', 'spend_permission', 'it may be a permission for someone else to take your tokens', null, ['May let someone take your tokens']));
  }
  return { ...base, headline: [APP, ' wants you to sign something Journear can’t check'], lines, warnings: [cannotTell('danger'), ...warnings], explainable: false };
}

// ---- messages ----

/** EIP-4361's first line: `${scheme?}${domain} wants you to sign in with your Ethereum account:`. */
const SIWE_FIRST_LINE = /^(?:(https?):\/\/)?([A-Za-z0-9.-]+(?::[0-9]{1,5})?) wants you to sign in with your Ethereum account:$/u;

function hostOf(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function message(kind: 'personal_sign' | 'stellar_message', text: string | null, ctx: SummaryContext): ApprovalSummary {
  const base = { fee: null, network: null, lines: [] as SummaryText[] };
  if (text === null) return { ...base, headline: [APP, ' wants you to sign a message Journear can’t read'], warnings: [unreadableMessage()], explainable: false };
  const siwe = kind === 'personal_sign' ? SIWE_FIRST_LINE.exec(text.split('\n', 1)[0] ?? '') : null;
  if (siwe) {
    const domain = siwe[2] as string;
    const host = hostOf(ctx.parentOrigin);
    const warnings: SummaryWarning[] = [];
    if (host !== null && host.toLowerCase() !== domain.toLowerCase()) {
      warnings.push({ level: 'warning', code: 'sign_in_mismatch', short: ['Signs you in to ', code(domain), ', not ', code(host)], text: ['This app is at ', code(host), ', but the message signs you in to ', code(domain), '. Sign only if you mean to sign in to ', code(domain), '.'] });
    }
    return { ...base, headline: [APP, ' wants you to sign in to ', code(domain)], warnings, explainable: true };
  }
  return { ...base, headline: [APP, ' wants you to sign a message'], warnings: [], explainable: true };
}

// ---- Stellar ----

/** Stellar's network: its name, or the passphrase (a request may name any), as hex when it isn't display-safe, cut short. */
function stellarNetwork(passphrase: string): SummaryText {
  if (passphrase === STELLAR_MAINNET_PASSPHRASE) return ['Stellar (real money)'];
  if (passphrase === STELLAR_TESTNET_PASSPHRASE) return ['Stellar (test network)'];
  const shown = isDisplaySafeLine(passphrase) ? passphrase : `(shown as hex) ${toHex(new TextEncoder().encode(passphrase))}`;
  return ['a Stellar network Journear doesn’t know: ', code(shown.length > 64 ? `${shown.slice(0, 63)}…` : shown)];
}

const xlm = (stroops: string | bigint, dir: AmountDirection = 'out'): string => `${displayUnits(BigInt(stroops), 7, dir)} XLM`;

/**
 * A Stellar asset named in a sentence: XLM; a listed asset by its symbol, with the real-token line; anything
 * else as "the asset CODE:ISSUER" (a code is its issuer's choice), with the look-alike warning when its code is a listed
 * token's symbol on this network.
 */
function stellarAsset(asset: string): { readonly listed: KnownToken | null } {
  if (asset === 'native' || !tokenNotes) return { listed: null };
  const listed = knownStellarToken(tokenNotes.passphrase, asset);
  if (listed) noteOnce(tokenNotes.lines, realTokenLine(asset, listed));
  else {
    const symbol = asset.slice(0, asset.indexOf(':'));
    if (knownSymbolOn({ kind: 'stellar', networkPassphrase: tokenNotes.passphrase }, symbol) && !tokenNotes.warnings.some((w) => w.code === 'token_lookalike' && JSON.stringify(w.text).includes(asset))) tokenNotes.warnings.push(lookalikeToken(symbol, asset));
  }
  return { listed };
}

/** An amount of a Stellar asset (`native` or `CODE:ISSUER`): "1.5 XLM", "5 USDC" (listed), or "2 of the asset X:G…". */
function stellarAmount(stroops: string | bigint, asset: string, dir: AmountDirection = 'out'): SummaryText {
  if (asset === 'native') return [strong(xlm(stroops, dir))];
  const { listed } = stellarAsset(asset);
  return listed ? [strong(`${displayUnits(BigInt(stroops), listed.decimals, dir)} ${listed.symbol}`)] : [strong(displayUnits(BigInt(stroops), 7, dir)), ' of the asset ', code(asset, 'token')];
}
const assetName = (asset: string): SummaryText => {
  if (asset === 'native') return ['XLM'];
  const { listed } = stellarAsset(asset);
  return listed ? [listed.symbol] : ['the asset ', code(asset, 'token')];
};
/**
 * A Stellar account's base account and muxed id: a muxed address (M…) is its base account (G…) with an id for the
 * account's own bookkeeping, and moves that base account's funds. Anything else is its own base.
 */
export function stellarBaseAccount(address: string): { readonly base: string; readonly muxedId: string | null } {
  if (!address.startsWith('M')) return { base: address, muxedId: null };
  try {
    const m = MuxedAccount.fromAddress(address, '0');
    return { base: m.baseAccount().accountId(), muxedId: m.id() };
  } catch {
    return { base: address, muxedId: null };
  }
}

/** Whether a Stellar address is the user's account, written plainly or muxed. Every comparison with the user's uses it. */
const isMeStellar = (address: string, me: string): boolean => address === me || stellarBaseAccount(address).base === me;

const stellarWho = (account: string, me: string, role: IdRole = 'to'): SummaryText => {
  if (account === me) return ['your account'];
  const { base, muxedId } = stellarBaseAccount(account);
  return base === me && muxedId !== null ? [`your account (extra id ${muxedId})`] : [code(account, role)];
};
/** "A, B or C". */
const either = (parts: readonly SummaryText[]): SummaryText => parts.flatMap((p, i) => [...(i === 0 ? [] : i === parts.length - 1 ? [' or '] : [', ']), ...p]);

const scAddr = (v: StellarScVal | undefined): string | null => (v?.type === 'address' ? v.address : null);
const scInt = (v: StellarScVal | undefined): bigint | null => (v?.type === 'i128' || v?.type === 'u128' ? BigInt(v.value) : null);

/** How a Soroban token call is phrased: the call itself, what an authorization entry signs, or a call nested under another. */
type TokenCallMode = 'send' | 'authorize' | 'nested';

/**
 * A Soroban token call (SEP-41, which every Stellar asset contract implements): `transfer(from, to, amount)` and
 * `approve(from, spender, amount, expiration_ledger)`, recognised only with exactly those argument types. Anything else
 * is a call Journear can't summarise (null). `nested` phrases it as a whole line ("It also authorizes sending …").
 */
function sorobanTokenCall(passphrase: string, c: StellarContractCall, me: string, warnings: SummaryWarning[], mode: TokenCallMode): SummaryText | null {
  const token = knownStellarToken(passphrase, c.contract);
  const a = c.args;
  const end: SummaryText = mode === 'nested' ? ['.'] : [];
  if (c.function === 'transfer' && a.length === 3 && scAddr(a[0]) && scAddr(a[1]) && a[2]?.type === 'i128') {
    const amount = scInt(a[2]) as bigint;
    const from = scAddr(a[0]) as string;
    const verb = { send: 'send ', authorize: 'approve sending ', nested: 'It also approves sending ' }[mode];
    const toMe = isMeStellar(scAddr(a[1]) as string, me) && !isMeStellar(from, me);
    if (tokenNotes) noteOnce(tokenNotes.lines, token ? realTokenLine(c.contract, token) : unlistedLine(null, c.contract));
    const what: SummaryText = token ? amountOf(amount, token, toMe ? 'in' : 'out') : [strong(groupDigits(amount.toString())), ` ${units(amount)} of the unlisted token `, code(c.contract, 'token')];
    return [verb, ...what, ...(from === me ? [] : [' from ', ...stellarWho(from, me, 'from')]), ' to ', ...stellarWho(scAddr(a[1]) as string, me), ...end];
  }
  if (c.function === 'approve' && a.length === 4 && scAddr(a[0]) && scAddr(a[1]) && a[2]?.type === 'i128' && a[3]?.type === 'u32') {
    const amount = scInt(a[2]) as bigint;
    const from = scAddr(a[0]) as string;
    const spender = scAddr(a[1]) as string;
    const whose: SummaryText = isMeStellar(from, me) ? ['your ', ...tokenName(c.contract, token)] : [...tokenName(c.contract, token), ' held by ', code(from, 'owner')];
    if (amount === 0n) return [{ send: 'cancel ', authorize: 'approve cancelling ', nested: 'It also cancels ' }[mode], code(spender, 'permission'), '’s permission to take ', ...whose, ...end];
    warnings.push(spendWarning(spenderOf({ kind: 'stellar', networkPassphrase: passphrase }, spender), c.contract, token, amount, I128_MAX, isMeStellar(from, me) ? {} : { owner: from }));
    return [{ send: 'let ', authorize: 'approve letting ', nested: 'It also lets ' }[mode], code(spender, 'spender'), ' take ', ...whose, ...end];
  }
  return null;
}

/** Two contract calls are the same call: same contract, function and arguments. */
const sameCall = (a: StellarContractCall, b: StellarContractCall): boolean => a.contract === b.contract && a.function === b.function && JSON.stringify(a.args) === JSON.stringify(b.args);

/**
 * Every call an authorization tree holds besides the one being made: each said in a line of its own (a token move or
 * approval in plain words, any other call by contract and function), approvals also warned about. Any such call makes
 * the request unexplainable (the caller), since the summary's headline describes only the call itself.
 */
function otherAuthorizations(passphrase: string, inv: StellarInvocation, me: string, warnings: SummaryWarning[], lines: SummaryText[]): void {
  const f = inv.function;
  const said = f.type === 'contractFn' ? sorobanTokenCall(passphrase, f, me, warnings, 'nested') : null;
  lines.push(said ?? (f.type === 'contractFn' ? ['It also approves using the program ', code(f.contract, 'program'), ' (', code(f.function), ').'] : ['It also approves creating a program.']));
  for (const s of inv.subInvocations) otherAuthorizations(passphrase, s, me, warnings, lines);
}

/** Offers: the price is `n / d` of `buying` per unit of `selling` (a sell offer) or of `selling` per unit bought (a buy offer). */
const times = (amount: string, n: number, d: number, round: 'down' | 'up'): bigint | null => {
  // A price whose parts aren't positive integers is malformed: never divided by, and the offer isn't explained.
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || n <= 0 || d <= 0) return null;
  const num = BigInt(amount) * BigInt(n);
  const den = BigInt(d);
  return round === 'down' ? num / den : (num + den - 1n) / den;
};
const badPrice = (what: SummaryText): OpSummary => ({ text: [...what, ' at a price Journear can’t read'], explainable: false });
const changes = (offerId: string): SummaryText => (offerId === '0' ? [] : [` (it changes your offer ${offerId})`]);

interface OpSummary {
  readonly text: SummaryText;
  readonly explainable: boolean;
  /** When not explainable: how strong its risk line is (amber unless said). */
  readonly risk?: RiskLevel;
}

/**
 * What one Stellar operation does, in a few words (no "{App} wants to"), with every term that decides what the user
 * gives or gets, and whether Journear can say that. Lines for what it also authorizes go to `extra`.
 */
function stellarOp(passphrase: string, op: StellarOperation, me: string, warnings: SummaryWarning[], extra: SummaryText[]): OpSummary {
  const ok = (text: SummaryText): OpSummary => ({ text, explainable: true });
  switch (op.type) {
    case 'payment':
      return ok(['send ', ...stellarAmount(op.amount, op.asset), ' to ', ...stellarWho(op.destination, me)]);
    case 'createAccount':
      return ok(['create the account ', code(op.destination, 'to'), ' and send it ', strong(xlm(op.startingBalance))]);
    case 'pathPaymentStrictReceive':
      return ok(['pay at most ', ...stellarAmount(op.sendMax, op.sendAsset), ' so that ', ...stellarWho(op.destination, me), ' receives exactly ', ...stellarAmount(op.destAmount, op.destAsset, 'in')]);
    case 'pathPaymentStrictSend':
      return ok(['pay exactly ', ...stellarAmount(op.sendAmount, op.sendAsset), ' so that ', ...stellarWho(op.destination, me), ' receives at least ', ...stellarAmount(op.destMin, op.destAsset, 'in')]);
    case 'manageSellOffer':
    case 'createPassiveSellOffer':
      if (op.amount === '0') return ok(['cancel your offer ', code(op.offerId), ' to sell ', ...assetName(op.selling)]);
      {
        const least = times(op.amount, op.price.n, op.price.d, 'down');
        if (least === null) return badPrice(['offer to sell ', ...stellarAmount(op.amount, op.selling), ' for ', ...assetName(op.buying)]);
        return ok(['offer to sell ', ...stellarAmount(op.amount, op.selling), ' for at least ', ...stellarAmount(least, op.buying, 'in'), ...changes(op.offerId)]);
      }
    case 'manageBuyOffer':
      if (op.buyAmount === '0') return ok(['cancel your offer ', code(op.offerId), ' to buy ', ...assetName(op.buying)]);
      {
        const most = times(op.buyAmount, op.price.n, op.price.d, 'up');
        if (most === null) return badPrice(['offer to buy ', ...stellarAmount(op.buyAmount, op.buying, 'in'), ' with ', ...assetName(op.selling)]);
        return ok(['offer to buy ', ...stellarAmount(op.buyAmount, op.buying, 'in'), ', paying at most ', ...stellarAmount(most, op.selling), ...changes(op.offerId)]);
      }
    case 'changeTrust':
      return ok(op.limit === '0' ? ['stop holding ', ...assetName(op.asset)] : ['let your account hold ', ...assetName(op.asset)]);
    case 'setOptions': {
      if (op.signer || op.masterWeight !== null || op.lowThreshold !== null || op.medThreshold !== null || op.highThreshold !== null) {
        // Who can sign: named, so two changes never read the same (D814).
        const parts: SummaryText[] = [];
        if (op.signer) parts.push(op.signer.weight === 0 ? ['stop the key ', code(op.signer.key, 'key'), ' acting for the account'] : ['let the key ', code(op.signer.key, 'key'), ` act for the account (strength ${op.signer.weight})`]);
        if (op.masterWeight !== null) parts.push([`set your own key’s strength to ${op.masterWeight}`]);
        if (op.lowThreshold !== null || op.medThreshold !== null || op.highThreshold !== null) parts.push(['change how many approvals the account needs']);
        return ok(parts.flatMap((p, i) => [...(i > 0 ? [' and '] : []), ...p]));
      }
      const what = [op.setFlags !== null || op.clearFlags !== null ? 'its options' : null, op.homeDomain ? 'its website name' : null, op.inflationDest !== null ? 'an old setting that no longer does anything' : null].filter((x): x is string => x !== null);
      return ok([what.length === 0 ? 'change nothing on the account' : `change the account’s settings (${what.join(', ')})`]);
    }
    case 'accountMerge':
      return ok(['close the account and send all its XLM to ', code(op.destination, 'to')]);
    case 'allowTrust':
      return ok([op.authorize === 0 ? 'stop ' : 'allow ', code(op.trustor, 'account'), op.authorize === 0 ? ' from using your asset ' : ' to hold your asset ', code(op.assetCode)]);
    case 'setTrustLineFlags':
      return ok(['change what ', code(op.trustor, 'account'), ' may do with your asset ', code(op.asset, 'token')]);
    case 'manageData':
      return ok([op.value === null ? 'delete a note on the account' : 'save a note on the account']);
    case 'bumpSequence':
      return ok(['move the account’s request counter forward']);
    case 'createClaimableBalance': {
      // Who can claim it decides who gets it; a claimant's conditions (time windows) are in the details, open then.
      const conditional = op.claimants.some((c) => !c.unconditional);
      return { text: ['set aside ', ...stellarAmount(op.amount, op.asset), ' that ', ...either(op.claimants.map((c) => stellarWho(c.destination, me))), ' can claim', ...(conditional ? [' (with conditions)'] : [])], explainable: !conditional };
    }
    case 'claimClaimableBalance':
      return ok(['claim a balance set aside for you']);
    case 'clawbackClaimableBalance':
      return ok(['take back a balance set aside for others']);
    case 'clawback':
      return ok(['take back ', ...stellarAmount(op.amount, op.asset, 'in'), ' from ', code(op.from, 'from')]);
    case 'beginSponsoringFutureReserves':
      return ok(['pay the minimum balances of ', code(op.sponsored, 'account')]);
    case 'endSponsoringFutureReserves':
      return ok(['stop paying someone else’s minimum balance']);
    case 'revokeSponsorship':
      return ok(op.target.type === 'signer' ? ['stop paying the minimum balance for a key of ', code(op.target.account, 'account')] : ['stop paying someone else’s minimum balance']);
    case 'liquidityPoolDeposit':
      // The pool's two assets aren't in the request (only its id): the amounts can't be named, so it isn't explained.
      return { text: ['deposit at most ', strong(displayUnits(BigInt(op.maxAmountA), 7)), ' of the pool’s first asset and ', strong(displayUnits(BigInt(op.maxAmountB), 7)), ' of its second into the liquidity pool ', code(op.poolId, 'pool')], explainable: false };
    case 'liquidityPoolWithdraw':
      return { text: ['withdraw ', strong(displayUnits(BigInt(op.amount), 7)), ' pool shares from the liquidity pool ', code(op.poolId, 'pool'), ' for at least ', strong(displayUnits(BigInt(op.minAmountA), 7, 'in')), ' of the pool’s first asset and ', strong(displayUnits(BigInt(op.minAmountB), 7, 'in')), ' of its second'], explainable: false };
    case 'inflation':
      return ok(['run an old Stellar action that no longer does anything']);
    case 'extendFootprintTtl':
      return ok(['keep a program’s stored information for longer']);
    case 'restoreFootprint':
      return ok(['bring back a program’s archived information']);
    case 'invokeHostFunction': {
      const f = op.hostFunction;
      if (f.type !== 'invokeContract') {
        // Creating a contract: every call its authorizations hold is listed (an authorization of the creation itself is
        // the operation; what sits under it is listed). Red when it authorizes anything or runs a constructor (V2),
        // which acts with the authorities given; amber for creating without either, or uploading code.
        for (const auth of op.auth) {
          const root = auth.rootInvocation;
          for (const inv of root.function.type === 'contractFn' ? [root] : root.subInvocations) otherAuthorizations(passphrase, inv, me, warnings, extra);
        }
        const red = op.auth.length > 0 || f.type === 'createContractV2';
        return { text: [f.type === 'uploadContractWasm' ? 'upload a program' : f.type === 'createContractV2' ? 'create a program and run its setup' : 'create a program'], explainable: false, risk: red ? 'danger' : 'warning' };
      }
      const token = sorobanTokenCall(passphrase, f, me, warnings, 'send');
      let explainable = token !== null;
      // The call is explained only when its authorizations hold exactly that call and nothing else: any other node is
      // said in a line of its own, and the request is then not explainable (its details start open).
      for (const auth of op.auth) {
        const root = auth.rootInvocation;
        const isCall = root.function.type === 'contractFn' && sameCall(root.function, f);
        for (const inv of isCall ? root.subInvocations : [root]) {
          otherAuthorizations(passphrase, inv, me, warnings, extra);
          explainable = false;
        }
      }
      // A contract call Journear can't summarise, or one that authorizes more: it could move value with no visible bound.
      return { text: token ?? ['use the program ', code(f.contract, 'program'), ' (', code(f.function), ')'], explainable, ...(explainable ? {} : { risk: 'danger' as const }) };
    }
  }
}

const capitalised = (t: SummaryText): SummaryText => {
  const [first, ...rest] = t;
  return typeof first === 'string' ? [first.charAt(0).toUpperCase() + first.slice(1), ...rest] : t;
};

/**
 * One step of a request with several. Steps group only when their keys are equal, and a key holds everything a
 * line says about a step except an amount that is summed: never two recipients, assets, contracts or methods in one
 * group. `order`: 0 control changes, 1 value to others, 2 approvals and grants, 3 contract calls, 4 other value, 5 moves
 * to the user's own account, 6 the rest.
 */
interface Step {
  readonly text: SummaryText;
  readonly value: boolean;
  readonly key: string;
  readonly order: number;
  /** A summable amount of this step, in smallest units, and whether it is the chain's own coin. */
  readonly sum?: bigint;
  readonly native?: boolean;
  /** The group's line for several such steps, from the count and the summed amount. */
  readonly many?: (count: number, sum: bigint) => SummaryText;
  /** What names this step when its line isn't shown (its key, spender or recipient), when its line doesn't. */
  readonly label?: SummaryText;
}

/** A step grouped only with steps whose line would read the same (no summed amount). */
const sameText = (text: SummaryText, value: boolean, order: number): Step => ({ text, value, order, key: JSON.stringify(text) });

interface StepGroup {
  readonly first: Step;
  readonly index: number;
  /** The steps in this group, by index. */
  readonly members: number[];
  count: number;
  sum: bigint;
}

/**
 * At most MAX_GROUP_LINES lines for a request with several steps, grouped by `Step.key`, in order: control
 * changes, value to others (the chain's coin first, then the largest total first), approvals and grants, contract calls,
 * other value, moves to the user's own account, the rest. With more groups, the last line is "…and N other steps" and
 * the caller says so in a warning (red when a left-out group moves or grants value or changes control). The largest
 * amount to others is never left out: a control group gives way to it (control changes are always in the red box).
 */
export function groupSteps(items: readonly Step[]): { lines: SummaryText[]; hidden: number; hiddenRisk: RiskLevel | null; leftOut: SummaryWarning[]; shown: number[] } {
  const byKey = new Map<string, StepGroup>();
  items.forEach((x, index) => {
    const k = `${x.order}|${x.key}`;
    const g = byKey.get(k);
    if (g) {
      g.count++;
      g.sum += x.sum ?? 0n;
      g.members.push(index);
    } else byKey.set(k, { first: x, index, members: [index], count: 1, sum: x.sum ?? 0n });
  });
  const outRank = (a: StepGroup, b: StepGroup): number => (a.first.native === b.first.native ? (a.sum === b.sum ? a.index - b.index : a.sum > b.sum ? -1 : 1) : a.first.native ? -1 : 1);
  const sorted = [...byKey.values()].sort((a, b) => a.first.order - b.first.order || (a.first.order === 1 ? outRank(a, b) : a.index - b.index));
  const slots = sorted.length <= MAX_GROUP_LINES ? sorted.length : MAX_GROUP_LINES - 1;
  const visible = sorted.slice(0, slots);
  const hidden = sorted.slice(slots);
  // The largest amount to someone else is always in a line. Room for it comes from the lowest-priority visible group
  // that isn't a control change or a grant (the rest, then moves to the user's own account, then calls); only when
  // every visible line is a control change does the last one give way, and then it is named in its own red bullet
  // (below), as every left-out control change, grant and value to someone else is.
  const topOut = sorted.find((g) => g.first.order === 1);
  if (topOut && hidden.includes(topOut)) {
    const protectedOrder = (o: number) => o === 0 || o === 2;
    let at = -1;
    for (let i = visible.length - 1; i >= 0 && at < 0; i--) if (!protectedOrder((visible[i] as StepGroup).first.order)) at = i;
    if (at < 0) for (let i = visible.length - 1; i >= 0 && at < 0; i--) if ((visible[i] as StepGroup).first.order === 0) at = i;
    if (at >= 0) {
      hidden.splice(hidden.indexOf(topOut), 1, visible[at] as StepGroup);
      visible[at] = topOut;
      visible.sort((a, b) => sorted.indexOf(a) - sorted.indexOf(b));
    }
  }
  const line = (g: StepGroup): SummaryText => capitalised(g.count === 1 ? g.first.text : g.first.many ? g.first.many(g.count, g.sum) : [`${g.count} times: `, ...g.first.text]);
  const lines = visible.map(line);
  // A grouped line names its steps whole (the group's key holds everything the line says), so they count as shown.
  const shown = visible.flatMap((g) => g.members);
  if (hidden.length === 0) return { lines, hidden: 0, hiddenRisk: null, leftOut: [], shown };
  const n = hidden.reduce((t, g) => t + g.count, 0);
  lines.push([`…and ${n} more ${n === 1 ? 'step' : 'steps'} (in the details).`]);
  // Each left-out control change, grant and value to someone else: its own red bullet, naming who or what.
  const leftOut: SummaryWarning[] = hidden
    .filter((g) => g.first.order <= 2)
    .map((g) => {
      const named = g.first.label ? (g.count > 1 ? [...capitalised(g.first.label), ` (${g.count} times)`] : capitalised(g.first.label)) : line(g);
      // In full: a key, signer or recipient is never cut where nothing else on the screen shows it.
      return { level: 'danger', code: 'step_left_out', text: sentence(['Not listed above: ', ...named]), short: named };
    });
  return { lines, hidden: n, hiddenRisk: hidden.some((g) => g.first.order <= 4 && g.first.value) ? 'danger' : 'warning', leftOut, shown };
}

/** The grouping of one Stellar operation. `suffix`: what the line says about another source account. */
function stellarStep(op: StellarOperation, text: SummaryText, me: string, txSource: string, suffix: SummaryText): Step {
  const value = stellarMovesValue(op);
  // Grouped only with identical operations (the same XDR, its source included): the same line, nothing hidden.
  const by = (order: number): Step => ({ ...sameText(text, value, order), key: op.xdr });
  const coin = (amount: bigint): Step => ({ ...by(1), sum: amount, native: true });
  switch (op.type) {
    case 'payment': {
      const src = op.source ?? txSource;
      return {
        text,
        value,
        key: `pay|${src}|${op.destination}|${op.asset}`,
        order: isMeStellar(op.destination, me) ? 5 : 1,
        sum: BigInt(op.amount),
        native: op.asset === 'native',
        many: (n, sum) => ['send ', ...stellarAmount(sum, op.asset), ' to ', ...stellarWho(op.destination, me), ` in ${n} payments`, ...suffix],
      };
    }
    case 'accountMerge':
      return by(0);
    case 'setOptions':
      return by(value ? 0 : 6);
    // Value to others carries its native-coin amount, so the largest of them ranks first (identical operations
    // group, so the group's sum is the count times it).
    case 'createAccount':
      return coin(BigInt(op.startingBalance));
    case 'pathPaymentStrictReceive':
      return op.sendAsset === 'native' ? coin(BigInt(op.sendMax)) : by(1);
    case 'pathPaymentStrictSend':
      return op.sendAsset === 'native' ? coin(BigInt(op.sendAmount)) : by(1);
    case 'createClaimableBalance':
      return op.asset === 'native' ? coin(BigInt(op.amount)) : by(1);
    case 'liquidityPoolDeposit':
      return by(1);
    case 'manageSellOffer':
    case 'createPassiveSellOffer':
      return !value ? by(6) : op.selling === 'native' ? coin(BigInt(op.amount)) : by(1);
    case 'manageBuyOffer': {
      if (!value) return by(6);
      const most = op.selling === 'native' ? times(op.buyAmount, op.price.n, op.price.d, 'up') : null;
      return most !== null ? coin(most) : by(1);
    }
    case 'invokeHostFunction': {
      const f = op.hostFunction;
      if (f.type === 'invokeContract' && f.function === 'approve') return by(2);
      if (f.type === 'invokeContract' && f.function === 'transfer') return by(1);
      return by(3);
    }
    default:
      return by(value ? 4 : 6);
  }
}

/** At most MAX_SUMMARY_STEPS extra lines, then "…and N more". */
function capped(lines: readonly SummaryText[]): { lines: SummaryText[]; capped: boolean } {
  if (lines.length <= MAX_SUMMARY_STEPS) return { lines: [...lines], capped: false };
  return { lines: [...lines.slice(0, MAX_SUMMARY_STEPS), [`…and ${lines.length - MAX_SUMMARY_STEPS} more (in the details).`]], capped: true };
}

/** Whether a Stellar operation moves or grants value, or changes who controls an account: always listed. */
function stellarMovesValue(op: StellarOperation): boolean {
  switch (op.type) {
    case 'payment':
    case 'createAccount':
    case 'pathPaymentStrictReceive':
    case 'pathPaymentStrictSend':
    case 'accountMerge':
    case 'createClaimableBalance':
    case 'clawback':
    case 'liquidityPoolDeposit':
    case 'liquidityPoolWithdraw':
    case 'invokeHostFunction':
    case 'beginSponsoringFutureReserves':
    case 'revokeSponsorship':
    case 'changeTrust':
    case 'claimClaimableBalance':
    case 'clawbackClaimableBalance':
      return true;
    case 'manageSellOffer':
    case 'createPassiveSellOffer':
      return op.amount !== '0';
    case 'manageBuyOffer':
      return op.buyAmount !== '0';
    case 'setOptions':
      return op.signer !== null || op.masterWeight !== null || op.lowThreshold !== null || op.medThreshold !== null || op.highThreshold !== null;
    // Deliberately neutral (D813): none moves or grants the user's value. A sequence bump, a data entry (its small
    // reserve aside), inflation (a no-op), keeping or restoring contract data (their cost is the network fee), ending
    // a sponsorship begun in the same transaction (its begin is listed), and an issuer's trust-line authorization of
    // someone else's holding.
    case 'bumpSequence':
    case 'manageData':
    case 'inflation':
    case 'extendFootprintTtl':
    case 'restoreFootprint':
    case 'endSponsoringFutureReserves':
    case 'allowTrust':
    case 'setTrustLineFlags':
      return false;
  }
}

/**
 * The XLM a transaction can take from the user's account, as NEAR's total does: payments, account creation, a path
 * payment's most paid, an offer selling XLM (a buy offer's most paid), a claimable balance; a merge takes all of it.
 * Contract calls and pool deposits can take more, which the line says. Null when no step on the user's account moves
 * value.
 */
function xlmLeaving(tx: { readonly source: string; readonly operations: readonly StellarOperation[] }, me: string): SummaryText | null {
  let total = 0n;
  let any = false;
  let more = false;
  let all = false;
  for (const op of tx.operations) {
    if (!isMeStellar(op.source ?? tx.source, me) || !stellarMovesValue(op)) continue;
    any = true;
    switch (op.type) {
      case 'payment':
        if (op.asset === 'native') total += BigInt(op.amount);
        break;
      case 'createAccount':
        total += BigInt(op.startingBalance);
        break;
      case 'pathPaymentStrictReceive':
        if (op.sendAsset === 'native') total += BigInt(op.sendMax);
        break;
      case 'pathPaymentStrictSend':
        if (op.sendAsset === 'native') total += BigInt(op.sendAmount);
        break;
      case 'manageSellOffer':
      case 'createPassiveSellOffer':
        if (op.selling === 'native') total += BigInt(op.amount);
        break;
      case 'manageBuyOffer': {
        if (op.selling !== 'native') break;
        const most = times(op.buyAmount, op.price.n, op.price.d, 'up');
        if (most === null) more = true;
        else total += most;
        break;
      }
      case 'createClaimableBalance':
        if (op.asset === 'native') total += BigInt(op.amount);
        break;
      case 'accountMerge':
        all = true;
        break;
      case 'invokeHostFunction':
      case 'liquidityPoolDeposit':
        more = true;
        break;
      default:
        break;
    }
  }
  if (!any || (total === 0n && !all)) return null;
  if (all) return ['XLM leaving your account: ', strong('all of it (the account is closed)'), '.'];
  return ['XLM leaving your account: ', ...upTo(xlm(total)), more ? ', plus what its programs or pool deposits take' : '', ', plus the network fee.'];
}

function stellarTx(decoded: Extract<DecodedApproval, { kind: 'stellar_tx' }>, me: string): ApprovalSummary {
  const warnings: SummaryWarning[] = [];
  const notes: TokenNotes = { passphrase: decoded.networkPassphrase, lines: [], warnings };
  const s = withTokenNotes(notes, () => stellarTxWith(decoded, me, warnings));
  // The token lines (D860) after the request's own lines.
  return notes.lines.length === 0 ? s : { ...s, lines: [...s.lines, ...notes.lines] };
}

function stellarTxWith(decoded: Extract<DecodedApproval, { kind: 'stellar_tx' }>, me: string, warnings: SummaryWarning[]): ApprovalSummary {
  const env = decoded.envelope;
  const tx = env.tx;
  const extra: SummaryText[] = [];
  const ops = tx.operations.map((op) => {
    const o = stellarOp(decoded.networkPassphrase, op, me, warnings, extra);
    // An operation on another account than the transaction's says so in its own line.
    const suffix: SummaryText = op.source === null || op.source === tx.source ? [] : [' (on ', ...(isMeStellar(op.source, me) ? stellarWho(op.source, me) : ['the account ', code(op.source, 'account')]), ')'];
    const text: SummaryText = [...o.text, ...suffix];
    return { ...o, text, step: stellarStep(op, text, me, tx.source, suffix) };
  });
  let explainable = ops.every((o) => o.explainable);
  let risk: RiskLevel | null = null;
  for (const o of ops) if (!o.explainable) risk = worse(risk, o.risk ?? 'warning');
  let hidden: { n: number; risk: RiskLevel } | null = null;
  const lines: SummaryText[] = [];
  let headline: SummaryText;
  // The steps whose own line is in view (the headline of a single step counts as its line).
  let shownSteps: number[] = [];
  if (ops.length === 1) {
    headline = [APP, ' wants to ', ...(ops[0] as OpSummary).text];
    shownSteps = [0];
  } else {
    headline = [APP, ` wants to do ${ops.length} things at once on Stellar`];
    const g = groupSteps(ops.map((o) => o.step));
    shownSteps = g.shown;
    lines.push(...g.lines);
    warnings.push(...g.leftOut);
    if (g.hiddenRisk) {
      explainable = false;
      hidden = { n: g.hidden, risk: g.hiddenRisk };
    }
  }
  const leaving = xlmLeaving(tx, me);
  if (leaving) lines.unshift(leaving);
  const more = capped(extra);
  lines.push(...more.lines);
  if (more.capped) {
    explainable = false;
    risk = 'danger';
  }
  if (tx.source !== me) lines.push(isMeStellar(tx.source, me) ? ['It is sent from ', ...stellarWho(tx.source, me, 'from'), '.'] : ['It is sent from the account ', code(tx.source, 'from'), '.']);
  if (env.envelope === 'fee_bump') lines.push(isMeStellar(env.feeSource, me) ? ['Your account pays the network fee for something sent from ', ...stellarWho(tx.source, me, 'from'), '.'] : ['The network fee is paid by ', code(env.feeSource, 'payer'), ', not your account.']);
  if (risk) warnings.unshift(cannotTell(risk, ops.length > 1 ? 'Journear can’t read part of it' : undefined));
  if (hidden) warnings.push(stepsNotListed(ops.length, hidden.n, hidden.risk));
  const feeStroops = env.envelope === 'fee_bump' ? env.fee : tx.fee;
  return {
    headline,
    lines,
    fee: env.envelope === 'fee_bump' && !isMeStellar(env.feeSource, me) ? null : upTo(xlm(feeStroops)),
    network: stellarNetwork(decoded.networkPassphrase),
    warnings,
    explainable,
    shownSteps,
  };
}

function stellarAuth(decoded: Extract<DecodedApproval, { kind: 'stellar_auth_entry' }>, me: string): ApprovalSummary {
  const warnings: SummaryWarning[] = [];
  const notes: TokenNotes = { passphrase: decoded.networkPassphrase, lines: [], warnings };
  const s = withTokenNotes(notes, () => stellarAuthWith(decoded, me, warnings));
  return notes.lines.length === 0 ? s : { ...s, lines: [...s.lines, ...notes.lines] };
}

function stellarAuthWith(decoded: Extract<DecodedApproval, { kind: 'stellar_auth_entry' }>, me: string, warnings: SummaryWarning[]): ApprovalSummary {
  const extra: SummaryText[] = [];
  const inv = decoded.preimage.invocation;
  const f = inv.function;
  const root = f.type === 'contractFn' ? sorobanTokenCall(decoded.networkPassphrase, f, me, warnings, 'authorize') : null;
  // Explained only when the entry authorizes one token call and nothing under it.
  let explainable = root !== null && inv.subInvocations.length === 0;
  for (const s of inv.subInvocations) otherAuthorizations(decoded.networkPassphrase, s, me, warnings, extra);
  const more = capped(extra);
  if (more.capped) explainable = false;
  const what: SummaryText = root ?? (f.type === 'contractFn' ? ['approve using the program ', code(f.contract, 'program'), ' (', code(f.function), ')'] : ['approve creating a program']);
  if (!explainable) warnings.unshift(cannotTell('danger', 'it approves an action Journear can’t read'));
  return { headline: [APP, ' wants to ', ...what], lines: more.lines, fee: null, network: stellarNetwork(decoded.networkPassphrase), warnings, explainable };
}

// ---- NEAR ----

/** Strict JSON object arguments, or null. */
function jsonArgs(args: Uint8Array): Record<string, unknown> | null {
  try {
    const v = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(args));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isAmount = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/u.test(v);
const isTokenId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128 && isDisplaySafeLine(v);
const nearWho = (account: string, me: string, role: IdRole = 'to'): SummaryText => (account === me ? ['your account'] : [code(account, role)]);

/** The NEAR token standards' value-moving methods the summary reads (NEP-141, NEP-171, NEP-178). */
const NEAR_STANDARD_METHODS: ReadonlySet<string> = new Set(['ft_transfer', 'ft_transfer_call', 'nft_transfer', 'nft_transfer_call', 'nft_approve']);

const hasOnly = (args: StrictJsonObject, keys: readonly string[]): boolean => Object.keys(args).every((k) => keys.includes(k));
const optText = (args: StrictJsonObject, k: string): boolean => !Object.hasOwn(args, k) || args[k] === null || typeof args[k] === 'string';
const isNearAccount = (v: unknown): v is string => typeof v === 'string' && isNearAccountId(v);
const isU64 = (v: unknown): boolean => v instanceof JsonNumber && /^(0|[1-9][0-9]{0,19})$/u.test(v.raw) && BigInt(v.raw) < 2n ** 64n;

/**
 * Whether a standard method's arguments have exactly the standard's shape: its keys and no others, each of its type
 * (an amount a canonical decimal string, an account a valid account id, a memo or message a string). Anything else is
 * read by the contract in a way the summary can't vouch for (a number amount, leading zeros or spaces, another key):
 * the request isn't explained, so its line can never be a plain one without the amount.
 */
function nearStandardShape(method: string, args: StrictJsonObject): boolean {
  switch (method) {
    case 'ft_transfer':
    case 'ft_transfer_call':
      return (
        hasOnly(args, method === 'ft_transfer' ? ['receiver_id', 'amount', 'memo'] : ['receiver_id', 'amount', 'memo', 'msg']) &&
        isNearAccount(args.receiver_id) &&
        isAmount(args.amount) &&
        optText(args, 'memo') &&
        (method === 'ft_transfer' || typeof args.msg === 'string')
      );
    case 'nft_transfer':
    case 'nft_transfer_call':
      return (
        hasOnly(args, method === 'nft_transfer' ? ['receiver_id', 'token_id', 'approval_id', 'memo'] : ['receiver_id', 'token_id', 'approval_id', 'memo', 'msg']) &&
        isNearAccount(args.receiver_id) &&
        isTokenId(args.token_id) &&
        (!Object.hasOwn(args, 'approval_id') || args.approval_id === null || isU64(args.approval_id)) &&
        optText(args, 'memo') &&
        (method === 'nft_transfer' || typeof args.msg === 'string')
      );
    case 'nft_approve':
      return hasOnly(args, ['token_id', 'account_id', 'msg']) && isNearAccount(args.account_id) && isTokenId(args.token_id) && optText(args, 'msg');
    default:
      return false;
  }
}

/**
 * A method name that says the call may move what the user holds with the contract: transfer, withdraw (so
 * `storage_withdraw`), approve, send, swap, execute, burn, remove_liquidity, unwrap, claim, redeem or stake (so
 * `unstake`) anywhere in it, and the multi-token standard's `mt_*` methods.
 */
export const NEAR_VALUE_METHOD = /transfer|withdraw|approve|send|swap|execute|burn|remove_liquidity|unwrap|claim|redeem|stake|^mt_/iu;
/** Read-style names (`get_stake`, `view_claimable`, `is_approved`): a view call, never warned about. */
const NEAR_READ_METHOD = /^(get|view|is|has)_/iu;

/** Whether a NEAR call Journear doesn't recognise gets the amber "may move tokens" line. */
export const nearMayMoveValue = (method: string): boolean => NEAR_VALUE_METHOD.test(method) && !NEAR_READ_METHOD.test(method);

const pushOnce = (warnings: SummaryWarning[], w: SummaryWarning): void => {
  const key = JSON.stringify(w.text);
  if (!warnings.some((x) => JSON.stringify(x.text) === key)) warnings.push(w);
};

/** What one NEAR action does, in a few words, whether Journear can say that, and how it groups with others. */
function nearAction(a: NearAction, receiver: string, me: string, warnings: SummaryWarning[], network: 'testnet' | 'mainnet', notes: SummaryText[], transfersOf: (token: string) => number): { text: SummaryText; explainable: boolean; step: Step } {
  // The account the actions run on: a program for a call, a recipient for a transfer, the account for key changes.
  const where = nearWho(receiver, me, a.type === 'transfer' ? 'to' : a.type === 'functionCall' ? 'program' : 'account');
  const value = nearMovesValue(a);
  // Grouped only with actions whose line reads the same and whose `extra` (what the line doesn't show) is equal too.
  const same = (text: SummaryText, order: number, explainable = true, extra = '', label?: SummaryText) => ({ text, explainable, step: { ...sameText(text, value, order), key: `${JSON.stringify(text)}|${extra}`, ...(label ? { label } : {}) } });
  switch (a.type) {
    case 'transfer': {
      const text: SummaryText = ['send ', strong(nearDisplay(a.deposit)), ' to ', ...where];
      return { text, explainable: true, step: { text, value, key: `transfer|${receiver}`, order: receiver === me ? 5 : 1, sum: a.deposit, native: true, many: (n, sum) => ['send NEAR to ', ...where, `, ${n} times (`, strong(nearDisplay(sum)), ' in total)'] } };
    }
    case 'functionCall': {
      const m = nearMethodName(a.methodName);
      if (m.text === null) return same(['use ', ...where, ' in a way Journear can’t show'], 3, false, m.hex);
      const method = m.text;
      const args = a.args.length === 0 ? {} : jsonArgs(a.args);
      if (args === null) return same(['use ', ...where, ' (', code(method), ') with information Journear can’t read'], 3, false, toHex(a.args));
      // A standard value-moving method whose arguments aren't exactly the standard's: the contract may read them
      // leniently and move tokens, so it is never a plain "use …" line: red, named, not explained.
      if (NEAR_STANDARD_METHODS.has(method) && !nearStandardShape(method, args as StrictJsonObject)) {
        pushOnce(warnings, cannotCheck('danger', 'cannot_explain', ['it uses ', code(method), ' on ', code(receiver, 'program'), ' in a non-standard way'], 'It could take your money or tokens.', ['Journear can’t check ', code(method), ' on ', code(receiver, 'program')]));
        return same(['use ', ...where, ' (', code(method), ') in a non-standard way'], 3, false, toHex(a.args));
      }
      // NEP-141 fungible tokens and NEP-171/178 NFTs: their methods' meaning is the standard's (the contract can still lie).
      if ((method === 'ft_transfer' || method === 'ft_transfer_call') && typeof args.receiver_id === 'string' && isNearAccountId(args.receiver_id) && isAmount(args.amount)) {
        const to = args.receiver_id;
        // D860: a listed token by its symbol and decimals (Journear's list, never the contract's own metadata).
        const token = knownNearToken(network, receiver);
        const sent = (n: bigint): SummaryText => (token ? amountOf(n, token, to === me ? 'in' : 'out') : [strong(groupDigits(n.toString())), ` ${units(n)} of the unlisted token `, code(receiver, 'token')]);
        // One line per token: with its amount when the request moves it once, "these units" when more often.
        noteOnce(notes, token ? realTokenLine(receiver, token) : unlistedLine(transfersOf(receiver) > 1 ? null : BigInt(args.amount), receiver));
        const text: SummaryText = ['send ', ...sent(BigInt(args.amount)), ' to ', ...nearWho(to, me)];
        return {
          text,
          explainable: true,
          step: { text, value, key: `ft|${receiver}|${method}|${to}`, order: to === me ? 5 : 1, sum: BigInt(args.amount), many: (n, sum) => ['send ', ...sent(sum), ' to ', ...nearWho(to, me), ` in ${n} transfers`] },
        };
      }
      if ((method === 'nft_transfer' || method === 'nft_transfer_call') && typeof args.receiver_id === 'string' && isNearAccountId(args.receiver_id) && isTokenId(args.token_id)) {
        return same(['send the collectible ', code(args.token_id), ' from ', code(receiver, 'collection'), ' to ', ...nearWho(args.receiver_id, me)], args.receiver_id === me ? 5 : 1);
      }
      if (method === 'nft_approve' && typeof args.account_id === 'string' && isNearAccountId(args.account_id) && isTokenId(args.token_id)) {
        warnings.push({ level: 'warning', code: 'spend_permission', text: ['This lets ', code(args.account_id, 'spender'), ' take your collectible ', code(args.token_id), ' from ', code(receiver, 'collection'), '. The permission lasts until they’ve used it or you cancel it elsewhere.'], short: ['Lets ', code(args.account_id, 'spender'), ' take your collectible ', code(args.token_id)] });
        return same(['let ', code(args.account_id, 'spender'), ' take your collectible ', code(args.token_id), ' from ', code(receiver, 'collection')], 2, true, args.account_id);
      }
      const text: SummaryText = ['use ', ...where, ' (', code(method), ')'];
      // A call Journear doesn't recognise stays explained (D810: it names the contract and the method), but one whose
      // name says it may move value gets an amber line: the contract may move what the user holds with it.
      if (nearMayMoveValue(method)) {
        pushOnce(warnings, {
          level: 'warning',
          code: 'may_move_tokens',
          text: ['This uses ', code(receiver, 'program'), ' (', code(method), '). It may move tokens or NEAR you keep with ', code(receiver, 'program'), '. ', ...RISK_END.warning],
          short: ['May move tokens you keep with ', code(receiver, 'program'), ' (', code(method), ')'],
        });
      }
      return {
        text,
        explainable: true,
        step: { text, value, key: `call|${receiver}|${method}`, order: 3, sum: a.deposit, many: (n, sum) => ['use ', ...where, ' (', code(method), `), ${n} times`, ...(sum > 0n ? [' (attaching ', strong(nearDisplay(sum)), ' in total)'] : [])] },
      };
    }
    case 'createAccount':
      return same(['create the account ', code(receiver, 'account')], 6);
    case 'deployContract':
      return same(['put a program on ', ...where], 0, true, nearCodeHash(a.code));
    case 'stake':
      return same(['lock up ', strong(nearDisplay(a.stake)), ' for staking'], 4, true, nearKeyText(a.publicKey));
    case 'addKey':
      // The whole key, in the line: a cut key could be ground to look like one the user expects.
      if (a.accessKey.permission.type === 'fullAccess') return same(['give full control of ', ...where, ' to another key, ', code(nearKeyText(a.publicKey), 'key')], 0, true);
      // A function-call key spends the account's NEAR on its calls' fees, up to its allowance: said in view.
      return same(
        ['let another device or app act for ', ...(receiver === me ? ['you'] : where), ' on ', code(a.accessKey.permission.receiverId, 'program'), ' without asking (key ', code(nearKeyText(a.publicKey), 'key'), ')', ...(a.accessKey.permission.allowance === null ? [', with no limit on the NEAR it spends on fees'] : [', spending up to ', strong(nearDisplay(a.accessKey.permission.allowance)), ' on fees'])],
        0,
        true,
        a.accessKey.permission.methodNames.join(','),
      );
    case 'deleteKey':
      return same(['remove the key ', code(nearKeyText(a.publicKey), 'key'), ' from ', ...where], 0, true);
    case 'deleteAccount':
      return same(['delete ', ...where, ' and send all its NEAR to ', code(a.beneficiaryId, 'to')], 0);
    case 'deployGlobalContract':
      return same(['publish a shared program'], 1, true, nearCodeHash(a.code));
    case 'useGlobalContract':
      return same(['put the shared program ', code(a.contract.type === 'codeHash' ? nearHash58(a.contract.hash) : a.contract.accountId, 'program'), ' on ', ...where], 0, true);
    case 'delegate':
      // Never shown: decodeApprovalRequest refuses a transaction that relays a delegate action.
      return same(['send someone else’s request'], 3, false);
  }
}

/** Whether a NEAR action moves or grants value, or changes who controls the account: always listed. */
function nearMovesValue(a: NearAction): boolean {
  switch (a.type) {
    case 'transfer':
    case 'stake':
    case 'addKey':
    case 'deleteKey':
    case 'deleteAccount':
    case 'deployContract':
    case 'deployGlobalContract':
    case 'useGlobalContract':
    case 'delegate':
      return true;
    case 'functionCall':
      // Any call: one with no deposit can still move tokens the account holds in that contract.
      return true;
    case 'createAccount':
      return false;
  }
}

/**
 * The fee row of a relayed NEAR action. It speaks about the fee only, never about what
 * the action costs. Never "Journear pays": a partner may relay it itself.
 */
export const RELAYED_FEE: SummaryText = Object.freeze(['free for you. Someone else pays it.']) as SummaryText;

/**
 * The risk that a relayed call acts as the user (it was half of the blue relayer note): the contract it calls can
 * use anything the user keeps with it. Amber, named by the receiver (an account id the decoder checked).
 */
export const actsAsYou = (receiver: string): SummaryWarning => ({
  level: 'warning',
  code: 'acts_as_you',
  text: ['This acts as you: ', code(receiver, 'program'), ' can use anything you keep with it.'],
  short: ['Acts as you with ', code(receiver, 'program')],
});

function nearActions(actions: readonly NearAction[], receiver: string, me: string, relayed: boolean, network: 'testnet' | 'mainnet'): ApprovalSummary {
  const warnings: SummaryWarning[] = [];
  const notes: SummaryText[] = [];
  // How many token transfers the request makes (a NEAR transaction has one receiver: the token, for ft_transfer).
  const ftCount = actions.filter((a) => a.type === 'functionCall' && (a.methodName === 'ft_transfer' || a.methodName === 'ft_transfer_call')).length;
  const done = actions.map((a) => nearAction(a, receiver, me, warnings, network, notes, () => ftCount));
  let explainable = done.every((x) => x.explainable);
  const unreadable = !explainable;
  let hidden: { n: number; risk: RiskLevel } | null = null;
  const lines: SummaryText[] = [];
  let headline: SummaryText;
  const transfers = actions.length > 0 && actions.every((a) => a.type === 'transfer');
  // The steps whose own line is in view (the headline of a single action counts as its line).
  let shownSteps: number[] = done.length === 1 ? [0] : [];
  if (transfers && actions.length > 1) {
    headline = [APP, ' wants to send ', strong(nearDisplay(actions.reduce((n, a) => n + (a.type === 'transfer' ? a.deposit : 0n), 0n))), ' to ', ...nearWho(receiver, me, 'to'), ` in ${actions.length} transfers`];
  } else if (done.length === 1) headline = [APP, ' wants to ', ...(done[0] as { text: SummaryText }).text];
  else {
    headline = [APP, ` wants to do ${done.length} things with `, ...nearWho(receiver, me, 'account'), ' at once'];
    const g = groupSteps(done.map((x) => x.step));
    shownSteps = g.shown;
    lines.push(...g.lines);
    warnings.push(...g.leftOut);
    if (g.hiddenRisk) {
      explainable = false;
      hidden = { n: g.hidden, risk: g.hiddenRisk };
    }
  }
  // A call Journear can't read (its arguments or its name) could move tokens with no visible bound.
  // The generic red line, unless an action already said in red what Journear can't read (a malformed standard call).
  if (unreadable && !warnings.some((w) => w.code === 'cannot_explain')) warnings.unshift(cannotTell('danger'));
  if (hidden) warnings.push(stepsNotListed(done.length, hidden.n, hidden.risk));
  // D858: no NEAR of the user's leaves, and no token move Journear can see, when every action is a transfer (the
  // relayer's NEAR, nearcore) or a plain call Journear reads as "use {contract} ({method})" on another account, every
  // step is in a line, and no line warns of anything. Then the page drops only the repeated "None of your NEAR" row;
  // anything else keeps the "NEAR leaving your account" row as decided (D723, D729). Never a claim that it costs
  // nothing: a call can still use what the user keeps with the contract (the amber acts-as-you line).
  const noNearLeaves =
    relayed &&
    receiver !== me &&
    warnings.length === 0 &&
    explainable &&
    actions.every((a, i) => a.type === 'transfer' || (a.type === 'functionCall' && (done[i] as { step: Step }).step.order === 3));
  if (relayed && receiver !== me && actions.some((a) => a.type === 'functionCall')) warnings.push(actsAsYou(receiver));
  return {
    headline,
    // The token lines (D860) after the grouped lines.
    lines: [...lines, ...notes],
    fee: relayed ? RELAYED_FEE : ['a small amount of NEAR, from your account'],
    network: null,
    ...(noNearLeaves ? { noNearLeaves: true as const } : {}),
    warnings,
    explainable,
    shownSteps,
  };
}

// ---- the entry point ----

/** What a request gets when building its summary fails: Journear can't explain it, and its details start open. */
export const UNEXPLAINED_SUMMARY: ApprovalSummary = Object.freeze({
  headline: [APP, ' wants you to approve something Journear can’t read'],
  lines: [],
  fee: null,
  network: null,
  warnings: [cannotCheck('danger', 'summary_failed', 'it couldn’t read this request', 'It could take your money or tokens.', ['Journear couldn’t read this request'])],
  explainable: false,
}) as ApprovalSummary;

/**
 * The plain summary of a request the popup decoded itself. Pure and total: any error while building it (a value no
 * decoder should let through) gives UNEXPLAINED_SUMMARY, never a throw.
 */
export function summarizeApproval(decoded: DecodedApproval, ctx: SummaryContext): ApprovalSummary {
  try {
    return summarize(decoded, ctx);
  } catch {
    return UNEXPLAINED_SUMMARY;
  }
}

function summarize(decoded: DecodedApproval, ctx: SummaryContext): ApprovalSummary {
  switch (decoded.kind) {
    case 'evm_tx':
      return evmTx(decoded.chainId, decoded.tx, ctx.address);
    case 'evm_sponsored':
      return sponsoredAction(decoded, ctx.address);
    case 'eip712':
      return typedData(decoded, ctx.address);
    case 'personal_sign':
    case 'stellar_message':
      return message(decoded.kind, decoded.message.text, ctx);
    case 'stellar_tx':
      return stellarTx(decoded, ctx.address);
    case 'stellar_auth_entry':
      return stellarAuth(decoded, ctx.address);
    case 'raw':
      return {
        headline: [APP, ' wants you to sign something Journear can’t read'],
        lines: [],
        fee: null,
        network: null,
        warnings: [{ level: 'danger', code: 'raw_signing', short: ['Asks you to sign something Journear can’t read'], text: ['Signing this could hand over your whole account and everything in it. Reject it unless you know exactly why you’re signing.'] }],
        explainable: false,
      };
    case 'near_tx':
      return nearActions(decoded.tx.actions, decoded.tx.receiverId, decoded.tx.signerId, false, decoded.network);
    case 'near_delegate':
      return nearActions(decoded.delegate.actions, decoded.delegate.receiverId, decoded.delegate.senderId, true, decoded.network);
    case 'near_message': {
      const readable = decoded.message.text !== null;
      return {
        headline: [APP, ' wants you to sign a message for ', code(decoded.payload.recipient)],
        lines: [],
        fee: null,
        network: null,
        warnings: readable ? [] : [unreadableMessage()],
        explainable: readable,
      };
    }
  }
}

/** A summary text as one string, with `appName` in place of the app part (tests, logs of the page's own text). */
export const summaryString = (t: SummaryText, appName: string): string => t.map((p) => (typeof p === 'string' ? p : p.kind === 'app' ? appName : p.text)).join('');
