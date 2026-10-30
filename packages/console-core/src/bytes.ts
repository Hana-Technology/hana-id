// Byte helpers for the layouts (docs/batch-c-spec.md "Nonce and digest layouts"): borsh strings (u32 LE length, then
// UTF-8), u64 LE, b64url without padding, base58, sha256 and HMAC-SHA256 through WebCrypto (Workers and Node ≥ 20).

const encoder = new TextEncoder();

export const utf8 = (s: string): Uint8Array => encoder.encode(s);

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function u32le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new RangeError(`u32 out of range: ${n}`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

/** u64 LE of a non-negative safe integer or a bigint below 2^64. */
export function u64le(n: number | bigint): Uint8Array {
  if (typeof n === 'number' && (!Number.isSafeInteger(n) || n < 0)) throw new RangeError(`u64 must be a non-negative safe integer: ${n}`);
  const v = BigInt(n);
  if (v < 0n || v >= 1n << 64n) throw new RangeError(`u64 out of range: ${v}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

export const borshString = (s: string): Uint8Array => {
  const b = utf8(s);
  return concatBytes(u32le(b.length), b);
};

export const borshStringVec = (list: readonly string[]): Uint8Array => concatBytes(u32le(list.length), ...list.map(borshString));

export function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** Strict b64url (no padding, URL-safe alphabet, canonical trailing bits); throws otherwise. */
export function fromB64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(s) || s.length % 4 === 1) throw new TypeError('Not b64url');
  const bin = atob(s.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (b64url(out) !== s) throw new TypeError('Not canonical b64url');
  return out;
}

export const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/u.test(s)) throw new TypeError('Not lowercase hex');
  return Uint8Array.from(s.match(/../gu) ?? [], (h) => parseInt(h, 16));
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

/** Copies into a fresh ArrayBuffer-backed array (WebCrypto's BufferSource typing refuses SharedArrayBuffer views). */
const own = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', own(bytes)));
}

export async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  if (key.length < 32) throw new RangeError('HMAC keys here are at least 32 bytes');
  const k = await subtle().importKey('raw', own(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, own(message)));
}

export function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** Lexicographic byte order (the order origins are sorted in before hashing). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && compareBytes(a, b) === 0;
}
