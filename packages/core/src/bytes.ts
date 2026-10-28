// Byte helpers (browser, Worker and Node; no Buffer). All return Uint8Array<ArrayBuffer> so results can go straight to
// WebCrypto. Ported from apps/smoke/src/bytes.ts; hashing uses @noble/hashes so the layouts are synchronous.
import { sha256 as nobleSha256 } from '@noble/hashes/sha2';

export type Bytes = Uint8Array<ArrayBuffer>;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (s: string): Bytes => utf8Encoder.encode(s) as Bytes;

/** Strict UTF-8 decode: throws on invalid sequences. */
export const fromUtf8 = (b: Uint8Array): string => utf8Decoder.decode(b);

/** UTF-8 byte length of a string. */
export const utf8Length = (s: string): number => utf8Encoder.encode(s).length;

/** Copies any byte array (e.g. a noble result backed by ArrayBufferLike) into a fresh ArrayBuffer-backed one. */
export const toBytes = (b: Uint8Array | readonly number[]): Bytes => Uint8Array.from(b);

export function concatBytes(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Constant-time equality of two byte arrays (the length is not secret). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Little-endian u64 (8 bytes). `n` must be a non-negative safe integer. */
export function u64le(n: number): Bytes {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`Not a u64 safe integer: ${n}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

/** Little-endian u32 (4 bytes). */
export function u32le(n: number): Bytes {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`Not a u32: ${n}`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

/** Borsh `String`: u32 LE byte length ‖ UTF-8 bytes. */
export function borshString(s: string): Bytes {
  const bytes = utf8(s);
  return concatBytes(u32le(bytes.length), bytes);
}

/** SHA-256 (synchronous, @noble/hashes). */
export const sha256 = (bytes: Uint8Array): Bytes => toBytes(nobleSha256(bytes));

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Bytes {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/u.test(hex)) throw new Error('Invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** `0x`-prefixed hex → bytes (an even number of digits). */
export function from0xHex(hex: string): Bytes {
  if (!hex.startsWith('0x')) throw new Error('Expected 0x-prefixed hex');
  return fromHex(hex.slice(2));
}

/** bytes → base64url without padding (RFC 4648 §5), as JWT and Google's `nonce` claim use. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** base64url (padding optional) → bytes. */
export function base64UrlDecode(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*=*$/u.test(text)) throw new Error('Invalid base64url');
  const b64 = text.replace(/=+$/u, '').replace(/-/gu, '+').replace(/_/gu, '/');
  if (b64.length % 4 === 1) throw new Error('Invalid base64url');
  return base64Decode(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

/** Standard base64 (with padding), as NEAR RPC `args_base64` and Stellar XDR use. */
export function base64Encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Standard base64 (padding required) → bytes. Throws on anything else. */
export function base64Decode(text: string): Bytes {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) throw new Error('Invalid base64');
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** JSON byte array, as the API and contract take `Vec<u8>`. */
export const jsonBytes = (b: Uint8Array): number[] => Array.from(b);

/** Overwrites each buffer with zeros (null and undefined are skipped). */
export function zero(...buffers: (Uint8Array | null | undefined)[]): void {
  for (const b of buffers) b?.fill(0);
}
