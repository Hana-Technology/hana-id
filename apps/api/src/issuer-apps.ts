// The email issuer's three app reads (IssuerRpc, rpc/issuer.ts; D432), on the API's own D1. Moved here from
// apps/email-issuer/src/apps.ts, where they ran over the issuer's read-write `APP_DB` binding (D251), unchanged in
// meaning. By the API gate's model (apps.ts getAppByKey, migration 0006; D206, D225): the key is an `app_keys` row not
// revoked, or revoked with its rotation grace still running (`revoked_at` in the future); the app isn't deleted
// (`deleted_at IS NULL`); it is active only with no suspension bit (`suspended_by = 0`) and the legacy `status` active.
// The legacy `apps.publishable_key` column is never read. Email is on for an app only when its `login_methods` lists
// `email` (login-methods.ts; migration 0010: until it is applied, email is off for every app).
//
// SELECTs only (a source test, scripts/test/issuer-rpc-source.test.ts): nothing the issuer calls writes.
import type { IssuerApp } from '@hana-id/console-core';
import { parseLoginMethods } from './login-methods.ts';

interface Row {
  id: string;
  name: string;
  scope_id: string;
  status: string;
  suspended_by: number;
  /** The scope's environment (`scopes.environment`), read only by the key lookup (`issuerAppByKey`). */
  environment?: string;
  /** The key the request named (`app_keys.key`), read only by the key lookup. */
  key?: string;
  google_web_client_id: string | null;
  login_methods?: string | null;
  per_minute: number;
  per_day: number;
}

const emailOn = (raw: string | null | undefined): boolean => parseLoginMethods(raw).includes('email');

/**
 * The gate's rule (handlers.ts appSuspended, `scope_conflict`): any suspension bit, or the legacy status column,
 * suspends; so does a key whose prefix names the other environment than its scope (only a direct `app_keys` edit can
 * make one).
 */
const isActive = (row: Pick<Row, 'status' | 'suspended_by' | 'environment' | 'key'>): boolean =>
  row.status === 'active' && row.suspended_by === 0 && (row.key === undefined || row.environment === (row.key.startsWith('pk_live_') ? 'live' : 'test'));

const toApp = (row: Row): IssuerApp => ({
  id: row.id,
  name: row.name,
  scopeId: row.scope_id,
  active: isActive(row),
  emailOn: emailOn(row.login_methods),
  perMinute: row.per_minute,
  perDay: row.per_day,
  googleWebClientId: row.google_web_client_id,
});

const COLUMNS = 'a.id, a.name, a.scope_id, a.status, a.suspended_by, a.google_web_client_id, p.per_minute, p.per_day';
/** Before migration 0010 the column doesn't exist: no app has email on. */
const noLoginMethods = (err: unknown): boolean => err instanceof Error && /no such column: (?:a\.)?login_methods/u.test(err.message);

/** Runs `sql` with the login_methods column, or without it (every app Google-only) before migration 0010. */
async function firstApp(db: D1Database, sql: (columns: string) => string, ...binds: unknown[]): Promise<Row | null> {
  try {
    return await db
      .prepare(sql(`${COLUMNS}, a.login_methods`))
      .bind(...binds)
      .first<Row>();
  } catch (err) {
    if (!noLoginMethods(err)) throw err;
    const row = await db
      .prepare(sql(COLUMNS))
      .bind(...binds)
      .first<Row>();
    return row ? { ...row, login_methods: 'google' } : null;
  }
}

/**
 * The app behind `pk`: a key not revoked (or still in its rotation grace) of an app not deleted. Null for an unknown,
 * revoked or deleted app's key (the issuer answers 401 invalid_key); a suspended app comes back with `active` false.
 */
export async function issuerAppByKey(db: D1Database, pk: string, now: number): Promise<IssuerApp | null> {
  const row = await firstApp(
    db,
    (c) => `SELECT ${c}, k.key, s.environment FROM app_keys k JOIN apps a ON a.id = k.app_id JOIN scopes s ON s.scope_id = a.scope_id
             JOIN plans p ON p.id = a.plan
             WHERE k.key = ?1 AND (k.revoked_at IS NULL OR k.revoked_at > ?2) AND a.deleted_at IS NULL`,
    pk,
    now,
  );
  return row ? toApp(row) : null;
}

/** The app by id (verify: the challenge names its app; a suspended or deleted app's challenges mint nothing). */
export async function issuerAppById(db: D1Database, id: string): Promise<IssuerApp | null> {
  const row = await firstApp(db, (c) => `SELECT ${c} FROM apps a JOIN plans p ON p.id = a.plan WHERE a.id = ?1 AND a.deleted_at IS NULL`, id);
  return row ? toApp(row) : null;
}

/**
 * Whether `scopeId` has an active (no suspension bit, legacy status active), undeleted app with email on (a staff
 * client proof is only for such a scope, tokens review L6).
 */
export async function issuerScopeHasEmailApp(db: D1Database, scopeId: string): Promise<boolean> {
  try {
    const rows = await db
      .prepare("SELECT login_methods FROM apps WHERE scope_id = ?1 AND status = 'active' AND suspended_by = 0 AND deleted_at IS NULL LIMIT 50")
      .bind(scopeId)
      .all<{ login_methods: string | null }>();
    return rows.results.some((r) => emailOn(r.login_methods));
  } catch (err) {
    if (noLoginMethods(err)) return false;
    throw err;
  }
}
