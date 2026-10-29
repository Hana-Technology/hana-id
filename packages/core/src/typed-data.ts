// EIP-712 typed data: the single strict parser (docs/batch-b-spec.md "Approval flow", eth_signTypedData_v4). The
// approval popup renders what normalizeTypedData returns and the vault hashes that same object with hashTypedData, so
// there is exactly one reading of a request. Anything ambiguous is refused before display: duplicate JSON keys, fields
// not declared in their type, missing fields, undeclared or cyclic types, a `primaryType` not in `types`, an
// `EIP712Domain` that isn't the standard fields in the standard order, or a domain that doesn't match its declaration.
import { keccak_256 } from '@noble/hashes/sha3';
import { DecodeError, fail } from './decode/errors.ts';
import { parseEvmAddress, parseHex0x, toHex0x } from './decode/hex.ts';
import { JsonNumber, type StrictJson, isJsonObject, parseStrictJson } from './decode/json.ts';

export interface TypedDataField {
  readonly name: string;
  readonly type: string;
}

export type TypedDataTypes = Readonly<Record<string, readonly TypedDataField[]>>;

/**
 * A normalized value. The field's declared type says how to read it: `uint*`/`int*` are bigint, `bool` is boolean,
 * `address` is an EIP-55 checksummed string, `bytes`/`bytesN` are `0x` lowercase hex, `string` is the string, arrays
 * are arrays and structs are TypedDataStruct.
 */
export type TypedDataValue = bigint | boolean | string | readonly TypedDataValue[] | TypedDataStruct;

/** A struct value: exactly its type's fields (null prototype, frozen). */
export interface TypedDataStruct {
  readonly [field: string]: TypedDataValue;
}

export interface NormalizedTypedData {
  /** Every declared type, `EIP712Domain` included, with its fields in declared order. */
  readonly types: TypedDataTypes;
  readonly primaryType: string;
  readonly domain: TypedDataStruct;
  readonly message: TypedDataStruct;
}

/** The standard `EIP712Domain` fields, in the order EIP-712 lists them. A domain declares a subsequence of these. */
export const EIP712_DOMAIN_FIELDS: readonly TypedDataField[] = Object.freeze([
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
  { name: 'salt', type: 'bytes32' },
]);

export const TYPED_DATA_MAX_TYPES = 128;
export const TYPED_DATA_MAX_FIELDS = 128;
export const TYPED_DATA_MAX_ARRAY_DIMENSION = 1024;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const TYPE_STRING = /^([A-Za-z_$][A-Za-z0-9_$]*)((?:\[(?:[1-9][0-9]*)?\])*)$/u;

type AtomicType =
  | { kind: 'address' }
  | { kind: 'bool' }
  | { kind: 'string' }
  | { kind: 'bytes' }
  | { kind: 'fixedBytes'; size: number }
  | { kind: 'int'; signed: boolean; bits: number };

export type ParsedTypedDataType =
  | AtomicType
  | { kind: 'struct'; name: string }
  | { kind: 'array'; element: ParsedTypedDataType; length: number | null };

function atomicType(name: string): AtomicType | null {
  if (name === 'address' || name === 'bool' || name === 'string' || name === 'bytes') return { kind: name };
  let m = /^bytes([1-9][0-9]?)$/u.exec(name);
  if (m) {
    const size = Number(m[1]);
    return size <= 32 ? { kind: 'fixedBytes', size } : null;
  }
  m = /^(u?)int([1-9][0-9]{0,2})$/u.exec(name);
  if (m) {
    const bits = Number(m[2]);
    return bits % 8 === 0 && bits <= 256 ? { kind: 'int', signed: m[1] === '', bits } : null;
  }
  return null;
}

/** True for a name EIP-712 treats as an atomic type (so it can't name a struct). `uint`/`int` aliases aren't types. */
export const isAtomicTypedDataType = (name: string): boolean => atomicType(name) !== null || /^u?int$/u.test(name);

/**
 * Parses a field type string (`uint256`, `Person`, `Mail[]`, `bytes32[2][]`). `structs` is the set of declared type
 * names; an undeclared struct name is refused.
 */
export function parseTypedDataType(type: string, structs: ReadonlySet<string>): ParsedTypedDataType {
  const m = TYPE_STRING.exec(type);
  if (!m) fail('typed_data_invalid', `Bad type "${type}"`);
  const base = m[1] as string;
  let parsed: ParsedTypedDataType;
  const atomic = atomicType(base);
  if (atomic) parsed = atomic;
  else if (structs.has(base)) parsed = { kind: 'struct', name: base };
  else fail('typed_data_invalid', `Undeclared type "${base}"`);
  for (const dim of (m[2] as string).match(/\[[0-9]*\]/gu) ?? []) {
    const length = dim === '[]' ? null : Number(dim.slice(1, -1));
    if (length !== null && length > TYPED_DATA_MAX_ARRAY_DIMENSION) fail('too_large', `Array dimension in "${type}"`);
    parsed = { kind: 'array', element: parsed, length };
  }
  return parsed;
}

const freezeStruct = (entries: [string, TypedDataValue][]): TypedDataStruct => {
  const obj = Object.create(null) as Record<string, TypedDataValue>;
  for (const [k, v] of entries) obj[k] = v;
  return Object.freeze(obj);
};

function parseTypes(raw: StrictJson | undefined): TypedDataTypes {
  if (!isJsonObject(raw)) fail('typed_data_invalid', '"types" must be an object');
  const names = Object.keys(raw);
  if (names.length > TYPED_DATA_MAX_TYPES) fail('too_large', 'Too many types');
  for (const name of names) {
    if (!IDENTIFIER.test(name)) fail('typed_data_invalid', `Bad type name "${name}"`);
    if (isAtomicTypedDataType(name)) fail('typed_data_invalid', `Type name "${name}" is an atomic type`);
  }
  const structs = new Set(names);
  const types = Object.create(null) as Record<string, readonly TypedDataField[]>;
  for (const name of names) {
    const fieldsRaw = raw[name];
    if (!Array.isArray(fieldsRaw)) fail('typed_data_invalid', `Type "${name}" must be an array of fields`);
    if (fieldsRaw.length > TYPED_DATA_MAX_FIELDS) fail('too_large', `Too many fields in "${name}"`);
    const seen = new Set<string>();
    const fields: TypedDataField[] = [];
    for (const f of fieldsRaw) {
      if (!isJsonObject(f)) fail('typed_data_invalid', `A field of "${name}" is not an object`);
      const keys = Object.keys(f);
      if (keys.length !== 2 || typeof f.name !== 'string' || typeof f.type !== 'string') {
        fail('typed_data_invalid', `A field of "${name}" must be exactly {name, type}`);
      }
      if (!IDENTIFIER.test(f.name)) fail('typed_data_invalid', `Bad field name in "${name}"`);
      if (seen.has(f.name)) fail('typed_data_invalid', `Duplicate field "${f.name}" in "${name}"`);
      seen.add(f.name);
      parseTypedDataType(f.type, structs); // refuses an undeclared type
      fields.push(Object.freeze({ name: f.name, type: f.type }));
    }
    types[name] = Object.freeze(fields);
  }

  // Refuse cycles (a type that references itself, directly or through others, arrays included).
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string) => {
    const s = state.get(name);
    if (s === 'done') return;
    if (s === 'visiting') fail('typed_data_invalid', `Cyclic type "${name}"`);
    state.set(name, 'visiting');
    for (const f of types[name] ?? []) {
      const base = structBase(parseTypedDataType(f.type, structs));
      if (base !== null) visit(base);
    }
    state.set(name, 'done');
  };
  for (const name of names) visit(name);

  const domain = types.EIP712Domain;
  if (domain === undefined) fail('typed_data_invalid', '"types" must declare EIP712Domain');
  let next = 0;
  for (const f of domain) {
    while (next < EIP712_DOMAIN_FIELDS.length && EIP712_DOMAIN_FIELDS[next]?.name !== f.name) next++;
    const std = EIP712_DOMAIN_FIELDS[next];
    if (std === undefined || std.type !== f.type) {
      fail('typed_data_invalid', 'EIP712Domain must be standard fields with standard types, in the standard order');
    }
    next++;
  }
  return Object.freeze(types);
}

function structBase(t: ParsedTypedDataType): string | null {
  while (t.kind === 'array') t = t.element;
  return t.kind === 'struct' ? t.name : null;
}

const DECIMAL = /^-?(?:0|[1-9][0-9]*)$/u;
const HEX_QUANTITY = /^0x[0-9a-fA-F]{1,64}$/u;

function parseInteger(raw: StrictJson, t: { signed: boolean; bits: number }, where: string): bigint {
  let n: bigint;
  if (raw instanceof JsonNumber) {
    if (!DECIMAL.test(raw.raw)) fail('typed_data_invalid', `${where}: integer expected`);
    n = BigInt(raw.raw);
  } else if (typeof raw === 'string' && DECIMAL.test(raw)) {
    n = BigInt(raw);
  } else if (typeof raw === 'string' && HEX_QUANTITY.test(raw)) {
    n = BigInt(raw);
  } else {
    fail('typed_data_invalid', `${where}: integer expected (number, decimal or 0x string)`);
  }
  const bits = BigInt(t.bits);
  const [min, max] = t.signed ? [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n] : [0n, (1n << bits) - 1n];
  if (n < min || n > max) fail('typed_data_invalid', `${where}: out of range for ${t.signed ? '' : 'u'}int${t.bits}`);
  return n;
}

function parseValue(
  types: TypedDataTypes,
  structs: ReadonlySet<string>,
  t: ParsedTypedDataType,
  raw: StrictJson | undefined,
  where: string,
): TypedDataValue {
  if (raw === undefined) fail('typed_data_invalid', `${where}: missing`);
  try {
    switch (t.kind) {
      case 'int':
        return parseInteger(raw, t, where);
      case 'bool':
        if (typeof raw !== 'boolean') fail('typed_data_invalid', `${where}: boolean expected`);
        return raw;
      case 'string':
        if (typeof raw !== 'string') fail('typed_data_invalid', `${where}: string expected`);
        return raw;
      case 'address':
        if (typeof raw !== 'string') fail('typed_data_invalid', `${where}: address expected`);
        return parseEvmAddress(raw);
      case 'bytes':
        if (typeof raw !== 'string') fail('typed_data_invalid', `${where}: hex bytes expected`);
        return toHex0x(parseHex0x(raw));
      case 'fixedBytes':
        if (typeof raw !== 'string') fail('typed_data_invalid', `${where}: hex bytes expected`);
        return toHex0x(parseHex0x(raw, t.size));
      case 'array': {
        if (!Array.isArray(raw)) fail('typed_data_invalid', `${where}: array expected`);
        if (t.length !== null && raw.length !== t.length) {
          fail('typed_data_invalid', `${where}: expected ${t.length} elements`);
        }
        return Object.freeze(raw.map((v, i) => parseValue(types, structs, t.element, v, `${where}[${i}]`)));
      }
      case 'struct':
        return parseStruct(types, structs, t.name, raw, where);
    }
  } catch (e) {
    if (e instanceof DecodeError && e.code === 'invalid_value') fail('typed_data_invalid', `${where}: ${e.message}`);
    throw e;
  }
}

function parseStruct(
  types: TypedDataTypes,
  structs: ReadonlySet<string>,
  name: string,
  raw: StrictJson,
  where: string,
): TypedDataStruct {
  if (!isJsonObject(raw)) fail('typed_data_invalid', `${where}: object expected for ${name}`);
  const fields = types[name] ?? [];
  const declared = new Set(fields.map((f) => f.name));
  for (const key of Object.keys(raw)) {
    if (!declared.has(key)) fail('typed_data_invalid', `${where}: field "${key}" is not declared in ${name}`);
  }
  return freezeStruct(
    fields.map((f) => [
      f.name,
      parseValue(types, structs, parseTypedDataType(f.type, structs), raw[f.name], `${where}.${f.name}`),
    ]),
  );
}

/**
 * Parses `eth_signTypedData_v4` typed data (the JSON string the dapp sent) and returns its normalized form. Throws
 * DecodeError ('malformed', 'too_large' or 'typed_data_invalid') for anything it refuses.
 */
export function normalizeTypedData(json: string): NormalizedTypedData {
  const root = parseStrictJson(json);
  if (!isJsonObject(root)) fail('typed_data_invalid', 'Typed data must be a JSON object');
  for (const key of Object.keys(root)) {
    if (key !== 'types' && key !== 'primaryType' && key !== 'domain' && key !== 'message') {
      fail('typed_data_invalid', `Unknown top-level key "${key}"`);
    }
  }
  const types = parseTypes(root.types);
  const structs = new Set(Object.keys(types));
  const primaryType = root.primaryType;
  if (typeof primaryType !== 'string' || !structs.has(primaryType)) {
    fail('typed_data_invalid', '"primaryType" must name a declared type');
  }
  if (primaryType === 'EIP712Domain') fail('typed_data_invalid', '"primaryType" can\'t be EIP712Domain');
  const domain = parseStruct(
    types,
    structs,
    'EIP712Domain',
    root.domain ?? fail('typed_data_invalid', 'No domain'),
    'domain',
  );
  const message = parseStruct(
    types,
    structs,
    primaryType,
    root.message ?? fail('typed_data_invalid', 'No message'),
    'message',
  );
  return Object.freeze({ types, primaryType, domain, message });
}

// --- Hashing (EIP-712 encodeType / hashStruct), over the normalized object only. ---

const utf8 = (s: string) => new TextEncoder().encode(s);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function word(n: bigint): Uint8Array {
  const v = n < 0n ? (1n << 256n) + n : n;
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** EIP-712 `encodeType(name)`: the type followed by its referenced struct types, sorted by name. */
export function encodeTypedDataType(types: TypedDataTypes, name: string): string {
  const structs = new Set(Object.keys(types));
  const deps = new Set<string>();
  const collect = (n: string) => {
    for (const f of types[n] ?? []) {
      const base = structBase(parseTypedDataType(f.type, structs));
      if (base !== null && base !== name && !deps.has(base)) {
        deps.add(base);
        collect(base);
      }
    }
  };
  collect(name);
  const render = (n: string) => `${n}(${(types[n] ?? []).map((f) => `${f.type} ${f.name}`).join(',')})`;
  return [name, ...[...deps].sort()].map(render).join('');
}

function encodeField(
  types: TypedDataTypes,
  structs: ReadonlySet<string>,
  t: ParsedTypedDataType,
  v: TypedDataValue,
): Uint8Array {
  switch (t.kind) {
    case 'struct':
      return hashStruct(types, structs, t.name, v as TypedDataStruct);
    case 'array':
      return keccak_256(concat((v as readonly TypedDataValue[]).map((e) => encodeField(types, structs, t.element, e))));
    case 'string':
      return keccak_256(utf8(v as string));
    case 'bytes':
      return keccak_256(parseHex0x(v as string));
    case 'bool':
      return word(v ? 1n : 0n);
    case 'int':
      return word(v as bigint);
    case 'address': {
      const out = new Uint8Array(32);
      out.set(parseHex0x(v as string, 20), 12);
      return out;
    }
    case 'fixedBytes': {
      const out = new Uint8Array(32);
      out.set(parseHex0x(v as string, t.size));
      return out;
    }
  }
}

function hashStruct(types: TypedDataTypes, structs: ReadonlySet<string>, name: string, v: TypedDataStruct): Uint8Array {
  const parts = [keccak_256(utf8(encodeTypedDataType(types, name)))];
  for (const f of types[name] ?? []) {
    parts.push(encodeField(types, structs, parseTypedDataType(f.type, structs), v[f.name] as TypedDataValue));
  }
  return keccak_256(concat(parts));
}

/** EIP-712 `hashStruct(EIP712Domain, domain)`. */
export function typedDataDomainSeparator(data: NormalizedTypedData): Uint8Array {
  return hashStruct(data.types, new Set(Object.keys(data.types)), 'EIP712Domain', data.domain);
}

/** The 32-byte EIP-712 digest the vault signs: keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct(message)). */
export function hashTypedData(data: NormalizedTypedData): Uint8Array {
  const structs = new Set(Object.keys(data.types));
  return keccak_256(
    concat([
      new Uint8Array([0x19, 0x01]),
      hashStruct(data.types, structs, 'EIP712Domain', data.domain),
      hashStruct(data.types, structs, data.primaryType, data.message),
    ]),
  );
}

/** The domain's chainId as a number, or null when the domain doesn't declare one. Throws if it isn't a safe integer. */
export function typedDataChainId(data: NormalizedTypedData): number | null {
  const id = data.domain.chainId;
  if (id === undefined) return null;
  if (typeof id !== 'bigint' || id <= 0n || id > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('typed_data_invalid', 'domain.chainId must be a positive safe integer');
  }
  return Number(id);
}
