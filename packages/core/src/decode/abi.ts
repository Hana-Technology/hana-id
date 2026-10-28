// Solidity ABI: canonical function signatures, 4-byte selectors and a strict calldata decoder. The approval page shows
// decoded arguments for known selectors and the auto-approve matcher checks every `address` value against the address
// rule, so the decoder accepts only the canonical encoding (heads in order, each tail exactly where the previous one
// ended, zero padding, values in range, nothing trailing): one calldata, one reading.
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { fail } from './errors.ts';
import { checksumAddress, toHex0x } from './hex.ts';

export type AbiType =
  | { kind: 'uint' | 'int'; bits: number }
  | { kind: 'address' }
  | { kind: 'bool' }
  | { kind: 'string' }
  | { kind: 'bytes' }
  | { kind: 'fixedBytes'; size: number }
  | { kind: 'array'; element: AbiType; length: number | null }
  | { kind: 'tuple'; components: AbiType[] };

export interface AbiFunction {
  readonly name: string;
  readonly params: readonly AbiType[];
  /** Canonical signature, e.g. `transfer(address,uint256)`. */
  readonly signature: string;
  /** `0x` + 8 lowercase hex: the first 4 bytes of keccak256(signature). */
  readonly selector: string;
}

/** A decoded value; `type` is its canonical ABI type string. Addresses are EIP-55, bytes are `0x` lowercase hex. */
export type AbiValue =
  | { readonly type: string; readonly kind: 'uint' | 'int'; readonly value: bigint }
  | { readonly type: string; readonly kind: 'address'; readonly value: string }
  | { readonly type: string; readonly kind: 'bool'; readonly value: boolean }
  | { readonly type: string; readonly kind: 'bytes'; readonly value: string }
  | { readonly type: string; readonly kind: 'string'; readonly value: string }
  | { readonly type: string; readonly kind: 'array' | 'tuple'; readonly items: readonly AbiValue[] };

export const ABI_MAX_SIGNATURE_LENGTH = 1024;
export const ABI_MAX_NESTING = 16;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/** Canonical type string (`uint256`, `(address,uint256)[]`). */
export function abiTypeString(t: AbiType): string {
  switch (t.kind) {
    case 'uint':
    case 'int':
      return `${t.kind}${t.bits}`;
    case 'fixedBytes':
      return `bytes${t.size}`;
    case 'array':
      return `${abiTypeString(t.element)}[${t.length ?? ''}]`;
    case 'tuple':
      return `(${t.components.map(abiTypeString).join(',')})`;
    default:
      return t.kind;
  }
}

function parseBaseType(name: string): AbiType {
  if (name === 'address' || name === 'bool' || name === 'string' || name === 'bytes') return { kind: name };
  let m = /^bytes([1-9][0-9]?)$/u.exec(name);
  if (m && Number(m[1]) <= 32) return { kind: 'fixedBytes', size: Number(m[1]) };
  m = /^(u?int)([1-9][0-9]{0,2})$/u.exec(name);
  if (m && Number(m[2]) % 8 === 0 && Number(m[2]) <= 256) {
    return { kind: m[1] === 'uint' ? 'uint' : 'int', bits: Number(m[2]) };
  }
  // `uint`/`int` aliases, `fixed`, `function` and anything else aren't canonical signature types.
  fail('invalid_value', `Unsupported or non-canonical ABI type "${name}"`);
}

/**
 * Parses a canonical function signature (`name(type,...)`, no spaces, no parameter names, `uint256` not `uint`).
 * Throws DecodeError('invalid_value') otherwise.
 */
export function parseFunctionSignature(signature: string): AbiFunction {
  if (signature.length > ABI_MAX_SIGNATURE_LENGTH) fail('too_large', 'Function signature too long');
  const open = signature.indexOf('(');
  const name = open < 0 ? '' : signature.slice(0, open);
  if (!IDENTIFIER.test(name) || !signature.endsWith(')')) fail('invalid_value', 'Bad function signature');
  let at = open + 1;
  const end = signature.length - 1;

  const list = (depth: number, closeAt: string): AbiType[] => {
    const out: AbiType[] = [];
    if (signature[at] === closeAt) return out;
    for (;;) {
      out.push(type(depth));
      if (signature[at] === ',') {
        at++;
        continue;
      }
      return out;
    }
  };

  const type = (depth: number): AbiType => {
    if (depth > ABI_MAX_NESTING) fail('too_large', 'ABI type nested too deep');
    let t: AbiType;
    if (signature[at] === '(') {
      at++;
      const components = list(depth + 1, ')');
      if (components.length === 0 || signature[at] !== ')') fail('invalid_value', 'Bad tuple in signature');
      at++;
      t = { kind: 'tuple', components };
    } else {
      const m = /^[a-z0-9]+/u.exec(signature.slice(at));
      if (!m) fail('invalid_value', 'Bad type in signature');
      at += m[0].length;
      t = parseBaseType(m[0]);
    }
    for (;;) {
      const m = /^\[([1-9][0-9]*)?\]/u.exec(signature.slice(at));
      if (!m) break;
      at += m[0].length;
      t = { kind: 'array', element: t, length: m[1] === undefined ? null : Number(m[1]) };
      if (++depth > ABI_MAX_NESTING) fail('too_large', 'ABI type nested too deep');
    }
    return t;
  };

  const params = list(0, ')');
  if (at !== end) fail('invalid_value', 'Bad function signature');
  const canonical = `${name}(${params.map(abiTypeString).join(',')})`;
  if (canonical !== signature) fail('invalid_value', 'Function signature is not canonical');
  return Object.freeze({ name, params: Object.freeze(params), signature, selector: functionSelector(signature) });
}

/** `0x` + 8 hex: the first 4 bytes of keccak256(utf8(signature)). Doesn't validate the signature. */
export function functionSelector(signature: string): string {
  return `0x${bytesToHex(keccak_256(new TextEncoder().encode(signature)).subarray(0, 4))}`;
}

/** True when `t`, or any type nested in it, satisfies `pred`. */
export function abiTypeContains(t: AbiType, pred: (t: AbiType) => boolean): boolean {
  if (pred(t)) return true;
  if (t.kind === 'array') return abiTypeContains(t.element, pred);
  if (t.kind === 'tuple') return t.components.some((c) => abiTypeContains(c, pred));
  return false;
}

const isDynamic = (t: AbiType): boolean =>
  t.kind === 'string' ||
  t.kind === 'bytes' ||
  (t.kind === 'array' && (t.length === null || isDynamic(t.element))) ||
  (t.kind === 'tuple' && t.components.some(isDynamic));

function headSize(t: AbiType): number {
  if (isDynamic(t)) return 32;
  if (t.kind === 'array') return (t.length as number) * headSize(t.element);
  if (t.kind === 'tuple') return t.components.reduce((n, c) => n + headSize(c), 0);
  return 32;
}

function wordAt(data: Uint8Array, at: number): Uint8Array {
  if (at + 32 > data.length) fail('malformed', 'ABI data runs past the end');
  return data.subarray(at, at + 32);
}

const wordValue = (w: Uint8Array): bigint => BigInt(`0x${bytesToHex(w)}`);

/** An offset or length word: must fit comfortably in a number. */
function smallWord(data: Uint8Array, at: number): number {
  const v = wordValue(wordAt(data, at));
  if (v > 0xffffffffn) fail('malformed', 'ABI offset or length too large');
  return Number(v);
}

function decodeStatic(t: AbiType, data: Uint8Array, at: number, depth: number): AbiValue {
  const type = abiTypeString(t);
  if (t.kind === 'array' || t.kind === 'tuple') {
    const types = t.kind === 'array' ? Array.from({ length: t.length as number }, () => t.element) : t.components;
    const [items] = decodeTuple(types, data, at, depth + 1);
    return { type, kind: t.kind, items };
  }
  const w = wordAt(data, at);
  switch (t.kind) {
    case 'uint': {
      const v = wordValue(w);
      if (v >> BigInt(t.bits) !== 0n) fail('invalid_value', `ABI ${type} out of range`);
      return { type, kind: 'uint', value: v };
    }
    case 'int': {
      const raw = wordValue(w);
      const v = raw >= 1n << 255n ? raw - (1n << 256n) : raw;
      const half = 1n << BigInt(t.bits - 1);
      if (v < -half || v >= half) fail('invalid_value', `ABI ${type} out of range`);
      return { type, kind: 'int', value: v };
    }
    case 'address':
      if (w.subarray(0, 12).some((b) => b !== 0)) fail('invalid_value', 'ABI address has dirty high bytes');
      return { type, kind: 'address', value: checksumAddress(w.subarray(12)) };
    case 'bool': {
      const v = wordValue(w);
      if (v > 1n) fail('invalid_value', 'ABI bool is not 0 or 1');
      return { type, kind: 'bool', value: v === 1n };
    }
    case 'fixedBytes':
      if (w.subarray(t.size).some((b) => b !== 0)) fail('invalid_value', `ABI ${type} has dirty padding`);
      return { type, kind: 'bytes', value: toHex0x(w.subarray(0, t.size)) };
    default:
      fail('malformed', `ABI ${type} is not static`);
  }
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Decodes a dynamic value whose encoding starts at `at`; returns it and where its encoding ends. */
function decodeDynamic(t: AbiType, data: Uint8Array, at: number, depth: number): [AbiValue, number] {
  const type = abiTypeString(t);
  if (t.kind === 'bytes' || t.kind === 'string') {
    const len = smallWord(data, at);
    const start = at + 32;
    const padded = Math.ceil(len / 32) * 32;
    if (start + padded > data.length) fail('malformed', `ABI ${type} runs past the end`);
    if (data.subarray(start + len, start + padded).some((b) => b !== 0)) fail('invalid_value', 'ABI dirty padding');
    const body = data.subarray(start, start + len);
    if (t.kind === 'bytes') return [{ type, kind: 'bytes', value: toHex0x(body) }, start + padded];
    let value: string;
    try {
      value = utf8Decoder.decode(body);
    } catch {
      fail('invalid_value', 'ABI string is not valid UTF-8');
    }
    return [{ type, kind: 'string', value }, start + padded];
  }
  if (t.kind === 'array') {
    let start = at;
    let length = t.length;
    if (length === null) {
      length = smallWord(data, at);
      start = at + 32;
      // Every element takes at least one word, so a larger count can't be honest (and would allocate a lot).
      if (length > (data.length - start) / 32) fail('malformed', 'ABI array length runs past the end');
    }
    const [items, end] = decodeTuple(
      Array.from({ length }, () => t.element),
      data,
      start,
      depth + 1,
    );
    return [{ type, kind: 'array', items }, end];
  }
  if (t.kind === 'tuple') {
    const [items, end] = decodeTuple(t.components, data, at, depth + 1);
    return [{ type, kind: 'tuple', items }, end];
  }
  fail('malformed', `ABI ${type} is not dynamic`);
}

function decodeTuple(types: readonly AbiType[], data: Uint8Array, start: number, depth: number): [AbiValue[], number] {
  if (depth > ABI_MAX_NESTING * 2) fail('too_large', 'ABI value nested too deep');
  let head = start;
  let tail = start + types.reduce((n, t) => n + headSize(t), 0);
  if (tail > data.length) fail('malformed', 'ABI data runs past the end');
  const out: AbiValue[] = [];
  for (const t of types) {
    if (isDynamic(t)) {
      const offset = smallWord(data, head);
      // Canonical encoding: each tail starts exactly where the previous one ended.
      if (start + offset !== tail) fail('invalid_value', 'Non-canonical ABI offset');
      const [v, end] = decodeDynamic(t, data, tail, depth);
      out.push(v);
      tail = end;
      head += 32;
    } else {
      out.push(decodeStatic(t, data, head, depth));
      head += headSize(t);
    }
  }
  return [out, tail];
}

/** Decodes `data` as exactly the ABI encoding of `types` (no trailing bytes). Throws DecodeError. */
export function decodeAbiParameters(types: readonly AbiType[], data: Uint8Array): AbiValue[] {
  const [values, end] = decodeTuple(types, data, 0, 0);
  if (end !== data.length) fail('malformed', 'Trailing bytes after ABI data');
  return values;
}

/** Decodes calldata for `fn`: checks the selector, then decodes the arguments strictly. Throws DecodeError. */
export function decodeFunctionData(fn: AbiFunction, calldata: Uint8Array): AbiValue[] {
  if (calldata.length < 4 || toHex0x(calldata.subarray(0, 4)) !== fn.selector) {
    fail('invalid_value', 'Calldata selector does not match the function');
  }
  return decodeAbiParameters(fn.params, calldata.subarray(4));
}

/** Every value in `values` (at any depth) of kind `kind`. */
export function abiValuesOfKind<K extends AbiValue['kind']>(
  values: readonly AbiValue[],
  kind: K,
): Extract<AbiValue, { kind: K }>[] {
  const out: Extract<AbiValue, { kind: K }>[] = [];
  const walk = (v: AbiValue) => {
    if (v.kind === kind) out.push(v as Extract<AbiValue, { kind: K }>);
    if (v.kind === 'array' || v.kind === 'tuple') v.items.forEach(walk);
  };
  values.forEach(walk);
  return out;
}
