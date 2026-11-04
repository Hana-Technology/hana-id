// The console's check of the Google ID token its code flow gets back (docs/batch-c-spec.md "Code flow" step 3): RS256
// against Google's JWKS (@hana-id/oidc, optional claims strict, D201), `iss`, `aud` the console client, `nonce` the
// flow's, `exp`, `iat` at most 120 s old, then the claims by scope. The token comes from the console's own server-side
// code exchange (client secret and PKCE verifier), never from a browser, and is never logged, stored or returned:
// only the verified `sub`, `email` and `hd` go on (into the 60-second handoff row, sign-in.ts).
//
// The claim allow-list (D271, D274, D277: every Google token Hana verifies is held to it, and the API's source scan
// in apps/api/scripts/test/relayed-tokens.test.ts lists this file):
//   - `openid` (every step-up and owner action, batch C10, whose tokens the API verifies again and relays on chain):
//     exactly the API's TOKEN_CLAIM_ALLOW_LIST, nothing else;
//   - `openid email` (sign-in only, never relayed): the same list plus exactly `email`, `email_verified`, `hd` and
//     `at_hash` (D290). Sign-in needs the address (an invite is bound to it; members see each other's) and `hd` (an
//     org's `required_hd`); a code-flow ID token carries `at_hash`, the hash of the access token issued with it, which
//     is checked against that token here. A name, picture or locale (`profile` scope) is refused.
import { b64url, sha256 } from '@hana-id/console-core';
import { JwksUnavailableError, verifyIdToken } from '@hana-id/oidc';

/** The API's claim allow-list (apps/api/src/claims.ts, @hana-id/core TOKEN_CLAIM_ALLOW_LIST; the scan pins all three). */
export const TOKEN_CLAIM_ALLOW_LIST: readonly string[] = Object.freeze(['iss', 'azp', 'aud', 'sub', 'iat', 'exp', 'nonce', 'nbf', 'jti', 'auth_time']);
/** What a sign-in token (`openid email`) may carry besides the allow-list (D290). */
export const SIGN_IN_EXTRA_CLAIMS: readonly string[] = Object.freeze(['email', 'email_verified', 'hd', 'at_hash']);

export type ConsoleScope = 'openid email' | 'openid';

/** The oldest `iat` accepted (spec: ≤ 120 s), and how far ahead of the console's clock one may be. */
export const TOKEN_MAX_AGE_MS = 120_000;
export const TOKEN_IAT_SKEW_MS = 60_000;

export interface ConsoleTokenCheck {
  /** The console's own Google client: the token's `aud` (and `azp` when present). */
  clientId: string;
  /** The flow's nonce (auth_flows.nonce). */
  nonce: string;
  scope: ConsoleScope;
  now: number;
  /** The access token from the same code exchange, for `at_hash`. Never stored or logged. */
  accessToken?: string | undefined;
}

export interface ConsoleIdentity {
  provider: string;
  sub: string;
  /** Sign-in only: the verified address, lowercased. */
  email: string | null;
  /** Sign-in only: the Workspace domain, or null. */
  hd: string | null;
}

/** Why a token was refused (logged by code, never with the token or a claim's value). */
export type TokenRefusal =
  | 'invalid_token'
  | 'token_expired'
  | 'unsupported_issuer'
  | 'bad_token'
  | 'wrong_audience'
  | 'wrong_nonce'
  | 'stale_iat'
  | 'claim_not_allowed'
  | 'email_missing'
  | 'email_unverified'
  | 'email_present'
  | 'at_hash_mismatch'
  | 'jwks_unavailable';

export type TokenResult = { ok: true; identity: ConsoleIdentity } | { ok: false; code: TokenRefusal; claim?: string };

/** A JWT's payload as an object, or null when it isn't one. */
function payloadOf(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split('.')[1] ?? '';
    const bin = atob(part.replace(/-/gu, '+').replace(/_/gu, '/'));
    const claims: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
    return typeof claims === 'object' && claims !== null && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The claims a token of `scope` may carry. */
export const allowedClaims = (scope: ConsoleScope): readonly string[] => (scope === 'openid' ? TOKEN_CLAIM_ALLOW_LIST : [...TOKEN_CLAIM_ALLOW_LIST, ...SIGN_IN_EXTRA_CLAIMS]);

/** The first claim of a token's payload outside the scope's list, or null (an unreadable payload: verifyIdToken refuses it). */
export function disallowedClaim(jwt: string, scope: ConsoleScope): string | null {
  const claims = payloadOf(jwt);
  if (!claims) return null;
  const allowed = allowedClaims(scope);
  return Object.keys(claims).find((k) => !allowed.includes(k)) ?? null;
}

/** OpenID Connect `at_hash`: b64url of the left half of SHA-256 over the access token (RS256). */
export async function atHash(accessToken: string): Promise<string> {
  return b64url((await sha256(new TextEncoder().encode(accessToken))).slice(0, 16));
}

/** The claim names of a token's payload, sorted (the open-question harness prints these, never a value). */
export function claimNames(jwt: string): string[] | null {
  const claims = payloadOf(jwt);
  return claims ? Object.keys(claims).sort() : null;
}

/**
 * Verifies a console ID token for its flow. Fails closed: JWKS unavailable is `jwks_unavailable` (the caller answers
 * 503), never a pass.
 */
export async function verifyConsoleToken(jwt: string, c: ConsoleTokenCheck): Promise<TokenResult> {
  let v;
  try {
    v = await verifyIdToken(jwt, c.now, { optionalClaims: 'strict' });
  } catch (err) {
    if (err instanceof JwksUnavailableError) return { ok: false, code: 'jwks_unavailable' };
    throw err;
  }
  if (!v.ok) return { ok: false, code: v.code };
  const t = v.token;
  if (t.aud !== c.clientId || (t.azp !== undefined && t.azp !== c.clientId)) return { ok: false, code: 'wrong_audience' };
  if (t.nonce === null || t.nonce !== c.nonce) return { ok: false, code: 'wrong_nonce' };
  if (t.iat === undefined) return { ok: false, code: 'stale_iat' };
  const iatMs = t.iat * 1000;
  if (iatMs < c.now - TOKEN_MAX_AGE_MS || iatMs > c.now + TOKEN_IAT_SKEW_MS) return { ok: false, code: 'stale_iat' };
  const claim = disallowedClaim(jwt, c.scope);
  if (claim !== null) return { ok: false, code: 'claim_not_allowed', claim };
  const raw = payloadOf(jwt) ?? {};
  if (Object.hasOwn(raw, 'at_hash')) {
    if (typeof raw.at_hash !== 'string' || !c.accessToken || raw.at_hash !== (await atHash(c.accessToken))) return { ok: false, code: 'at_hash_mismatch' };
  }
  if (c.scope === 'openid') {
    // Unreachable past the allow-list (it has no email claim); kept so the rule reads on its own (spec: a step-up token
    // must carry no `email`).
    if (t.email !== undefined) return { ok: false, code: 'email_present' };
    return { ok: true, identity: { provider: t.provider, sub: t.sub, email: null, hd: null } };
  }
  if (t.email === undefined || t.email.length === 0 || t.email.length > 254) return { ok: false, code: 'email_missing' };
  if (t.email_verified !== true) return { ok: false, code: 'email_unverified' };
  return { ok: true, identity: { provider: t.provider, sub: t.sub, email: t.email.toLowerCase(), hd: t.hd ?? null } };
}
