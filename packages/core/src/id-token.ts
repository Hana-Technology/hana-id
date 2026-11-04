// Google ID-token check (docs/batch-b-spec.md "Login" step 7, "Key export" step 4) and the claim allow-list. The
// vault and the export window run it on the relayed token before they fix the path. The RS256 check is defence in depth
// (R11): the end-to-end encrypted relay is what keeps the API from substituting a token. The API applies the same
// allow-list (`token_has_pii`); the contract does not (it ignores unknown claims).
//
// SECURITY: an ID token is a credential. Nothing here logs it, and no result or error message contains it.
import { base64UrlDecode, fromUtf8, utf8, utf8Length } from './bytes.ts';

export const GOOGLE_ISSUERS: readonly string[] = ['https://accounts.google.com', 'accounts.google.com'];
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/**
 * The only claims a token may carry (fixed by the 2026-10-28 spike: `scope=openid` gives exactly
 * {aud, azp, exp, iat, iss, jti, nbf, nonce, sub}; `auth_time` appears with `max_age`). `at_hash` (D342): Google adds
 * it to an ID token issued with an access token (the console's code flow; an implicit `id_token token` answer), a
 * truncated SHA-256 of that short-lived access token, nothing about the person.
 */
export const TOKEN_CLAIM_ALLOW_LIST: readonly string[] = Object.freeze(['iss', 'azp', 'aud', 'sub', 'iat', 'exp', 'nonce', 'nbf', 'jti', 'auth_time', 'at_hash']);
/** Claims refused by name (all outside the allow-list); `hd` identifies an employer. Documentation and tests only. */
export const NAMED_PII_CLAIMS: readonly string[] = Object.freeze(['hd', 'email', 'email_verified', 'name', 'picture', 'given_name', 'family_name', 'locale', 'profile']);
/** Clock skew on exp, iat and nbf: the same 60 s as the API's TOKEN_EXP_SKEW_MS. */
export const TOKEN_SKEW_MS = 60_000;
/** Export: `auth_time` must be at most this old when maxAuthAgeMs isn't given explicitly. */
export const EXPORT_MAX_AUTH_AGE_MS = 5 * 60_000;
const MAX_TOKEN_LENGTH = 8192;

export interface Jwk {
  kid: string;
  n: string;
  e: string;
  kty?: string;
  alg?: string;
  use?: string;
}

const B64URL = /^[A-Za-z0-9_-]+$/u;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** RS256 signing keys only, from a JWKS document (as apps/api/src/issuer-keys.ts usableJwks). */
export function usableJwks(body: unknown): Jwk[] {
  const keys = isObj(body) ? body.keys : undefined;
  if (!Array.isArray(keys)) return [];
  return keys.filter(
    (k): k is Jwk =>
      isObj(k) &&
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

/** Fetches Google's JWKS (the vault's CSP allows https://www.googleapis.com). Throws if it has no usable key. */
export async function fetchGoogleJwks(fetchFn: typeof fetch = (...args) => fetch(...args)): Promise<Jwk[]> {
  const res = await fetchFn(GOOGLE_JWKS_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
  const keys = usableJwks(await res.json());
  if (keys.length === 0) throw new Error('JWKS has no usable key');
  return keys;
}

/** The first claim outside the allow-list, or null. */
export function disallowedClaim(claims: Record<string, unknown>): string | null {
  for (const k of Object.keys(claims)) if (!TOKEN_CLAIM_ALLOW_LIST.includes(k)) return k;
  return null;
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array<ArrayBuffer>;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(fromUtf8(base64UrlDecode(part)));
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** Splits and decodes a compact JWS without verifying it, or null if malformed. */
export function decodeJwt(jwt: string): DecodedJwt | null {
  if (typeof jwt !== 'string' || jwt.length > MAX_TOKEN_LENGTH) return null;
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  if (!header || !claims) return null;
  try {
    return { header, claims, signingInput: `${parts[0]}.${parts[1]}`, signature: base64UrlDecode(parts[2]) };
  } catch {
    return null;
  }
}

export interface IdTokenExpectations {
  /** The Google client the login used (`aud`). */
  clientId: string;
  /** The pending login's nonce. */
  nonce: string;
  /** Server-corrected time in ms (the vault's now()). */
  nowMs: number;
  /** Google's keys, or a lookup by kid (which may refetch on an unknown kid). */
  jwks: readonly Jwk[] | ((kid: string) => Promise<Jwk | null>);
  /**
   * Export only: require `auth_time` no older than this. Off by default: the 2026-10-28 spike found that Google
   * returns no `auth_time` even with max_age=0 (Q33), so the export window doesn't set it today.
   */
  maxAuthAgeMs?: number;
}

export interface VerifiedIdToken {
  iss: string;
  aud: string;
  sub: string;
  nonce: string;
  iat: number;
  exp: number;
  authTime: number | null;
}

export type IdTokenResult =
  | { ok: true; token: VerifiedIdToken }
  | { ok: false; code: 'token_invalid'; reason: string }
  | { ok: false; code: 'token_has_pii'; claim: string; reason: string };

const invalid = (reason: string): IdTokenResult => ({ ok: false, code: 'token_invalid', reason });

async function verifySignature(jwk: Jwk, signingInput: string, signature: Uint8Array<ArrayBuffer>): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, utf8(signingInput));
  } catch {
    return false;
  }
}

/**
 * Verifies a Google ID token for the pending login: RS256 against `jwks`, `iss` Google's, `aud === clientId`,
 * `nonce === nonce`, `exp*1000 > now − 60 s`, `iat*1000 ≤ now + 60 s` (and `nbf`, if present, likewise), every claim in
 * the allow-list (else `token_has_pii` with the claim), `sub` 1–255 bytes with no `#`. Never throws for a bad token;
 * a jwks lookup that throws (network) propagates, so the caller can tell "unavailable" from "invalid".
 */
export async function verifyGoogleIdToken(jwt: string, expect: IdTokenExpectations): Promise<IdTokenResult> {
  const decoded = decodeJwt(jwt);
  if (!decoded) return invalid('Malformed token');
  const { header, claims } = decoded;
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return invalid('Unsupported token algorithm');

  const jwk = typeof expect.jwks === 'function' ? await expect.jwks(header.kid) : (expect.jwks.find((k) => k.kid === header.kid) ?? null);
  if (!jwk) return invalid('Unknown token signing key');
  if (!(await verifySignature(jwk, decoded.signingInput, decoded.signature))) return invalid('Invalid token signature');

  const { iss, aud, sub, nonce, iat, exp, nbf, azp, auth_time: authTime } = claims;
  if (typeof iss !== 'string' || !GOOGLE_ISSUERS.includes(iss)) return invalid('Wrong token issuer');
  if (typeof aud !== 'string' || aud !== expect.clientId) return invalid('Wrong token audience');
  if (azp !== undefined && typeof azp !== 'string') return invalid('Malformed azp claim');
  if (typeof nonce !== 'string' || nonce !== expect.nonce) return invalid('Wrong token nonce');
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp * 1000 <= expect.nowMs - TOKEN_SKEW_MS) return invalid('The token has expired');
  if (typeof iat !== 'number' || !Number.isFinite(iat) || iat * 1000 > expect.nowMs + TOKEN_SKEW_MS) return invalid('The token is issued in the future');
  if (nbf !== undefined && (typeof nbf !== 'number' || !Number.isFinite(nbf) || nbf * 1000 > expect.nowMs + TOKEN_SKEW_MS)) return invalid('The token is not valid yet');
  if (authTime !== undefined && (typeof authTime !== 'number' || !Number.isFinite(authTime))) return invalid('Malformed auth_time claim');
  const claim = disallowedClaim(claims);
  if (claim !== null) return { ok: false, code: 'token_has_pii', claim, reason: `The token carries a claim outside the allow-list: ${claim}` };
  if (typeof sub !== 'string' || sub.length === 0 || utf8Length(sub) > 255 || sub.includes('#')) return invalid('Malformed sub claim');
  if (expect.maxAuthAgeMs !== undefined) {
    if (typeof authTime !== 'number') return invalid('The token has no auth_time');
    if (authTime * 1000 < expect.nowMs - expect.maxAuthAgeMs) return invalid('The sign-in is not fresh (auth_time)');
  }
  return { ok: true, token: { iss, aud, sub, nonce, iat, exp, authTime: typeof authTime === 'number' ? authTime : null } };
}
