// Stellar XDR decoders for the approval page and the auto-approve matcher (docs/batch-b-spec.md "Approval flow"):
// transaction envelopes (v1, v0 and fee-bump) with every operation, Soroban invocations with typed arguments and the
// whole authorization tree, and the `HashIdPreimage` a `stellar_signAuthEntry` signs. Values come out as plain,
// frozen, tagged objects (addresses as StrKey, 64-bit and larger integers as decimal strings) that the page renders
// with textContent and the matcher walks. Every operation type is decoded field by field (D110: the account-control
// ones, setOptions signers, weights and thresholds and accountMerge, are flagged by stellarAccountControl); ledger keys
// other than contract data, contract code and accounts keep their raw XDR so the page can show them by type. Malformed,
// trailing or over-deep input, or an operation type this library doesn't know, throws DecodeError.
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { base64 } from '@scure/base';
import { Address, SignerKey, StrKey, encodeMuxedAccountToAddress, scValToBigInt, xdr } from '@stellar/stellar-base';
import { DecodeError, fail } from './errors.ts';
import { decodeMessage } from './message.ts';

export const STELLAR_XDR_MAX_BYTES = 192 * 1024;
/** Deepest ScVal nesting and deepest authorization tree the decoders accept. */
export const STELLAR_MAX_DEPTH = 32;

export type StellarAddressType = 'account' | 'contract' | 'muxedAccount' | 'claimableBalance' | 'liquidityPool';

export type StellarScVal =
  | { readonly type: 'bool'; readonly value: boolean }
  | { readonly type: 'void' }
  | { readonly type: 'u32' | 'i32'; readonly value: number }
  | {
      readonly type: 'u64' | 'i64' | 'u128' | 'i128' | 'u256' | 'i256' | 'timepoint' | 'duration';
      /** Decimal. */
      readonly value: string;
    }
  | { readonly type: 'bytes'; readonly hex: string }
  /** `value` is null when the bytes aren't clean UTF-8 (then the page shows `hex`). */
  | { readonly type: 'string'; readonly value: string | null; readonly hex: string }
  | { readonly type: 'symbol'; readonly value: string }
  | { readonly type: 'address'; readonly addressType: StellarAddressType; readonly address: string }
  | { readonly type: 'vec'; readonly items: readonly StellarScVal[] }
  | { readonly type: 'map'; readonly entries: readonly { readonly key: StellarScVal; readonly value: StellarScVal }[] }
  /** Values that have no business in call arguments; shown as raw XDR. */
  | {
      readonly type: 'error' | 'contractInstance' | 'ledgerKeyContractInstance' | 'ledgerKeyNonce';
      readonly xdr: string;
    };

export interface StellarContractCall {
  readonly contract: string;
  readonly function: string;
  readonly args: readonly StellarScVal[];
}

export type StellarAuthorizedFunction =
  | ({ readonly type: 'contractFn' } & StellarContractCall)
  | { readonly type: 'createContract' | 'createContractV2'; readonly xdr: string };

export interface StellarInvocation {
  readonly function: StellarAuthorizedFunction;
  readonly subInvocations: readonly StellarInvocation[];
}

export interface StellarAuthEntry {
  readonly credentials:
    | { readonly type: 'sourceAccount' }
    | {
        readonly type: 'address';
        readonly address: string;
        readonly nonce: string;
        readonly signatureExpirationLedger: number;
      };
  readonly rootInvocation: StellarInvocation;
}

export type StellarHostFunction =
  | ({ readonly type: 'invokeContract' } & StellarContractCall)
  | { readonly type: 'createContract' | 'createContractV2' | 'uploadContractWasm'; readonly xdr: string };

export type StellarLedgerKey =
  | {
      readonly type: 'contractData';
      readonly contract: string;
      readonly durability: 'temporary' | 'persistent';
      readonly key: StellarScVal;
    }
  | { readonly type: 'contractCode'; readonly hash: string }
  | { readonly type: 'account'; readonly account: string }
  | {
      readonly type: 'trustline' | 'offer' | 'data' | 'claimableBalance' | 'liquidityPool' | 'configSetting' | 'ttl';
      readonly xdr: string;
    };

interface OpBase {
  /** The operation's own source (StrKey G… or M…), or null when it uses the transaction's. */
  readonly source: string | null;
  /** The operation's XDR, base64, for the page's raw view. */
  readonly xdr: string;
}

export type StellarOperation =
  | (OpBase & {
      readonly type: 'invokeHostFunction';
      readonly hostFunction: StellarHostFunction;
      readonly auth: readonly StellarAuthEntry[];
    })
  | (OpBase & { readonly type: 'extendFootprintTtl'; readonly extendTo: number })
  | (OpBase & { readonly type: 'restoreFootprint' })
  | (OpBase & {
      readonly type: 'changeTrust';
      /** `CODE:ISSUER` for a credit asset, or `pool_share` (the pool parameters stay in `xdr`). */
      readonly asset: string;
      /** Stroops, decimal. */
      readonly limit: string;
    })
  | (OpBase & {
      readonly type: 'payment';
      readonly destination: string;
      readonly asset: string;
      readonly amount: string;
    })
  | (OpBase & { readonly type: 'createAccount'; readonly destination: string; readonly startingBalance: string })
  | (OpBase & {
      readonly type: 'pathPaymentStrictReceive';
      readonly sendAsset: string;
      /** The most the source pays, in `sendAsset` stroops. */
      readonly sendMax: string;
      readonly destination: string;
      readonly destAsset: string;
      /** The exact amount the destination receives, in `destAsset` stroops. */
      readonly destAmount: string;
      /** Intermediate assets, in order. */
      readonly path: readonly string[];
    })
  | (OpBase & {
      readonly type: 'pathPaymentStrictSend';
      readonly sendAsset: string;
      /** The exact amount the source pays, in `sendAsset` stroops. */
      readonly sendAmount: string;
      readonly destination: string;
      readonly destAsset: string;
      /** The least the destination receives, in `destAsset` stroops. */
      readonly destMin: string;
      readonly path: readonly string[];
    })
  | (OpBase & {
      readonly type: 'manageSellOffer' | 'createPassiveSellOffer';
      readonly selling: string;
      readonly buying: string;
      /** Stroops of `selling`; "0" deletes the offer. */
      readonly amount: string;
      readonly price: StellarPrice;
      /** "0" for a new offer (always "0" for createPassiveSellOffer). */
      readonly offerId: string;
    })
  | (OpBase & {
      readonly type: 'manageBuyOffer';
      readonly selling: string;
      readonly buying: string;
      /** Stroops of `buying`; "0" deletes the offer. */
      readonly buyAmount: string;
      readonly price: StellarPrice;
      readonly offerId: string;
    })
  | (OpBase & {
      readonly type: 'setOptions';
      readonly inflationDest: string | null;
      /** Account flag bits (STELLAR_ACCOUNT_FLAGS), or null when not changed. */
      readonly clearFlags: number | null;
      readonly setFlags: number | null;
      /** Weight of the account's own key (the master key: the Hana key for a Hana account), 0 to 255. */
      readonly masterWeight: number | null;
      readonly lowThreshold: number | null;
      readonly medThreshold: number | null;
      readonly highThreshold: number | null;
      readonly homeDomain: StellarText | null;
      /** A signer added, re-weighted, or removed (weight 0). */
      readonly signer: StellarSigner | null;
    })
  | (OpBase & {
      readonly type: 'allowTrust';
      readonly trustor: string;
      readonly assetCode: string;
      /** Trust-line flag bits (STELLAR_TRUSTLINE_FLAGS): 0 revokes, 1 authorizes, 2 authorizes to maintain liabilities. */
      readonly authorize: number;
    })
  /** Closes the source account and sends its whole XLM balance to `destination`. */
  | (OpBase & { readonly type: 'accountMerge'; readonly destination: string })
  | (OpBase & { readonly type: 'inflation' | 'endSponsoringFutureReserves' })
  | (OpBase & {
      readonly type: 'manageData';
      readonly name: StellarText;
      /** Hex, or null to delete the entry. */
      readonly value: string | null;
    })
  | (OpBase & { readonly type: 'bumpSequence'; readonly bumpTo: string })
  | (OpBase & {
      readonly type: 'createClaimableBalance';
      readonly asset: string;
      readonly amount: string;
      readonly claimants: readonly StellarClaimant[];
    })
  | (OpBase & {
      readonly type: 'claimClaimableBalance' | 'clawbackClaimableBalance';
      /** The ClaimableBalanceID XDR, hex (Horizon's form). */
      readonly balanceId: string;
    })
  | (OpBase & { readonly type: 'beginSponsoringFutureReserves'; readonly sponsored: string })
  | (OpBase & {
      readonly type: 'revokeSponsorship';
      readonly target:
        | { readonly type: 'ledgerEntry'; readonly key: StellarLedgerKey }
        | { readonly type: 'signer'; readonly account: string; readonly signer: string };
    })
  | (OpBase & { readonly type: 'clawback'; readonly asset: string; readonly from: string; readonly amount: string })
  | (OpBase & {
      readonly type: 'setTrustLineFlags';
      readonly trustor: string;
      readonly asset: string;
      readonly clearFlags: number;
      readonly setFlags: number;
    })
  | (OpBase & {
      readonly type: 'liquidityPoolDeposit';
      /** Hex. */
      readonly poolId: string;
      readonly maxAmountA: string;
      readonly maxAmountB: string;
      readonly minPrice: StellarPrice;
      readonly maxPrice: StellarPrice;
    })
  | (OpBase & {
      readonly type: 'liquidityPoolWithdraw';
      readonly poolId: string;
      readonly amount: string;
      readonly minAmountA: string;
      readonly minAmountB: string;
    });

export type StellarOperationType = StellarOperation['type'];

/** A price as the XDR holds it: `n / d`. */
export interface StellarPrice {
  readonly n: number;
  readonly d: number;
}

/** A short XDR string (home domain, data name): `value` is null when it isn't display-safe text (then show `hex`). */
export interface StellarText {
  readonly value: string | null;
  readonly hex: string;
}

export interface StellarSigner {
  /** StrKey: G… (an ed25519 key), T… (a pre-authorized transaction), X… (a sha256 hash) or P… (a signed payload). */
  readonly key: string;
  readonly keyType: 'ed25519' | 'preAuthTx' | 'sha256Hash' | 'ed25519SignedPayload';
  /** 0 removes the signer. */
  readonly weight: number;
}

export interface StellarClaimant {
  readonly destination: string;
  /** True when the claimant can claim at any time. */
  readonly unconditional: boolean;
  /** The ClaimPredicate XDR, base64, for the page's raw view. */
  readonly predicate: string;
}

type FlagNames = readonly { readonly bit: number; readonly name: string }[];

/** Account flags (setOptions setFlags / clearFlags). */
export const STELLAR_ACCOUNT_FLAGS: FlagNames = Object.freeze([
  Object.freeze({ bit: 1, name: 'auth required' }),
  Object.freeze({ bit: 2, name: 'auth revocable' }),
  Object.freeze({ bit: 4, name: 'auth immutable' }),
  Object.freeze({ bit: 8, name: 'clawback enabled' }),
]);

/** Trust-line flags (allowTrust authorize, setTrustLineFlags). */
export const STELLAR_TRUSTLINE_FLAGS: FlagNames = Object.freeze([
  Object.freeze({ bit: 1, name: 'authorized' }),
  Object.freeze({ bit: 2, name: 'authorized to maintain liabilities' }),
  Object.freeze({ bit: 4, name: 'clawback enabled' }),
]);

/** Flag bits by name, with any unknown bits as a number: stellarFlagNames(3, STELLAR_ACCOUNT_FLAGS) = ['auth required', 'auth revocable']. */
export function stellarFlagNames(bits: number, names: FlagNames): string[] {
  const out = names.filter((f) => (bits & f.bit) !== 0).map((f) => f.name);
  const known = names.reduce((m, f) => m | f.bit, 0);
  const unknown = bits & ~known;
  if (unknown !== 0) out.push(`unknown bits ${unknown >>> 0}`);
  return out;
}

/**
 * How an operation changes who controls an account: a signer added, re-weighted or removed,
 * a signing threshold or the master key's weight changed, or the account merged away. The approval popup shows each
 * with a danger-level warning, and no auto-approve policy can cover them (policy/match.ts 'account_control').
 */
export type StellarAccountControl = 'signer' | 'thresholds' | 'master_weight' | 'merge';

/** What `op` changes about control of its source account; empty for every other operation. */
export function stellarAccountControl(op: StellarOperation): readonly StellarAccountControl[] {
  if (op.type === 'accountMerge') return ['merge'];
  if (op.type !== 'setOptions') return [];
  const out: StellarAccountControl[] = [];
  if (op.signer !== null) out.push('signer');
  if (op.lowThreshold !== null || op.medThreshold !== null || op.highThreshold !== null) out.push('thresholds');
  if (op.masterWeight !== null) out.push('master_weight');
  return out;
}

export interface StellarSorobanData {
  /** Stroops, decimal. */
  readonly resourceFee: string;
  readonly instructions: number;
  readonly readOnly: readonly StellarLedgerKey[];
  readonly readWrite: readonly StellarLedgerKey[];
}

export interface StellarTransaction {
  /** StrKey G… (or M… for a muxed source). */
  readonly source: string;
  readonly sequence: string;
  /** Maximum fee in stroops, decimal (Soroban resource fee included). */
  readonly fee: string;
  readonly memo:
    | { readonly type: 'none' }
    | { readonly type: 'text'; readonly value: string | null; readonly hex: string }
    | { readonly type: 'id'; readonly value: string }
    | { readonly type: 'hash' | 'return'; readonly hex: string };
  /** Unix seconds, decimal; `maxTime` "0" means no upper bound. */
  readonly timeBounds: { readonly minTime: string; readonly maxTime: string } | null;
  readonly ledgerBounds: { readonly minLedger: number; readonly maxLedger: number } | null;
  /** Other preconditions (minSeqNum, minSeqAge, minSeqLedgerGap, extraSigners), set when present. */
  readonly otherPreconditions: boolean;
  readonly operations: readonly StellarOperation[];
  readonly soroban: StellarSorobanData | null;
}

export type DecodedStellarEnvelope =
  | { readonly envelope: 'tx' | 'tx_v0'; readonly tx: StellarTransaction; readonly signatures: number }
  | {
      readonly envelope: 'fee_bump';
      readonly feeSource: string;
      /** Stroops, decimal. */
      readonly fee: string;
      readonly tx: StellarTransaction;
      readonly signatures: number;
    };

export interface DecodedStellarAuthPreimage {
  /** sha256(network passphrase), hex. Checked against the request's passphrase. */
  readonly networkId: string;
  readonly nonce: string;
  readonly signatureExpirationLedger: number;
  readonly invocation: StellarInvocation;
}

// --- helpers ---

function parseXdr<T>(bytes: Uint8Array, what: string, parse: (input: string, format: 'base64') => T): T {
  if (bytes.length === 0) fail('malformed', `Empty ${what}`);
  if (bytes.length > STELLAR_XDR_MAX_BYTES) fail('too_large', `${what} too large`);
  try {
    return parse(base64.encode(bytes), 'base64');
  } catch {
    fail('malformed', `Not a valid ${what} XDR`);
  }
}

/** Runs a decoder, turning anything the XDR library throws on an unexpected arm into DecodeError('malformed'). */
function guarded<T>(what: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof DecodeError) throw e;
    if (e instanceof RangeError) fail('too_large', `${what} nested too deep`);
    fail('malformed', `Could not decode ${what}`);
  }
}

const u8 = (b: Uint8Array): Uint8Array => new Uint8Array(b);
const deepFreeze = <T>(v: T): T => {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
};

function stringBytes(v: string | Uint8Array): Uint8Array {
  return typeof v === 'string' ? new TextEncoder().encode(v) : u8(v);
}

function scAddress(a: xdr.ScAddress): { addressType: StellarAddressType; address: string } {
  const types: Record<string, StellarAddressType> = {
    scAddressTypeAccount: 'account',
    scAddressTypeContract: 'contract',
    scAddressTypeMuxedAccount: 'muxedAccount',
    scAddressTypeClaimableBalance: 'claimableBalance',
    scAddressTypeLiquidityPool: 'liquidityPool',
  };
  const addressType = types[a.switch().name];
  if (addressType === undefined) fail('unsupported', 'Unknown ScAddress type');
  return { addressType, address: Address.fromScAddress(a).toString() };
}

const muxed = (m: xdr.MuxedAccount): string => encodeMuxedAccountToAddress(m, true);

function accountId(a: xdr.AccountId): string {
  return StrKey.encodeEd25519PublicKey(a.ed25519());
}

const SYMBOL = /^[A-Za-z0-9_]{1,32}$/u;

function symbol(v: string | Uint8Array, what: string): string {
  const s = typeof v === 'string' ? v : new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(v);
  if (!SYMBOL.test(s)) fail('invalid_value', `Bad Soroban symbol in ${what}`);
  return s;
}

/** Decodes one ScVal, depth-capped. */
export function decodeScVal(v: xdr.ScVal, depth = 0): StellarScVal {
  if (depth > STELLAR_MAX_DEPTH) fail('too_large', 'ScVal nested too deep');
  const name = v.switch().name;
  switch (name) {
    case 'scvBool':
      return { type: 'bool', value: v.b() };
    case 'scvVoid':
      return { type: 'void' };
    case 'scvU32':
      return { type: 'u32', value: v.u32() };
    case 'scvI32':
      return { type: 'i32', value: v.i32() };
    case 'scvU64':
    case 'scvI64':
    case 'scvTimepoint':
    case 'scvDuration':
    case 'scvU128':
    case 'scvI128':
    case 'scvU256':
    case 'scvI256': {
      const type = (name.slice(3, 4).toLowerCase() + name.slice(4)) as
        | 'u64'
        | 'i64'
        | 'timepoint'
        | 'duration'
        | 'u128'
        | 'i128'
        | 'u256'
        | 'i256';
      return { type, value: scValToBigInt(v).toString() };
    }
    case 'scvBytes':
      return { type: 'bytes', hex: bytesToHex(v.bytes()) };
    case 'scvString': {
      const bytes = stringBytes(v.str());
      const m = decodeMessage(bytes);
      return { type: 'string', value: m.text, hex: bytesToHex(bytes) };
    }
    case 'scvSymbol':
      return { type: 'symbol', value: symbol(v.sym(), 'a symbol value') };
    case 'scvAddress':
      return { type: 'address', ...scAddress(v.address()) };
    case 'scvVec': {
      const items = v.vec();
      if (items === null) fail('invalid_value', 'ScVal vec is None');
      return { type: 'vec', items: items.map((x) => decodeScVal(x, depth + 1)) };
    }
    case 'scvMap': {
      const entries = v.map();
      if (entries === null) fail('invalid_value', 'ScVal map is None');
      return {
        type: 'map',
        entries: entries.map((e) => ({ key: decodeScVal(e.key(), depth + 1), value: decodeScVal(e.val(), depth + 1) })),
      };
    }
    case 'scvError':
      return { type: 'error', xdr: v.toXDR('base64') };
    case 'scvContractInstance':
      return { type: 'contractInstance', xdr: v.toXDR('base64') };
    case 'scvLedgerKeyContractInstance':
      return { type: 'ledgerKeyContractInstance', xdr: v.toXDR('base64') };
    case 'scvLedgerKeyNonce':
      return { type: 'ledgerKeyNonce', xdr: v.toXDR('base64') };
    default:
      fail('unsupported', `Unknown ScVal type ${name}`);
  }
}

function contractCall(args: xdr.InvokeContractArgs): StellarContractCall {
  const contract = scAddress(args.contractAddress());
  if (contract.addressType !== 'contract') fail('invalid_value', 'Invocation target is not a contract');
  return {
    contract: contract.address,
    function: symbol(args.functionName(), 'a function name'),
    args: args.args().map((a) => decodeScVal(a)),
  };
}

function invocation(inv: xdr.SorobanAuthorizedInvocation, depth: number): StellarInvocation {
  if (depth > STELLAR_MAX_DEPTH) fail('too_large', 'Authorization tree nested too deep');
  const fn = inv.function();
  let decoded: StellarAuthorizedFunction;
  switch (fn.switch().name) {
    case 'sorobanAuthorizedFunctionTypeContractFn':
      decoded = { type: 'contractFn', ...contractCall(fn.contractFn()) };
      break;
    case 'sorobanAuthorizedFunctionTypeCreateContractHostFn':
      decoded = { type: 'createContract', xdr: fn.toXDR('base64') };
      break;
    case 'sorobanAuthorizedFunctionTypeCreateContractV2HostFn':
      decoded = { type: 'createContractV2', xdr: fn.toXDR('base64') };
      break;
    default:
      fail('unsupported', 'Unknown authorized function type');
  }
  return { function: decoded, subInvocations: inv.subInvocations().map((s) => invocation(s, depth + 1)) };
}

function authEntry(e: xdr.SorobanAuthorizationEntry): StellarAuthEntry {
  const c = e.credentials();
  let credentials: StellarAuthEntry['credentials'];
  switch (c.switch().name) {
    case 'sorobanCredentialsSourceAccount':
      credentials = { type: 'sourceAccount' };
      break;
    case 'sorobanCredentialsAddress': {
      const a = c.address();
      credentials = {
        type: 'address',
        address: scAddress(a.address()).address,
        nonce: a.nonce().toString(),
        signatureExpirationLedger: a.signatureExpirationLedger(),
      };
      break;
    }
    default:
      fail('unsupported', 'Unknown Soroban credentials type');
  }
  return { credentials, rootInvocation: invocation(e.rootInvocation(), 0) };
}

const ASSET_CODE = /^[A-Za-z0-9]+$/u;

function assetCode(raw: Uint8Array, alphanum12: boolean): string {
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0) end--;
  const code = new TextDecoder('latin1').decode(raw.subarray(0, end));
  const [min, max] = alphanum12 ? [5, 12] : [1, 4];
  if (!ASSET_CODE.test(code) || code.length < min || code.length > max) fail('invalid_value', 'Bad asset code');
  return code;
}

function credit(kind: string, a: xdr.AlphaNum4 | xdr.AlphaNum12): string {
  return `${assetCode(u8(a.assetCode()), kind === 'assetTypeCreditAlphanum12')}:${accountId(a.issuer())}`;
}

function asset(a: xdr.Asset): string {
  const kind = a.switch().name;
  if (kind === 'assetTypeNative') return 'native';
  if (kind === 'assetTypeCreditAlphanum4') return credit(kind, a.alphaNum4());
  if (kind === 'assetTypeCreditAlphanum12') return credit(kind, a.alphaNum12());
  fail('unsupported', 'Unknown asset type');
}

function changeTrustAsset(a: xdr.ChangeTrustAsset): string {
  const kind = a.switch().name;
  if (kind === 'assetTypeCreditAlphanum4') return credit(kind, a.alphaNum4());
  if (kind === 'assetTypeCreditAlphanum12') return credit(kind, a.alphaNum12());
  if (kind === 'assetTypePoolShare') return 'pool_share';
  if (kind === 'assetTypeNative') fail('invalid_value', 'changeTrust on the native asset');
  fail('unsupported', 'Unknown change-trust asset type');
}

function ledgerKey(k: xdr.LedgerKey): StellarLedgerKey {
  const type = k.switch().name;
  switch (type) {
    case 'contractData': {
      const d = k.contractData();
      return {
        type: 'contractData',
        contract: scAddress(d.contract()).address,
        durability: d.durability().name === 'temporary' ? 'temporary' : 'persistent',
        key: decodeScVal(d.key()),
      };
    }
    case 'contractCode':
      return { type: 'contractCode', hash: bytesToHex(k.contractCode().hash()) };
    case 'account':
      return { type: 'account', account: accountId(k.account().accountId()) };
    default:
      return { type: type as Extract<StellarLedgerKey, { xdr: string }>['type'], xdr: k.toXDR('base64') };
  }
}

function operation(op: xdr.Operation): StellarOperation {
  const sourceAccount = op.sourceAccount();
  const base = { source: sourceAccount ? muxed(sourceAccount) : null, xdr: op.toXDR('base64') };
  const body = op.body();
  const type = body.switch().name;
  switch (type) {
    case 'invokeHostFunction': {
      const o = body.invokeHostFunctionOp();
      const hf = o.hostFunction();
      let hostFunction: StellarHostFunction;
      switch (hf.switch().name) {
        case 'hostFunctionTypeInvokeContract':
          hostFunction = { type: 'invokeContract', ...contractCall(hf.invokeContract()) };
          break;
        case 'hostFunctionTypeCreateContract':
          hostFunction = { type: 'createContract', xdr: hf.toXDR('base64') };
          break;
        case 'hostFunctionTypeCreateContractV2':
          hostFunction = { type: 'createContractV2', xdr: hf.toXDR('base64') };
          break;
        case 'hostFunctionTypeUploadContractWasm':
          hostFunction = { type: 'uploadContractWasm', xdr: hf.toXDR('base64') };
          break;
        default:
          fail('unsupported', 'Unknown host function type');
      }
      return { ...base, type, hostFunction, auth: o.auth().map(authEntry) };
    }
    case 'extendFootprintTtl':
      return { ...base, type, extendTo: body.extendFootprintTtlOp().extendTo() };
    case 'restoreFootprint':
      return { ...base, type };
    case 'changeTrust': {
      const o = body.changeTrustOp();
      return { ...base, type, asset: changeTrustAsset(o.line()), limit: o.limit().toString() };
    }
    case 'payment': {
      const o = body.paymentOp();
      return {
        ...base,
        type,
        destination: muxed(o.destination()),
        asset: asset(o.asset()),
        amount: o.amount().toString(),
      };
    }
    case 'createAccount': {
      const o = body.createAccountOp();
      return {
        ...base,
        type,
        destination: accountId(o.destination()),
        startingBalance: o.startingBalance().toString(),
      };
    }
    case 'pathPaymentStrictReceive': {
      const o = body.pathPaymentStrictReceiveOp();
      return {
        ...base,
        type,
        sendAsset: asset(o.sendAsset()),
        sendMax: o.sendMax().toString(),
        destination: muxed(o.destination()),
        destAsset: asset(o.destAsset()),
        destAmount: o.destAmount().toString(),
        path: o.path().map(asset),
      };
    }
    case 'pathPaymentStrictSend': {
      const o = body.pathPaymentStrictSendOp();
      return {
        ...base,
        type,
        sendAsset: asset(o.sendAsset()),
        sendAmount: o.sendAmount().toString(),
        destination: muxed(o.destination()),
        destAsset: asset(o.destAsset()),
        destMin: o.destMin().toString(),
        path: o.path().map(asset),
      };
    }
    case 'manageSellOffer': {
      const o = body.manageSellOfferOp();
      return {
        ...base,
        type,
        selling: asset(o.selling()),
        buying: asset(o.buying()),
        amount: o.amount().toString(),
        price: price(o.price()),
        offerId: o.offerId().toString(),
      };
    }
    case 'createPassiveSellOffer': {
      const o = body.createPassiveSellOfferOp();
      return {
        ...base,
        type,
        selling: asset(o.selling()),
        buying: asset(o.buying()),
        amount: o.amount().toString(),
        price: price(o.price()),
        offerId: '0',
      };
    }
    case 'manageBuyOffer': {
      const o = body.manageBuyOfferOp();
      return {
        ...base,
        type,
        selling: asset(o.selling()),
        buying: asset(o.buying()),
        buyAmount: o.buyAmount().toString(),
        price: price(o.price()),
        offerId: o.offerId().toString(),
      };
    }
    case 'setOptions': {
      const o = body.setOptionsOp();
      const inflationDest = o.inflationDest();
      const homeDomain = o.homeDomain();
      const signer = o.signer();
      return {
        ...base,
        type,
        // Absent XDR optionals read back as undefined (or null): both become null here.
        inflationDest: inflationDest ? accountId(inflationDest) : null,
        clearFlags: o.clearFlags() ?? null,
        setFlags: o.setFlags() ?? null,
        masterWeight: o.masterWeight() ?? null,
        lowThreshold: o.lowThreshold() ?? null,
        medThreshold: o.medThreshold() ?? null,
        highThreshold: o.highThreshold() ?? null,
        homeDomain: homeDomain === null || homeDomain === undefined ? null : text(homeDomain),
        signer: signer ? { ...signerKey(signer.key()), weight: signer.weight() } : null,
      };
    }
    case 'allowTrust': {
      const o = body.allowTrustOp();
      const a = o.asset();
      const twelve = a.switch().name === 'assetTypeCreditAlphanum12';
      return {
        ...base,
        type,
        trustor: accountId(o.trustor()),
        assetCode: assetCode(u8(twelve ? a.assetCode12() : a.assetCode4()), twelve),
        authorize: o.authorize(),
      };
    }
    case 'accountMerge':
      return { ...base, type, destination: muxed(body.destination()) };
    case 'inflation':
    case 'endSponsoringFutureReserves':
      return { ...base, type };
    case 'manageData': {
      const o = body.manageDataOp();
      const value = o.dataValue();
      return { ...base, type, name: text(o.dataName()), value: value ? bytesToHex(value) : null };
    }
    case 'bumpSequence':
      return { ...base, type, bumpTo: body.bumpSequenceOp().bumpTo().toString() };
    case 'createClaimableBalance': {
      const o = body.createClaimableBalanceOp();
      return {
        ...base,
        type,
        asset: asset(o.asset()),
        amount: o.amount().toString(),
        claimants: o.claimants().map((c) => {
          const v0 = c.v0();
          const predicate = v0.predicate();
          return {
            destination: accountId(v0.destination()),
            unconditional: predicate.switch().name === 'claimPredicateUnconditional',
            predicate: predicate.toXDR('base64'),
          };
        }),
      };
    }
    case 'claimClaimableBalance':
      return { ...base, type, balanceId: bytesToHex(body.claimClaimableBalanceOp().balanceId().toXDR()) };
    case 'clawbackClaimableBalance':
      return { ...base, type, balanceId: bytesToHex(body.clawbackClaimableBalanceOp().balanceId().toXDR()) };
    case 'beginSponsoringFutureReserves':
      return { ...base, type, sponsored: accountId(body.beginSponsoringFutureReservesOp().sponsoredId()) };
    case 'revokeSponsorship': {
      const o = body.revokeSponsorshipOp();
      if (o.switch().name === 'revokeSponsorshipLedgerEntry') {
        return { ...base, type, target: { type: 'ledgerEntry', key: ledgerKey(o.ledgerKey()) } };
      }
      const s = o.signer();
      return {
        ...base,
        type,
        target: { type: 'signer', account: accountId(s.accountId()), signer: signerKey(s.signerKey()).key },
      };
    }
    case 'clawback': {
      const o = body.clawbackOp();
      return { ...base, type, asset: asset(o.asset()), from: muxed(o.from()), amount: o.amount().toString() };
    }
    case 'setTrustLineFlags': {
      const o = body.setTrustLineFlagsOp();
      return {
        ...base,
        type,
        trustor: accountId(o.trustor()),
        asset: asset(o.asset()),
        clearFlags: o.clearFlags(),
        setFlags: o.setFlags(),
      };
    }
    case 'liquidityPoolDeposit': {
      const o = body.liquidityPoolDepositOp();
      return {
        ...base,
        type,
        poolId: poolId(o.liquidityPoolId()),
        maxAmountA: o.maxAmountA().toString(),
        maxAmountB: o.maxAmountB().toString(),
        minPrice: price(o.minPrice()),
        maxPrice: price(o.maxPrice()),
      };
    }
    case 'liquidityPoolWithdraw': {
      const o = body.liquidityPoolWithdrawOp();
      return {
        ...base,
        type,
        poolId: poolId(o.liquidityPoolId()),
        amount: o.amount().toString(),
        minAmountA: o.minAmountA().toString(),
        minAmountB: o.minAmountB().toString(),
      };
    }
    default:
      fail('unsupported', `Unknown operation type ${type}`);
  }
}

const price = (p: xdr.Price): StellarPrice => ({ n: p.n(), d: p.d() });
// PoolId is typed as Hash (an Opaque[] typedef) but is a Buffer at run time.
const poolId = (id: xdr.PoolId): string => bytesToHex(u8(id as unknown as Uint8Array));

function text(v: string | Uint8Array): StellarText {
  const bytes = stringBytes(v);
  return { value: decodeMessage(bytes).text, hex: bytesToHex(bytes) };
}

const SIGNER_KEY_TYPES: Record<string, StellarSigner['keyType']> = {
  signerKeyTypeEd25519: 'ed25519',
  signerKeyTypePreAuthTx: 'preAuthTx',
  signerKeyTypeHashX: 'sha256Hash',
  signerKeyTypeEd25519SignedPayload: 'ed25519SignedPayload',
};

function signerKey(k: xdr.SignerKey): Pick<StellarSigner, 'key' | 'keyType'> {
  const keyType = SIGNER_KEY_TYPES[k.switch().name];
  if (keyType === undefined) fail('unsupported', 'Unknown signer key type');
  return { key: SignerKey.encodeSignerKey(k), keyType };
}

function memo(m: xdr.Memo): StellarTransaction['memo'] {
  switch (m.switch().name) {
    case 'memoNone':
      return { type: 'none' };
    case 'memoText': {
      const bytes = stringBytes(m.text());
      return { type: 'text', value: decodeMessage(bytes).text, hex: bytesToHex(bytes) };
    }
    case 'memoId':
      return { type: 'id', value: m.id().toString() };
    case 'memoHash':
      return { type: 'hash', hex: bytesToHex(m.hash()) };
    case 'memoReturn':
      return { type: 'return', hex: bytesToHex(m.retHash()) };
    default:
      fail('unsupported', 'Unknown memo type');
  }
}

const timeBounds = (t: xdr.TimeBounds | null) =>
  t ? { minTime: t.minTime().toString(), maxTime: t.maxTime().toString() } : null;

function transactionV1(tx: xdr.Transaction): StellarTransaction {
  const cond = tx.cond();
  let tb: StellarTransaction['timeBounds'] = null;
  let lb: StellarTransaction['ledgerBounds'] = null;
  let otherPreconditions = false;
  switch (cond.switch().name) {
    case 'precondNone':
      break;
    case 'precondTime':
      tb = timeBounds(cond.timeBounds());
      break;
    case 'precondV2': {
      const v2 = cond.v2();
      tb = timeBounds(v2.timeBounds());
      const l = v2.ledgerBounds();
      lb = l ? { minLedger: l.minLedger(), maxLedger: l.maxLedger() } : null;
      otherPreconditions =
        v2.minSeqNum() !== null ||
        v2.minSeqAge().toString() !== '0' ||
        v2.minSeqLedgerGap() !== 0 ||
        v2.extraSigners().length > 0;
      break;
    }
    default:
      fail('unsupported', 'Unknown precondition type');
  }
  const ext = tx.ext();
  let soroban: StellarSorobanData | null = null;
  if (ext.switch() === 1) {
    const data = ext.sorobanData();
    const r = data.resources();
    soroban = {
      resourceFee: data.resourceFee().toString(),
      instructions: r.instructions(),
      readOnly: r.footprint().readOnly().map(ledgerKey),
      readWrite: r.footprint().readWrite().map(ledgerKey),
    };
  }
  return {
    source: muxed(tx.sourceAccount()),
    sequence: tx.seqNum().toString(),
    fee: String(tx.fee()),
    memo: memo(tx.memo()),
    timeBounds: tb,
    ledgerBounds: lb,
    otherPreconditions,
    operations: tx.operations().map(operation),
    soroban,
  };
}

function transactionV0(tx: xdr.TransactionV0): StellarTransaction {
  return {
    source: StrKey.encodeEd25519PublicKey(tx.sourceAccountEd25519()),
    sequence: tx.seqNum().toString(),
    fee: String(tx.fee()),
    memo: memo(tx.memo()),
    timeBounds: timeBounds(tx.timeBounds()),
    ledgerBounds: null,
    otherPreconditions: false,
    operations: tx.operations().map(operation),
    soroban: null,
  };
}

/**
 * Decodes a `TransactionEnvelope` (the bytes of the `xdr` a dapp passes to `stellar_signTransaction`). The network
 * passphrase isn't in the bytes; the page shows the request's.
 */
export function decodeStellarTransaction(bytes: Uint8Array): DecodedStellarEnvelope {
  const env = parseXdr(bytes, 'transaction envelope', (s, f) => xdr.TransactionEnvelope.fromXDR(s, f));
  return deepFreeze(
    guarded('transaction envelope', (): DecodedStellarEnvelope => {
      switch (env.switch().name) {
        case 'envelopeTypeTx': {
          const v1 = env.v1();
          return { envelope: 'tx', tx: transactionV1(v1.tx()), signatures: v1.signatures().length };
        }
        case 'envelopeTypeTxV0': {
          const v0 = env.v0();
          return { envelope: 'tx_v0', tx: transactionV0(v0.tx()), signatures: v0.signatures().length };
        }
        case 'envelopeTypeTxFeeBump': {
          const fb = env.feeBump();
          const t = fb.tx();
          const inner = t.innerTx();
          if (inner.switch().name !== 'envelopeTypeTx') fail('unsupported', 'Unknown fee-bump inner transaction');
          return {
            envelope: 'fee_bump',
            feeSource: muxed(t.feeSource()),
            fee: t.fee().toString(),
            tx: transactionV1(inner.v1().tx()),
            signatures: fb.signatures().length,
          };
        }
        default:
          fail('unsupported', 'Not a transaction envelope');
      }
    }),
  );
}

/** sha256(utf8(passphrase)), the Stellar network ID. */
export const stellarNetworkId = (networkPassphrase: string): Uint8Array =>
  sha256(new TextEncoder().encode(networkPassphrase));

/**
 * Decodes the `HashIdPreimage` a `stellar_signAuthEntry` signs. It must be `ENVELOPE_TYPE_SOROBAN_AUTHORIZATION` for
 * `networkPassphrase`'s network; anything else throws ('unsupported' or 'network_mismatch').
 */
export function decodeStellarAuthPreimage(bytes: Uint8Array, networkPassphrase: string): DecodedStellarAuthPreimage {
  const pre = parseXdr(bytes, 'authorization preimage', (s, f) => xdr.HashIdPreimage.fromXDR(s, f));
  return deepFreeze(
    guarded('authorization preimage', () => {
      if (pre.switch().name !== 'envelopeTypeSorobanAuthorization') {
        fail('unsupported', 'Preimage is not a Soroban authorization');
      }
      const a = pre.sorobanAuthorization();
      const networkId = bytesToHex(a.networkId());
      if (networkId !== bytesToHex(stellarNetworkId(networkPassphrase))) {
        fail('network_mismatch', 'Authorization is for another network');
      }
      return {
        networkId,
        nonce: a.nonce().toString(),
        signatureExpirationLedger: a.signatureExpirationLedger(),
        invocation: invocation(a.invocation(), 0),
      };
    }),
  );
}
