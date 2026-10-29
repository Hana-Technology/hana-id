// Issuer JWKS handling shared by apps/api (copies Google's keys into hana-signer) and apps/watchdog (checks every
// pending and active on-chain key against Google's JWKS). No I/O here: callers fetch.

export const GOOGLE_PROVIDER = 'google';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export interface Jwk {
  kid: string;
  n: string;
  e: string;
  kty?: string;
  alg?: string;
  use?: string;
}

const B64URL = /^[A-Za-z0-9_-]+$/u;

/** RS256 signing keys only (the contract verifies RS256 today), kid 1..=128 bytes, base64url `n` and `e`. */
export function usableJwks(body: unknown): Jwk[] {
  const keys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) return [];
  return keys.filter(
    (k): k is Jwk =>
      typeof k === 'object' &&
      k !== null &&
      typeof k.kid === 'string' &&
      k.kid.length > 0 &&
      k.kid.length <= 128 &&
      k.kty === 'RSA' &&
      (k.alg === undefined || k.alg === 'RS256') &&
      (k.use === undefined || k.use === 'sig') &&
      typeof k.n === 'string' &&
      B64URL.test(k.n) &&
      typeof k.e === 'string' &&
      B64URL.test(k.e),
  );
}

/**
 * Big-endian bytes of a JWK key component (base64url, or plain base64 as the contract also accepts), leading zero
 * bytes stripped as the contract stores them. Null when it isn't valid base64.
 */
export function keyComponentBytes(text: string): Uint8Array | null {
  const b64 = text.replace(/-/gu, '+').replace(/_/gu, '/').replace(/=+$/u, '');
  if (!/^[A-Za-z0-9+/]*$/u.test(b64) || b64.length % 4 === 1) return null;
  let bin: string;
  try {
    bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  } catch {
    return null;
  }
  let first = 0;
  while (first < bin.length && bin.charCodeAt(first) === 0) first++;
  const out = new Uint8Array(bin.length - first);
  for (let i = first; i < bin.length; i++) out[i - first] = bin.charCodeAt(i);
  return out;
}

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Same RSA public key: equal modulus and exponent after decoding and stripping leading zeros (the contract strips
 * them; Google doesn't send any, but a JWK may). An undecodable component never matches.
 */
export function sameRsaKey(a: { n: string; e: string }, b: { n: string; e: string }): boolean {
  const [an, ae, bn, be] = [a.n, a.e, b.n, b.e].map(keyComponentBytes);
  if (!an || !ae || !bn || !be) return false;
  return equalBytes(an, bn) && equalBytes(ae, be);
}
