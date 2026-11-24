// The other apps that use an app's wallet (D912), for `GET /v1/app` on the vault's own read only: the vault puts them
// in its sign-in and approval windows ("This wallet is also used on 2 other apps."), never in anything it sends the
// partner page, and this answer is never given to a partner page's read.
//
// Who counts: the other apps of the app's scope (one scope is one wallet: the same sign-in gives the same addresses on
// every app of it) that are not deleted, not suspended (any suspension bit, or the legacy status column, as the gate's
// appSuspended) and have at least one web address in force now (`active_from <= now`: an app no site can use yet uses
// no wallet; it counts from the read after its first address takes effect). Test and live apps are never on one scope
// (D51), so a count is always of apps of the same kind. One statement, from D1 only (no chain read), on every read, so
// a suspension, a deletion or a new address is in the next answer, as the app's own name and settings are.
//
// SECURITY: the names are partners' own words. They go out as JSON data; the vault and the windows hold them to the
// display-safety rule and cut them as Passport Home does before any is shown.
import type { App } from './apps.ts';

/** How many names one answer carries; equals @hana-id/core's OTHER_APPS_NAMES_MAX (test/other-apps.test.ts). */
export const OTHER_APPS_NAMES_MAX = 5;

export interface OtherApps {
  /** How many other apps use the wallet (0: the app is alone on its scope). */
  count: number;
  /** The first OTHER_APPS_NAMES_MAX of them, oldest first, as stored. */
  names: string[];
}

/** The other apps that use `app`'s wallet at `now`. */
export async function readOtherApps(db: D1Database, app: Pick<App, 'id' | 'scope_id'>, now: number): Promise<OtherApps> {
  // COUNT(*) OVER () is the whole result's size, computed before the LIMIT.
  const { results } = await db
    .prepare(
      `SELECT a.name AS name, COUNT(*) OVER () AS total
         FROM apps a
        WHERE a.scope_id = ?1 AND a.id <> ?2 AND a.deleted_at IS NULL AND a.suspended_by = 0 AND a.status = 'active'
          AND EXISTS (SELECT 1 FROM app_origins o WHERE o.app_id = a.id AND o.active_from IS NOT NULL AND o.active_from <= ?3)
        ORDER BY a.created_at, a.id
        LIMIT ?4`,
    )
    .bind(app.scope_id, app.id, now, OTHER_APPS_NAMES_MAX)
    .all<{ name: string; total: number }>();
  return { count: results.length === 0 ? 0 : Number(results[0]!.total), names: results.map((r) => String(r.name)) };
}
