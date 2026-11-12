// The user's profile name as the partner page sees it: the `given_name` and `family_name` claims of the identity token
// the page already holds (packages/core/src/identity.ts, IdentityClaims). No vault call of its own and no signature
// check: the page reads its own token for display only, and the partner's backend verifies the token before it trusts
// any claim.
import { base64UrlDecode, normalizeProfileName } from '@hana-id/core';

/**
 * The name the user set in Passport Home and shared with this app. Each part is null when it isn't set, isn't shared, or
 * the token carries a value that isn't a name Journear would sign (`normalizeProfileName` must return it unchanged).
 */
export interface HanaProfile {
  readonly givenName: string | null;
  readonly familyName: string | null;
}

/** The profile of a logged-in user who shared no name (or whose token says nothing readable). */
const NO_NAME: HanaProfile = Object.freeze({ givenName: null, familyName: null });

const utf8Fatal = new TextDecoder('utf-8', { fatal: true });

/** The JWT's payload object, or null when the token isn't a compact JWS with a JSON object payload. */
function payloadOf(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims: unknown = JSON.parse(utf8Fatal.decode(base64UrlDecode(parts[1]!)));
    return typeof claims === 'object' && claims !== null && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A claim kept only when it is already a normalized profile name; anything else counts as absent. */
function namePart(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return normalizeProfileName(v) === v ? v : null;
}

/**
 * The profile an identity token carries: null for no token (logged out), else `{givenName, familyName}`, each part
 * null unless its claim is a normalized profile name. Frozen, and the same object for every token without a name.
 * Doesn't verify the token: never authorize anything on it.
 */
export function profileFromIdentityToken(token: string | null): HanaProfile | null {
  if (token === null) return null;
  const claims = payloadOf(token);
  if (claims === null) return NO_NAME;
  const givenName = namePart(claims.given_name);
  const familyName = namePart(claims.family_name);
  return givenName === null && familyName === null ? NO_NAME : Object.freeze({ givenName, familyName });
}

/** Same name (both null, or both profiles with equal parts). */
export const sameProfile = (a: HanaProfile | null, b: HanaProfile | null): boolean =>
  a === null || b === null ? a === b : a.givenName === b.givenName && a.familyName === b.familyName;
