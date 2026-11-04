// The ID-token claim allow-list (docs/batch-b-spec.md, "Claim allow-list"). Tokens the API relays carry only these
// claims, so no email, name, picture or Workspace domain (`hd`) ever reaches the chain. With `scope=openid` Google
// sends exactly {aud, azp, exp, iat, iss, jti, nbf, nonce, sub} (spike, 2026-10-28), plus `auth_time` with `max_age`
// and `at_hash` (D342) when the token comes with an access token (the console's code flow): a truncated hash of that
// access token, nothing personal. Anything else is refused, which only happens if Google changes that or a client asks
// for more scopes (Google Identity Services tokens carry `email`). The contract does not enforce this for direct
// callers. The list equals @hana-id/core's TOKEN_CLAIM_ALLOW_LIST and the console's (scripts/test/relayed-tokens).
import { base64UrlDecode } from './bytes.ts';

export const ALLOWED_CLAIMS: ReadonlySet<string> = new Set(['iss', 'azp', 'aud', 'sub', 'iat', 'exp', 'nonce', 'nbf', 'jti', 'auth_time', 'at_hash']);

/**
 * The first claim of `jwt`'s payload outside the allow-list, or null when every claim is allowed. Call it on a token
 * verifyIdToken accepted (so the payload is a JSON object); an unreadable payload answers null and is left to that
 * check.
 */
export function disallowedClaim(jwt: string): string | null {
  const payload = jwt.split('.')[1];
  if (!payload) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch {
    return null;
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) return null;
  return Object.keys(claims).find((k) => !ALLOWED_CLAIMS.has(k)) ?? null;
}
