// The partner label matcher (D892): is this request exactly the call a partner's label describes? A match hands back
// the format, the sentence's parts and every field's value, each value the request's own and each with where its
// meaning came from; anything else is a precise reason code. The matcher decides nothing about trust, warnings or
// colours (the window does, a later piece): a partner label never removes, lowers or rewords a warning.
//
// It takes the contract's code hash as an input and requires it to equal the document's: who reads it from the chain
// is a later piece, and a missing hash is no match. Pure: no network, no clock, no randomness.
import { isNearAccountId } from '../addresses.ts';
import { JsonNumber, type StrictJson, isJsonObject, parseStrictJson } from '../decode/json.ts';
import { NEAR_ARGS_JSON_MAX_BYTES, formatNear } from '../decode/near.ts';
import type { DecodedApproval } from '../decode/request.ts';
import type { StellarContractCall, StellarInvocation, StellarScVal, StellarTransaction } from '../decode/stellar.ts';
import { formatTokenUnits, groupDigits } from '../decode/summary.ts';
import { knownToken } from '../known-tokens.ts';
import type { NearAction } from '../near/codec.ts';
import { COMBINING_RUN, QUOTE_LIKE } from '../reviewed-near-calls.ts';
import { isDisplaySafeLine } from '../display-safe.ts';
import { isNearCodeHash, isWasmHash } from './schema.ts';
import type { ArgSpec, ArgType, LabelDocument, LabelField, LabelFormat, NearCallSpec, NearNetwork, PaymentCallSpec, RelayRule, SorobanCallSpec } from './schema.ts';
import type { PartnerConnector, PartnerVerb } from './words.ts';

// ---- the request, as the matcher reads it ----

/** A request the matcher can read, from the decoders' own output (`labelRequestOf`). */
export type LabelRequest =
  | {
      readonly kind: 'near';
      readonly network: NearNetwork;
      /** The user's account: the transaction's signer or the delegate action's sender. */
      readonly user: string;
      readonly receiver: string;
      readonly actions: readonly NearAction[];
      /** A delegate action someone else sends (true), or the user's own transaction (false). */
      readonly relayed: boolean;
    }
  | { readonly kind: 'stellar_tx'; readonly networkPassphrase: string; readonly user: string; readonly tx: StellarTransaction }
  | { readonly kind: 'stellar_auth'; readonly networkPassphrase: string; readonly user: string; readonly invocation: StellarInvocation };

/**
 * The request as the matcher reads it, from what `decodeApprovalRequest` returned, or null for a kind no label can
 * describe (EVM, messages, raw signing). `user` is the vault's address for the chain (the decoders already refuse a NEAR
 * request from any other account). A pure helper beside the decoders; it changes nothing they do.
 */
export function labelRequestOf(d: DecodedApproval, user: string): LabelRequest | null {
  switch (d.kind) {
    case 'near_tx':
      return { kind: 'near', network: d.network, user: d.tx.signerId, receiver: d.tx.receiverId, actions: d.tx.actions, relayed: false };
    case 'near_delegate':
      return { kind: 'near', network: d.network, user: d.delegate.senderId, receiver: d.delegate.receiverId, actions: d.delegate.actions, relayed: true };
    case 'stellar_tx':
      return { kind: 'stellar_tx', networkPassphrase: d.networkPassphrase, user, tx: d.envelope.tx };
    case 'stellar_auth_entry':
      return { kind: 'stellar_auth', networkPassphrase: d.networkPassphrase, user, invocation: d.preimage.invocation };
    default:
      return null;
  }
}

/** What only the chain can tell, read by a later piece: the contract's code hash (NEAR base58) or Wasm hash (hex). */
export interface LabelChainFacts {
  /** null or absent: unknown, which is no match for a NEAR or Soroban label. */
  readonly codeHash?: string | null;
  /**
   * Soroban only, optional: the function's parameter names from the contract's own spec (SEP-48 `contractspecv0`).
   * When given, the declared names must be exactly these.
   */
  readonly sorobanParams?: readonly string[] | null;
  /**
   * NEAR only: whether the vault checked the request's network itself (a transaction's block hash on the env's
   * endpoint; a delegate action's key, nonce and expiry on both providers). Unchecked or absent is no match: an
   * implicit account exists on both networks, and the window says "Only the app says so" for such a request.
   */
  readonly networkChecked?: boolean;
  /** The build's reviewed NEAR accounts (`HanaEnv.nearReviewed`): Journear reads their calls itself; a label never does. */
  readonly reviewedNear?: readonly string[];
}

// ---- what a match hands back ----

/** Where a shown value's meaning came from. */
export type MeaningSource =
  /** The partner's enumeration label for the request's exact value. */
  | 'partner_enum'
  /** Journear's known-token list (symbol and decimals). */
  | 'journear_known_tokens'
  /** A token not on the list: raw units with its id, never the partner's claim. */
  | 'unlisted_token'
  /** The account is the user's own: "your account". */
  | 'computed_self'
  /** A name from the partner's address book, for an account listed exactly. */
  | 'partner_address_book'
  /** The request's own value, formatted by Journear (an amount, a date, a number, an id, a bare account). */
  | 'request';

export type RenderedValue =
  | { readonly format: 'enum'; readonly raw: string; readonly text: string; readonly source: 'partner_enum' }
  | {
      readonly format: 'tokenAmount';
      /** The amount in the token's smallest units, decimal. */
      readonly raw: string;
      /** The token's id: a NEAR account or a Stellar contract. */
      readonly token: string;
      /** "10 USDC", or "10000000 units of an unlisted token". */
      readonly text: string;
      readonly symbol: string | null;
      readonly decimals: number | null;
      readonly source: 'journear_known_tokens' | 'unlisted_token';
      /** A listed token's kind: a collectible's numbers are item ids, never amounts. */
      readonly kind: 'token' | 'collectible' | null;
      /**
       * Always `partner`: which token a call moves, and that this argument is its amount, is the partner's
       * description (the contract decides); only the symbol and decimals are Journear's. A renderer must never style
       * it as checked.
       */
      readonly binding: 'partner';
    }
  /** The request's own attached NEAR (the deposit): the chain's value, not a description. */
  | { readonly format: 'nativeAmount'; readonly raw: string; readonly text: string; readonly source: 'request'; readonly binding: 'request' }
  | {
      readonly format: 'account';
      /** The account, whole. */
      readonly value: string;
      /** "your account", the address book's name, or the account itself. */
      readonly text: string;
      readonly source: 'computed_self' | 'partner_address_book' | 'request';
    }
  | { readonly format: 'date' | 'duration' | 'count' | 'itemId' | 'orderNumber'; readonly raw: string; readonly text: string; readonly source: 'request' };

export interface RenderedField {
  readonly path: string;
  /** The partner's label for the row. */
  readonly label: string;
  readonly value: RenderedValue;
}

/**
 * A sentence part, structured so the renderer decides the markup: Journear's verb and joining words, the partner's
 * object phrase, and slot values set apart from both.
 */
export type SentencePart =
  | { readonly kind: 'verb'; readonly text: PartnerVerb }
  | { readonly kind: 'word'; readonly text: PartnerConnector }
  | { readonly kind: 'object'; readonly text: string }
  | { readonly kind: 'value'; readonly path: string; readonly value: RenderedValue };

export interface LabelMatch {
  readonly ok: true;
  /** The format's key: the method, the function, or `payment`. */
  readonly format: string;
  readonly verb: PartnerVerb;
  readonly parts: readonly SentencePart[];
  readonly fields: readonly RenderedField[];
  /** A classic payment's destination, as the address book names it. */
  readonly destination?: RenderedValue & { readonly format: 'account' };
  /**
   * Every true value of the request, shown in a field or not: each declared argument (null when an optional one is
   * absent), NEAR's deposit and gas, a Soroban transaction's fee, a payment's amount, asset, destination, memo and fee.
   * A later renderer can show all of them; two requests that differ in any of them never give the same list.
   */
  readonly values: readonly TrueValue[];
}

/** One true value of the request, as the request holds it (decimal for numbers, the account or text as written). */
export interface TrueValue {
  readonly path: string;
  readonly type: ArgType | 'deposit' | 'gas' | 'fee' | 'amount' | 'asset' | 'destination' | 'memo';
  readonly value: string | null;
  /** Whether a field of the format shows it. */
  readonly shown: boolean;
}

/** Why a request is not the declared thing. Stable codes, safe to log and count (they carry no request value). */
export type LabelNoMatchCode =
  | 'wrong_chain'
  | 'wrong_network'
  | 'wrong_account'
  | 'calls_own_account'
  | 'no_code_hash'
  | 'code_hash_mismatch'
  | 'spec_mismatch'
  | 'more_than_one_action'
  | 'not_a_function_call'
  | 'nested_call'
  | 'wrong_method'
  | 'relayed_not_allowed'
  | 'direct_not_allowed'
  | 'deposit_not_allowed'
  | 'gas_too_high'
  | 'fee_too_high'
  | 'args_not_json'
  | 'args_not_object'
  | 'undeclared_arg'
  | 'missing_arg'
  | 'type_mismatch'
  | 'out_of_bounds'
  | 'not_one_of'
  | 'not_self'
  | 'not_in_address_book'
  | 'enum_value_not_listed'
  | 'value_not_displayable'
  | 'source_not_user'
  | 'wrong_operation'
  | 'token_not_allowed'
  | 'memo_mismatch'
  | 'journear_reads_this'
  | 'network_not_checked'
  | 'bad_code_hash_input'
  | 'no_contract_code';

export interface LabelNoMatch {
  readonly ok: false;
  readonly reason: LabelNoMatchCode;
  /** Which part failed: an argument's path (`args.stamp`), `deposit`, `gas`, `fee`, `memo`, `receiver`, … Never a value. */
  readonly at?: string;
}

export type LabelMatchResult = LabelMatch | LabelNoMatch;

const no = (reason: LabelNoMatchCode, at?: string): LabelNoMatch => Object.freeze(at === undefined ? { ok: false, reason } : { ok: false, reason, at });

// ---- values ----

/** An argument's value, read for one declared type: a canonical form (decimal string, account, text) or a no-match. */
type ArgValue = { readonly kind: 'text'; readonly v: string } | { readonly kind: 'int'; readonly v: bigint } | { readonly kind: 'bool'; readonly v: boolean } | { readonly kind: 'account'; readonly v: string };

const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const MAX: Readonly<Partial<Record<ArgType, bigint>>> = Object.freeze({ u128: 2n ** 128n - 1n, u64: 2n ** 64n - 1n });

/** A NEAR JSON argument's value for `type`, or null when it isn't of that type. */
function nearValue(v: StrictJson, type: ArgType): ArgValue | null {
  switch (type) {
    case 'string':
      return typeof v === 'string' ? { kind: 'text', v } : null;
    case 'accountId':
      return typeof v === 'string' && isNearAccountId(v) ? { kind: 'account', v } : null;
    case 'u128':
    case 'u64': {
      if (typeof v !== 'string' || !DECIMAL.test(v) || v.length > 39) return null;
      const n = BigInt(v);
      return n <= MAX[type]! ? { kind: 'int', v: n } : null;
    }
    case 'integer':
      // "-0" is refused: one value, one form.
      if (!(v instanceof JsonNumber) || !/^(?:0|-?[1-9][0-9]*)$/u.test(v.raw)) return null;
      return Number.isSafeInteger(Number(v.raw)) ? { kind: 'int', v: BigInt(v.raw) } : null;
    case 'boolean':
      return typeof v === 'boolean' ? { kind: 'bool', v } : null;
    default:
      return null;
  }
}

/** A Soroban argument's value for `type`, or null when it isn't of that type. */
function sorobanValue(v: StellarScVal, type: ArgType): ArgValue | null {
  switch (type) {
    case 'string':
      return v.type === 'string' && v.value !== null ? { kind: 'text', v: v.value } : null;
    case 'symbol':
      return v.type === 'symbol' ? { kind: 'text', v: v.value } : null;
    case 'address':
      return v.type === 'address' && (v.addressType === 'account' || v.addressType === 'contract') ? { kind: 'account', v: v.address } : null;
    case 'bool':
      return v.type === 'bool' ? { kind: 'bool', v: v.value } : null;
    case 'u32':
    case 'i32':
      return v.type === type ? { kind: 'int', v: BigInt(v.value) } : null;
    case 'u64':
    case 'i64':
    case 'u128':
    case 'i128':
    case 'timepoint':
    case 'duration':
      return v.type === type ? { kind: 'int', v: BigInt(v.value) } : null;
    default:
      return null;
  }
}

/** An argument's value as `TrueValue` writes it. */
const valueText = (v: ArgValue): string => (v.kind === 'int' ? v.v.toString() : v.kind === 'bool' ? String(v.v) : v.v);

/** A key the no-match may name: an argument name of plain characters, else `args.*` (a request key is the request's text). */
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const argAt = (k: string): string => (SAFE_KEY.test(k) ? `args.${k}` : 'args.*');

/** The all-zero code hash: an account or contract with no code. */
const NEAR_NO_CODE = '11111111111111111111111111111111';
const WASM_NO_CODE = '0'.repeat(64);

/** The code hash fact: absent, malformed, the no-code hash, other than the document's, or the same (null). */
function codeHashFails(given: string | null | undefined, want: string, kind: 'near' | 'soroban'): LabelNoMatch | null {
  if (given === undefined || given === null) return no('no_code_hash');
  if (kind === 'near' ? !isNearCodeHash(given) : !isWasmHash(given)) return no('bad_code_hash_input');
  if (given === (kind === 'near' ? NEAR_NO_CODE : WASM_NO_CODE)) return no('no_contract_code');
  return given === want ? null : no('code_hash_mismatch');
}

/** Whether an argument's value meets its declared constraints, or the no-match it is. */
function constraintFails(spec: ArgSpec, value: ArgValue, path: string, user: string, book: ReadonlySet<string>): LabelNoMatch | null {
  if (spec.type === 'string' || spec.type === 'symbol') {
    const s = (value as { v: string }).v;
    if (spec.maxLength !== undefined && [...s].length > spec.maxLength) return no('out_of_bounds', path);
    if (spec.oneOf !== undefined && !spec.oneOf.includes(s)) return no('not_one_of', path);
    return null;
  }
  if (spec.type === 'accountId' || spec.type === 'address') {
    const a = (value as { v: string }).v;
    if (spec.isSelf && a !== user) return no('not_self', path);
    if (spec.inAddressBook && !book.has(a)) return no('not_in_address_book', path);
    if (spec.oneOf !== undefined && !spec.oneOf.includes(a)) return no('not_one_of', path);
    return null;
  }
  if (spec.type === 'boolean' || spec.type === 'bool') return spec.equals !== undefined && spec.equals !== (value as { v: boolean }).v ? no('not_one_of', path) : null;
  const n = (value as { v: bigint }).v;
  if ('atLeast' in spec && spec.atLeast !== undefined && n < BigInt(spec.atLeast)) return no('out_of_bounds', path);
  if ('atMost' in spec && spec.atMost !== undefined && n > BigInt(spec.atMost)) return no('out_of_bounds', path);
  if ('min' in spec && spec.min !== undefined && n < BigInt(spec.min)) return no('out_of_bounds', path);
  if ('max' in spec && spec.max !== undefined && n > BigInt(spec.max)) return no('out_of_bounds', path);
  return null;
}

/** An id or order number the window may show as code: short, plain ASCII, nothing that could read as words or a quote. */
const ID_TEXT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** 2000-01-01 and 9999-12-31 23:59:59.999 UTC, in ms: a date outside reads as nothing a person would expect. */
const DATE_MIN_MS = 946_684_800_000n;
const DATE_MAX_MS = 253_402_300_799_999n;
/** At most 100 years (365-day years) for a duration. */
const DURATION_MAX_MS = 100n * 365n * 86_400_000n;
const UNIT_NS: Readonly<Record<'seconds' | 'milliseconds' | 'nanoseconds', bigint>> = Object.freeze({ seconds: 1_000_000_000n, milliseconds: 1_000_000n, nanoseconds: 1n });

/** "23 November 2026, 14:05 UTC" (seconds when not zero): UTC, from the value alone (no clock). */
function dateText(ms: bigint): string {
  const d = new Date(Number(ms));
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = d.getUTCSeconds();
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm}${ss ? `:${String(ss).padStart(2, '0')}` : ''} UTC`;
}

/** "2 days 3 hours", "45 minutes", "1 second 500 milliseconds": every non-zero unit, exact. */
function durationText(ms: bigint): string {
  const units: readonly [bigint, string][] = [
    [86_400_000n, 'day'],
    [3_600_000n, 'hour'],
    [60_000n, 'minute'],
    [1000n, 'second'],
    [1n, 'millisecond'],
  ];
  const out: string[] = [];
  let rest = ms;
  for (const [size, name] of units) {
    const n = rest / size;
    rest %= size;
    if (n > 0n) out.push(`${groupDigits(n.toString())} ${name}${n === 1n ? '' : 's'}`);
  }
  return out.length ? out.join(' ') : '0 seconds';
}

interface RenderContext {
  readonly doc: LabelDocument;
  readonly user: string;
  readonly book: ReadonlyMap<string, string>;
  readonly tokenNetwork: Parameters<typeof knownToken>[0];
  /** The value of a declared argument by path, as read for its type. */
  readonly valueAt: (path: string) => ArgValue | undefined;
}

/** The account as the window names it: the user's own, a name from the address book (exactly listed), or itself. */
function accountValue(account: string, user: string, book: ReadonlyMap<string, string>): RenderedValue & { format: 'account' } {
  if (account === user) return Object.freeze({ format: 'account', value: account, text: 'your account', source: 'computed_self' });
  const name = book.get(account);
  if (name !== undefined) return Object.freeze({ format: 'account', value: account, text: name, source: 'partner_address_book' });
  return Object.freeze({ format: 'account', value: account, text: account, source: 'request' });
}

/** A field's value, or the no-match it is. */
function renderField(f: LabelField, c: RenderContext): RenderedValue | LabelNoMatch {
  const value = c.valueAt(f.path);
  const p = f.params;
  if (value === undefined) {
    // An optional argument the request leaves out has nothing to show: a description that names it in a field needs it.
    return no('missing_arg', f.path);
  }
  switch (p.format) {
    case 'enum': {
      const raw = value.kind === 'int' ? value.v.toString() : value.kind === 'text' ? value.v : null;
      const labels = c.doc.metadata.enums[p.enum]!;
      if (raw === null || !Object.hasOwn(labels, raw)) return no('enum_value_not_listed', f.path);
      return Object.freeze({ format: 'enum', raw, text: labels[raw]!, source: 'partner_enum' });
    }
    case 'tokenAmount': {
      if (value.kind !== 'int') return no('type_mismatch', f.path);
      if (value.v < 0n) return no('out_of_bounds', f.path);
      let token: string;
      if ('token' in p) token = p.token;
      else {
        const t = c.valueAt(p.tokenPath);
        if (t === undefined || t.kind !== 'account') return no('missing_arg', p.tokenPath);
        token = t.v;
      }
      const listed = knownToken(c.tokenNetwork, token);
      const raw = value.v.toString();
      if (listed && listed.kind === 'token') {
        return Object.freeze({ format: 'tokenAmount', raw, token, text: `${groupDigits(formatTokenUnits(value.v, listed.decimals))} ${listed.symbol}`, symbol: listed.symbol, decimals: listed.decimals, source: 'journear_known_tokens', kind: 'token', binding: 'partner' });
      }
      if (listed) {
        return Object.freeze({ format: 'tokenAmount', raw, token, text: `item ${raw} of ${listed.symbol}`, symbol: listed.symbol, decimals: null, source: 'journear_known_tokens', kind: 'collectible', binding: 'partner' });
      }
      return Object.freeze({ format: 'tokenAmount', raw, token, text: `${groupDigits(raw)} units of the unlisted token ${token}`, symbol: null, decimals: null, source: 'unlisted_token', kind: null, binding: 'partner' });
    }
    case 'nativeAmount': {
      if (value.kind !== 'int' || value.v < 0n) return no('type_mismatch', f.path);
      return Object.freeze({ format: 'nativeAmount', raw: value.v.toString(), text: groupDigits(formatNear(value.v)), source: 'request', binding: 'request' });
    }
    case 'account':
      if (value.kind !== 'account') return no('type_mismatch', f.path);
      return accountValue(value.v, c.user, c.book);
    case 'date':
    case 'duration': {
      if (value.kind !== 'int' || value.v < 0n) return no('out_of_bounds', f.path);
      const ns = value.v * UNIT_NS[p.unit];
      // A date is shown to the second (below a millisecond is dropped); a duration is exact or not shown.
      const ms = ns / 1_000_000n;
      if (p.format === 'duration' && ns % 1_000_000n !== 0n) return no('value_not_displayable', f.path);
      if (p.format === 'date') {
        if (ms < DATE_MIN_MS || ms > DATE_MAX_MS) return no('out_of_bounds', f.path);
        return Object.freeze({ format: 'date', raw: value.v.toString(), text: dateText(ms), source: 'request' });
      }
      if (ms > DURATION_MAX_MS) return no('out_of_bounds', f.path);
      return Object.freeze({ format: 'duration', raw: value.v.toString(), text: durationText(ms), source: 'request' });
    }
    case 'count': {
      if (value.kind !== 'int') return no('type_mismatch', f.path);
      if (value.v < BigInt(p.min) || value.v > BigInt(p.max)) return no('out_of_bounds', f.path);
      return Object.freeze({ format: 'count', raw: value.v.toString(), text: groupDigits(value.v.toString()), source: 'request' });
    }
    case 'itemId':
    case 'orderNumber': {
      const raw = value.kind === 'int' ? value.v.toString() : value.kind === 'text' ? value.v : null;
      if (raw === null || !ID_TEXT.test(raw)) return no('value_not_displayable', f.path);
      return Object.freeze({ format: p.format, raw, text: raw, source: 'request' });
    }
  }
}

/** The fields and the sentence of a format whose call matched, or the first field that doesn't. */
function build(key: string, format: LabelFormat, c: RenderContext, raw: readonly Omit<TrueValue, 'shown'>[], destination?: RenderedValue & { format: 'account' }): LabelMatchResult {
  const rendered = new Map<string, RenderedField>();
  for (const f of format.fields) {
    const v = renderField(f, c);
    if ('ok' in v) return v;
    rendered.set(f.path, Object.freeze({ path: f.path, label: f.label, value: v }));
  }
  const parts: SentencePart[] = format.sentence.map((s): SentencePart => {
    switch (s.kind) {
      case 'verb':
        return Object.freeze({ kind: 'verb', text: format.intent.verb });
      case 'object':
        return Object.freeze({ kind: 'object', text: format.intent.object! });
      case 'word':
        return Object.freeze({ kind: 'word', text: s.word });
      case 'field':
        return Object.freeze({ kind: 'value', path: s.path, value: rendered.get(s.path)!.value });
    }
  });
  return Object.freeze({
    ok: true,
    format: key,
    verb: format.intent.verb,
    parts: Object.freeze(parts),
    fields: Object.freeze(format.fields.map((f) => rendered.get(f.path)!)),
    ...(destination ? { destination } : {}),
    values: Object.freeze(raw.map((v) => Object.freeze({ ...v, shown: rendered.has(v.path) }))),
  });
}

const relayFails = (rule: RelayRule, relayed: boolean): LabelNoMatch | null =>
  rule === 'relayed' && !relayed ? no('direct_not_allowed') : rule === 'direct' && relayed ? no('relayed_not_allowed') : null;

/** The format for this key, own property only (a method named `constructor` or `__proto__` is just a key). */
const formatFor = (doc: LabelDocument, key: string): LabelFormat | undefined => (Object.hasOwn(doc.formats, key) ? doc.formats[key] : undefined);

const utf8Fatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Strict JSON object arguments (UTF-8, no BOM, no duplicate key, nothing trailing), {} for none, or the no-match. */
function nearArgs(bytes: Uint8Array, declared: number): { readonly args: Record<string, StrictJson> } | LabelNoMatch {
  if (bytes.length === 0) return declared === 0 ? { args: Object.create(null) as Record<string, StrictJson> } : no('args_not_json', 'args');
  if (bytes.length > NEAR_ARGS_JSON_MAX_BYTES) return no('args_not_json', 'args');
  let v: StrictJson;
  try {
    v = parseStrictJson(utf8Fatal.decode(bytes));
  } catch {
    return no('args_not_json', 'args');
  }
  return isJsonObject(v) ? { args: v } : no('args_not_object', 'args');
}

function matchNear(doc: LabelDocument, req: Extract<LabelRequest, { kind: 'near' }>, facts: LabelChainFacts): LabelMatchResult {
  const ctx = doc.context;
  if (ctx.chain !== 'near') return no('wrong_chain');
  if (req.network !== ctx.network) return no('wrong_network');
  if (req.receiver !== ctx.account) return no('wrong_account', 'receiver');
  if (req.receiver === req.user) return no('calls_own_account', 'receiver');
  if (facts.reviewedNear?.includes(req.receiver)) return no('journear_reads_this', 'receiver');
  if (facts.networkChecked !== true) return no('network_not_checked');
  const hash = codeHashFails(facts.codeHash, ctx.codeHash, 'near');
  if (hash) return hash;
  if (req.actions.length !== 1) return no('more_than_one_action');
  const a = req.actions[0]!;
  if (a.type !== 'functionCall') return no('not_a_function_call');
  const format = formatFor(doc, a.methodName);
  if (format === undefined || format.chain !== 'near') return no('wrong_method', 'method');
  const call: NearCallSpec = format.call;
  const relay = relayFails(call.relayed, req.relayed);
  if (relay) return relay;
  if ('exactly' in call.deposit ? a.deposit !== BigInt(call.deposit.exactly) : a.deposit > BigInt(call.deposit.atMost)) return no('deposit_not_allowed', 'deposit');
  if (call.gasAtMost !== undefined && a.gas > BigInt(call.gasAtMost)) return no('gas_too_high', 'gas');
  const parsed = nearArgs(a.args, call.args.length);
  if (!('args' in parsed)) return parsed;
  const obj = parsed.args;
  const declared = new Map(call.args.map((s) => [s.name, s]));
  for (const k of Object.keys(obj)) if (!declared.has(k)) return no('undeclared_arg', argAt(k));
  const book = new Map(doc.metadata.addressBook.map((e) => [e.account, e.name]));
  const bookSet = new Set(book.keys());
  const values = new Map<string, ArgValue>();
  for (const spec of call.args) {
    const path = `args.${spec.name}`;
    if (!Object.hasOwn(obj, spec.name)) {
      if (spec.optional) continue;
      return no('missing_arg', path);
    }
    const v = nearValue(obj[spec.name]!, spec.type);
    if (v === null) return no('type_mismatch', path);
    const fails = constraintFails(spec, v, path, req.user, bookSet);
    if (fails) return fails;
    values.set(path, v);
  }
  values.set('deposit', { kind: 'int', v: a.deposit });
  const raw: Omit<TrueValue, 'shown'>[] = [
    ...call.args.map((spec) => ({ path: `args.${spec.name}`, type: spec.type, value: values.has(`args.${spec.name}`) ? valueText(values.get(`args.${spec.name}`)!) : null })),
    { path: 'deposit', type: 'deposit' as const, value: a.deposit.toString() },
    { path: 'gas', type: 'gas' as const, value: a.gas.toString() },
  ];
  return build(a.methodName, format, {
    doc,
    user: req.user,
    book,
    tokenNetwork: { kind: 'near', network: ctx.network },
    valueAt: (p) => values.get(p),
  }, raw);
}

/** Two decoded Soroban values are the same value (the auth entry authorizes exactly the call). */
const sameScVal = (a: StellarScVal, b: StellarScVal): boolean => JSON.stringify(a) === JSON.stringify(b);
const sameCall = (a: StellarContractCall, b: StellarContractCall): boolean =>
  a.contract === b.contract && a.function === b.function && a.args.length === b.args.length && a.args.every((x, i) => sameScVal(x, b.args[i]!));

function matchSoroban(doc: LabelDocument, req: Exclude<LabelRequest, { kind: 'near' }>, facts: LabelChainFacts): LabelMatchResult {
  const ctx = doc.context;
  if (ctx.chain !== 'soroban') return no('wrong_chain');
  if (req.networkPassphrase !== ctx.networkPassphrase) return no('wrong_network');
  let call: StellarContractCall;
  let relayed: boolean;
  let fee: string | null = null;
  if (req.kind === 'stellar_tx') {
    const tx = req.tx;
    if (tx.operations.length !== 1) return no('more_than_one_action');
    const op = tx.operations[0]!;
    if (op.type !== 'invokeHostFunction' || op.hostFunction.type !== 'invokeContract') return no('not_a_function_call');
    if (tx.source !== req.user || (op.source !== null && op.source !== req.user)) return no('source_not_user');
    call = op.hostFunction;
    // Every authorization the transaction carries is exactly this call, with nothing nested under it.
    for (const e of op.auth) {
      if (e.rootInvocation.subInvocations.length > 0) return no('nested_call');
      const f = e.rootInvocation.function;
      if (f.type !== 'contractFn' || !sameCall(f, call)) return no('nested_call');
    }
    relayed = false;
    fee = tx.fee;
  } else {
    const f = req.invocation.function;
    if (f.type !== 'contractFn') return no('not_a_function_call');
    if (req.invocation.subInvocations.length > 0) return no('nested_call');
    call = f;
    relayed = true;
  }
  if (call.contract !== ctx.contract) return no('wrong_account', 'contract');
  const hash = codeHashFails(facts.codeHash, ctx.wasmHash, 'soroban');
  if (hash) return hash;
  const format = formatFor(doc, call.function);
  if (format === undefined || format.chain !== 'soroban') return no('wrong_method', 'function');
  const spec: SorobanCallSpec = format.call;
  if (facts.sorobanParams !== undefined && facts.sorobanParams !== null) {
    const names = spec.args.map((x) => x.name);
    if (names.length !== facts.sorobanParams.length || names.some((n, i) => n !== facts.sorobanParams![i])) return no('spec_mismatch');
  }
  const relay = relayFails(spec.relayed, relayed);
  if (relay) return relay;
  if (spec.feeAtMost !== undefined && fee !== null && BigInt(fee) > BigInt(spec.feeAtMost)) return no('fee_too_high', 'fee');
  if (call.args.length > spec.args.length) return no('undeclared_arg', `args[${spec.args.length}]`);
  if (call.args.length < spec.args.length) return no('missing_arg', `args.${spec.args[call.args.length]!.name}`);
  const book = new Map(doc.metadata.addressBook.map((e) => [e.account, e.name]));
  const bookSet = new Set(book.keys());
  const values = new Map<string, ArgValue>();
  for (let i = 0; i < spec.args.length; i++) {
    const s = spec.args[i]!;
    const path = `args.${s.name}`;
    const v = sorobanValue(call.args[i]!, s.type);
    if (v === null) return no('type_mismatch', path);
    const fails = constraintFails(s, v, path, req.user, bookSet);
    if (fails) return fails;
    values.set(path, v);
  }
  const raw: Omit<TrueValue, 'shown'>[] = [
    ...spec.args.map((x) => ({ path: `args.${x.name}`, type: x.type, value: valueText(values.get(`args.${x.name}`)!) })),
    { path: 'fee', type: 'fee' as const, value: fee },
  ];
  return build(
    call.function,
    format,
    {
      doc,
      user: req.user,
      book,
      tokenNetwork: { kind: 'stellar', networkPassphrase: ctx.networkPassphrase },
      valueAt: (p) => values.get(p),
    },
    raw,
  );
}

const MEMO_TEXT_OK = (s: string): boolean => isDisplaySafeLine(s) && !COMBINING_RUN.test(s) && !QUOTE_LIKE.test(s);

function matchPayment(doc: LabelDocument, req: Exclude<LabelRequest, { kind: 'near' }>): LabelMatchResult {
  const ctx = doc.context;
  if (ctx.chain !== 'stellar') return no('wrong_chain');
  if (req.networkPassphrase !== ctx.networkPassphrase) return no('wrong_network');
  if (req.kind !== 'stellar_tx') return no('wrong_operation');
  const tx = req.tx;
  if (tx.operations.length !== 1) return no('more_than_one_action');
  const op = tx.operations[0]!;
  const format = formatFor(doc, 'payment');
  if (op.type !== 'payment' || format === undefined || format.chain !== 'stellar') return no('wrong_operation');
  const call: PaymentCallSpec = format.call;
  if (tx.source !== req.user || (op.source !== null && op.source !== req.user)) return no('source_not_user');
  const book = new Map(doc.metadata.addressBook.map((e) => [e.account, e.name]));
  if (!book.has(op.destination)) return no('not_in_address_book', 'destination');
  if (call.assets !== undefined && !call.assets.includes(op.asset)) return no('token_not_allowed', 'asset');
  if (call.amountAtMost !== undefined && BigInt(op.amount) > BigInt(call.amountAtMost)) return no('out_of_bounds', 'amount');
  if (call.feeAtMost !== undefined && BigInt(tx.fee) > BigInt(call.feeAtMost)) return no('fee_too_high', 'fee');
  if (tx.memo.type !== call.memo) return no('memo_mismatch', 'memo');
  let memo: ArgValue | undefined;
  if (tx.memo.type === 'text') {
    if (tx.memo.value === null || !MEMO_TEXT_OK(tx.memo.value)) return no('value_not_displayable', 'memo');
    memo = { kind: 'text', v: tx.memo.value };
  } else if (tx.memo.type === 'id') memo = { kind: 'int', v: BigInt(tx.memo.value) };
  return build(
    'payment',
    format,
    {
      doc,
      user: req.user,
      book,
      tokenNetwork: { kind: 'stellar', networkPassphrase: ctx.networkPassphrase },
      valueAt: (p) => (p === 'memo' ? memo : undefined),
    },
    [
      { path: 'amount', type: 'amount', value: op.amount },
      { path: 'asset', type: 'asset', value: op.asset },
      { path: 'destination', type: 'destination', value: op.destination },
      { path: 'memo', type: 'memo', value: memo === undefined ? null : `${tx.memo.type}:${valueText(memo)}` },
      { path: 'fee', type: 'fee', value: tx.fee },
    ],
    accountValue(op.destination, req.user, book),
  );
}

/**
 * Whether `req` is exactly a call `doc` describes. A match needs all of: the document's chain and network; the
 * contract it binds (its account or contract id, never the user's own account) and, for NEAR and Soroban, its code
 * hash equal to `facts.codeHash`; one action, a call of a described method or function with nothing nested; every
 * constraint of the format met (deposit, gas, fee, relayed or direct, each declared argument present, of its type and
 * within its bounds, no argument not declared); every field's value showable (an enumeration value listed, a number
 * within bounds, an id in plain characters). Anything else is a no-match with its reason.
 */
export function matchLabel(doc: LabelDocument, req: LabelRequest, facts: LabelChainFacts = {}): LabelMatchResult {
  if (req.kind === 'near') return matchNear(doc, req, facts);
  if (doc.context.chain === 'near') return no('wrong_chain');
  return doc.context.chain === 'soroban' ? matchSoroban(doc, req, facts) : matchPayment(doc, req);
}

// ---- the plain-text form ----

/**
 * A value as the plain-text form writes it: partner words (an enumeration label, an address book name) and ids in
 * quotation marks (partner text can hold none, and an id is plain ASCII), so they never run into Journear's words;
 * a token amount as the partner's description of the request's units, naming the app ("2,500,000 units, which Stamp
 * Trail says are 2.5 USDC"; "10 units of the unlisted token x.testnet, as Stamp Trail describes it"); NEAR's deposit,
 * dates and numbers as Journear wrote them; "your account" and a bare account as they are. The window renders the
 * structured parts itself (a later piece); this form is for tests and the console's preview.
 */
export function valuePlainText(v: RenderedValue, appName = 'the app'): string {
  switch (v.format) {
    case 'enum':
    case 'itemId':
    case 'orderNumber':
      return `“${v.text}”`;
    case 'account':
      return v.source === 'partner_address_book' ? `“${v.text}” (${v.value})` : v.text;
    case 'tokenAmount':
      if (v.kind === 'token') return `${groupDigits(v.raw)} units, which ${appName} says are ${v.text}`;
      return `${v.text}, as ${appName} describes it`;
    default:
      return v.text;
  }
}

/**
 * The sentence as plain text, deterministically, for tests and the console's preview: the parts joined by single
 * spaces ("collect the stamp “Fare paid”"). The window renders `parts` itself, with its own markup.
 */
export const sentencePlainText = (parts: readonly SentencePart[], appName = 'the app'): string => parts.map((p) => (p.kind === 'value' ? valuePlainText(p.value, appName) : p.text)).join(' ');

/** The whole line as the console previews it: "{App} says: {sentence}". */
export const labelLinePlainText = (appName: string, m: LabelMatch): string => `${appName} says: ${sentencePlainText(m.parts, appName)}`;

/** What a no-match means for the window's later mismatch line. */
export type NoMatchKind =
  /** The request isn't one the document describes at all: show today's screen, say nothing about a description. */
  | 'not_described'
  /** A described call, but this request doesn't meet its description: the mismatch line ("doesn't match its description"). */
  | 'described_mismatch'
  /** Journear couldn't check what the match needs (the code hash, the network): today's screen, no mismatch claim. */
  | 'couldnt_check';

const NOT_DESCRIBED: ReadonlySet<LabelNoMatchCode> = new Set<LabelNoMatchCode>(['wrong_chain', 'wrong_network', 'wrong_account', 'wrong_method', 'wrong_operation', 'calls_own_account', 'journear_reads_this', 'not_a_function_call']);
const COULDNT_CHECK: ReadonlySet<LabelNoMatchCode> = new Set<LabelNoMatchCode>(['no_code_hash', 'bad_code_hash_input', 'network_not_checked']);

/** The kind of a no-match (`NoMatchKind`), so a renderer never infers it from the codes itself. */
export const noMatchKind = (reason: LabelNoMatchCode): NoMatchKind => (NOT_DESCRIBED.has(reason) ? 'not_described' : COULDNT_CHECK.has(reason) ? 'couldnt_check' : 'described_mismatch');

// ---- the preview (D894): every format with example values, exactly as the plain-text form renders a match ----

/** One format as users would see it, with made-up example values (core's plain-text form, for the console and staff). */
export interface LabelPreviewFormat {
  readonly key: string;
  /** "{App} says: …" */
  readonly line: string;
  readonly sentence: string;
  readonly parts: readonly { readonly kind: 'verb' | 'word' | 'object' | 'value'; readonly text: string }[];
  readonly fields: readonly { readonly label: string; readonly value: string }[];
}

/** The example user in a preview: an account argument marked `isSelf` reads "your account". */
const PREVIEW_USER = 'the-user.example';
/** A placeholder Stellar account (the all-zero key's address) for an account argument with no listed value. */
const PREVIEW_STELLAR = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
/** 1 January 2027, 00:00 UTC, and two hours: the example date and duration. */
const PREVIEW_DATE_MS = 1_798_761_600_000n;
const PREVIEW_DURATION_MS = 7_200_000n;

const clamp = (v: bigint, lo?: string, hi?: string): bigint => {
  let x = v;
  if (hi !== undefined && x > BigInt(hi)) x = BigInt(hi);
  if (lo !== undefined && x < BigInt(lo)) x = BigInt(lo);
  return x;
};

/** The example value of a declared argument, chosen to meet its constraints where it can. */
function exampleArg(spec: ArgSpec, field: LabelField | undefined, c: { doc: LabelDocument; near: NearNetwork | null; tokenNetwork: Parameters<typeof knownToken>[0] }): ArgValue {
  const p = field?.params;
  switch (spec.type) {
    case 'accountId':
    case 'address': {
      if (spec.isSelf) return { kind: 'account', v: PREVIEW_USER };
      if (spec.oneOf?.length) return { kind: 'account', v: spec.oneOf[0]! };
      const listed = c.doc.metadata.addressBook[0];
      if (listed) return { kind: 'account', v: listed.account };
      return { kind: 'account', v: c.near ? `example.${c.near}` : PREVIEW_STELLAR };
    }
    case 'string':
    case 'symbol': {
      if (spec.oneOf?.length) return { kind: 'text', v: spec.oneOf[0]! };
      if (p?.format === 'enum') {
        const first = Object.keys(c.doc.metadata.enums[p.enum] ?? {})[0];
        if (first !== undefined) return { kind: 'text', v: first };
      }
      return { kind: 'text', v: '1042' };
    }
    case 'boolean':
    case 'bool':
      return { kind: 'bool', v: spec.equals ?? true };
    case 'integer':
    case 'u32':
    case 'i32': {
      const lo = spec.min === undefined ? undefined : String(spec.min);
      const hi = spec.max === undefined ? undefined : String(spec.max);
      if (p?.format === 'enum') {
        const first = Object.keys(c.doc.metadata.enums[p.enum] ?? {}).find((k) => DECIMAL.test(k));
        if (first !== undefined) return { kind: 'int', v: BigInt(first) };
      }
      if (p?.format === 'count') return { kind: 'int', v: clamp(1n, String(Math.max(p.min, spec.min ?? p.min)), String(Math.min(p.max, spec.max ?? p.max))) };
      return { kind: 'int', v: clamp(p?.format === 'itemId' || p?.format === 'orderNumber' ? 1042n : 1n, lo, hi) };
    }
    default: {
      // u128, u64, i128, i64, timepoint, duration.
      const s = spec as Extract<ArgSpec, { atLeast?: string }>;
      let v = 1n;
      if (p?.format === 'enum') {
        const first = Object.keys(c.doc.metadata.enums[p.enum] ?? {}).find((k) => DECIMAL.test(k));
        if (first !== undefined) return { kind: 'int', v: BigInt(first) };
      } else if (p?.format === 'date' || p?.format === 'duration') {
        const ms = p.format === 'date' ? PREVIEW_DATE_MS : PREVIEW_DURATION_MS;
        v = (ms * 1_000_000n) / UNIT_NS[p.unit];
      } else if (p?.format === 'nativeAmount') v = 10n ** 24n;
      else if (p?.format === 'tokenAmount') {
        const token = 'token' in p ? p.token : null;
        const listed = token === null ? null : knownToken(c.tokenNetwork, token);
        v = listed && listed.kind === 'token' && listed.decimals > 0 ? 25n * 10n ** BigInt(listed.decimals - 1) : 25n;
      } else if (p?.format === 'itemId' || p?.format === 'orderNumber') v = 1042n;
      else if (p?.format === 'count') v = clamp(1n, String(p.min), String(p.max));
      return { kind: 'int', v: clamp(v, s.atLeast, s.atMost) };
    }
  }
}

/**
 * Every format of a parsed document as users would see it, with example values: each field rendered by the matcher's
 * own renderer and the sentence by `sentencePlainText`, so the console's and the staff feed's preview is the plain form
 * a real match would give (values aside). An example that the document's own constraints can't take reads "(an
 * example value)". Pure.
 */
export function previewLabelDocument(doc: LabelDocument, appName: string): LabelPreviewFormat[] {
  const ctx = doc.context;
  const near = ctx.chain === 'near' ? ctx.network : null;
  const tokenNetwork: Parameters<typeof knownToken>[0] = ctx.chain === 'near' ? { kind: 'near', network: ctx.network } : { kind: 'stellar', networkPassphrase: ctx.networkPassphrase };
  const book = new Map(doc.metadata.addressBook.map((e) => [e.account, e.name]));
  return Object.keys(doc.formats).map((key) => {
    const format = doc.formats[key]!;
    const values = new Map<string, ArgValue>();
    const fieldAt = (path: string) => format.fields.find((f) => f.path === path);
    if (format.chain === 'near' || format.chain === 'soroban') {
      for (const spec of format.call.args) values.set(`args.${spec.name}`, exampleArg(spec, fieldAt(`args.${spec.name}`), { doc, near, tokenNetwork }));
      // A tokenPath names an account argument: its example is a token (its first listed value, else a placeholder), never an address book name.
      for (const f of format.fields) {
        if (f.params.format !== 'tokenAmount' || !('tokenPath' in f.params)) continue;
        const spec = format.call.args.find((a) => `args.${a.name}` === (f.params as { tokenPath: string }).tokenPath) as { oneOf?: readonly string[] } | undefined;
        values.set(f.params.tokenPath, { kind: 'account', v: spec?.oneOf?.[0] ?? (near ? `token.${near}` : PREVIEW_STELLAR) });
      }
    }
    if (format.chain === 'near') {
      const d = format.call.deposit;
      values.set('deposit', { kind: 'int', v: 'exactly' in d ? BigInt(d.exactly) : clamp(10n ** 24n, undefined, d.atMost) });
    }
    if (format.chain === 'stellar') values.set('memo', format.call.memo === 'id' ? { kind: 'int', v: 1042n } : { kind: 'text', v: '1042' });
    const rc: RenderContext = { doc, user: PREVIEW_USER, book, tokenNetwork, valueAt: (p) => values.get(p) };
    const rendered = new Map<string, string>();
    for (const f of format.fields) {
      const v = renderField(f, rc);
      rendered.set(f.path, 'ok' in v ? '(an example value)' : valuePlainText(v, appName));
    }
    const parts = format.sentence.map((s) => {
      switch (s.kind) {
        case 'verb':
          return { kind: 'verb' as const, text: format.intent.verb as string };
        case 'object':
          return { kind: 'object' as const, text: format.intent.object! };
        case 'word':
          return { kind: 'word' as const, text: s.word as string };
        case 'field':
          return { kind: 'value' as const, text: rendered.get(s.path) ?? '(an example value)' };
      }
    });
    const sentence = parts.map((p) => p.text).join(' ');
    return Object.freeze({ key, line: `${appName} says: ${sentence}`, sentence, parts: Object.freeze(parts), fields: Object.freeze(format.fields.map((f) => ({ label: f.label, value: rendered.get(f.path)! }))) });
  });
}
