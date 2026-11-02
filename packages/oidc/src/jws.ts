// Compact JWS pieces shared by the ID-token and Access-JWT checks: the contract's strict base64url, the JSON segments
// and the RS256 signature check (Web Crypto).
import type { Jwk } from '@hana-id/jwks';

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * base64url (no padding) → bytes. Throws on invalid input, including non-canonical encodings (a length ≡ 1 mod 4,
 * or non-zero unused bits in the last character), which `atob` would silently accept but the contract's decoder
 * (Rust `base64` URL_SAFE_NO_PAD, trailing bits not allowed) rejects. Same rules as apps/api `bytes.ts`.
 */
export function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/u.test(s)) throw new Error('Invalid base64url');
  const rem = s.length % 4;
  if (rem === 1) throw new Error('Invalid base64url');
  if (rem !== 0) {
    const last = B64URL_ALPHABET.indexOf(s[s.length - 1]!);
    // 2 chars carry 1 byte (4 spare bits), 3 chars carry 2 bytes (2 spare bits).
    if ((last & (rem === 2 ? 0x0f : 0x03)) !== 0) throw new Error('Non-canonical base64url');
  }
  const bin = atob(s.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - rem) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * A JWS segment as a JSON object, or null when it isn't one. `fatal` refuses invalid UTF-8 instead of replacing it
 * (the ID-token check keeps the API's lenient decoder, unchanged; the Access check is strict).
 */
export function decodeSegment(part: string, fatal = false): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal, ignoreBOM: false }).decode(base64UrlDecode(part)));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Whether `signatureB64url` is a valid RS256 signature by `jwk` over `signingInput`; false on any decoding error. */
export async function verifyRs256(jwk: Pick<Jwk, 'n' | 'e'>, signingInput: string, signatureB64url: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlDecode(signatureB64url), new TextEncoder().encode(signingInput));
  } catch {
    return false;
  }
}
