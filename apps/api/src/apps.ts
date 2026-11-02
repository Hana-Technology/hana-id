// Off-chain app config in D1: publishable keys (app_keys), origins, plans, scopes, suspension, usage. The two login-path
// reads (docs/batch-c-spec.md §Hot DB "Login-path reads"): the app behind an unrevoked key, then its origins in force.

export type Environment = 'test' | 'live';

export interface App {
  id: string;
  name: string;
  scope_id: string;
  /** The app's org (`org_legacy` until Hana assigns the scope). */
  org_id: string;
  /** The key the request named (an unrevoked `app_keys` row): never `apps.publishable_key`. */
  publishable_key: string;
  /** The legacy status column, kept equal to `suspended_by != 0` by a trigger; the gate reads both (appSuspended). */
  status: 'active' | 'suspended' | string;
  /** Suspension bitmask: hana = 1, org = 2, partner = 4. Active iff 0. */
  suspended_by: number;
  plan: string;
  per_minute: number;
  per_day: number;
  per_ip_minute: number;
  /** The scope's Google client GET /v1/app hands out, when set (a scope may also hold iOS/Android clients). */
  google_web_client_id: string | null;
  logo_key: string | null;
  /** The scope's environment (`scopes.environment`): loopback origins and dev-env partner calls only for `test`. */
  environment: Environment;
  /** When the scope saw its first successful login, or null (no user has a key in it yet). */
  first_session_at: number | null;
  /**
   * The key's prefix names the other environment than its scope. The 0006 triggers refuse such a row, so this is a
   * second check only: the gate refuses it (403 scope_conflict) so a test key's dev-env privileges never reach a live
   * scope even after a direct D1 write.
   */
  scope_conflict: boolean;
  /** The origins in force now (`active_from <= now`; NULL, not yet announced, never matches). */
  origins: string[];
}

/**
 * The hot-DB migration this build's reads need (0006: keys in app_keys, origins in force by active_from, the
 * suspension bits). Reported by GET /v1/health; the admin CLI checks it before it writes a guarded proposal.
 */
export const HOT_DB_SCHEMA = 6;

export const PUBLISHABLE_KEY_RE = /^pk_(test|live)_[1-9A-HJ-NP-Za-km-z]{16,64}$/u;

// Origin rules live in origins.ts (dev envs, Hana pages); re-exported for callers that only need these.
export { LOCALHOST_WILDCARD, originAllowed } from './origins.ts';

/** Whether the gate refuses the app as suspended: any suspension bit, or the legacy status column. */
export const appSuspended = (app: Pick<App, 'suspended_by' | 'status'>): boolean => app.suspended_by !== 0 || app.status !== 'active';

type AppRow = Omit<App, 'origins' | 'scope_conflict'>;

/**
 * The app behind an unrevoked publishable key (`revoked_at` NULL or still in the future: the rotation grace), with its
 * origins in force at `now`. Null for an unknown, revoked or deleted app's key: the gate answers 401 unknown_app.
 */
export async function getAppByKey(db: D1Database, publishableKey: string, now = Date.now()): Promise<App | null> {
  const row = await db
    .prepare(
      `SELECT a.id, a.name, a.scope_id, a.org_id, a.plan, a.suspended_by, a.status, a.logo_key, a.google_web_client_id,
              k.key AS publishable_key, s.environment, s.first_session_at, p.per_minute, p.per_day, p.per_ip_minute
         FROM app_keys k JOIN apps a ON a.id = k.app_id JOIN scopes s ON s.scope_id = a.scope_id JOIN plans p ON p.id = a.plan
        WHERE k.key = ?1 AND (k.revoked_at IS NULL OR k.revoked_at > ?2) AND a.deleted_at IS NULL`,
    )
    .bind(publishableKey, now)
    .first<AppRow>();
  if (!row) return null;
  const { results } = await db.prepare('SELECT origin FROM app_origins WHERE app_id = ?1 AND active_from <= ?2').bind(row.id, now).all<{ origin: string }>();
  const keyEnvironment = row.publishable_key.startsWith('pk_live_') ? 'live' : 'test';
  return { ...row, scope_conflict: keyEnvironment !== row.environment, origins: results.map((r) => r.origin) };
}

/**
 * Records the scope's first session attempt: called when a session-pool relay (`/v1/sessions`, `/v1/login`,
 * `/v1/derive`, `/v1/sessions/revoke`) is about to be sent, on a scope with no `first_session_at` yet, and run beside
 * the relay. At the attempt, not the success, so a relay whose answer is lost (a timeout, a 5xx after the transaction
 * landed) still ends the `no_session` waiver (fail closed). Set once; a failure is only logged (the next attempt
 * retries, and the waiver also needs no usage, vault share or identity row in the scope). The promise never rejects;
 * null when there is nothing to write.
 */
export function startFirstSession(db: D1Database, app: Pick<App, 'scope_id' | 'first_session_at'>, onError: () => void, now = Date.now()): Promise<void> | null {
  if (app.first_session_at !== null) return null;
  return db
    .prepare('UPDATE scopes SET first_session_at = ?1 WHERE scope_id = ?2 AND first_session_at IS NULL')
    .bind(now, app.scope_id)
    .run()
    .then(
      () => undefined,
      () => onError(),
    );
}

export const usageDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

export async function incrementUsage(db: D1Database, appId: string, field: 'sessions' | 'derives', now = Date.now()): Promise<void> {
  const column = field === 'sessions' ? 'sessions' : 'derives';
  await db
    .prepare(
      `INSERT INTO usage (app_id, day, sessions, derives) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (app_id, day) DO UPDATE SET ${column} = ${column} + 1`,
    )
    .bind(appId, usageDay(now), field === 'sessions' ? 1 : 0, field === 'derives' ? 1 : 0)
    .run();
}
