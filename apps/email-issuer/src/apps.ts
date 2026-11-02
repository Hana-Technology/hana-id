// The app behind a publishable key, read from the API's D1 (binding APP_DB, read only: the issuer never writes there).
// Email is on for an app only when its `login_methods` lists `email` (comma-separated, default 'google'; the column is
// the API's batch 6 migration: until it exists, email is off for every app).

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

export async function appByKey(db: D1Database, pk: string): Promise<IssuerApp | null> {
  let row: Row | null;
  try {
    row = await db
      .prepare('SELECT a.id, a.name, a.scope_id, a.status, a.google_web_client_id, a.login_methods, p.per_minute, p.per_day FROM apps a JOIN plans p ON p.id = a.plan WHERE a.publishable_key = ?1')
      .bind(pk)
      .first<Row>();
  } catch (err) {
    // Before the API's login_methods migration: the column doesn't exist, so no app has email on.
    if (!(err instanceof Error) || !/no such column: a\.login_methods|no such column: login_methods/u.test(err.message)) throw err;
    row = await db
      .prepare('SELECT a.id, a.name, a.scope_id, a.status, a.google_web_client_id, p.per_minute, p.per_day FROM apps a JOIN plans p ON p.id = a.plan WHERE a.publishable_key = ?1')
      .bind(pk)
      .first<Row>();
    if (row) row.login_methods = 'google';
  }
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    scopeId: row.scope_id,
    active: row.status === 'active',
    emailOn: loginMethods(row.login_methods).includes('email'),
    perMinute: row.per_minute,
    perDay: row.per_day,
    googleWebClientId: row.google_web_client_id,
  };
}

/** The app by id (verify: the challenge names its app; a suspended app's challenges mint nothing). */
export async function appById(db: D1Database, id: string): Promise<IssuerApp | null> {
  let row: Row | null;
  try {
    row = await db.prepare('SELECT a.id, a.name, a.scope_id, a.status, a.google_web_client_id, a.login_methods, p.per_minute, p.per_day FROM apps a JOIN plans p ON p.id = a.plan WHERE a.id = ?1').bind(id).first<Row>();
  } catch (err) {
    if (!(err instanceof Error) || !/no such column/u.test(err.message)) throw err;
    return null;
  }
  if (!row) return null;
  return { id: row.id, name: row.name, scopeId: row.scope_id, active: row.status === 'active', emailOn: loginMethods(row.login_methods).includes('email'), perMinute: row.per_minute, perDay: row.per_day, googleWebClientId: row.google_web_client_id };
}

/** Whether `scopeId` has an active app with email on (a staff client proof is only for such a scope, tokens review L6). */
export async function scopeHasEmailApp(db: D1Database, scopeId: string): Promise<boolean> {
  try {
    const rows = await db.prepare("SELECT login_methods FROM apps WHERE scope_id = ?1 AND status = 'active' LIMIT 50").bind(scopeId).all<{ login_methods: string | null }>();
    return rows.results.some((r) => loginMethods(r.login_methods).includes('email'));
  } catch (err) {
    if (err instanceof Error && /no such column/u.test(err.message)) return false;
    throw err;
  }
}
