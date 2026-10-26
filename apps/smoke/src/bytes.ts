// Byte helpers (browser and Node, no Buffer). All return Uint8Array<ArrayBuffer> so they can go straight to WebCrypto.

export type Bytes = Uint8Array<ArrayBuffer>;

const utf8Encoder = new TextEncoder();

export const utf8 = (s: string): Bytes => utf8Encoder.encode(s) as Bytes;

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

export async function sha256(bytes: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Bytes {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/u.test(hex)) throw new Error('Invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** bytes → base64url without padding (RFC 4648 §5), as JWT and Google's `nonce` claim use. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** base64url (padding optional) → bytes. */
export function base64UrlDecode(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*=*$/u.test(text)) throw new Error('Invalid base64url');
  const b64 = text.replace(/=+$/u, '').replace(/-/gu, '+').replace(/_/gu, '/');
  const s = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Standard base64 (with padding), as NEAR RPC `args_base64` takes. */
export function base64Encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
