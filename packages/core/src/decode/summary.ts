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
// Token amounts: only a token on the pinned, reviewed list (MAINNET_DEMO: USDC and EURC on Base, XLM, USDC and EURC
// on Stellar's public network) gets a symbol and decimals. Any other token's amount is shown as it is signed, in its
// smallest units, and called "tokens of contract …": a contract's own symbol() or decimals() is the contract's claim.
import { isDisplaySafeLine } from '../display-safe.ts';
import { toHex } from '../bytes.ts';
import { MAINNET_DEMO } from '../mainnet-demo.ts';
import { STELLAR_MAINNET_PASSPHRASE, evmChainInfo } from '../networks.ts';
import type { NearAction } from '../near/codec.ts';
import { isNearAccountId } from '../addresses.ts';
import { type ContractChain, STELLAR_TESTNET_PASSPHRASE, verifiedContract } from '../verified-contracts.ts';
import type { AbiValue } from './abi.ts';
import type { DecodedApproval } from './request.ts';
import type { DecodedEvmTx } from './evm.ts';
import { parseStrictJson } from './json.ts';
import { nearCodeHash, nearHash58, nearKeyText, nearMethodName } from './near.ts';
import { MuxedAccount } from '@stellar/stellar-base';
import type { StellarContractCall, StellarInvocation, StellarOperation, StellarScVal } from './stellar.ts';
import type { TypedDataStruct, TypedDataValue } from '../typed-data.ts';

/**
 * One piece of a summary's text: plain words, the requesting app's name (filled in by the page from the vault's app
 * name), a value shown as code (an address, an account id, a contract), or a value in bold (a verified contract's name).
 */
export type SummaryPart = string | { readonly kind: 'app' } | { readonly kind: 'code'; readonly text: string } | { readonly kind: 'strong'; readonly text: string };
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
  /** Raw signing: Journear can't read what is signed at all. */
  | 'raw_signing';

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
  /** The network the request is bound to, as a value ("Sepolia (testnet)"), when the request names one. NEAR's line is the page's. */
  readonly network: SummaryText | null;
  readonly warnings: readonly SummaryWarning[];
  /** False when Journear can't say what the request does: a risk warning says so (the details still start folded). */
  readonly explainable: boolean;
}

export interface SummaryContext {
  /** The user's own address on the request's chain (the vault's: EIP-55, G… StrKey or the NEAR implicit account id). */
  readonly address: string;
  /** The partner page's origin, as the vault pinned it (a sign-in message's domain is compared with its host). */
  readonly parentOrigin?: string;
}

const APP = { kind: 'app' } as const;
const code = (text: string): SummaryPart => ({ kind: 'code', text });
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

/** A summary text with every code part cut by shortId (a bullet's form). */
export const shortCodes = (t: SummaryText): SummaryText => t.map((p) => (typeof p !== 'string' && p.kind === 'code' ? code(shortId(p.text)) : p));

/** Who a spender is, in a bullet: a verified contract by name, else its address. */
const spenderShort = (t: SummaryText): SummaryText => {
  const named = t.find((p) => typeof p !== 'string' && p.kind === 'strong');
  if (named) return [named];
  const c = t.find((p) => typeof p !== 'string' && p.kind === 'code');
  return c ? [c] : t;
};

/** How strong a risk line is: red where the unreadable part could move value or control with no visible bound. */
export type RiskLevel = 'danger' | 'warning';

/** The risk line of a request Journear can't explain, written for someone who doesn't know Web3. */
export const cannotTell = (level: RiskLevel, reason?: string): SummaryWarning => ({
  level,
  code: 'cannot_explain',
  text: [`Journear can’t tell what this request does${reason ? `: ${reason}` : ''}. It could move your money or tokens. Only approve if you fully trust `, APP, '. Technical details are below.'],
  short: [reason ? `Journear can’t tell what it does: ${reason}` : 'Journear can’t tell what it does'],
});

/** A message Journear can't read (not plain text): it can't say what signing it does. */
const unreadableMessage = (): SummaryWarning => ({ level: 'warning', code: 'cannot_explain', text: ['Journear can’t read this message, so it can’t tell what signing it does. Only approve if you fully trust ', APP, '. Technical details are below.'], short: ['Journear can’t read the message'] });

/**
 * Steps the summary's lines leave out: red when any of them moves or grants value or changes control, amber
 * otherwise. `n` is how many steps the request has; `hidden` how many aren't in a line.
 */
const stepsNotListed = (n: number, hidden: number, level: RiskLevel): SummaryWarning => ({
  level,
  code: 'steps_not_listed',
  text: [`This request does ${n} things at once and not all are listed here${level === 'danger' ? '; some of those left out move money or tokens or change who controls your account' : ''}. Only approve if you fully trust `, APP, '. Technical details are below.'],
  short: [`${hidden} other ${hidden === 1 ? 'step isn’t' : 'steps aren’t'} listed here${level === 'danger' ? ' (some move money or tokens)' : ''}`],
});

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

/** A token on the pinned list for this EVM chain, by address (any case), or null. */
export function knownEvmToken(chainId: number, address: string): KnownToken | null {
  const chain = (MAINNET_DEMO.evm as Readonly<Record<number, { tokens: Readonly<Record<string, KnownToken>> }>>)[chainId];
  if (!chain) return null;
  const a = address.toLowerCase();
  for (const [addr, t] of Object.entries(chain.tokens)) if (addr.toLowerCase() === a) return t;
  return null;
}

/** A Stellar asset contract on the pinned list (the public network only), by contract id, or null. */
export function knownStellarToken(networkPassphrase: string, contract: string): KnownToken | null {
  const s = MAINNET_DEMO.stellar;
  if (networkPassphrase !== s.networkPassphrase) return null;
  if (s.native.assetContract === contract) return s.native;
  for (const t of Object.values(s.assets)) if (t.assetContract === contract) return t;
  return null;
}

/** "5 USDC", or "1000 of the token’s smallest units" when the token isn't on the pinned list. */
function amountOf(amount: bigint, token: KnownToken | null, dir: AmountDirection = 'out'): SummaryText {
  return token ? [strong(`${displayUnits(amount, token.decimals, dir)} ${token.symbol}`)] : [strong(groupDigits(amount.toString())), ' in the token’s smallest units'];
}

/** Whether an allowance has no practical limit (see PRACTICALLY_UNLIMITED). */
const unlimited = (amount: bigint, token: KnownToken | null): boolean => amount >= PRACTICALLY_UNLIMITED || (token !== null && amount > PINNED_UNLIMITED_WHOLE * 10n ** BigInt(token.decimals));

/** "USDC", or "tokens of contract 0x…". */
function tokenName(contract: string, token: KnownToken | null): SummaryText {
  return token ? [token.symbol] : ['tokens of contract ', code(contract)];
}

/** For a pinned token named by its symbol: which contract that is, so the contract is always in view. */
const tokenContractLine = (contract: string, token: KnownToken): SummaryText => [`${token.symbol} here is the token contract `, code(contract), ', on Journear’s reviewed list.'];

/** Who would be allowed to spend: a verified contract by name, else its address, said to be unverified. */
function spenderOf(chain: ContractChain | null, address: string): SummaryText {
  const v = chain ? verifiedContract(chain, address) : null;
  if (v) return [strong(v.name), ' (', code(address), ', verified by Journear)'];
  if (ZERO_ADDRESS.test(address)) return [code(address), ' (the zero address)'];
  return [code(address), ', an address Journear hasn’t verified,'];
}

/**
 * The warning for a permission to spend the user's tokens (ERC-20 approve and increaseAllowance, EIP-2612 and Permit2
 * signatures, a Soroban token's approve). The caller handles 0 (a revoke: no warning). At or above
 * PRACTICALLY_UNLIMITED (or the type's max): the red "no limit" warning; below it, the amber one with the amount.
 * `nftToo`: ERC-20's and ERC-721's approve share one selector, so for a token Journear doesn't know the amount may be
 * an NFT's item number.
 */
function spendWarning(spender: SummaryText, contract: string, token: KnownToken | null, amount: bigint, typeMax: bigint, opts: { more?: boolean; nftToo?: boolean; via?: string; owner?: string } = {}): SummaryWarning {
  const via = opts.via ? ` ${opts.via}` : '';
  // `owner`: the tokens are someone else's (a Soroban approve `from` another account): never "your".
  const yours: SummaryText = opts.owner ? ['the ', ...tokenName(contract, token), ' held by ', code(opts.owner)] : token ? [`your ${token.symbol}`] : ['your tokens of contract ', code(contract)];
  if (unlimited(amount, token)) {
    const how = amount >= typeMax ? 'with no limit' : 'with no practical limit';
    return { level: 'danger', code: 'unlimited_spend', text: ['This lets ', ...spender, ' spend all of ', ...yours, via, `, ${how}, until you take the permission back. Approve only if you trust it completely.`], short: shortCodes(['Lets ', ...spenderShort(spender), ' spend all of ', ...yours, via]) };
  }
  const much: SummaryText = token && !opts.owner ? [strong(`${displayUnits(amount, token.decimals)} ${token.symbol}`), ' from your account'] : [strong(token ? displayUnits(amount, token.decimals) : groupDigits(amount.toString())), token ? ' of ' : ' (in the token’s smallest units) of ', ...yours];
  const nft = opts.nftToo && !token ? ` If the contract is an NFT collection, it lets them take your item ${amount} instead.` : '';
  return { level: 'warning', code: 'spend_permission', text: ['This lets ', ...spender, ` spend ${opts.more ? 'a further ' : 'up to '}`, ...much, via, `, until it is used up or you take the permission back.${nft}`], short: shortCodes(['Lets ', ...spenderShort(spender), ` spend ${opts.more ? 'a further ' : 'up to '}`, ...much, via]) };
}

// ---- EVM ----

const abiAddr = (v: AbiValue | undefined): string | null => (v?.kind === 'address' ? v.value : null);
const abiUint = (v: AbiValue | undefined): bigint | null => (v?.kind === 'uint' ? v.value : null);
const abiBool = (v: AbiValue | undefined): boolean | null => (v?.kind === 'bool' ? v.value : null);
const sameEvm = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function evmNative(chainId: number, wei: bigint): string {
  const info = evmChainInfo(chainId);
  return info ? `${displayUnits(wei, 18)} ${info.nativeSymbol}` : `${displayUnits(wei, 18)} of this chain’s coin`;
}

function evmNetwork(chainId: number): SummaryText {
  const info = evmChainInfo(chainId);
  return info ? [`${info.label}, chain ${chainId}`] : [`chain ${chainId}, which Journear doesn’t know by name`];
}

/** "your account" when `address` is the user's, else the address as code. */
const evmWho = (address: string, me: string): SummaryText => (sameEvm(address, me) ? ['your account'] : [code(address)]);

interface Draft {
  headline: SummaryText;
  lines: SummaryText[];
  warnings: SummaryWarning[];
  explainable: boolean;
}

function evmCall(chainId: number, tx: DecodedEvmTx, me: string): Draft {
  const to = tx.to as string;
  const chain: ContractChain = { kind: 'evm', chainId };
  const lines: SummaryText[] = [];
  const warnings: SummaryWarning[] = [];
  const contract = code(to);
  // What the call sends with it: in the headline of a generic call, a line of its own otherwise.
  const sending: SummaryText = tx.value > 0n ? [', sending it ', strong(evmNative(chainId, tx.value))] : [];
  const valueLine: SummaryText | null = tx.value > 0n ? ['It also sends ', strong(evmNative(chainId, tx.value)), ' to the contract.'] : null;
  const withoutValueLine = () => lines.filter((l) => l !== valueLine);
  const unknown = (reason: string): Draft => ({ headline: [APP, ' wants to use contract ', contract, ...sending], lines: withoutValueLine(), warnings: [cannotTell('danger', reason), ...warnings], explainable: false });
  if (valueLine) lines.push(valueLine);
  const call = tx.call;
  if (!call) return unknown(tx.selector ? 'it calls a function Journear doesn’t recognise' : 'it sends data Journear can’t read');
  const a = call.args;
  const token = knownEvmToken(chainId, to);
  if (token) lines.push(tokenContractLine(to, token));
  switch (call.signature) {
    case 'transfer(address,uint256)': {
      const recipient = abiAddr(a[0]) as string;
      const amount = abiUint(a[1]) as bigint;
      return {
        headline: [APP, ' wants to send ', ...(token ? amountOf(amount, token) : ['tokens of contract ', contract]), ' to ', ...evmWho(recipient, me)],
        lines: token ? lines : [['Amount: ', ...amountOf(amount, null), ' (Journear doesn’t know this token’s decimals).'], ...lines],
        warnings,
        explainable: true,
      };
    }
    case 'transferFrom(address,address,uint256)': {
      const from = abiAddr(a[0]) as string;
      const recipient = abiAddr(a[1]) as string;
      const amount = abiUint(a[2]) as bigint;
      return {
        headline: [APP, ' wants to move ', ...(token ? amountOf(amount, token) : ['tokens of contract ', contract]), ' from ', ...evmWho(from, me), ' to ', ...evmWho(recipient, me)],
        lines: token ? lines : [['Amount: ', ...amountOf(amount, null), ' (or, if this contract is an NFT collection, item ', strong(amount.toString()), ').'], ...lines],
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
          warnings.push({ level: 'warning', code: 'spend_permission', short: shortCodes(['May let ', code(spender), ' take your item 0 of ', contract]), text: ['If contract ', contract, ' is a token, this takes back ', code(spender), '’s permission to spend it. If it is an NFT collection, this lets ', ...spenderOf(chain, spender), ' take your item 0.'] });
          return { headline: [APP, ' wants to change ', code(spender), '’s permission for contract ', contract], lines, warnings, explainable: true };
        }
        return { headline: [APP, ' wants to take back ', code(spender), '’s permission to spend your ', ...tokenName(to, token)], lines, warnings, explainable: true };
      }
      warnings.push(spendWarning(spenderOf(chain, spender), to, token, amount, UINT256_MAX, { nftToo: true }));
      return { headline: [APP, ' wants to let someone else spend your ', ...tokenName(to, token)], lines, warnings, explainable: true };
    }
    case 'increaseAllowance(address,uint256)': {
      const spender = abiAddr(a[0]) as string;
      const amount = abiUint(a[1]) as bigint;
      if (amount > 0n) warnings.push(spendWarning(spenderOf(chain, spender), to, token, amount, UINT256_MAX, { more: true }));
      return { headline: [APP, ' wants to let someone else spend more of your ', ...tokenName(to, token)], lines, warnings, explainable: true };
    }
    case 'decreaseAllowance(address,uint256)': {
      const spender = abiAddr(a[0]) as string;
      return { headline: [APP, ' wants to lower ', code(spender), '’s permission to spend your ', ...tokenName(to, token)], lines, warnings, explainable: true };
    }
    case 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)': {
      const owner = abiAddr(a[0]) as string;
      const spender = abiAddr(a[1]) as string;
      const amount = abiUint(a[2]) as bigint;
      if (sameEvm(owner, me) && amount > 0n) warnings.push(spendWarning(spenderOf(chain, spender), to, token, amount, UINT256_MAX));
      return { headline: [APP, ' wants to submit a signed permission to spend ', ...tokenName(to, token), ' held by ', ...evmWho(owner, me)], lines, warnings, explainable: true };
    }
    case 'setApprovalForAll(address,bool)': {
      const operator = abiAddr(a[0]) as string;
      if (abiBool(a[1]) === false) return { headline: [APP, ' wants to take back ', code(operator), '’s permission to move your items in collection ', contract], lines, warnings, explainable: true };
      warnings.push({ level: 'danger', code: 'collection_operator', text: ['This lets ', ...spenderOf(chain, operator), ' move every item you hold in collection ', contract, ', now and later, until you take the permission back. Approve only if you trust it completely.'], short: shortCodes(['Lets ', ...spenderShort(spenderOf(chain, operator)), ' move all your items in ', contract]) });
      return { headline: [APP, ' wants to let someone else move all your items in collection ', contract], lines, warnings, explainable: true };
    }
    case 'safeTransferFrom(address,address,uint256)':
    case 'safeTransferFrom(address,address,uint256,bytes)':
      return { headline: [APP, ' wants to send item ', strong((abiUint(a[2]) as bigint).toString()), ' of collection ', contract, ' from ', ...evmWho(abiAddr(a[0]) as string, me), ' to ', ...evmWho(abiAddr(a[1]) as string, me)], lines, warnings, explainable: true };
    case 'safeTransferFrom(address,address,uint256,uint256,bytes)':
      return {
        headline: [APP, ' wants to send ', strong((abiUint(a[3]) as bigint).toString()), ' of item ', strong((abiUint(a[2]) as bigint).toString()), ' of collection ', contract, ' from ', ...evmWho(abiAddr(a[0]) as string, me), ' to ', ...evmWho(abiAddr(a[1]) as string, me)],
        lines,
        warnings,
        explainable: true,
      };
    case 'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)': {
      const ids = a[2]?.kind === 'array' ? a[2].items.map(abiUint) : [];
      const amounts = a[3]?.kind === 'array' ? a[3].items.map(abiUint) : [];
      const headline: SummaryText = [APP, ` wants to send ${ids.length === 1 ? '1 kind' : `${ids.length} kinds`} of item of collection `, contract, ' from ', ...evmWho(abiAddr(a[0]) as string, me), ' to ', ...evmWho(abiAddr(a[1]) as string, me)];
      // Each item and how many: in view up to five kinds (item ids as written, amounts grouped); more can't be listed.
      if (ids.length > MAX_SUMMARY_STEPS || ids.length !== amounts.length || ids.some((x) => x === null) || amounts.some((x) => x === null)) {
        return { headline, lines, warnings: [cannotTell('danger', 'it sends more kinds of item than this summary lists'), ...warnings], explainable: false };
      }
      const items: SummaryText[] = ids.map((id, i) => ['Item ', strong((id as bigint).toString()), ': ', strong(groupDigits((amounts[i] as bigint).toString()))]);
      return { headline, lines: [...items, ...lines], warnings, explainable: true };
    }
    case 'multicall(bytes[])':
    case 'multicall(uint256,bytes[])':
      return unknown('it bundles several calls Journear can’t read');
    case 'withdraw(uint256)':
      return { headline: [APP, ' wants to withdraw ', strong(groupDigits((abiUint(a[0]) as bigint).toString())), ' (smallest units) from contract ', contract, ...sending], lines: withoutValueLine(), warnings, explainable: true };
    default:
      // deposit(): named by the standard, but the contract decides what it does; what it sends is in the headline.
      return { headline: [APP, ' wants to use contract ', contract, ' (', code(call.name), ')', ...sending], lines: withoutValueLine(), warnings, explainable: true };
  }
}

function evmTx(chainId: number, tx: DecodedEvmTx, me: string): ApprovalSummary {
  const base = { fee: ['up to ', strong(evmNative(chainId, tx.maxFeeWei))] as SummaryText, network: evmNetwork(chainId) };
  if (tx.to === null) {
    return { ...base, headline: [APP, ' wants to create a new contract'], lines: tx.value > 0n ? [['It also sends ', strong(evmNative(chainId, tx.value)), ' to the new contract.']] : [], warnings: [{ ...cannotTell('warning', 'it creates a new contract from code Journear can’t read'), code: 'contract_creation' }], explainable: false };
  }
  if (tx.data === '0x') return { ...base, headline: [APP, ' wants to send ', strong(evmNative(chainId, tx.value)), ' to ', ...evmWho(tx.to, me)], lines: [], warnings: [], explainable: true };
  return { ...base, ...evmCall(chainId, tx, me) };
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
    if (!sameEvm(owner, me)) lines.push(['The tokens’ owner it names is ', code(owner), ', not your account.']);
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
    if (value === 0n) return { ...base, headline: [APP, ' wants your signature to take back ', code(spender), '’s permission to spend your ', ...tokenName(verifying, token)], lines, warnings, explainable: true };
    warnings.push(spendWarning(spenderOf(chain, spender), verifying, token, value, UINT256_MAX));
    return { ...base, headline: [APP, ' wants your signature to let someone else spend your ', ...tokenName(verifying, token)], lines, warnings, explainable: true };
  }
  // DAI's permit: all or nothing.
  if (pt === 'Permit' && verifying && typeCount === 2 && sameFields(td.types.Permit, DAI_PERMIT)) {
    const m = td.message;
    const spender = str(m.spender) as string;
    ownerLine(str(m.holder) as string);
    const token = chainId === null ? null : knownEvmToken(chainId, verifying);
    if (token) lines.push(tokenContractLine(verifying, token));
    if (m.allowed !== true) return { ...base, headline: [APP, ' wants your signature to take back ', code(spender), '’s permission to spend your ', ...tokenName(verifying, token)], lines, warnings, explainable: true };
    warnings.push(spendWarning(spenderOf(chain, spender), verifying, token, UINT256_MAX, UINT256_MAX));
    return { ...base, headline: [APP, ' wants your signature to let someone else spend your ', ...tokenName(verifying, token)], lines, warnings, explainable: true };
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
      if (amount === 0n) lines.push(['It sets the permission of ', ...spender, ' for ', ...tokenName(tokenAddr, token), ' to zero.']);
      else warnings.push(spendWarning(spender, tokenAddr, token, amount, allowance ? UINT160_MAX : UINT256_MAX, { via: allowance ? 'through Permit2' : 'through Permit2, once' }));
    }
    return { ...base, headline: [APP, ' wants your signature to let someone else spend your tokens through Permit2'], lines, warnings, explainable: true };
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
      if (amount > 0n) warnings.push(spendWarning(spender, tokenAddr, token, amount, UINT256_MAX, { via: 'through Permit2, once' }));
    }
    return { ...base, headline: [APP, ' wants your signature to let someone else spend your tokens through Permit2, with extra data Journear can’t read'], lines, warnings: [cannotTell('warning', 'it carries extra data Journear can’t read'), ...warnings], explainable: false };
  }
  // Anything else: Journear can't explain it. Say so louder when it imitates a permit.
  if (domain.name === 'Permit2' && !isPermit2Domain) {
    warnings.push({ level: 'danger', code: 'permit_lookalike', short: ['Calls itself Permit2 but isn’t Permit2'], text: ['This calls itself Permit2, but it isn’t for Permit2’s contract. Don’t approve unless you know exactly why ', APP, ' needs it.'] });
  } else if (mayGrantSpending(td.types, pt, str(domain.name))) {
    warnings.push({ level: 'warning', code: 'spend_permission', short: ['May be a permission to spend your tokens'], text: ['This may be a permission to spend your tokens, in a form Journear can’t check. Read the details before you approve.'] });
  }
  return { ...base, headline: [APP, ' wants your signature on data Journear can’t explain'], lines, warnings: [cannotTell('danger'), ...warnings], explainable: false };
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
  if (text === null) return { ...base, headline: [APP, ' wants you to sign data that isn’t readable text'], warnings: [unreadableMessage()], explainable: false };
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
  if (passphrase === STELLAR_MAINNET_PASSPHRASE) return ['Stellar public network (real funds)'];
  if (passphrase === STELLAR_TESTNET_PASSPHRASE) return ['Stellar testnet'];
  const shown = isDisplaySafeLine(passphrase) ? passphrase : `(shown as hex) ${toHex(new TextEncoder().encode(passphrase))}`;
  return ['the Stellar network named ', code(shown.length > 64 ? `${shown.slice(0, 63)}…` : shown)];
}

const xlm = (stroops: string | bigint, dir: AmountDirection = 'out'): string => `${displayUnits(BigInt(stroops), 7, dir)} XLM`;

/** An amount of a Stellar asset (`native` or `CODE:ISSUER`): "1.5 XLM", or "2 of the asset USDC:G…" (a code is its issuer's choice). */
function stellarAmount(stroops: string | bigint, asset: string, dir: AmountDirection = 'out'): SummaryText {
  return asset === 'native' ? [strong(xlm(stroops, dir))] : [strong(displayUnits(BigInt(stroops), 7, dir)), ' of the asset ', code(asset)];
}
const assetName = (asset: string): SummaryText => (asset === 'native' ? ['XLM'] : ['the asset ', code(asset)]);
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

const stellarWho = (account: string, me: string): SummaryText => {
  if (account === me) return ['your account'];
  const { base, muxedId } = stellarBaseAccount(account);
  return base === me && muxedId !== null ? [`your account (muxed id ${muxedId})`] : [code(account)];
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
    const verb = { send: 'send ', authorize: 'authorize sending ', nested: 'It also authorizes sending ' }[mode];
    const what: SummaryText = token ? [...amountOf(amount, token), ' (token contract ', code(c.contract), ')'] : [strong(groupDigits(amount.toString())), ' (in the token’s smallest units) of the token contract ', code(c.contract)];
    return [verb, ...what, ...(from === me ? [] : [' from ', ...stellarWho(from, me)]), ' to ', ...stellarWho(scAddr(a[1]) as string, me), ...end];
  }
  if (c.function === 'approve' && a.length === 4 && scAddr(a[0]) && scAddr(a[1]) && a[2]?.type === 'i128' && a[3]?.type === 'u32') {
    const amount = scInt(a[2]) as bigint;
    const from = scAddr(a[0]) as string;
    const spender = scAddr(a[1]) as string;
    const whose: SummaryText = isMeStellar(from, me) ? ['your ', ...tokenName(c.contract, token)] : [...tokenName(c.contract, token), ' held by ', code(from)];
    if (amount === 0n) return [{ send: 'take back ', authorize: 'authorize taking back ', nested: 'It also takes back ' }[mode], code(spender), '’s permission to spend ', ...whose, ...end];
    warnings.push(spendWarning(spenderOf({ kind: 'stellar', networkPassphrase: passphrase }, spender), c.contract, token, amount, I128_MAX, isMeStellar(from, me) ? {} : { owner: from }));
    return [{ send: 'let ', authorize: 'authorize ', nested: 'It also lets ' }[mode], code(spender), mode === 'authorize' ? ' to spend ' : ' spend ', ...whose, ...end];
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
  lines.push(said ?? (f.type === 'contractFn' ? ['It also authorizes a call to contract ', code(f.contract), ' (', code(f.function), ').'] : ['It also authorizes creating a contract.']));
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
      return ok(['create the account ', code(op.destination), ' and send it ', strong(xlm(op.startingBalance))]);
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
        if (most === null) return badPrice(['offer to buy ', ...stellarAmount(op.buyAmount, op.buying), ' with ', ...assetName(op.selling)]);
        return ok(['offer to buy ', ...stellarAmount(op.buyAmount, op.buying), ', paying at most ', ...stellarAmount(most, op.selling), ...changes(op.offerId)]);
      }
    case 'changeTrust':
      return ok(op.limit === '0' ? ['stop holding ', ...assetName(op.asset)] : ['let your account hold ', ...assetName(op.asset)]);
    case 'setOptions': {
      if (op.signer || op.masterWeight !== null || op.lowThreshold !== null || op.medThreshold !== null || op.highThreshold !== null) {
        // Who can sign: named, so two changes never read the same (D814).
        const parts: SummaryText[] = [];
        if (op.signer) parts.push(op.signer.weight === 0 ? ['remove the signer ', code(op.signer.key)] : ['add ', code(op.signer.key), ` as a signer with weight ${op.signer.weight}`]);
        if (op.masterWeight !== null) parts.push([`set your own key’s weight to ${op.masterWeight}`]);
        if (op.lowThreshold !== null || op.medThreshold !== null || op.highThreshold !== null) parts.push(['change the signing thresholds']);
        return ok(parts.flatMap((p, i) => [...(i > 0 ? [' and '] : []), ...p]));
      }
      const what = [op.setFlags !== null || op.clearFlags !== null ? 'its flags' : null, op.homeDomain ? 'its home domain' : null, op.inflationDest !== null ? 'its inflation destination' : null].filter((x): x is string => x !== null);
      return ok([what.length === 0 ? 'change nothing on the account' : `change the account’s settings (${what.join(', ')})`]);
    }
    case 'accountMerge':
      return ok(['close the account and send all its XLM to ', code(op.destination)]);
    case 'allowTrust':
      return ok([op.authorize === 0 ? 'stop ' : 'allow ', code(op.trustor), op.authorize === 0 ? ' from using your asset ' : ' to hold your asset ', code(op.assetCode)]);
    case 'setTrustLineFlags':
      return ok(['change the flags of ', code(op.trustor), '’s trust line for your asset ', code(op.asset)]);
    case 'manageData':
      return ok([op.value === null ? 'delete a data entry on the account' : 'save a data entry on the account']);
    case 'bumpSequence':
      return ok(['move the account’s sequence number forward']);
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
      return ok(['take back ', ...stellarAmount(op.amount, op.asset), ' from ', code(op.from)]);
    case 'beginSponsoringFutureReserves':
      return ok(['pay the reserves of ', code(op.sponsored)]);
    case 'endSponsoringFutureReserves':
      return ok(['end a reserve sponsorship']);
    case 'revokeSponsorship':
      return ok(op.target.type === 'signer' ? ['end a sponsorship of a signer of ', code(op.target.account)] : ['end a reserve sponsorship']);
    case 'liquidityPoolDeposit':
      // The pool's two assets aren't in the request (only its id): the amounts can't be named, so it isn't explained.
      return { text: ['deposit at most ', strong(displayUnits(BigInt(op.maxAmountA), 7)), ' of the pool’s first asset and ', strong(displayUnits(BigInt(op.maxAmountB), 7)), ' of its second into the liquidity pool ', code(op.poolId)], explainable: false };
    case 'liquidityPoolWithdraw':
      return { text: ['withdraw ', strong(displayUnits(BigInt(op.amount), 7)), ' pool shares from the liquidity pool ', code(op.poolId), ' for at least ', strong(displayUnits(BigInt(op.minAmountA), 7, 'in')), ' of the pool’s first asset and ', strong(displayUnits(BigInt(op.minAmountB), 7, 'in')), ' of its second'], explainable: false };
    case 'inflation':
      return ok(['run inflation (it does nothing on Stellar any more)']);
    case 'extendFootprintTtl':
      return ok(['keep contract data stored for longer']);
    case 'restoreFootprint':
      return ok(['restore archived contract data']);
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
        return { text: [f.type === 'uploadContractWasm' ? 'upload contract code' : f.type === 'createContractV2' ? 'create a contract and run its constructor' : 'create a contract'], explainable: false, risk: red ? 'danger' : 'warning' };
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
      return { text: token ?? ['use contract ', code(f.contract), ' (', code(f.function), ')'], explainable, ...(explainable ? {} : { risk: 'danger' as const }) };
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
export function groupSteps(items: readonly Step[]): { lines: SummaryText[]; hidden: number; hiddenRisk: RiskLevel | null; leftOut: SummaryWarning[] } {
  const byKey = new Map<string, StepGroup>();
  items.forEach((x, index) => {
    const k = `${x.order}|${x.key}`;
    const g = byKey.get(k);
    if (g) {
      g.count++;
      g.sum += x.sum ?? 0n;
    } else byKey.set(k, { first: x, index, count: 1, sum: x.sum ?? 0n });
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
  if (hidden.length === 0) return { lines, hidden: 0, hiddenRisk: null, leftOut: [] };
  const n = hidden.reduce((t, g) => t + g.count, 0);
  lines.push([`…and ${n} other ${n === 1 ? 'step' : 'steps'}: see the details.`]);
  // Each left-out control change, grant and value to someone else: its own red bullet, naming who or what.
  const leftOut: SummaryWarning[] = hidden
    .filter((g) => g.first.order <= 2)
    .map((g) => {
      const named = g.first.label ? (g.count > 1 ? [...capitalised(g.first.label), ` (${g.count} times)`] : capitalised(g.first.label)) : line(g);
      return { level: 'danger', code: 'step_left_out', text: ['Not in the lines above: ', ...named, '.'], short: shortCodes(named) };
    });
  return { lines, hidden: n, hiddenRisk: hidden.some((g) => g.first.order <= 4 && g.first.value) ? 'danger' : 'warning', leftOut };
}

/** The grouping of one Stellar operation. `suffix`: what the line says about another source account. */
function stellarStep(op: StellarOperation, text: SummaryText, me: string, txSource: string, suffix: SummaryText): Step {
  const value = stellarMovesValue(op);
  // Grouped only with identical operations (the same XDR, its source included): the same line, nothing hidden.
  const by = (order: number, label?: SummaryText): Step => ({ ...sameText(text, value, order), key: op.xdr, ...(label ? { label } : {}) });
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
    case 'createAccount':
    case 'pathPaymentStrictReceive':
    case 'pathPaymentStrictSend':
    case 'createClaimableBalance':
    case 'liquidityPoolDeposit':
      return by(1);
    case 'manageSellOffer':
    case 'createPassiveSellOffer':
    case 'manageBuyOffer':
      return by(value ? 1 : 6);
    case 'invokeHostFunction': {
      const f = op.hostFunction;
      if (f.type === 'invokeContract' && f.function === 'approve') {
        const spender = scAddr(f.args[1]);
        return by(2, spender ? ['let ', code(spender), ' spend tokens of contract ', code(f.contract), ...suffix] : undefined);
      }
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
  return { lines: [...lines.slice(0, MAX_SUMMARY_STEPS), [`…and ${lines.length - MAX_SUMMARY_STEPS} more: see the details.`]], capped: true };
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
  return ['XLM leaving your account: up to ', strong(xlm(total)), more ? ', plus what its contract calls or pool deposits take' : '', ', plus the network fee.'];
}

function stellarTx(decoded: Extract<DecodedApproval, { kind: 'stellar_tx' }>, me: string): ApprovalSummary {
  const env = decoded.envelope;
  const tx = env.tx;
  const warnings: SummaryWarning[] = [];
  const extra: SummaryText[] = [];
  const ops = tx.operations.map((op) => {
    const o = stellarOp(decoded.networkPassphrase, op, me, warnings, extra);
    // An operation on another account than the transaction's says so in its own line.
    const suffix: SummaryText = op.source === null || op.source === tx.source ? [] : [' (on ', ...(isMeStellar(op.source, me) ? stellarWho(op.source, me) : ['the account ', code(op.source)]), ')'];
    const text: SummaryText = [...o.text, ...suffix];
    return { ...o, text, step: stellarStep(op, text, me, tx.source, suffix) };
  });
  let explainable = ops.every((o) => o.explainable);
  let risk: RiskLevel | null = null;
  for (const o of ops) if (!o.explainable) risk = worse(risk, o.risk ?? 'warning');
  let hidden: { n: number; risk: RiskLevel } | null = null;
  const lines: SummaryText[] = [];
  let headline: SummaryText;
  if (ops.length === 1) headline = [APP, ' wants to ', ...(ops[0] as OpSummary).text];
  else {
    headline = [APP, ` wants to do ${ops.length} things in one Stellar transaction`];
    const g = groupSteps(ops.map((o) => o.step));
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
  if (tx.source !== me) lines.push(isMeStellar(tx.source, me) ? ['The transaction is from ', ...stellarWho(tx.source, me), '.'] : ['The transaction is from the account ', code(tx.source), '.']);
  if (env.envelope === 'fee_bump') lines.push(isMeStellar(env.feeSource, me) ? ['Your account pays the network fee for a transaction from ', ...stellarWho(tx.source, me), '.'] : ['The network fee is paid by ', code(env.feeSource), ', not your account.']);
  if (risk) warnings.unshift(cannotTell(risk, ops.length > 1 ? 'part of it is something Journear can’t summarise' : undefined));
  if (hidden) warnings.push(stepsNotListed(ops.length, hidden.n, hidden.risk));
  const feeStroops = env.envelope === 'fee_bump' ? env.fee : tx.fee;
  return {
    headline,
    lines,
    fee: env.envelope === 'fee_bump' && !isMeStellar(env.feeSource, me) ? null : ['up to ', strong(xlm(feeStroops))],
    network: stellarNetwork(decoded.networkPassphrase),
    warnings,
    explainable,
  };
}

function stellarAuth(decoded: Extract<DecodedApproval, { kind: 'stellar_auth_entry' }>, me: string): ApprovalSummary {
  const warnings: SummaryWarning[] = [];
  const extra: SummaryText[] = [];
  const inv = decoded.preimage.invocation;
  const f = inv.function;
  const root = f.type === 'contractFn' ? sorobanTokenCall(decoded.networkPassphrase, f, me, warnings, 'authorize') : null;
  // Explained only when the entry authorizes one token call and nothing under it.
  let explainable = root !== null && inv.subInvocations.length === 0;
  for (const s of inv.subInvocations) otherAuthorizations(decoded.networkPassphrase, s, me, warnings, extra);
  const more = capped(extra);
  if (more.capped) explainable = false;
  const what: SummaryText = root ?? (f.type === 'contractFn' ? ['authorize a call to contract ', code(f.contract), ' (', code(f.function), ')'] : ['authorize creating a contract']);
  if (!explainable) warnings.unshift(cannotTell('danger', 'it authorizes a contract call Journear can’t summarise'));
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
const nearWho = (account: string, me: string): SummaryText => (account === me ? ['your account'] : [code(account)]);

/** What one NEAR action does, in a few words, whether Journear can say that, and how it groups with others. */
function nearAction(a: NearAction, receiver: string, me: string, warnings: SummaryWarning[]): { text: SummaryText; explainable: boolean; step: Step } {
  const where = nearWho(receiver, me);
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
      if (m.text === null) return same(['call a function on ', ...where, ' whose name can’t be shown as text'], 3, false, m.hex);
      const method = m.text;
      const args = a.args.length === 0 ? {} : jsonArgs(a.args);
      if (args === null) return same(['use ', ...where, ' (', code(method), ') with data Journear can’t read'], 3, false, toHex(a.args));
      // NEP-141 fungible tokens and NEP-171/178 NFTs: their methods' meaning is the standard's (the contract can still lie).
      if ((method === 'ft_transfer' || method === 'ft_transfer_call') && typeof args.receiver_id === 'string' && isNearAccountId(args.receiver_id) && isAmount(args.amount)) {
        const to = args.receiver_id;
        const text: SummaryText = ['send ', strong(groupDigits(args.amount)), ' (smallest units) of the token ', code(receiver), ' to ', ...nearWho(to, me)];
        return {
          text,
          explainable: true,
          step: { text, value, key: `ft|${receiver}|${method}|${to}`, order: to === me ? 5 : 1, sum: BigInt(args.amount), many: (n, sum) => ['send ', strong(groupDigits(sum.toString())), ' (smallest units) of the token ', code(receiver), ' to ', ...nearWho(to, me), ` in ${n} transfers`] },
        };
      }
      if ((method === 'nft_transfer' || method === 'nft_transfer_call') && typeof args.receiver_id === 'string' && isNearAccountId(args.receiver_id) && isTokenId(args.token_id)) {
        return same(['send item ', code(args.token_id), ' of collection ', code(receiver), ' to ', ...nearWho(args.receiver_id, me)], args.receiver_id === me ? 5 : 1);
      }
      if (method === 'nft_approve' && typeof args.account_id === 'string' && isNearAccountId(args.account_id) && isTokenId(args.token_id)) {
        warnings.push({ level: 'warning', code: 'spend_permission', text: ['This lets ', code(args.account_id), ' move your item ', code(args.token_id), ' of collection ', code(receiver), ', until it is used or you take the permission back.'], short: ['Lets ', code(args.account_id), ' move your item ', code(args.token_id)] });
        return same(['let ', code(args.account_id), ' move your item ', code(args.token_id), ' of collection ', code(receiver)], 2, true, args.account_id);
      }
      const text: SummaryText = ['use ', ...where, ' (', code(method), ')'];
      return {
        text,
        explainable: true,
        step: { text, value, key: `call|${receiver}|${method}`, order: 3, sum: a.deposit, many: (n, sum) => ['use ', ...where, ' (', code(method), `), ${n} times`, ...(sum > 0n ? [' (attaching ', strong(nearDisplay(sum)), ' in total)'] : [])] },
      };
    }
    case 'createAccount':
      return same(['create the account ', code(receiver)], 6);
    case 'deployContract':
      return same(['put a contract on ', ...where], 0, true, nearCodeHash(a.code));
    case 'stake':
      return same(['stake (lock) ', strong(nearDisplay(a.stake))], 4, true, nearKeyText(a.publicKey));
    case 'addKey':
      if (a.accessKey.permission.type === 'fullAccess') return same(['add a full-access key to ', ...where], 0, true, nearKeyText(a.publicKey), ['add the full-access key ', code(nearKeyText(a.publicKey)), ' to ', ...where]);
      // A function-call key spends the account's NEAR on its calls' fees, up to its allowance: said in view.
      return same(
        ['add a key to ', ...where, ' that can use ', code(a.accessKey.permission.receiverId), ...(a.accessKey.permission.allowance === null ? [', with no limit on the NEAR it spends on fees'] : [', spending up to ', strong(nearDisplay(a.accessKey.permission.allowance)), ' on fees'])],
        0,
        true,
        `${nearKeyText(a.publicKey)}|${a.accessKey.permission.methodNames.join(',')}`,
        ['add the key ', code(nearKeyText(a.publicKey)), ' to ', ...where, ' that can use ', code(a.accessKey.permission.receiverId)],
      );
    case 'deleteKey':
      return same(['remove a key from ', ...where], 0, true, nearKeyText(a.publicKey), ['remove the key ', code(nearKeyText(a.publicKey)), ' from ', ...where]);
    case 'deleteAccount':
      return same(['delete ', ...where, ' and send all its NEAR to ', code(a.beneficiaryId)], 0);
    case 'deployGlobalContract':
      return same(['publish a global contract'], 1, true, nearCodeHash(a.code));
    case 'useGlobalContract':
      return same(['set the contract of ', ...where], 0, true, a.contract.type === 'codeHash' ? nearHash58(a.contract.hash) : a.contract.accountId);
    case 'delegate':
      // Never shown: decodeApprovalRequest refuses a transaction that relays a delegate action.
      return same(['relay someone else’s transaction'], 3, false);
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

function nearActions(actions: readonly NearAction[], receiver: string, me: string, relayed: boolean): ApprovalSummary {
  const warnings: SummaryWarning[] = [];
  const done = actions.map((a) => nearAction(a, receiver, me, warnings));
  let explainable = done.every((x) => x.explainable);
  const unreadable = !explainable;
  let hidden: { n: number; risk: RiskLevel } | null = null;
  const lines: SummaryText[] = [];
  let headline: SummaryText;
  const transfers = actions.length > 0 && actions.every((a) => a.type === 'transfer');
  if (transfers && actions.length > 1) {
    headline = [APP, ' wants to send ', strong(nearDisplay(actions.reduce((n, a) => n + (a.type === 'transfer' ? a.deposit : 0n), 0n))), ' to ', ...nearWho(receiver, me), ` in ${actions.length} transfers`];
  } else if (done.length === 1) headline = [APP, ' wants to ', ...(done[0] as { text: SummaryText }).text];
  else {
    headline = [APP, ` wants to do ${done.length} things with `, ...nearWho(receiver, me), ' in one transaction'];
    const g = groupSteps(done.map((x) => x.step));
    lines.push(...g.lines);
    warnings.push(...g.leftOut);
    if (g.hiddenRisk) {
      explainable = false;
      hidden = { n: g.hidden, risk: g.hiddenRisk };
    }
  }
  // A call Journear can't read (its arguments or its name) could move tokens with no visible bound.
  if (unreadable) warnings.unshift(cannotTell('danger'));
  if (hidden) warnings.push(stepsNotListed(done.length, hidden.n, hidden.risk));
  return {
    headline,
    lines,
    fee: relayed ? ['paid for you by a relayer, not from your account'] : ['a small amount of NEAR for gas, from your account'],
    network: null,
    warnings,
    explainable,
  };
}

// ---- the entry point ----

/** What a request gets when building its summary fails: Journear can't explain it, and its details start open. */
export const UNEXPLAINED_SUMMARY: ApprovalSummary = Object.freeze({
  headline: [APP, ' wants you to approve a request Journear can’t explain'],
  lines: [],
  fee: null,
  network: null,
  warnings: [{ level: 'danger', code: 'summary_failed', text: ['Journear couldn’t read this request. Reject it unless you are certain.'], short: ['Journear couldn’t read this request'] }],
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
        headline: [APP, ' wants a raw signature that Journear can’t read'],
        lines: [],
        fee: null,
        network: null,
        warnings: [{ level: 'danger', code: 'raw_signing', short: ['Asks for a raw signature Journear can’t read'], text: [`This asks you to sign something Journear can’t read at all. On ${decoded.chain === 'evm' ? 'EVM chains' : 'Stellar'} it could give away control of your account or your funds. Reject unless you are certain.`] }],
        explainable: false,
      };
    case 'near_tx':
      return nearActions(decoded.tx.actions, decoded.tx.receiverId, decoded.tx.signerId, false);
    case 'near_delegate':
      return nearActions(decoded.delegate.actions, decoded.delegate.receiverId, decoded.delegate.senderId, true);
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
