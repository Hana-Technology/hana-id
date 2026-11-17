// The approval window's plain-language summary (D808–D812): one headline ("{App} wants to send 0.1 NEAR to
// bob.testnet"), a few plain lines, the network fee, and the warnings for requests that let someone spend the user's
// tokens, built only from the request the popup decoded itself (decode/request.ts). Never from text the partner page
// supplies: the app's name is a placeholder part (`{ kind: 'app' }`) the page fills with the vault's app name, and every
// other value comes from the signed bytes. Values a partner chose (addresses, account ids, method names, token ids) are
// `code` parts, shown as text in mono; a string that isn't display-safe is never put in a summary.
//
// `explainable` is false when Journear can't say in plain words what the request does (an unknown contract function,
// raw bytes, typed data it can't summarise, a Soroban call that isn't a token transfer or approval): the summary then
// says so, and the popup starts its details open. `detailsMustStayOpen` (raw signing) means the details can't be folded
// at all. The popup still shows every technical fact in its details; nothing here replaces a fact, it only says it
// plainly first.
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
import { formatNear, nearMethodName } from './near.ts';
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
  | 'sign_in_mismatch';

export interface SummaryWarning {
  /** `danger`: red, the popup's strongest style; `warning`: amber. Both always visible, never folded. */
  readonly level: 'danger' | 'warning';
  readonly code: SummaryWarningCode;
  readonly text: SummaryText;
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
  /** False when Journear can't say what the request does: the details start open. */
  readonly explainable: boolean;
  /** True for raw signing: the details are shown and can't be folded. */
  readonly detailsMustStayOpen: boolean;
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

/** The line every request Journear can't explain carries. */
export const cannotExplain = (reason?: string): SummaryText => [`Journear can’t explain this request in plain words${reason ? `: ${reason}` : ''}. Only approve if you trust `, APP, '.'];

/**
 * Allowances at or above this, of a token Journear doesn't know, have no practical limit: 10^27 of its smallest units is
 * a billion whole tokens even at 18 decimals, and below 2^96 (the max of a 96-bit balance, which some tokens use as
 * "unlimited"). For a pinned token the line is a trillion whole tokens (PINNED_UNLIMITED_WHOLE), more than its supply.
 */
export const PRACTICALLY_UNLIMITED = 10n ** 27n;
/** A pinned token's allowance above this many whole tokens has no practical limit. */
export const PINNED_UNLIMITED_WHOLE = 10n ** 12n;
/** At most this many numbered lines; the rest are in the details, which then start open. */
export const MAX_SUMMARY_STEPS = 5;

/** Permit2's canonical contract (the same address on every chain). */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const ZERO_ADDRESS = /^0x0{40}$/iu;
const UINT256_MAX = 2n ** 256n - 1n;
const UINT160_MAX = 2n ** 160n - 1n;
const I128_MAX = 2n ** 127n - 1n;

/** A decimal string with its whole part grouped by thousands: "1234567.5" → "1,234,567.5". */
export const groupDigits = (n: string): string => n.replace(/^(-?)(\d+)/u, (_, sign: string, whole: string) => sign + whole.replace(/\B(?=(\d{3})+$)/gu, ','));

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
function amountOf(amount: bigint, token: KnownToken | null): SummaryText {
  return token ? [strong(`${groupDigits(formatTokenUnits(amount, token.decimals))} ${token.symbol}`)] : [strong(groupDigits(amount.toString())), ' in the token’s smallest units'];
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
    return { level: 'danger', code: 'unlimited_spend', text: ['This lets ', ...spender, ' spend all of ', ...yours, via, `, ${how}, until you take the permission back. Approve only if you trust it completely.`] };
  }
  const much: SummaryText = token && !opts.owner ? [strong(`${groupDigits(formatTokenUnits(amount, token.decimals))} ${token.symbol}`), ' from your account'] : [strong(token ? groupDigits(formatTokenUnits(amount, token.decimals)) : groupDigits(amount.toString())), token ? ' of ' : ' (in the token’s smallest units) of ', ...yours];
  const nft = opts.nftToo && !token ? ` If the contract is an NFT collection, it lets them take your item ${amount} instead.` : '';
  return { level: 'warning', code: 'spend_permission', text: ['This lets ', ...spender, ` spend ${opts.more ? 'a further ' : 'up to '}`, ...much, via, `, until it is used up or you take the permission back.${nft}`] };
}

// ---- EVM ----

const abiAddr = (v: AbiValue | undefined): string | null => (v?.kind === 'address' ? v.value : null);
const abiUint = (v: AbiValue | undefined): bigint | null => (v?.kind === 'uint' ? v.value : null);
const abiBool = (v: AbiValue | undefined): boolean | null => (v?.kind === 'bool' ? v.value : null);
const sameEvm = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function evmNative(chainId: number, wei: bigint): string {
  const info = evmChainInfo(chainId);
  return info ? `${formatTokenUnits(wei, 18)} ${info.nativeSymbol}` : `${formatTokenUnits(wei, 18)} of this chain’s coin`;
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
  const unknown = (reason: string): Draft => ({ headline: [APP, ' wants to use contract ', contract], lines, warnings: [{ level: 'warning', code: 'cannot_explain', text: cannotExplain(reason) }, ...warnings], explainable: false });
  if (tx.value > 0n) lines.push(['It also sends ', strong(evmNative(chainId, tx.value)), ' to the contract.']);
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
          warnings.push({ level: 'warning', code: 'spend_permission', text: ['If contract ', contract, ' is a token, this takes back ', code(spender), '’s permission to spend it. If it is an NFT collection, this lets ', ...spenderOf(chain, spender), ' take your item 0.'] });
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
      warnings.push({ level: 'danger', code: 'collection_operator', text: ['This lets ', ...spenderOf(chain, operator), ' move every item you hold in collection ', contract, ', now and later, until you take the permission back. Approve only if you trust it completely.'] });
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
      const ids = a[2]?.kind === 'array' ? a[2].items.length : 0;
      return { headline: [APP, ` wants to send ${ids === 1 ? '1 kind' : `${ids} kinds`} of item of collection `, contract, ' from ', ...evmWho(abiAddr(a[0]) as string, me), ' to ', ...evmWho(abiAddr(a[1]) as string, me)], lines, warnings, explainable: true };
    }
    case 'multicall(bytes[])':
    case 'multicall(uint256,bytes[])':
      return unknown('it bundles several calls Journear can’t read');
    default:
      // deposit(), withdraw(uint256): named by the standard, but the contract decides what they do.
      return { headline: [APP, ' wants to use contract ', contract, ' (', code(call.name), ')'], lines, warnings, explainable: true };
  }
}

function evmTx(chainId: number, tx: DecodedEvmTx, me: string): ApprovalSummary {
  const base = { fee: ['up to ', strong(evmNative(chainId, tx.maxFeeWei))] as SummaryText, network: evmNetwork(chainId), detailsMustStayOpen: false };
  if (tx.to === null) {
    return { ...base, headline: [APP, ' wants to create a new contract'], lines: tx.value > 0n ? [['It also sends ', strong(evmNative(chainId, tx.value)), ' to the new contract.']] : [], warnings: [{ level: 'warning', code: 'contract_creation', text: cannotExplain('it creates a new contract from code Journear can’t read') }], explainable: false };
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
  const base = { fee: null, network, detailsMustStayOpen: false };
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
    return { ...base, headline: [APP, ' wants your signature to let someone else spend your tokens through Permit2, with extra data Journear can’t read'], lines, warnings: [{ level: 'warning', code: 'cannot_explain', text: cannotExplain('it carries extra data Journear can’t read') }, ...warnings], explainable: false };
  }
  // Anything else: Journear can't explain it. Say so louder when it imitates a permit.
  if (domain.name === 'Permit2' && !isPermit2Domain) {
    warnings.push({ level: 'danger', code: 'permit_lookalike', text: ['This calls itself Permit2, but it isn’t for Permit2’s contract. Don’t approve unless you know exactly why ', APP, ' needs it.'] });
  } else if (mayGrantSpending(td.types, pt, str(domain.name))) {
    warnings.push({ level: 'warning', code: 'spend_permission', text: ['This may be a permission to spend your tokens, in a form Journear can’t check. Read the details before you approve.'] });
  }
  return { ...base, headline: [APP, ' wants your signature on data Journear can’t explain'], lines, warnings: [{ level: 'warning', code: 'cannot_explain', text: cannotExplain() }, ...warnings], explainable: false };
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
  const base = { fee: null, network: null, detailsMustStayOpen: false, lines: [] as SummaryText[] };
  if (text === null) return { ...base, headline: [APP, ' wants you to sign data that isn’t readable text'], warnings: [{ level: 'warning', code: 'cannot_explain', text: cannotExplain('it isn’t plain text') }], explainable: false };
  const siwe = kind === 'personal_sign' ? SIWE_FIRST_LINE.exec(text.split('\n', 1)[0] ?? '') : null;
  if (siwe) {
    const domain = siwe[2] as string;
    const host = hostOf(ctx.parentOrigin);
    const warnings: SummaryWarning[] = [];
    if (host !== null && host.toLowerCase() !== domain.toLowerCase()) {
      warnings.push({ level: 'warning', code: 'sign_in_mismatch', text: ['This app is at ', code(host), ', but the message signs you in to ', code(domain), '. Sign only if you mean to sign in to ', code(domain), '.'] });
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

const xlm = (stroops: string | bigint): string => `${groupDigits(formatTokenUnits(BigInt(stroops), 7))} XLM`;

/** An amount of a Stellar asset (`native` or `CODE:ISSUER`): "1.5 XLM", or "2 of the asset USDC:G…" (a code is its issuer's choice). */
function stellarAmount(stroops: string | bigint, asset: string): SummaryText {
  return asset === 'native' ? [strong(xlm(stroops))] : [strong(groupDigits(formatTokenUnits(BigInt(stroops), 7))), ' of the asset ', code(asset)];
}
const assetName = (asset: string): SummaryText => (asset === 'native' ? ['XLM'] : ['the asset ', code(asset)]);
const stellarWho = (account: string, me: string): SummaryText => (account === me ? ['your account'] : [code(account)]);
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
    return [verb, ...what, ...(from === me ? [] : [' from ', code(from)]), ' to ', ...stellarWho(scAddr(a[1]) as string, me), ...end];
  }
  if (c.function === 'approve' && a.length === 4 && scAddr(a[0]) && scAddr(a[1]) && a[2]?.type === 'i128' && a[3]?.type === 'u32') {
    const amount = scInt(a[2]) as bigint;
    const from = scAddr(a[0]) as string;
    const spender = scAddr(a[1]) as string;
    const whose: SummaryText = from === me ? ['your ', ...tokenName(c.contract, token)] : [...tokenName(c.contract, token), ' held by ', code(from)];
    if (amount === 0n) return [{ send: 'take back ', authorize: 'authorize taking back ', nested: 'It also takes back ' }[mode], code(spender), '’s permission to spend ', ...whose, ...end];
    warnings.push(spendWarning(spenderOf({ kind: 'stellar', networkPassphrase: passphrase }, spender), c.contract, token, amount, I128_MAX, from === me ? {} : { owner: from }));
    return [{ send: 'let someone else spend ', authorize: 'authorize someone else to spend ', nested: 'It also lets someone else spend ' }[mode], ...whose, ...end];
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
const times = (amount: string, n: number, d: number, round: 'down' | 'up'): bigint => {
  const num = BigInt(amount) * BigInt(n);
  const den = BigInt(d);
  return round === 'down' ? num / den : (num + den - 1n) / den;
};
const changes = (offerId: string): SummaryText => (offerId === '0' ? [] : [` (it changes your offer ${offerId})`]);

interface OpSummary {
  readonly text: SummaryText;
  readonly explainable: boolean;
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
      return ok(['pay at most ', ...stellarAmount(op.sendMax, op.sendAsset), ' so that ', ...stellarWho(op.destination, me), ' receives exactly ', ...stellarAmount(op.destAmount, op.destAsset)]);
    case 'pathPaymentStrictSend':
      return ok(['pay exactly ', ...stellarAmount(op.sendAmount, op.sendAsset), ' so that ', ...stellarWho(op.destination, me), ' receives at least ', ...stellarAmount(op.destMin, op.destAsset)]);
    case 'manageSellOffer':
    case 'createPassiveSellOffer':
      if (op.amount === '0') return ok(['cancel your offer ', code(op.offerId), ' to sell ', ...assetName(op.selling)]);
      return ok(['offer to sell ', ...stellarAmount(op.amount, op.selling), ' for at least ', ...stellarAmount(times(op.amount, op.price.n, op.price.d, 'down'), op.buying), ...changes(op.offerId)]);
    case 'manageBuyOffer':
      if (op.buyAmount === '0') return ok(['cancel your offer ', code(op.offerId), ' to buy ', ...assetName(op.buying)]);
      return ok(['offer to buy ', ...stellarAmount(op.buyAmount, op.buying), ', paying at most ', ...stellarAmount(times(op.buyAmount, op.price.n, op.price.d, 'up'), op.selling), ...changes(op.offerId)]);
    case 'changeTrust':
      return ok(op.limit === '0' ? ['stop holding ', ...assetName(op.asset)] : ['let your account hold ', ...assetName(op.asset)]);
    case 'setOptions': {
      if (op.signer || op.masterWeight !== null || op.lowThreshold !== null || op.medThreshold !== null || op.highThreshold !== null) return ok(['change who can sign for the account']);
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
      return { text: ['deposit at most ', strong(groupDigits(formatTokenUnits(BigInt(op.maxAmountA), 7))), ' of the pool’s first asset and ', strong(groupDigits(formatTokenUnits(BigInt(op.maxAmountB), 7))), ' of its second into the liquidity pool ', code(op.poolId)], explainable: false };
    case 'liquidityPoolWithdraw':
      return { text: ['withdraw ', strong(groupDigits(formatTokenUnits(BigInt(op.amount), 7))), ' pool shares from the liquidity pool ', code(op.poolId), ' for at least ', strong(groupDigits(formatTokenUnits(BigInt(op.minAmountA), 7))), ' of the pool’s first asset and ', strong(groupDigits(formatTokenUnits(BigInt(op.minAmountB), 7))), ' of its second'], explainable: false };
    case 'inflation':
      return ok(['run inflation (it does nothing on Stellar any more)']);
    case 'extendFootprintTtl':
      return ok(['keep contract data stored for longer']);
    case 'restoreFootprint':
      return ok(['restore archived contract data']);
    case 'invokeHostFunction': {
      const f = op.hostFunction;
      if (f.type !== 'invokeContract') return { text: [f.type === 'uploadContractWasm' ? 'upload contract code' : 'create a contract'], explainable: false };
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
      return { text: token ?? ['use contract ', code(f.contract), ' (', code(f.function), ')'], explainable };
    }
  }
}

const capitalised = (t: SummaryText): SummaryText => {
  const [first, ...rest] = t;
  return typeof first === 'string' ? [first.charAt(0).toUpperCase() + first.slice(1), ...rest] : t;
};

/** At most MAX_SUMMARY_STEPS numbered lines, then "…and N more"; `capped` when some were left out. */
function steps(texts: readonly SummaryText[]): { lines: SummaryText[]; capped: boolean } {
  const lines = texts.slice(0, MAX_SUMMARY_STEPS).map((t, i) => [`${i + 1}. `, ...capitalised(t)]);
  if (texts.length <= MAX_SUMMARY_STEPS) return { lines, capped: false };
  return { lines: [...lines, [`…and ${texts.length - MAX_SUMMARY_STEPS} more: see the details.`]], capped: true };
}

/** At most MAX_SUMMARY_STEPS extra lines, then "…and N more". */
function capped(lines: readonly SummaryText[]): { lines: SummaryText[]; capped: boolean } {
  if (lines.length <= MAX_SUMMARY_STEPS) return { lines: [...lines], capped: false };
  return { lines: [...lines.slice(0, MAX_SUMMARY_STEPS), [`…and ${lines.length - MAX_SUMMARY_STEPS} more: see the details.`]], capped: true };
}

function stellarTx(decoded: Extract<DecodedApproval, { kind: 'stellar_tx' }>, me: string): ApprovalSummary {
  const env = decoded.envelope;
  const tx = env.tx;
  const warnings: SummaryWarning[] = [];
  const extra: SummaryText[] = [];
  const ops = tx.operations.map((op) => {
    const o = stellarOp(decoded.networkPassphrase, op, me, warnings, extra);
    // An operation on another account than the transaction's says so in its own line.
    return op.source !== null && op.source !== tx.source ? { ...o, text: [...o.text, ' (on the account ', code(op.source), ')'] } : o;
  });
  let explainable = ops.every((o) => o.explainable);
  const lines: SummaryText[] = [];
  let headline: SummaryText;
  if (ops.length === 1) headline = [APP, ' wants to ', ...(ops[0] as OpSummary).text];
  else {
    headline = [APP, ` wants to do ${ops.length} things in one Stellar transaction`];
    const s = steps(ops.map((o) => o.text));
    lines.push(...s.lines);
    if (s.capped) explainable = false;
  }
  const more = capped(extra);
  lines.push(...more.lines);
  if (more.capped) explainable = false;
  if (tx.source !== me) lines.push(['The transaction is from the account ', code(tx.source), '.']);
  if (env.envelope === 'fee_bump') lines.push(env.feeSource === me ? ['Your account pays the network fee for a transaction from ', ...stellarWho(tx.source, me), '.'] : ['The network fee is paid by ', code(env.feeSource), ', not your account.']);
  if (!explainable) warnings.unshift({ level: 'warning', code: 'cannot_explain', text: cannotExplain(ops.every((o) => o.explainable) && !more.capped ? 'it has more steps than this summary lists' : 'it does something Journear can’t summarise') });
  const feeStroops = env.envelope === 'fee_bump' ? env.fee : tx.fee;
  return {
    headline,
    lines,
    fee: env.envelope === 'fee_bump' && env.feeSource !== me ? null : ['up to ', strong(xlm(feeStroops))],
    network: stellarNetwork(decoded.networkPassphrase),
    warnings,
    explainable,
    detailsMustStayOpen: false,
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
  if (!explainable) warnings.unshift({ level: 'warning', code: 'cannot_explain', text: cannotExplain('it authorizes a contract call Journear can’t summarise') });
  return { headline: [APP, ' wants to ', ...what], lines: more.lines, fee: null, network: stellarNetwork(decoded.networkPassphrase), warnings, explainable, detailsMustStayOpen: false };
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

/** What one NEAR action does, in a few words, and whether Journear can say that. */
function nearAction(a: NearAction, receiver: string, me: string, warnings: SummaryWarning[]): { text: SummaryText; explainable: boolean } {
  const where = nearWho(receiver, me);
  const ok = (text: SummaryText) => ({ text, explainable: true });
  switch (a.type) {
    case 'transfer':
      return ok(['send ', strong(formatNear(a.deposit)), ' to ', ...where]);
    case 'functionCall': {
      const m = nearMethodName(a.methodName);
      if (m.text === null) return { text: ['call a function on ', ...where, ' whose name can’t be shown as text'], explainable: false };
      const args = a.args.length === 0 ? {} : jsonArgs(a.args);
      if (args === null) return { text: ['use ', ...where, ' (', code(m.text), ') with data Journear can’t read'], explainable: false };
      // NEP-141 fungible tokens and NEP-171/178 NFTs: their methods' meaning is the standard's (the contract can still lie).
      if ((m.text === 'ft_transfer' || m.text === 'ft_transfer_call') && typeof args.receiver_id === 'string' && isNearAccountId(args.receiver_id) && isAmount(args.amount)) {
        return ok(['send ', strong(groupDigits(args.amount)), ' (smallest units) of the token ', code(receiver), ' to ', ...nearWho(args.receiver_id, me)]);
      }
      if ((m.text === 'nft_transfer' || m.text === 'nft_transfer_call') && typeof args.receiver_id === 'string' && isNearAccountId(args.receiver_id) && isTokenId(args.token_id)) {
        return ok(['send item ', code(args.token_id), ' of collection ', code(receiver), ' to ', ...nearWho(args.receiver_id, me)]);
      }
      if (m.text === 'nft_approve' && typeof args.account_id === 'string' && isNearAccountId(args.account_id) && isTokenId(args.token_id)) {
        warnings.push({ level: 'warning', code: 'spend_permission', text: ['This lets ', code(args.account_id), ' move your item ', code(args.token_id), ' of collection ', code(receiver), ', until it is used or you take the permission back.'] });
        return ok(['let someone else move your item ', code(args.token_id), ' of collection ', code(receiver)]);
      }
      return ok(['use ', ...where, ' (', code(m.text), ')']);
    }
    case 'createAccount':
      return ok(['create the account ', code(receiver)]);
    case 'deployContract':
      return ok(['put a contract on ', ...where]);
    case 'stake':
      return ok(['stake (lock) ', strong(formatNear(a.stake))]);
    case 'addKey':
      return ok(a.accessKey.permission.type === 'fullAccess' ? ['add a full-access key to ', ...where] : ['add a key to ', ...where, ' that can use ', code(a.accessKey.permission.receiverId)]);
    case 'deleteKey':
      return ok(['remove a key from ', ...where]);
    case 'deleteAccount':
      return ok(['delete ', ...where, ' and send all its NEAR to ', code(a.beneficiaryId)]);
    case 'deployGlobalContract':
      return ok(['publish a global contract']);
    case 'useGlobalContract':
      return ok(['set the contract of ', ...where]);
    case 'delegate':
      // Never shown: decodeApprovalRequest refuses a transaction that relays a delegate action.
      return { text: ['relay someone else’s transaction'], explainable: false };
  }
}

function nearActions(actions: readonly NearAction[], receiver: string, me: string, relayed: boolean): ApprovalSummary {
  const warnings: SummaryWarning[] = [];
  const done = actions.map((a) => nearAction(a, receiver, me, warnings));
  let explainable = done.every((x) => x.explainable);
  const lines: SummaryText[] = [];
  let headline: SummaryText;
  const transfers = actions.length > 0 && actions.every((a) => a.type === 'transfer');
  if (transfers && actions.length > 1) {
    headline = [APP, ' wants to send ', strong(formatNear(actions.reduce((n, a) => n + (a.type === 'transfer' ? a.deposit : 0n), 0n))), ' to ', ...nearWho(receiver, me), ` in ${actions.length} transfers`];
  } else if (done.length === 1) headline = [APP, ' wants to ', ...(done[0] as { text: SummaryText }).text];
  else {
    headline = [APP, ` wants to do ${done.length} things with `, ...nearWho(receiver, me), ' in one transaction'];
    const s = steps(done.map((x) => x.text));
    lines.push(...s.lines);
    if (s.capped) explainable = false;
  }
  if (!explainable) warnings.unshift({ level: 'warning', code: 'cannot_explain', text: cannotExplain(done.every((x) => x.explainable) ? 'it has more steps than this summary lists' : undefined) });
  return {
    headline,
    lines,
    fee: relayed ? ['paid for you by a relayer, not from your account'] : ['a small amount of NEAR for gas, from your account'],
    network: null,
    warnings,
    explainable,
    detailsMustStayOpen: false,
  };
}

// ---- the entry point ----

/** The plain summary of a request the popup decoded itself. Pure; never throws for a decoded request. */
export function summarizeApproval(decoded: DecodedApproval, ctx: SummaryContext): ApprovalSummary {
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
      return { headline: [APP, ' wants a raw signature that Journear can’t read'], lines: [], fee: null, network: null, warnings: [], explainable: false, detailsMustStayOpen: true };
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
        warnings: readable ? [] : [{ level: 'warning', code: 'cannot_explain', text: cannotExplain('its message isn’t plain text') }],
        explainable: readable,
        detailsMustStayOpen: false,
      };
    }
  }
}

/** A summary text as one string, with `appName` in place of the app part (tests, logs of the page's own text). */
export const summaryString = (t: SummaryText, appName: string): string => t.map((p) => (typeof p === 'string' ? p : p.kind === 'app' ? appName : p.text)).join('');
