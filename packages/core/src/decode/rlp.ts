// Strict RLP decoder for unsigned EVM transactions. Only canonical encodings are accepted (a single byte < 0x80 is
// itself, lengths use the short form below 56 and have no leading zeros, nothing trails the item), so one byte string
// has exactly one reading.
import { fail } from './errors.ts';

export type RlpItem = Uint8Array | RlpItem[];

export const RLP_MAX_DEPTH = 16;

/** Decodes exactly one RLP item filling `bytes`. Throws DecodeError('malformed' | 'too_large'). */
export function decodeRlp(bytes: Uint8Array): RlpItem {
  const [item, end] = readItem(bytes, 0, bytes.length, 0);
  if (end !== bytes.length) fail('malformed', 'Trailing bytes after RLP item');
  return item;
}

function readLength(bytes: Uint8Array, at: number, n: number, limit: number): number {
  if (at + n > limit) fail('malformed', 'RLP length runs past the end');
  if (bytes[at] === 0) fail('malformed', 'RLP length has a leading zero');
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + (bytes[at + i] as number);
  if (len < 56) fail('malformed', 'RLP long form used for a short length');
  return len;
}

function readItem(bytes: Uint8Array, at: number, limit: number, depth: number): [RlpItem, number] {
  if (at >= limit) fail('malformed', 'RLP item runs past the end');
  const b = bytes[at] as number;
  if (b < 0x80) return [bytes.slice(at, at + 1), at + 1];
  if (b <= 0xb7) {
    const len = b - 0x80;
    const start = at + 1;
    if (start + len > limit) fail('malformed', 'RLP string runs past the end');
    if (len === 1 && (bytes[start] as number) < 0x80) fail('malformed', 'Non-canonical RLP single byte');
    return [bytes.slice(start, start + len), start + len];
  }
  if (b <= 0xbf) {
    const n = b - 0xb7;
    const len = readLength(bytes, at + 1, n, limit);
    const start = at + 1 + n;
    if (start + len > limit) fail('malformed', 'RLP string runs past the end');
    return [bytes.slice(start, start + len), start + len];
  }
  if (depth >= RLP_MAX_DEPTH) fail('too_large', 'RLP nested too deep');
  let start: number;
  let len: number;
  if (b <= 0xf7) {
    len = b - 0xc0;
    start = at + 1;
  } else {
    const n = b - 0xf7;
    len = readLength(bytes, at + 1, n, limit);
    start = at + 1 + n;
  }
  const end = start + len;
  if (end > limit) fail('malformed', 'RLP list runs past the end');
  const items: RlpItem[] = [];
  let p = start;
  while (p < end) {
    const [item, next] = readItem(bytes, p, end, depth + 1);
    items.push(item);
    p = next;
  }
  return [items, end];
}

/** An RLP scalar (big-endian, no leading zeros, 0 is empty) → bigint. Throws DecodeError('invalid_value'). */
export function rlpScalar(item: RlpItem | undefined, what: string, maxBytes = 32): bigint {
  if (!(item instanceof Uint8Array)) fail('malformed', `${what} must be an RLP string`);
  if (item.length > maxBytes) fail('invalid_value', `${what} is too large`);
  if (item.length > 0 && item[0] === 0) fail('invalid_value', `${what} has a leading zero`);
  let n = 0n;
  for (const byte of item) n = (n << 8n) | BigInt(byte);
  return n;
}
