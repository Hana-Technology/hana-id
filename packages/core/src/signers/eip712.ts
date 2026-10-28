// EIP-712 hashing (eth_signTypedData_v4) over the normalized typed data. Parsing and normalizing the partner's JSON is
// `normalizeTypedData`'s job (the single EIP-712 parser, docs/batch-b-spec.md "Approval flow"): the approval popup
// renders its output and the vault hashes that same object here. TypedDataForHashing is the structural shape this
// module needs from it. This module still refuses anything it can't hash unambiguously (undeclared types, missing or
// extra fields, out-of-range values), so it is safe on its own; test/signers.test.ts checks it against viem.
import { keccak_256 } from '@noble/hashes/sha3';
import { parseEvmAddress } from '../addresses.ts';
import { type Bytes, concatBytes, from0xHex, toBytes, utf8 } from '../bytes.ts';

export interface TypedDataField {
  name: string;
  type: string;
}

export interface TypedDataForHashing {
  types: Readonly<Record<string, readonly TypedDataField[]>>;
  primaryType: string;
  domain: Readonly<Record<string, unknown>>;
  message: Readonly<Record<string, unknown>>;
}

const MAX_DEPTH = 32;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const ARRAY_SUFFIX = /^(.*)\[(\d*)\]$/u;
const UINT = /^uint(\d{1,3})$/u;
const INT = /^int(\d{1,3})$/u;
const BYTES_N = /^bytes(\d{1,2})$/u;

type Types = Readonly<Record<string, readonly TypedDataField[]>>;

const keccak = (b: Uint8Array): Bytes => toBytes(keccak_256(b));
/** Own-property lookup, so `__proto__` or `constructor` never resolve to Object.prototype members. */
const fieldsOf = (types: Types, name: string): readonly TypedDataField[] | undefined => (Object.hasOwn(types, name) ? types[name] : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);

function intBits(type: string, pattern: RegExp): number | null {
  const m = pattern.exec(type);
  if (!m) return null;
  const bits = Number(m[1]);
  if (bits < 8 || bits > 256 || bits % 8 !== 0) throw new Error(`Invalid EIP-712 type ${type}`);
  return bits;
}

function isAtomic(type: string): boolean {
  if (type === 'address' || type === 'bool' || type === 'string' || type === 'bytes') return true;
  const n = BYTES_N.exec(type);
  if (n) return Number(n[1]) >= 1 && Number(n[1]) <= 32;
  return intBits(type, UINT) !== null || intBits(type, INT) !== null;
}

/** Struct names `type` depends on (itself included), for encodeType. */
function dependencies(type: string, types: Types, found: Set<string>): Set<string> {
  const base = type.replace(/(\[\d*\])+$/u, '');
  if (found.has(base) || isAtomic(base)) return found;
  const fields = fieldsOf(types, base);
  if (!fields) throw new Error(`Undeclared EIP-712 type ${base}`);
  found.add(base);
  for (const f of fields) dependencies(f.type, types, found);
  return found;
}

/** encodeType: `Primary(t1 n1,…)` followed by its dependencies sorted by name. */
export function encodeType(primaryType: string, types: Types): string {
  const deps = [...dependencies(primaryType, types, new Set())].filter((t) => t !== primaryType).sort();
  return [primaryType, ...deps].map((t) => `${t}(${fieldsOf(types, t)!.map((f) => `${f.type} ${f.name}`).join(',')})`).join('');
}

export const typeHash = (primaryType: string, types: Types): Bytes => keccak(utf8(encodeType(primaryType, types)));

function toBigInt(v: unknown, type: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`EIP-712 ${type} value is not a safe integer`);
    return BigInt(v);
  }
  if (typeof v === 'string' && /^-?(?:0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/u.test(v)) {
    return v.startsWith('-') ? -BigInt(v.slice(1)) : BigInt(v);
  }
  throw new Error(`EIP-712 ${type} value must be an integer`);
}

function bytesValue(v: unknown, type: string): Bytes {
  if (v instanceof Uint8Array) return toBytes(v);
  if (typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/u.test(v)) return from0xHex(v);
  throw new Error(`EIP-712 ${type} value must be 0x hex bytes`);
}

function word(n: bigint): Bytes {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function encodeValue(type: string, value: unknown, types: Types, depth: number): Bytes {
  if (depth > MAX_DEPTH) throw new Error('EIP-712 data is nested too deeply');
  const arr = ARRAY_SUFFIX.exec(type);
  if (arr) {
    const [, inner, len] = arr as unknown as [string, string, string];
    if (!Array.isArray(value)) throw new Error(`EIP-712 ${type} value must be an array`);
    if (len !== '' && value.length !== Number(len)) throw new Error(`EIP-712 ${type} value must have ${len} items`);
    return keccak(concatBytes(...value.map((v) => encodeValue(inner, v, types, depth + 1))));
  }
  if (fieldsOf(types, type)) {
    if (!isObj(value)) throw new Error(`EIP-712 ${type} value must be an object`);
    return keccak(encodeData(type, value, types, depth + 1));
  }
  if (type === 'string') {
    if (typeof value !== 'string') throw new Error('EIP-712 string value must be a string');
    return keccak(utf8(value));
  }
  if (type === 'bytes') return keccak(bytesValue(value, type));
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw new Error('EIP-712 bool value must be a boolean');
    return word(value ? 1n : 0n);
  }
  if (type === 'address') {
    if (typeof value !== 'string') throw new Error('EIP-712 address value must be a string');
    const out = new Uint8Array(32);
    out.set(parseEvmAddress(value), 12);
    return out;
  }
  const bn = BYTES_N.exec(type);
  if (bn) {
    const n = Number(bn[1]);
    if (n < 1 || n > 32) throw new Error(`Invalid EIP-712 type ${type}`);
    const b = bytesValue(value, type);
    if (b.length !== n) throw new Error(`EIP-712 ${type} value must be ${n} bytes`);
    const out = new Uint8Array(32);
    out.set(b);
    return out;
  }
  const ubits = intBits(type, UINT);
  if (ubits !== null) {
    const n = toBigInt(value, type);
    if (n < 0n || n >= 1n << BigInt(ubits)) throw new RangeError(`EIP-712 ${type} value is out of range`);
    return word(n);
  }
  const ibits = intBits(type, INT);
  if (ibits !== null) {
    const n = toBigInt(value, type);
    const half = 1n << BigInt(ibits - 1);
    if (n < -half || n >= half) throw new RangeError(`EIP-712 ${type} value is out of range`);
    return word(n < 0n ? (1n << 256n) + n : n);
  }
  throw new Error(`Undeclared EIP-712 type ${type}`);
}

function checkFields(type: string, fields: readonly TypedDataField[]): void {
  const names = new Set<string>();
  for (const f of fields) {
    if (!isObj(f) || typeof f.name !== 'string' || typeof f.type !== 'string' || !IDENT.test(f.name)) throw new Error(`Malformed EIP-712 field in ${type}`);
    if (names.has(f.name)) throw new Error(`Duplicate EIP-712 field ${type}.${f.name}`);
    names.add(f.name);
  }
}

/**
 * Every struct name is an identifier that isn't an atomic type name (a struct called `address` would hash differently
 * across implementations), and every field type is atomic, a declared struct, or an array of those.
 */
function checkTypes(types: Types): void {
  for (const [name, fields] of Object.entries(types)) {
    if (!IDENT.test(name) || isAtomic(name) || !Array.isArray(fields)) throw new Error(`Invalid EIP-712 type name ${name}`);
    checkFields(name, fields);
    for (const f of fields) {
      const base = f.type.replace(/(\[\d*\])+$/u, '');
      if (!isAtomic(base) && !fieldsOf(types, base)) throw new Error(`Undeclared EIP-712 type ${base}`);
    }
  }
}

/** encodeData: typeHash ‖ the 32-byte encoding of every declared field. Every field must be present, and no others. */
function encodeData(type: string, data: Record<string, unknown>, types: Types, depth: number): Bytes {
  const fields = fieldsOf(types, type);
  if (!fields || !IDENT.test(type)) throw new Error(`Undeclared EIP-712 type ${type}`);
  checkFields(type, fields);
  const declared = new Set(fields.map((f) => f.name));
  for (const k of Object.keys(data)) if (!declared.has(k)) throw new Error(`EIP-712 field ${type}.${k} is not declared`);
  return concatBytes(
    typeHash(type, types),
    ...fields.map((f) => {
      if (!Object.hasOwn(data, f.name) || data[f.name] === undefined) throw new Error(`EIP-712 field ${type}.${f.name} is missing`);
      return encodeValue(f.type, data[f.name], types, depth);
    }),
  );
}

/** hashStruct(type, data) = keccak256(encodeData). */
export const hashStruct = (type: string, data: Record<string, unknown>, types: Types): Bytes => keccak(encodeData(type, data, types, 0));

/**
 * `types` must declare EIP712Domain. Implementations infer a missing one differently (viem by the values' JS types,
 * eth-sig-util as empty), so a digest over an inferred domain could differ from what the dApp verifies;
 * normalizeTypedData requires it too, and eth_signTypedData_v4 callers (viem, ethers) always send it.
 */
function domainTypes(td: TypedDataForHashing): Types {
  if (!fieldsOf(td.types, 'EIP712Domain')) throw new Error('EIP-712 types must declare EIP712Domain');
  return td.types;
}

/** The domain separator: hashStruct("EIP712Domain", domain). */
export const domainSeparator = (td: TypedDataForHashing): Bytes => hashStruct('EIP712Domain', { ...td.domain }, domainTypes(td));

/**
 * The EIP-712 digest: keccak256(0x19 ‖ 0x01 ‖ domainSeparator ‖ hashStruct(primaryType, message)), or without the
 * message hash when primaryType is EIP712Domain (as eth_signTypedData_v4 implementations do).
 */
export function hashTypedData(td: TypedDataForHashing): Bytes {
  if (!isObj(td) || !isObj(td.types) || !isObj(td.domain) || !isObj(td.message) || typeof td.primaryType !== 'string') throw new Error('Malformed typed data');
  const types = domainTypes(td);
  checkTypes(types);
  if (!fieldsOf(types, td.primaryType)) throw new Error(`primaryType ${td.primaryType} is not in types`);
  const parts = [Uint8Array.of(0x19, 0x01), hashStruct('EIP712Domain', { ...td.domain }, types)];
  if (td.primaryType !== 'EIP712Domain') parts.push(hashStruct(td.primaryType, { ...td.message }, types));
  return keccak(concatBytes(...parts));
}
