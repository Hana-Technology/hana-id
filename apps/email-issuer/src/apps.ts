// The app behind a publishable key, read from the API's D1 (binding APP_DB, read only: the issuer never writes there),
// by the API gate's model (apps/api/src/apps.ts getAppByKey, migration 0006; D206, D225): the key is an `app_keys` row
// not revoked, or revoked with its rotation grace still running (`revoked_at` in the future); the app isn't deleted
// (`deleted_at IS NULL`); it is active only with no suspension bit (`suspended_by = 0`) and the legacy `status` active.
// The legacy `apps.publishable_key` column is never read. Email is on for an app only when its `login_methods` lists
// `email` (comma-separated, default 'google'; the API's migration 0010: until it is applied, email is off for every app).

export interface IssuerApp {
  id: string;
  name: string;
  scopeId: string;
  active: boolean;
  emailOn: boolean;
  perMinute: number;
  perDay: number;
  /** The app's own Google web client, when it set one (API migration 0003): google-match then accepts only it. */
  googleWebClientId: string | null;
}

const PK_RE = /^pk_(?:test|live)_[1-9A-HJ-NP-Za-km-z]{16,64}$/u;
export const isPublishableKey = (v: unknown): v is string => typeof v === 'string' && PK_RE.test(v);

interface Row {
  id: string;
  name: string;
  scope_id: string;
  status: string;
  suspended_by: number;
  google_web_client_id: string | null;
  login_methods?: string | null;
  per_minute: number;
  per_day: number;
}

export const loginMethods = (raw: string | null | undefined): string[] =>
  (raw ?? 'google')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** The gate's rule (apps/api appSuspended): any suspension bit, or the legacy status column, suspends. */
const isActive = (row: Pick<Row, 'status' | 'suspended_by'>): boolean => row.status === 'active' && row.suspended_by === 0;

const toApp = (row: Row): IssuerApp => ({
  id: row.id,
  name: row.name,
  scopeId: row.scope_id,
  active: isActive(row),
  emailOn: loginMethods(row.login_methods).includes('email'),
  perMinute: row.per_minute,
  perDay: row.per_day,
  googleWebClientId: row.google_web_client_id,
});

const COLUMNS = 'a.id, a.name, a.scope_id, a.status, a.suspended_by, a.google_web_client_id, p.per_minute, p.per_day';
/** Before the API's migration 0010 the column doesn't exist: no app has email on. */
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
 * revoked or deleted app's key (the caller answers 401 unknown_app); a suspended app comes back with `active` false.
 */
export async function appByKey(db: D1Database, pk: string, now: number = Date.now()): Promise<IssuerApp | null> {
  const row = await firstApp(
    db,
    (c) => `SELECT ${c} FROM app_keys k JOIN apps a ON a.id = k.app_id JOIN plans p ON p.id = a.plan
             WHERE k.key = ?1 AND (k.revoked_at IS NULL OR k.revoked_at > ?2) AND a.deleted_at IS NULL`,
    pk,
    now,
  );
  return row ? toApp(row) : null;
}

/** The app by id (verify: the challenge names its app; a suspended or deleted app's challenges mint nothing). */
export async function appById(db: D1Database, id: string): Promise<IssuerApp | null> {
  const row = await firstApp(db, (c) => `SELECT ${c} FROM apps a JOIN plans p ON p.id = a.plan WHERE a.id = ?1 AND a.deleted_at IS NULL`, id);
  return row ? toApp(row) : null;
}

/**
 * Whether `scopeId` has an active (no suspension bit, legacy status active), undeleted app with email on (a staff
 * client proof is only for such a scope, tokens review L6).
 */
export async function scopeHasEmailApp(db: D1Database, scopeId: string): Promise<boolean> {
  try {
    const rows = await db
      .prepare("SELECT login_methods FROM apps WHERE scope_id = ?1 AND status = 'active' AND suspended_by = 0 AND deleted_at IS NULL LIMIT 50")
      .bind(scopeId)
      .all<{ login_methods: string | null }>();
    return rows.results.some((r) => loginMethods(r.login_methods).includes('email'));
  } catch (err) {
    if (noLoginMethods(err)) return false;
    throw err;
  }
}
