// The profile name in identity tokens (D714, migration 0021): the first and last name the user set in Passport Home, only for
// an app they shared it with there (`name_shares`, keyed by the app and the account's User ID, the token's `sub`). Read
// through the identity that shared it, so a token always carries the name as it is now (an edit, a removal or a stop in
// Home reaches the next mint). Never an error: a mint without the table, or failing to read it, carries no name.
//
// SECURITY: nothing here logs a name, a `sub` or a User ID.
import { normalizeProfileName } from '@hana-id/core/identity';
import type { Env } from '../env.ts';
import type { Ctx } from '../handlers.ts';
import { log } from '../log.ts';

export interface ProfileName {
  givenName: string | null;
  familyName: string | null;
}

/** A stored row's two parts, normalized again (a part that no longer passes is dropped); null when neither remains. */
export function storedName(r: { given_name: string | null; family_name: string | null } | null): ProfileName | null {
  if (!r) return null;
  const givenName = normalizeProfileName(r.given_name) ?? null;
  const familyName = normalizeProfileName(r.family_name) ?? null;
  return givenName === null && familyName === null ? null : { givenName, familyName };
}

/** Whether a D1 error is migration 0021's tables missing (an env before profile names). */
export const noNameTables = (err: unknown): boolean => err instanceof Error && /no such table: (home_profiles|name_shares)/u.test(err.message);

/**
 * Whether the share `n` counts at `now` (an SQL condition; `now` is the expression given, unix ms). A share made by the
 * account's root (`via = 'own'`) always does. A member's counts only while the wallet directory lists that identity as a
 * live member of the account whose User ID the share is keyed by (`active`, or `pending` past its activation, as
 * directory/read.ts statusAt), and only when the share is no older than that link: an unlink stops it at once, and a
 * later link again doesn't bring it back (the user shares again). The directory is best effort, and an unlink whose
 * sync failed leaves the row `active` (D661): the share then counts until the next login's sync of that account.
 */
export const LIVE_NAME_SHARE = (now: string): string => `(n.via = 'own' OR EXISTS (
  SELECT 1 FROM end_users lu JOIN end_user_identities li ON li.user_id = lu.user_id
   WHERE lu.token_sub = n.user_sub AND li.provider = n.provider AND li.sub = n.sub AND li.role = 'member'
     AND (li.status = 'active' OR (li.status = 'pending' AND li.effective_at IS NOT NULL AND li.effective_at <= ${now}))
     AND n.shared_at >= COALESCE(li.effective_at, 0)))`;

/** The name shared with this app by this account, or null. */
export async function mintName(env: Pick<Env, 'DB'>, ctx: Ctx, i: { appId: string; userSub: string; now: number }): Promise<ProfileName | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT p.given_name, p.family_name FROM name_shares n JOIN home_profiles p ON p.provider = n.provider AND p.sub = n.sub
        WHERE n.app_id = ?1 AND n.user_sub = ?2 AND ${LIVE_NAME_SHARE('?3')}`,
    )
      .bind(i.appId, i.userSub, i.now)
      .first<{ given_name: string | null; family_name: string | null }>();
    return storedName(row);
  } catch (err) {
    if (!noNameTables(err)) log({ event: 'identity_name_failed', requestId: ctx.requestId, appId: i.appId, code: 'internal' }, 'error');
    return null;
  }
}
