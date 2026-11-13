// The site's two routes (D799), shared by the page and the Worker so both accept exactly the same paths:
//
//   /                     the signed-in user's passport, or the cover with "Sign in"
//   /p/<account_id>       anyone's passport, read-only, read live from NEAR testnet (no sign-in)
//
// The account id is validated strictly before anything reads or shows it: a 64-hex implicit account (every Journear
// Passport account) or a named `.testnet` account (viewing only), lowercase, as NEAR spells account ids. Anything
// else, a trailing slash, an encoded character, a query the page doesn't read, is not a passport.
import { isNearAccountId } from '@hana-id/core';

export type Route = { kind: 'mine' } | { kind: 'public'; accountId: string } | { kind: 'not_found' };

/** An account id a public passport may show: implicit (64 hex), or a named `.testnet` account. */
export function isViewableAccount(id: string): boolean {
  if (!isNearAccountId(id)) return false;
  return /^[0-9a-f]{64}$/u.test(id) || id.endsWith('.testnet');
}

/** The route of a path (`location.pathname`). */
export function parseRoute(pathname: string): Route {
  if (pathname === '/') return { kind: 'mine' };
  const m = /^\/p\/([a-z0-9._-]{2,64})$/u.exec(pathname);
  if (m && isViewableAccount(m[1]!)) return { kind: 'public', accountId: m[1]! };
  return { kind: 'not_found' };
}

/** The path of an account's public passport (the id is validated: no encoding is needed, none is done). */
export function passportPath(accountId: string): string {
  if (!isViewableAccount(accountId)) throw new Error('Not a viewable NEAR account id');
  return `/p/${accountId}`;
}

/** NearBlocks' page of an account, or null without an explorer. */
export const explorerAccountUrl = (explorer: string | null, accountId: string): string | null => (explorer === null ? null : `${explorer}/address/${encodeURIComponent(accountId)}`);

const BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;

/** NearBlocks' page of a transaction (base58 hash, checked), or null. */
export const explorerTxUrl = (explorer: string | null, hash: string): string | null => (explorer === null || !BASE58_HASH.test(hash) ? null : `${explorer}/txns/${encodeURIComponent(hash)}`);
