// Byte helpers that don't need Node's Buffer.

export function base64Encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64Decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * base64url (no padding) → bytes. Throws on invalid input, including non-canonical encodings (a length ≡ 1 mod 4,
 * or non-zero unused bits in the last character), which `atob` would silently accept but the contract's decoder
 * (Rust `base64` URL_SAFE_NO_PAD, trailing bits not allowed) rejects.
 */
export function base64UrlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(s)) throw new Error('Invalid base64url');
  const rem = s.length % 4;
  if (rem === 1) throw new Error('Invalid base64url');
  if (rem !== 0) {
    const last = B64URL_ALPHABET.indexOf(s[s.length - 1]!);
    // 2 chars carry 1 byte (4 spare bits), 3 chars carry 2 bytes (2 spare bits).
    if ((last & (rem === 2 ? 0x0f : 0x03)) !== 0) throw new Error('Non-canonical base64url');
  }
  const b64 = s.replace(/-/gu, '+').replace(/_/gu, '/');
  return base64Decode(b64 + '='.repeat((4 - rem) % 4));
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Lowercase or uppercase hex (even length) → bytes. Throws on anything else. */
export function fromHex(text: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/u.test(text)) throw new Error('Invalid hex');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** bytes → base64url without padding (RFC 4648 §5, as JWT and Google's `nonce` claim use). */
export function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Little-endian u64 (8 bytes). `n` must be a non-negative safe integer or bigint. */
export function u64le(n: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

/** Little-endian u32 (4 bytes). */
export function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

/** Borsh `String`: u32 LE byte length ‖ UTF-8 bytes. */
export function borshString(s: string): Uint8Array {
  const utf8 = new TextEncoder().encode(s);
  return concatBytes(u32le(utf8.length), utf8);
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
}
