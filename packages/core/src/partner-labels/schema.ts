// The partner label document, `journear-labels/1` (D892): what a partner declares about its own contract's calls so
// the approval window can read them in plain words, in the partner's voice. Modelled on ERC-7730's three parts
// (context, metadata, display) with stricter rules: a fixed verb list, a short checked object phrase, typed slots
// filled only from the request's true values, and constraints the request must meet or the entry doesn't match.
//
// This module is the strict parser: text in, a frozen document or every reason it is refused out. Unknown keys,
// wrong types, duplicate keys, oversize documents and anything not in v1 are refused, each with a stable code and a
// plain message a partner can act on (the console shows them, a later piece). The server adds the owning org, the
// apps, the environment, the version and when it takes effect; none of that is in the partner's document.
// Pure: no network, no clock.
import { isNearAccountId, isStellarAddress } from '../addresses.ts';
import { base58 } from '@scure/base';
import { DecodeError } from '../decode/errors.ts';
import { JsonNumber, type StrictJson, isJsonObject, parseStrictJson } from '../decode/json.ts';
import { STELLAR_MAINNET_PASSPHRASE } from '../networks.ts';
import { STELLAR_TESTNET_PASSPHRASE } from '../verified-contracts.ts';
import { StrKey } from '@stellar/stellar-base';
import { type PartnerTextCode, type PartnerTextRole, foldLetters, partnerTextProblem } from './text-rules.ts';
import { KNOWN_TOKENS } from '../known-tokens.ts';
import { VERIFIED_CONTRACTS } from '../verified-contracts.ts';
import { REVIEWED_NEAR_DEPLOYS } from '../reviewed-near-calls.ts';
import { sha256, toHex, utf8 } from '../bytes.ts';
import { type PartnerConnector, type PartnerVerb, PARTNER_CONNECTORS, SOFT_VERBS, isPartnerConnector, isPartnerVerb } from './words.ts';

export const LABEL_SCHEMA = 'journear-labels/1';

/**
 * The limits. A document is stored with the app and sent with the vault's app config on every load,
 * and the window must show every field it declares, so it is small by design.
 */
export const LABEL_LIMITS = Object.freeze({
  /** The document's UTF-8 size. */
  documentBytes: 16 * 1024,
  /** JSON nesting. */
  depth: 8,
  /** Formats (methods or functions) per document. */
  formats: 16,
  /** Declared arguments per format. */
  args: 16,
  /** Fields per format: each is a row the window shows. */
  fields: 8,
  /** Sentence parts, of which at most `sentenceFields` slots and `connectors` joining words. */
  sentenceParts: 8,
  sentenceFields: 4,
  connectors: 3,
  /** Enumerations, values per enumeration, a value's raw key length. */
  enums: 8,
  enumValues: 32,
  enumKeyChars: 64,
  /** Address book entries. */
  addressBook: 16,
  /** Values in a `oneOf`. */
  oneOf: 16,
  /** The longest `maxLength` a string argument may declare. */
  stringMaxLength: 256,
  /** A NEAR method or Soroban function name. */
  methodChars: 64,
  /** The largest `count` bound. */
  countMax: 1_000_000,
});

// ---- the document's types ----

export type NearNetwork = 'testnet' | 'mainnet';

export type LabelContext =
  | { readonly chain: 'near'; readonly network: NearNetwork; readonly account: string; readonly codeHash: string }
  | { readonly chain: 'soroban'; readonly networkPassphrase: string; readonly contract: string; readonly wasmHash: string }
  | { readonly chain: 'stellar'; readonly networkPassphrase: string };

export interface AddressBookEntry {
  readonly account: string;
  readonly name: string;
}

export interface LabelMetadata {
  /** By enumeration name: raw value → the partner's label for it. Null-prototype objects. */
  readonly enums: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly addressBook: readonly AddressBookEntry[];
}

/** A declared argument's type and the constraints its value must meet. */
export type ArgSpec =
  | { readonly type: 'string' | 'symbol'; readonly maxLength?: number; readonly oneOf?: readonly string[]; readonly optional?: true }
  | { readonly type: 'accountId' | 'address'; readonly isSelf?: true; readonly inAddressBook?: true; readonly oneOf?: readonly string[]; readonly optional?: true }
  | {
      readonly type: 'u128' | 'u64' | 'i128' | 'i64' | 'timepoint' | 'duration';
      /** Decimal strings. */
      readonly atLeast?: string;
      readonly atMost?: string;
      readonly optional?: true;
    }
  | { readonly type: 'integer' | 'u32' | 'i32'; readonly min?: number; readonly max?: number; readonly optional?: true }
  | { readonly type: 'boolean' | 'bool'; readonly equals?: boolean; readonly optional?: true };

export type ArgType = ArgSpec['type'];

/** Which way the request reaches the chain: someone else sends it (a NEAR delegate action, a Soroban authorization), or the user does. */
export type RelayRule = 'relayed' | 'direct' | 'either';

/** A NEAR function call's constraints. */
export interface NearCallSpec {
  /** yoctoNEAR, decimal; absent means exactly 0. */
  readonly deposit: { readonly exactly: string } | { readonly atMost: string };
  /** Gas units, decimal. */
  readonly gasAtMost?: string;
  readonly relayed: RelayRule;
  /** By argument name, in the order declared. */
  readonly args: readonly (ArgSpec & { readonly name: string })[];
}

/** A Soroban contract call's constraints: positional arguments, each named by the partner. */
export interface SorobanCallSpec {
  /** Stroops, decimal: the transaction's fee (no bound for an authorization, which pays none). */
  readonly feeAtMost?: string;
  readonly relayed: RelayRule;
  readonly args: readonly (ArgSpec & { readonly name: string })[];
}

/** A classic Stellar payment's constraints. Its destination must be in the address book (v1). */
export interface PaymentCallSpec {
  /** `native` or `CODE:ISSUER`; absent: any asset. */
  readonly assets?: readonly string[];
  /** Stroops, decimal. */
  readonly amountAtMost?: string;
  readonly memo: 'none' | 'text' | 'id';
  readonly feeAtMost?: string;
}

export type FieldFormat = 'enum' | 'tokenAmount' | 'nativeAmount' | 'account' | 'date' | 'duration' | 'count' | 'itemId' | 'orderNumber';
export type TimeUnit = 'seconds' | 'milliseconds' | 'nanoseconds';

export type FieldParams =
  | { readonly format: 'enum'; readonly enum: string }
  | { readonly format: 'tokenAmount'; readonly token: string }
  | { readonly format: 'tokenAmount'; readonly tokenPath: string }
  | { readonly format: 'date' | 'duration'; readonly unit: TimeUnit }
  | { readonly format: 'count'; readonly min: number; readonly max: number }
  | { readonly format: 'nativeAmount' | 'account' | 'itemId' | 'orderNumber' };

export interface LabelField {
  /** `args.<name>`, `deposit` (NEAR) or `memo` (a Stellar payment). */
  readonly path: string;
  /** The partner's label for the row. */
  readonly label: string;
  readonly params: FieldParams;
}

export type SentencePartSpec = { readonly kind: 'verb' } | { readonly kind: 'object' } | { readonly kind: 'field'; readonly path: string } | { readonly kind: 'word'; readonly word: PartnerConnector };

export interface LabelFormatBase {
  readonly intent: { readonly verb: PartnerVerb; readonly object?: string };
  readonly sentence: readonly SentencePartSpec[];
  readonly fields: readonly LabelField[];
}

export type LabelFormat =
  | (LabelFormatBase & { readonly chain: 'near'; readonly call: NearCallSpec })
  | (LabelFormatBase & { readonly chain: 'soroban'; readonly call: SorobanCallSpec })
  | (LabelFormatBase & { readonly chain: 'stellar'; readonly call: PaymentCallSpec });

export interface LabelDocument {
  readonly schema: typeof LABEL_SCHEMA;
  readonly context: LabelContext;
  readonly metadata: LabelMetadata;
  /** By NEAR method name, Soroban function name, or `payment` (classic Stellar). Null-prototype object. */
  readonly formats: Readonly<Record<string, LabelFormat>>;
}

// ---- refusals ----

export type LabelErrorCode =
  | 'not_json'
  | 'duplicate_key'
  | 'too_large'
  | 'too_deep'
  | 'unknown_key'
  | 'not_in_v1'
  | 'missing_key'
  | 'wrong_type'
  | 'bad_schema'
  | 'bad_context'
  | 'bad_network'
  | 'bad_account'
  | 'bad_code_hash'
  | 'bad_method'
  | 'bad_number'
  | 'too_many'
  | 'bad_verb'
  | 'bad_sentence'
  | 'bad_field'
  | 'bad_params'
  | 'unknown_enum'
  | 'duplicate'
  | 'journear_reads_this'
  | 'reserved_method'
  | 'field_required'
  | 'sentence_text'
  | PartnerTextCode;

export interface LabelError {
  readonly code: LabelErrorCode;
  /** Where in the document: `display.formats.collect.fields[0].label`. Never a value. */
  readonly path: string;
  readonly message: string;
}

export type LabelParseResult = { readonly ok: true; readonly document: LabelDocument } | { readonly ok: false; readonly errors: readonly LabelError[] };

/** At most this many errors are reported (the rest are hidden behind the first ones). */
export const LABEL_MAX_ERRORS = 20;

/**
 * Keys of ERC-7730 or of a later version that v1 refuses with a message that says so, rather than "unknown key":
 * hiding fields, free intent text, nested calldata, other bindings.
 */
const LATER_KEYS: Readonly<Record<string, string>> = Object.freeze({
  visible: 'Every field is always shown: hiding fields isn’t allowed.',
  excluded: 'Every argument is always shown: excluding arguments isn’t allowed.',
  interpolatedIntent: 'The window builds the sentence from "sentence"; free sentence text isn’t allowed.',
  calldata: 'Nested calls aren’t in v1.',
  factory: 'Bind to one contract (an account id or a contract id and its code hash); factories aren’t in v1.',
  deployments: 'EVM contracts aren’t in v1 (NEAR and Stellar first).',
  eip712: 'EIP-712 messages aren’t in v1.',
  token: 'A token’s symbol and decimals come only from Journear’s known-token list.',
  constants: 'Constants aren’t in v1.',
  maps: 'Maps aren’t in v1.',
  owner: 'The owner is set by Journear from your account, not in the document.',
  unknownValue: 'An enumeration value that isn’t listed always means the description doesn’t match.',
  description: 'Free text isn’t allowed; use the verb, the object and the fields.',
});

const EVM_KEYS = new Set(['evm', 'eip155', 'contract']);

// ---- the reader ----

class Reader {
  readonly errors: LabelError[] = [];

  add(code: LabelErrorCode, path: string, message: string): void {
    if (this.errors.length < LABEL_MAX_ERRORS) this.errors.push(Object.freeze({ code, path, message }));
  }

  /** The object at `path`, with only `allowed` keys and every `required` one, or null (errors added). */
  object(v: StrictJson | undefined, path: string, allowed: readonly string[], required: readonly string[] = []): Record<string, StrictJson> | null {
    if (!isJsonObject(v)) {
      this.add('wrong_type', path, 'This must be an object ({ … }).');
      return null;
    }
    for (const k of Object.keys(v)) {
      if (allowed.includes(k)) continue;
      const later = LATER_KEYS[k];
      if (later !== undefined) this.add('not_in_v1', join(path, k), later);
      else this.add('unknown_key', join(path, k), `"${shortKey(k)}" isn’t a key here. Allowed: ${allowed.join(', ')}.`);
    }
    for (const k of required) if (!Object.hasOwn(v, k)) this.add('missing_key', join(path, k), `"${k}" is required here.`);
    return v;
  }

  string(v: StrictJson | undefined, path: string): string | null {
    if (typeof v !== 'string') {
      this.add('wrong_type', path, 'This must be a string ("…").');
      return null;
    }
    return v;
  }

  text(v: StrictJson | undefined, path: string, role: PartnerTextRole): string | null {
    const p = partnerTextProblem(v, role);
    if (p) {
      this.add(p.code, path, p.message);
      return null;
    }
    return v as string;
  }

  /** A JSON integer within the safe range and [min, max]. */
  int(v: StrictJson | undefined, path: string, min: number, max: number): number | null {
    if (!(v instanceof JsonNumber) || !/^-?(?:0|[1-9][0-9]*)$/u.test(v.raw)) {
      this.add('wrong_type', path, 'This must be a whole number.');
      return null;
    }
    const n = Number(v.raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      this.add('bad_number', path, `This must be a whole number from ${min} to ${max}.`);
      return null;
    }
    return n;
  }

  /** A non-negative decimal string (no sign, no leading zero), at most `digits` digits. */
  decimal(v: StrictJson | undefined, path: string, digits = 39): string | null {
    if (typeof v !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(v) || v.length > digits) {
      this.add('bad_number', path, `This must be a whole number written as a string of digits ("1000"), at most ${digits} digits.`);
      return null;
    }
    return v;
  }

  bool(v: StrictJson | undefined, path: string): boolean | null {
    if (typeof v !== 'boolean') {
      this.add('wrong_type', path, 'This must be true or false.');
      return null;
    }
    return v;
  }

  /** `true` only: a flag that is on when present. */
  flag(v: StrictJson | undefined, path: string): true | null {
    if (v !== true) {
      this.add('wrong_type', path, 'This must be true (leave it out for false).');
      return null;
    }
    return true;
  }

  array(v: StrictJson | undefined, path: string, max: number): StrictJson[] | null {
    if (!Array.isArray(v)) {
      this.add('wrong_type', path, 'This must be a list ([ … ]).');
      return null;
    }
    if (v.length > max) {
      this.add('too_many', path, `At most ${max} entries.`);
      return null;
    }
    return v;
  }
}

const join = (path: string, key: string | number): string => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key);
/** A key as an error names it: its first 40 characters, display-safe characters only. */
const shortKey = (k: string): string => k.slice(0, 40).replace(/[^\x20-\x7e]/gu, '?');

const nullProto = <T>(entries: readonly (readonly [string, T])[]): Readonly<Record<string, T>> => {
  const o = Object.create(null) as Record<string, T>;
  for (const [k, v] of entries) o[k] = v;
  return Object.freeze(o);
};

/** A NEAR code hash: base58 of 32 bytes, in its one canonical form. */
export function isNearCodeHash(v: unknown): v is string {
  if (typeof v !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(v)) return false;
  try {
    const b = base58.decode(v);
    return b.length === 32 && base58.encode(b) === v;
  } catch {
    return false;
  }
}

/**
 * Methods a label may never describe, on any contract: the standards' value-moving and
 * permission methods, which Journear reads itself or will, and whose meaning a partner's words must never replace.
 * NEAR: NEP-141 (ft_*), NEP-171/177/178/181 (nft_*), NEP-245 multi-token (mt_*), NEP-145 storage (storage_*), the
 * wrapped-NEAR contract's near_deposit and near_withdraw, and the staking pool's distinctive deposit_and_stake,
 * unstake_all and withdraw_all. Soroban: SEP-41's transfer, transfer_from, approve, burn, burn_from and mint, the Stellar
 * asset contract's admin set (set_admin, clawback, set_authorized), and upgrade (the common name for replacing code).
 */
const NEAR_RESERVED_PREFIXES = ['ft_', 'nft_', 'mt_', 'storage_'];
const NEAR_RESERVED = new Set(['near_deposit', 'near_withdraw', 'deposit_and_stake', 'unstake_all', 'withdraw_all']);
const SOROBAN_RESERVED = new Set(['transfer', 'transfer_from', 'approve', 'burn', 'burn_from', 'mint', 'set_admin', 'clawback', 'set_authorized', 'upgrade']);
export const reservedMethod = (chain: 'near' | 'soroban' | 'stellar', key: string): boolean =>
  chain === 'near' ? NEAR_RESERVED_PREFIXES.some((p) => key.startsWith(p)) || NEAR_RESERVED.has(key) : chain === 'soroban' ? SOROBAN_RESERVED.has(key) : false;

/**
 * Whether Journear already reads the context's contract itself: a token on the known-token list, a contract on the
 * verified list, or a reviewed NEAR contract recorded for an env (compared by its sha256, as the record holds it). A
 * label never competes with Journear's own reading (Journear's reading always wins). The matcher also refuses the build's reviewed
 * NEAR accounts (`LabelChainFacts.reviewedNear`), which the record may not hold (the local stack's).
 */
export function journearReads(context: LabelContext): boolean {
  if (context.chain === 'near') {
    if (Object.hasOwn(KNOWN_TOKENS.near[context.network], context.account)) return true;
    const sha = toHex(sha256(utf8(context.account)));
    return Object.values(REVIEWED_NEAR_DEPLOYS).some((env) => Object.values(env).some((d) => d?.accountSha256 === sha));
  }
  if (context.chain === 'soroban') {
    const tokens = Object.hasOwn(KNOWN_TOKENS.stellar, context.networkPassphrase) ? KNOWN_TOKENS.stellar[context.networkPassphrase]! : {};
    if (Object.hasOwn(tokens, context.contract)) return true;
    return VERIFIED_CONTRACTS.some((c) => c.chain.kind === 'stellar' && c.chain.networkPassphrase === context.networkPassphrase && c.address === context.contract);
  }
  return false;
}

/** A Soroban Wasm hash: 64 lowercase hex characters. */
export const isWasmHash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v);

const isContractId = (v: string): boolean => StrKey.isValidContract(v);
/** A Stellar asset as the decoder writes it: `native`, or `CODE:ISSUER` with a 1–12 character code. */
const isStellarAsset = (v: string): boolean => {
  if (v === 'native') return true;
  const m = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/u.exec(v);
  return m !== null && isStellarAddress(m[2]!);
};

const STELLAR_PASSPHRASES = new Set([STELLAR_TESTNET_PASSPHRASE, STELLAR_MAINNET_PASSPHRASE]);

/** A NEAR method or Soroban function name: letters, digits and underscores, starting with a letter or underscore. */
const METHOD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const NEAR_ARG_TYPES: readonly ArgType[] = ['string', 'accountId', 'u128', 'u64', 'integer', 'boolean'];
const SOROBAN_ARG_TYPES: readonly ArgType[] = ['string', 'symbol', 'address', 'i128', 'u128', 'i64', 'u64', 'timepoint', 'duration', 'u32', 'i32', 'bool'];

/** The argument types each field format reads. */
export const FORMAT_ARG_TYPES: Readonly<Record<FieldFormat, readonly ArgType[]>> = Object.freeze({
  enum: ['string', 'symbol', 'integer', 'u32', 'i32', 'u64', 'u128'],
  tokenAmount: ['u128', 'u64', 'integer', 'i128', 'i64', 'u32'],
  nativeAmount: [],
  account: ['accountId', 'address'],
  date: ['u64', 'integer', 'timepoint'],
  duration: ['u64', 'integer', 'duration', 'u32'],
  count: ['integer', 'u32', 'u64'],
  itemId: ['string', 'symbol', 'integer', 'u32', 'u64'],
  orderNumber: ['string', 'symbol', 'integer', 'u32', 'u64'],
});

const FIELD_FORMATS = Object.keys(FORMAT_ARG_TYPES) as FieldFormat[];

/** The digits a decimal-string type may have, and whether it may be negative. */
const DECIMAL_DIGITS: Readonly<Partial<Record<ArgType, number>>> = Object.freeze({ u128: 39, i128: 39, u64: 20, i64: 19, timepoint: 20, duration: 20 });
const INT_BOUNDS: Readonly<Partial<Record<ArgType, readonly [number, number]>>> = Object.freeze({
  integer: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  u32: [0, 0xffffffff],
  i32: [-0x80000000, 0x7fffffff],
});

// ---- the parts ----

function readContext(r: Reader, v: StrictJson | undefined): LabelContext | null {
  if (isJsonObject(v)) {
    const keys = Object.keys(v);
    if (keys.some((k) => EVM_KEYS.has(k))) {
      r.add('not_in_v1', 'context', 'EVM contracts aren’t in v1 (NEAR and Stellar first).');
      return null;
    }
    if (keys.length !== 1) {
      r.add('bad_context', 'context', 'Give exactly one of "near", "soroban" or "stellar".');
      return null;
    }
  }
  const o = r.object(v, 'context', ['near', 'soroban', 'stellar']);
  if (!o) return null;
  const key = Object.keys(o)[0];
  if (key === 'near') {
    const n = r.object(o.near, 'context.near', ['network', 'account', 'codeHash'], ['network', 'account', 'codeHash']);
    if (!n) return null;
    const network = n.network === 'testnet' || n.network === 'mainnet' ? n.network : null;
    if (network === null && Object.hasOwn(n, 'network')) r.add('bad_network', 'context.near.network', 'Use "testnet" or "mainnet".');
    const account = typeof n.account === 'string' && isNearAccountId(n.account) ? n.account : null;
    if (account === null && Object.hasOwn(n, 'account')) r.add('bad_account', 'context.near.account', 'This must be a NEAR account id, as in "stamps.example.testnet".');
    const codeHash = isNearCodeHash(n.codeHash) ? n.codeHash : null;
    if (codeHash === null && Object.hasOwn(n, 'codeHash')) r.add('bad_code_hash', 'context.near.codeHash', 'This must be the contract’s code hash as NEAR shows it (base58, 32 bytes).');
    return network && account && codeHash ? { chain: 'near', network, account, codeHash } : null;
  }
  if (key === 'soroban') {
    const s = r.object(o.soroban, 'context.soroban', ['networkPassphrase', 'contract', 'wasmHash'], ['networkPassphrase', 'contract', 'wasmHash']);
    if (!s) return null;
    const networkPassphrase = typeof s.networkPassphrase === 'string' && STELLAR_PASSPHRASES.has(s.networkPassphrase) ? s.networkPassphrase : null;
    if (networkPassphrase === null && Object.hasOwn(s, 'networkPassphrase')) r.add('bad_network', 'context.soroban.networkPassphrase', 'Use the Stellar test network’s or the public network’s passphrase.');
    const contract = typeof s.contract === 'string' && isContractId(s.contract) ? s.contract : null;
    if (contract === null && Object.hasOwn(s, 'contract')) r.add('bad_account', 'context.soroban.contract', 'This must be a contract id (C…).');
    const wasmHash = isWasmHash(s.wasmHash) ? s.wasmHash : null;
    if (wasmHash === null && Object.hasOwn(s, 'wasmHash')) r.add('bad_code_hash', 'context.soroban.wasmHash', 'This must be the contract’s Wasm hash: 64 lowercase hex characters.');
    return networkPassphrase && contract && wasmHash ? { chain: 'soroban', networkPassphrase, contract, wasmHash } : null;
  }
  const c = r.object(o.stellar, 'context.stellar', ['networkPassphrase'], ['networkPassphrase']);
  if (!c) return null;
  const networkPassphrase = typeof c.networkPassphrase === 'string' && STELLAR_PASSPHRASES.has(c.networkPassphrase) ? c.networkPassphrase : null;
  if (networkPassphrase === null && Object.hasOwn(c, 'networkPassphrase')) r.add('bad_network', 'context.stellar.networkPassphrase', 'Use the Stellar test network’s or the public network’s passphrase.');
  return networkPassphrase ? { chain: 'stellar', networkPassphrase } : null;
}

/** An account of the document's chain: a NEAR account id, or a Stellar account (G…) or contract (C…). */
const accountOk = (chain: LabelContext['chain'], v: string): boolean => (chain === 'near' ? isNearAccountId(v) : isStellarAddress(v) || isContractId(v));

function readMetadata(r: Reader, v: StrictJson | undefined, chain: LabelContext['chain'] | null): LabelMetadata {
  const empty: LabelMetadata = { enums: nullProto([]), addressBook: [] };
  if (v === undefined) return empty;
  const o = r.object(v, 'metadata', ['enums', 'addressBook']);
  if (!o) return empty;
  const enums: [string, Readonly<Record<string, string>>][] = [];
  if (o.enums !== undefined) {
    const e = r.object(o.enums, 'metadata.enums', Object.keys(isJsonObject(o.enums) ? o.enums : {}));
    if (e) {
      const names = Object.keys(e);
      if (names.length > LABEL_LIMITS.enums) r.add('too_many', 'metadata.enums', `At most ${LABEL_LIMITS.enums} enumerations.`);
      for (const name of names.slice(0, LABEL_LIMITS.enums)) {
        const path = join('metadata.enums', name);
        if (!METHOD_NAME.test(name) || name.length > 32) {
          r.add('bad_params', path, 'An enumeration’s name uses letters, digits and underscores (at most 32).');
          continue;
        }
        const values = e[name];
        if (!isJsonObject(values)) {
          r.add('wrong_type', path, 'This must be an object of value → label.');
          continue;
        }
        const keys = Object.keys(values);
        if (keys.length === 0 || keys.length > LABEL_LIMITS.enumValues) {
          r.add('too_many', path, `List 1 to ${LABEL_LIMITS.enumValues} values.`);
          continue;
        }
        const labels: [string, string][] = [];
        const seen = new Map<string, string>();
        for (const raw of keys) {
          const p = join(path, raw);
          if (raw.length === 0 || [...raw].length > LABEL_LIMITS.enumKeyChars || !/^[\x21-\x7e]+$/u.test(raw)) {
            r.add('bad_params', p, `A value is 1 to ${LABEL_LIMITS.enumKeyChars} printable ASCII characters, without spaces, exactly as the request carries it.`);
            continue;
          }
          const label = r.text(values[raw], p, 'enumLabel');
          if (label === null) continue;
          const fold = foldLetters(label);
          if (seen.has(fold)) {
            r.add('duplicate', p, `Two values have the label “${label}”: each value needs its own.`);
            continue;
          }
          seen.set(fold, raw);
          labels.push([raw, label]);
        }
        enums.push([name, nullProto(labels)]);
      }
    }
  }
  const book: AddressBookEntry[] = [];
  if (o.addressBook !== undefined) {
    const list = r.array(o.addressBook, 'metadata.addressBook', LABEL_LIMITS.addressBook);
    const accounts = new Set<string>();
    const names = new Set<string>();
    list?.forEach((item, i) => {
      const path = join('metadata.addressBook', i);
      const e = r.object(item, path, ['account', 'name'], ['account', 'name']);
      if (!e) return;
      const account = r.string(e.account, join(path, 'account'));
      const name = e.name === undefined ? null : r.text(e.name, join(path, 'name'), 'addressName');
      if (account !== null && chain !== null && !accountOk(chain, account)) {
        r.add('bad_account', join(path, 'account'), chain === 'near' ? 'This must be a NEAR account id.' : 'This must be a Stellar account (G…) or contract (C…).');
        return;
      }
      if (account === null || name === null) return;
      if (accounts.has(account)) return r.add('duplicate', join(path, 'account'), 'This account is listed twice.');
      if (names.has(foldLetters(name))) return r.add('duplicate', join(path, 'name'), `Two accounts are named “${name}”: each needs its own name.`);
      accounts.add(account);
      names.add(foldLetters(name));
      book.push(Object.freeze({ account, name }));
    });
  }
  return Object.freeze({ enums: nullProto(enums), addressBook: Object.freeze(book) });
}

function readArg(r: Reader, v: StrictJson | undefined, path: string, name: string, chain: 'near' | 'soroban', positional: boolean): (ArgSpec & { name: string }) | null {
  const types = chain === 'near' ? NEAR_ARG_TYPES : SOROBAN_ARG_TYPES;
  if (!isJsonObject(v)) {
    r.add('wrong_type', path, 'An argument is an object with its "type".');
    return null;
  }
  const type = v.type as ArgType;
  if (typeof v.type !== 'string' || !types.includes(type)) {
    if (v.type === 'object' || v.type === 'array') r.add('not_in_v1', join(path, 'type'), 'Nested objects and lists aren’t in v1: declare flat arguments.');
    else r.add('wrong_type', join(path, 'type'), `"type" is one of ${types.join(', ')}.`);
    return null;
  }
  const base = positional ? ['name', 'type'] : ['type'];
  const optional = positional ? [] : ['optional'];
  let spec: ArgSpec | null = null;
  if (type === 'string' || type === 'symbol') {
    const o = r.object(v, path, [...base, ...optional, 'maxLength', 'oneOf']);
    if (!o) return null;
    const maxLength = o.maxLength === undefined ? undefined : r.int(o.maxLength, join(path, 'maxLength'), 1, LABEL_LIMITS.stringMaxLength);
    const oneOf = o.oneOf === undefined ? undefined : r.array(o.oneOf, join(path, 'oneOf'), LABEL_LIMITS.oneOf)?.map((x, i) => r.string(x, join(join(path, 'oneOf'), i)));
    if (maxLength === null || oneOf === null || oneOf?.some((x) => x === null)) return null;
    spec = { type, ...(maxLength !== undefined ? { maxLength } : {}), ...(oneOf !== undefined ? { oneOf: Object.freeze(oneOf as string[]) } : {}) };
  } else if (type === 'accountId' || type === 'address') {
    const o = r.object(v, path, [...base, ...optional, 'isSelf', 'inAddressBook', 'oneOf']);
    if (!o) return null;
    const isSelf = o.isSelf === undefined ? undefined : r.flag(o.isSelf, join(path, 'isSelf'));
    const inBook = o.inAddressBook === undefined ? undefined : r.flag(o.inAddressBook, join(path, 'inAddressBook'));
    const oneOf = o.oneOf === undefined ? undefined : r.array(o.oneOf, join(path, 'oneOf'), LABEL_LIMITS.oneOf)?.map((x, i) => r.string(x, join(join(path, 'oneOf'), i)));
    if (isSelf === null || inBook === null || oneOf === null || oneOf?.some((x) => x === null)) return null;
    spec = { type, ...(isSelf ? { isSelf } : {}), ...(inBook ? { inAddressBook: inBook } : {}), ...(oneOf !== undefined ? { oneOf: Object.freeze(oneOf as string[]) } : {}) };
  } else if (DECIMAL_DIGITS[type] !== undefined) {
    const o = r.object(v, path, [...base, ...optional, 'atLeast', 'atMost']);
    if (!o) return null;
    const atLeast = o.atLeast === undefined ? undefined : r.decimal(o.atLeast, join(path, 'atLeast'), DECIMAL_DIGITS[type]);
    const atMost = o.atMost === undefined ? undefined : r.decimal(o.atMost, join(path, 'atMost'), DECIMAL_DIGITS[type]);
    if (atLeast === null || atMost === null) return null;
    if (atLeast !== undefined && atMost !== undefined && BigInt(atLeast) > BigInt(atMost)) {
      r.add('bad_number', path, '"atLeast" is more than "atMost".');
      return null;
    }
    spec = { type: type as 'u128', ...(atLeast !== undefined ? { atLeast } : {}), ...(atMost !== undefined ? { atMost } : {}) };
  } else if (INT_BOUNDS[type] !== undefined) {
    const [lo, hi] = INT_BOUNDS[type]!;
    const o = r.object(v, path, [...base, ...optional, 'min', 'max']);
    if (!o) return null;
    const min = o.min === undefined ? undefined : r.int(o.min, join(path, 'min'), lo, hi);
    const max = o.max === undefined ? undefined : r.int(o.max, join(path, 'max'), lo, hi);
    if (min === null || max === null) return null;
    if (min !== undefined && max !== undefined && min > max) {
      r.add('bad_number', path, '"min" is more than "max".');
      return null;
    }
    spec = { type: type as 'integer', ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
  } else {
    const o = r.object(v, path, [...base, ...optional, 'equals']);
    if (!o) return null;
    const equals = o.equals === undefined ? undefined : r.bool(o.equals, join(path, 'equals'));
    if (equals === null) return null;
    spec = { type: type as 'boolean', ...(equals !== undefined ? { equals } : {}) };
  }
  if (!positional && v.optional !== undefined) {
    if (r.flag(v.optional, join(path, 'optional')) === null) return null;
    spec = { ...spec, optional: true } as ArgSpec;
  }
  return Object.freeze({ ...spec, name });
}

function readRelay(r: Reader, v: StrictJson | undefined, path: string): RelayRule | null {
  if (v === undefined) return 'either';
  if (v === 'relayed' || v === 'direct' || v === 'either') return v;
  r.add('wrong_type', path, 'Use "relayed", "direct" or "either".');
  return null;
}

function readNearCall(r: Reader, v: StrictJson | undefined, path: string): NearCallSpec | null {
  const o = r.object(v, path, ['deposit', 'gasAtMost', 'relayed', 'args', 'otherArgs'], ['args']);
  if (!o) return null;
  let deposit: NearCallSpec['deposit'] = { exactly: '0' };
  if (o.deposit !== undefined) {
    const d = r.object(o.deposit, join(path, 'deposit'), ['exactly', 'atMost']);
    if (!d) return null;
    const keys = Object.keys(d);
    if (keys.length !== 1) {
      r.add('bad_params', join(path, 'deposit'), 'Give one of "exactly" or "atMost" (yoctoNEAR).');
      return null;
    }
    const value = r.decimal(d[keys[0]!], join(join(path, 'deposit'), keys[0]!));
    if (value === null) return null;
    deposit = keys[0] === 'exactly' ? { exactly: value } : { atMost: value };
  }
  const gasAtMost = o.gasAtMost === undefined ? undefined : r.decimal(o.gasAtMost, join(path, 'gasAtMost'), 20);
  if (gasAtMost === null) return null;
  const relayed = readRelay(r, o.relayed, join(path, 'relayed'));
  if (o.otherArgs !== undefined && o.otherArgs !== 'refuse') r.add('not_in_v1', join(path, 'otherArgs'), 'Only "refuse" is allowed in v1: a request with an argument you didn’t declare doesn’t match.');
  const a = r.object(o.args, join(path, 'args'), Object.keys(isJsonObject(o.args) ? o.args : {}));
  if (!a || relayed === null) return null;
  const names = Object.keys(a);
  if (names.length > LABEL_LIMITS.args) {
    r.add('too_many', join(path, 'args'), `At most ${LABEL_LIMITS.args} arguments.`);
    return null;
  }
  const args: (ArgSpec & { name: string })[] = [];
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(name)) {
      r.add('bad_params', join(join(path, 'args'), name), 'An argument’s name uses letters, digits and underscores (at most 64).');
      continue;
    }
    const spec = readArg(r, a[name], join(join(path, 'args'), name), name, 'near', false);
    if (spec) args.push(spec);
  }
  return Object.freeze({ deposit: Object.freeze(deposit), ...(gasAtMost !== undefined ? { gasAtMost } : {}), relayed, args: Object.freeze(args) });
}

function readSorobanCall(r: Reader, v: StrictJson | undefined, path: string): SorobanCallSpec | null {
  const o = r.object(v, path, ['feeAtMost', 'relayed', 'args', 'otherArgs'], ['args']);
  if (!o) return null;
  const feeAtMost = o.feeAtMost === undefined ? undefined : r.decimal(o.feeAtMost, join(path, 'feeAtMost'), 20);
  const relayed = readRelay(r, o.relayed, join(path, 'relayed'));
  if (o.otherArgs !== undefined && o.otherArgs !== 'refuse') r.add('not_in_v1', join(path, 'otherArgs'), 'Only "refuse" is allowed in v1: a call with more arguments than you declared doesn’t match.');
  const list = r.array(o.args, join(path, 'args'), LABEL_LIMITS.args);
  if (feeAtMost === null || relayed === null || list === null) return null;
  const args: (ArgSpec & { name: string })[] = [];
  const names = new Set<string>();
  list.forEach((item, i) => {
    const p = join(join(path, 'args'), i);
    const name = isJsonObject(item) && typeof item.name === 'string' ? item.name : null;
    if (name === null || !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/u.test(name)) return r.add('bad_params', join(p, 'name'), 'Each argument has a "name": letters, digits and underscores (at most 32), as the contract names it.');
    if (names.has(name)) return r.add('duplicate', join(p, 'name'), `Two arguments are named "${name}".`);
    names.add(name);
    const spec = readArg(r, item, p, name, 'soroban', true);
    if (spec) args.push(spec);
  });
  return Object.freeze({ ...(feeAtMost !== undefined ? { feeAtMost } : {}), relayed, args: Object.freeze(args) });
}

function readPaymentCall(r: Reader, v: StrictJson | undefined, path: string): PaymentCallSpec | null {
  const o = r.object(v, path, ['assets', 'amountAtMost', 'memo', 'feeAtMost'], ['memo']);
  if (!o) return null;
  let assets: string[] | undefined;
  if (o.assets !== undefined) {
    const list = r.array(o.assets, join(path, 'assets'), LABEL_LIMITS.oneOf);
    if (list === null) return null;
    assets = [];
    list.forEach((a, i) => {
      if (typeof a === 'string' && isStellarAsset(a)) assets!.push(a);
      else r.add('bad_params', join(join(path, 'assets'), i), 'An asset is "native" or "CODE:ISSUER" (the issuer’s G… account).');
    });
  }
  const amountAtMost = o.amountAtMost === undefined ? undefined : r.decimal(o.amountAtMost, join(path, 'amountAtMost'), 19);
  const feeAtMost = o.feeAtMost === undefined ? undefined : r.decimal(o.feeAtMost, join(path, 'feeAtMost'), 20);
  const memo = o.memo === 'none' || o.memo === 'text' || o.memo === 'id' ? o.memo : null;
  if (memo === null && o.memo !== undefined) r.add('wrong_type', join(path, 'memo'), 'Use "none", "text" or "id": the kind of memo the payment carries.');
  if (amountAtMost === null || feeAtMost === null || memo === null) return null;
  return Object.freeze({
    ...(assets !== undefined ? { assets: Object.freeze(assets) } : {}),
    ...(amountAtMost !== undefined ? { amountAtMost } : {}),
    memo,
    ...(feeAtMost !== undefined ? { feeAtMost } : {}),
  });
}

/** The argument type at `path` in this call, or null when the path names nothing declared. */
function typeAt(chain: LabelContext['chain'], call: NearCallSpec | SorobanCallSpec | PaymentCallSpec, path: string): ArgType | 'deposit' | 'memo' | null {
  if (chain === 'near' && path === 'deposit') return 'deposit';
  if (chain === 'stellar') return path === 'memo' ? 'memo' : null;
  const m = /^args\.([A-Za-z_][A-Za-z0-9_]*)$/u.exec(path);
  if (!m) return null;
  const arg = (call as NearCallSpec | SorobanCallSpec).args.find((a) => a.name === m[1]);
  return arg ? arg.type : null;
}

function readField(r: Reader, v: StrictJson | undefined, path: string, ctx: { chain: LabelContext['chain']; call: NearCallSpec | SorobanCallSpec | PaymentCallSpec; metadata: LabelMetadata }): LabelField | null {
  const o = r.object(v, path, ['path', 'label', 'format', 'params'], ['path', 'label', 'format']);
  if (!o) return null;
  const fieldPath = r.string(o.path, join(path, 'path'));
  const label = r.text(o.label, join(path, 'label'), 'fieldLabel');
  const format = typeof o.format === 'string' && (FIELD_FORMATS as string[]).includes(o.format) ? (o.format as FieldFormat) : null;
  if (format === null && o.format !== undefined) {
    r.add(o.format === 'calldata' || o.format === 'nftName' || o.format === 'raw' || o.format === 'addressName' ? 'not_in_v1' : 'bad_field', join(path, 'format'), `"format" is one of ${FIELD_FORMATS.join(', ')}.`);
  }
  if (fieldPath === null || label === null || format === null) return null;
  const type = typeAt(ctx.chain, ctx.call, fieldPath);
  if (type === null) {
    r.add('bad_field', join(path, 'path'), ctx.chain === 'stellar' ? 'A payment’s only field is "memo".' : 'The path names a declared argument ("args.<name>") or "deposit".');
    return null;
  }
  const typeOk =
    type === 'deposit' ? format === 'nativeAmount' : type === 'memo' ? format === 'orderNumber' || format === 'itemId' : FORMAT_ARG_TYPES[format].includes(type) && !(format === 'nativeAmount' && ctx.chain !== 'near');
  if (!typeOk) {
    r.add('bad_field', join(path, 'format'), type === 'memo' ? 'A memo is shown as "orderNumber" or "itemId".' : `A "${format}" field can’t show an argument of type "${type === 'deposit' ? 'deposit' : type}".`);
    return null;
  }
  const paramKeys: Readonly<Record<FieldFormat, readonly string[]>> = { enum: ['enum'], tokenAmount: ['token', 'tokenPath'], nativeAmount: [], account: [], date: ['unit'], duration: ['unit'], count: ['min', 'max'], itemId: [], orderNumber: [] };
  const required: Readonly<Partial<Record<FieldFormat, readonly string[]>>> = { enum: ['enum'], date: ['unit'], duration: ['unit'], count: ['min', 'max'] };
  if (paramKeys[format].length === 0) {
    if (o.params !== undefined) r.add('bad_params', join(path, 'params'), `A "${format}" field takes no params.`);
    return Object.freeze({ path: fieldPath, label, params: Object.freeze({ format }) as FieldParams });
  }
  const pp = join(path, 'params');
  if (o.params === undefined) {
    r.add('missing_key', pp, `A "${format}" field needs "params" (${paramKeys[format].join(' or ')}).`);
    return null;
  }
  const p = r.object(o.params, pp, paramKeys[format], required[format] ?? []);
  if (!p) return null;
  switch (format) {
    case 'enum': {
      const name = r.string(p.enum, join(pp, 'enum'));
      if (name === null) return null;
      if (!Object.hasOwn(ctx.metadata.enums, name)) {
        r.add('unknown_enum', join(pp, 'enum'), `No enumeration "${shortKey(name)}" in metadata.enums.`);
        return null;
      }
      return Object.freeze({ path: fieldPath, label, params: Object.freeze({ format, enum: name }) });
    }
    case 'tokenAmount': {
      const keys = Object.keys(p);
      if (keys.length !== 1) {
        r.add('bad_params', pp, 'Give one of "token" (the token’s id) or "tokenPath" (the argument that names it).');
        return null;
      }
      if (keys[0] === 'token') {
        const token = r.string(p.token, join(pp, 'token'));
        if (token === null) return null;
        if (!(ctx.chain === 'near' ? isNearAccountId(token) : isContractId(token))) {
          r.add('bad_account', join(pp, 'token'), ctx.chain === 'near' ? 'A token is its NEAR account id.' : 'A token is its contract id (C…).');
          return null;
        }
        return Object.freeze({ path: fieldPath, label, params: Object.freeze({ format, token }) });
      }
      const tokenPath = r.string(p.tokenPath, join(pp, 'tokenPath'));
      if (tokenPath === null) return null;
      const t = typeAt(ctx.chain, ctx.call, tokenPath);
      if (t !== 'accountId' && t !== 'address') {
        r.add('bad_params', join(pp, 'tokenPath'), '"tokenPath" names a declared account argument ("args.<name>").');
        return null;
      }
      return Object.freeze({ path: fieldPath, label, params: Object.freeze({ format, tokenPath }) });
    }
    case 'date':
    case 'duration': {
      const unit = p.unit === 'seconds' || p.unit === 'milliseconds' || p.unit === 'nanoseconds' ? p.unit : null;
      if (unit === null) {
        r.add('bad_params', join(pp, 'unit'), 'Use "seconds", "milliseconds" or "nanoseconds".');
        return null;
      }
      if ((type === 'timepoint' || type === 'duration') && unit !== 'seconds') {
        r.add('bad_params', join(pp, 'unit'), 'A Soroban timepoint or duration is in seconds.');
        return null;
      }
      return Object.freeze({ path: fieldPath, label, params: Object.freeze({ format, unit }) });
    }
    case 'count': {
      const min = r.int(p.min, join(pp, 'min'), 0, LABEL_LIMITS.countMax);
      const max = r.int(p.max, join(pp, 'max'), 0, LABEL_LIMITS.countMax);
      if (min === null || max === null) return null;
      if (min > max) {
        r.add('bad_number', pp, '"min" is more than "max".');
        return null;
      }
      return Object.freeze({ path: fieldPath, label, params: Object.freeze({ format, min, max }) });
    }
    default:
      return null;
  }
}

function readSentence(r: Reader, v: StrictJson | undefined, path: string, fields: readonly LabelField[], hasObject: boolean): SentencePartSpec[] | null {
  const list = r.array(v, path, LABEL_LIMITS.sentenceParts);
  if (list === null) return null;
  const parts: SentencePartSpec[] = [];
  const used = new Set<string>();
  let ok = true;
  const bad = (p: string, message: string) => {
    r.add('bad_sentence', p, message);
    ok = false;
  };
  list.forEach((item, i) => {
    const p = join(path, i);
    if (item === 'verb') parts.push({ kind: 'verb' });
    else if (item === 'object') parts.push({ kind: 'object' });
    else if (isJsonObject(item) && Object.keys(item).length === 1 && typeof item.field === 'string') {
      if (!fields.some((f) => f.path === item.field)) return bad(p, `No field has the path "${shortKey(item.field)}".`);
      if (used.has(item.field)) return bad(p, 'A field appears in the sentence at most once.');
      used.add(item.field);
      parts.push({ kind: 'field', path: item.field });
    } else if (isJsonObject(item) && Object.keys(item).length === 1 && typeof item.word === 'string') {
      if (!isPartnerConnector(item.word)) return bad(p, `A joining word is one of: ${PARTNER_CONNECTORS.join(', ')}.`);
      parts.push({ kind: 'word', word: item.word });
    } else bad(p, 'A part is "verb", "object", { "field": "<path>" } or { "word": "<joining word>" }.');
  });
  if (!ok) return null;
  if (parts[0]?.kind !== 'verb') bad(path, 'The sentence starts with "verb".');
  if (parts.filter((x) => x.kind === 'verb').length !== 1) bad(path, 'The sentence has the verb exactly once.');
  const objects = parts.filter((x) => x.kind === 'object').length;
  if (objects > 1) bad(path, 'The sentence has the object at most once.');
  if (objects === 1 && !hasObject) bad(path, 'The sentence uses "object", but the intent has no object.');
  if (objects === 0 && hasObject) bad(path, 'The intent has an object: put "object" in the sentence.');
  if (parts.filter((x) => x.kind === 'field').length > LABEL_LIMITS.sentenceFields) bad(path, `At most ${LABEL_LIMITS.sentenceFields} fields in the sentence.`);
  if (parts.filter((x) => x.kind === 'word').length > LABEL_LIMITS.connectors) bad(path, `At most ${LABEL_LIMITS.connectors} joining words.`);
  parts.forEach((x, i) => {
    if (x.kind === 'word' && (i === parts.length - 1 || parts[i + 1]?.kind === 'word')) bad(join(path, i), 'A joining word goes between two other parts.');
  });
  return ok ? parts.map((x) => Object.freeze(x)) : null;
}

/** Argument types that can carry an account, an amount or a token: each declared one must be a shown field. */
const MUST_SHOW: ReadonlySet<ArgType> = new Set<ArgType>(['accountId', 'address', 'u128', 'i128']);

/** Whether a NEAR call's deposit can be above 0. */
const depositCanMove = (call: NearCallSpec): boolean => ('exactly' in call.deposit ? call.deposit.exactly !== '0' : call.deposit.atMost !== '0');

/**
 * Every declared argument that can carry an account, an amount or a token is a shown field, and so is a NEAR deposit
 * that can be above 0: a partner chooses words, never which true values the window may leave out (others, such as a
 * string or a count, may stay in the details).
 */
function requiredFieldsShown(r: Reader, path: string, chain: LabelContext['chain'], call: NearCallSpec | SorobanCallSpec | PaymentCallSpec, fields: readonly LabelField[]): boolean {
  if (chain === 'stellar') return true;
  const shown = new Set(fields.map((f) => f.path));
  let ok = true;
  for (const a of (call as NearCallSpec | SorobanCallSpec).args) {
    if (MUST_SHOW.has(a.type) && !shown.has(`args.${a.name}`)) {
      r.add('field_required', join(path, 'fields'), `"${a.name}" (${a.type}) can carry an account, an amount or a token: show it as a field.`);
      ok = false;
    }
  }
  if (chain === 'near' && depositCanMove(call as NearCallSpec) && !shown.has('deposit')) {
    r.add('field_required', join(path, 'fields'), 'The deposit can be above 0: show it as a field ({ "path": "deposit", "format": "nativeAmount" }).');
    ok = false;
  }
  return ok;
}

/** Whether a format's request can move value: a NEAR deposit above 0, any amount field, or a payment. */
const valueCanMove = (chain: LabelContext['chain'], call: NearCallSpec | SorobanCallSpec | PaymentCallSpec, fields: readonly LabelField[]): boolean =>
  chain === 'stellar' || (chain === 'near' && depositCanMove(call as NearCallSpec)) || fields.some((f) => f.params.format === 'tokenAmount' || f.params.format === 'nativeAmount');

/** The most partner-written characters a sentence may hold: the object phrase and its one partner-worded value. */
export const SENTENCE_PARTNER_CHARS = 40;

/** The longest text a field may put in the sentence in the partner's words: an enum label or an address book name. */
function partnerWordsOf(f: LabelField, metadata: LabelMetadata): number | null {
  if (f.params.format === 'enum') return Math.max(...Object.values(metadata.enums[f.params.enum] ?? {}).map((l) => [...l].length));
  if (f.params.format === 'account') return metadata.addressBook.length ? Math.max(...metadata.addressBook.map((e) => [...e.name].length)) : null;
  return null;
}

/**
 * At most one value in the sentence may be in the partner's words (an enumeration label, or an account the address
 * book may name), and the object phrase plus that value's longest text is at most SENTENCE_PARTNER_CHARS: one short
 * partner phrase, never several strung together in Journear's sentence. Other such fields are rows of their own.
 */
function sentenceTextFits(r: Reader, path: string, sentence: readonly SentencePartSpec[], fields: readonly LabelField[], metadata: LabelMetadata, object: string | undefined): boolean {
  const worded = sentence.flatMap((p) => (p.kind === 'field' ? [fields.find((f) => f.path === p.path)!] : [])).filter((f) => f.params.format === 'enum' || f.params.format === 'account');
  if (worded.length > 1) {
    r.add('sentence_text', path, 'At most one enumeration or account field in the sentence: show the others as rows.');
    return false;
  }
  const longest = worded.length ? (partnerWordsOf(worded[0]!, metadata) ?? 0) : 0;
  if ([...(object ?? '')].length + longest > SENTENCE_PARTNER_CHARS) {
    r.add('sentence_text', path, `The object and the longest label the sentence can show come to more than ${SENTENCE_PARTNER_CHARS} characters: shorten them.`);
    return false;
  }
  return true;
}

function readFormat(r: Reader, v: StrictJson | undefined, path: string, context: LabelContext, metadata: LabelMetadata): LabelFormat | null {
  const o = r.object(v, path, ['call', 'intent', 'sentence', 'fields'], ['call', 'intent', 'sentence', 'fields']);
  if (!o) return null;
  const call = context.chain === 'near' ? readNearCall(r, o.call, join(path, 'call')) : context.chain === 'soroban' ? readSorobanCall(r, o.call, join(path, 'call')) : readPaymentCall(r, o.call, join(path, 'call'));
  const i = r.object(o.intent, join(path, 'intent'), ['verb', 'object'], ['verb']);
  let verb: PartnerVerb | null = null;
  let object: string | undefined;
  if (i) {
    if (isPartnerVerb(i.verb)) verb = i.verb;
    else if (i.verb !== undefined) r.add('bad_verb', join(join(path, 'intent'), 'verb'), 'The verb is one of Journear’s list (collect, join, vote, swap, buy, sell, pay, send, …), in lower case.');
    if (i.object !== undefined) object = r.text(i.object, join(join(path, 'intent'), 'object'), 'object') ?? undefined;
    if (i.object !== undefined && object === undefined) verb = null;
  }
  if (call === null || verb === null) return null;
  const list = r.array(o.fields, join(path, 'fields'), LABEL_LIMITS.fields);
  if (list === null) return null;
  const fields: LabelField[] = [];
  const paths = new Set<string>();
  list.forEach((item, n) => {
    const f = readField(r, item, join(join(path, 'fields'), n), { chain: context.chain, call, metadata });
    if (!f) return;
    if (paths.has(f.path)) return r.add('duplicate', join(join(join(path, 'fields'), n), 'path'), 'Two fields show the same value.');
    paths.add(f.path);
    fields.push(f);
  });
  if (fields.length !== list.length) return null;
  const labels = new Set<string>();
  fields.forEach((f, n) => {
    if (labels.has(foldLetters(f.label))) r.add('duplicate', join(join(join(path, 'fields'), n), 'label'), `Two fields are labelled “${f.label}”: each row needs its own label.`);
    labels.add(foldLetters(f.label));
  });
  if (!requiredFieldsShown(r, path, context.chain, call, fields)) return null;
  const sentence = readSentence(r, o.sentence, join(path, 'sentence'), fields, object !== undefined);
  if (sentence === null) return null;
  if (!sentenceTextFits(r, join(path, 'sentence'), sentence, fields, metadata, object)) return null;
  if (SOFT_VERBS.has(verb) && valueCanMove(context.chain, call, fields)) {
    r.add('bad_verb', join(join(path, 'intent'), 'verb'), `"${verb}" says no value moves, but this request can move value (a deposit, an amount or a payment): use a verb that says so, such as pay, send, buy, deposit or donate.`);
    return null;
  }
  const base = { intent: Object.freeze({ verb, ...(object !== undefined ? { object } : {}) }), sentence: Object.freeze(sentence), fields: Object.freeze(fields) };
  if (context.chain === 'near') return Object.freeze({ chain: 'near', call: call as NearCallSpec, ...base });
  if (context.chain === 'soroban') return Object.freeze({ chain: 'soroban', call: call as SorobanCallSpec, ...base });
  return Object.freeze({ chain: 'stellar', call: call as PaymentCallSpec, ...base });
}

/**
 * Parses a label document (its JSON text, as the partner uploads it). Refused, with every reason (at most
 * LABEL_MAX_ERRORS): a document over LABEL_LIMITS.documentBytes or nested deeper than LABEL_LIMITS.depth; JSON with a
 * duplicate key, a lone surrogate or anything trailing; a key that isn't in v1; a value of the wrong type; any text that
 * fails the partner text rules; more of anything than the limits allow.
 */
export function parseLabelDocument(text: string): LabelParseResult {
  const r = new Reader();
  if (typeof text !== 'string') return { ok: false, errors: [{ code: 'wrong_type', path: '', message: 'The document must be JSON text.' }] };
  if (new TextEncoder().encode(text).length > LABEL_LIMITS.documentBytes) return { ok: false, errors: [{ code: 'too_large', path: '', message: `The document is over ${LABEL_LIMITS.documentBytes / 1024} KiB.` }] };
  if (text.charCodeAt(0) === 0xfeff) return { ok: false, errors: [{ code: 'not_json', path: '', message: 'Save the document without a byte order mark (BOM).' }] };
  let json: StrictJson;
  try {
    json = parseStrictJson(text, LABEL_LIMITS.depth);
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    if (e.code === 'too_large') return { ok: false, errors: [{ code: 'too_deep', path: '', message: `The document is nested deeper than ${LABEL_LIMITS.depth} levels.` }] };
    if (/^Duplicate JSON key/u.test(e.message)) return { ok: false, errors: [{ code: 'duplicate_key', path: '', message: 'A key appears twice in one object: each key once.' }] };
    return { ok: false, errors: [{ code: 'not_json', path: '', message: 'This isn’t valid JSON.' }] };
  }
  const top = r.object(json, '', ['schema', 'context', 'metadata', 'display'], ['schema', 'context', 'display']);
  if (!top) return { ok: false, errors: r.errors };
  if (top.schema !== undefined && top.schema !== LABEL_SCHEMA) r.add('bad_schema', 'schema', `"schema" is "${LABEL_SCHEMA}".`);
  const context = Object.hasOwn(top, 'context') ? readContext(r, top.context) : null;
  if (context && journearReads(context)) r.add('journear_reads_this', 'context', 'Journear already reads this program itself (a token, a program on its checked list, or one of its own): a label can’t describe it.');
  const metadata = readMetadata(r, top.metadata, context?.chain ?? null);
  const formats: [string, LabelFormat][] = [];
  if (Object.hasOwn(top, 'display')) {
    const d = r.object(top.display, 'display', ['formats'], ['formats']);
    const f = d ? r.object(d.formats, 'display.formats', Object.keys(isJsonObject(d.formats) ? d.formats : {})) : null;
    if (f && context) {
      const keys = Object.keys(f);
      if (keys.length === 0) r.add('missing_key', 'display.formats', 'Describe at least one call.');
      if (keys.length > LABEL_LIMITS.formats) r.add('too_many', 'display.formats', `At most ${LABEL_LIMITS.formats} calls per document.`);
      for (const key of keys.slice(0, LABEL_LIMITS.formats)) {
        const path = join('display.formats', key);
        if (context.chain === 'stellar' ? key !== 'payment' : !METHOD_NAME.test(key) || key.length > (context.chain === 'soroban' ? 32 : LABEL_LIMITS.methodChars)) {
          r.add(context.chain === 'stellar' ? 'not_in_v1' : 'bad_method', path, context.chain === 'stellar' ? 'For a classic Stellar transaction only "payment" can be described in v1.' : 'The key is the method’s exact name: letters, digits and underscores.');
          continue;
        }
        if (reservedMethod(context.chain, key)) {
          r.add('reserved_method', path, `"${key}" is a standard method that moves value or grants a permission: Journear reads those itself, so a label can’t describe it.`);
          continue;
        }
        const format = readFormat(r, f[key], path, context, metadata);
        if (format) formats.push([key, format]);
      }
    }
  }
  if (context?.chain === 'stellar' && metadata.addressBook.length === 0) {
    r.add('missing_key', 'metadata.addressBook', 'A payment’s description shows only for an account in your address book: list at least one.');
  }
  if (r.errors.length > 0 || context === null) return { ok: false, errors: Object.freeze(r.errors.length ? r.errors : [{ code: 'bad_context', path: 'context', message: 'The context is missing.' } as LabelError]) };
  return { ok: true, document: Object.freeze({ schema: LABEL_SCHEMA, context: Object.freeze(context), metadata, formats: nullProto(formats) }) };
}
