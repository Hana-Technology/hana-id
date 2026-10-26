// Off-chain app config in D1: publishable keys, origins, plans, status, usage.

export interface App {
  id: string;
  name: string;
  scope_id: string;
  publishable_key: string;
  status: 'active' | 'suspended' | string;
  plan: string;
  per_minute: number;
  per_day: number;
  per_ip_minute: number;
  origins: string[];
}

export const PUBLISHABLE_KEY_RE = /^pk_(test|live)_[1-9A-HJ-NP-Za-km-z]{16,64}$/u;
/** App origin entry that allows any `http://localhost:<port>` (pk_test_ keys only). */
export const LOCALHOST_WILDCARD = 'http://localhost:*';
const LOCALHOST_RE = /^http:\/\/localhost(:\d{1,5})?$/u;
const LOOPBACK_RE = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d{1,5})?$/u;

export const isTestKey = (publishableKey: string): boolean => publishableKey.startsWith('pk_test_');

export async function getAppByKey(db: D1Database, publishableKey: string): Promise<App | null> {
  const row = await db
    .prepare(
      `SELECT a.id, a.name, a.scope_id, a.publishable_key, a.status, a.plan, p.per_minute, p.per_day, p.per_ip_minute
         FROM apps a JOIN plans p ON p.id = a.plan
        WHERE a.publishable_key = ?1`,
    )
    .bind(publishableKey)
    .first<Omit<App, 'origins'>>();
  if (!row) return null;
  const { results } = await db.prepare('SELECT origin FROM app_origins WHERE app_id = ?1').bind(row.id).all<{ origin: string }>();
  return { ...row, origins: results.map((r) => r.origin) };
}

/** Exact match against the app's origins; loopback origins only ever for pk_test_ keys. */
export function originAllowed(app: Pick<App, 'publishable_key' | 'origins'>, origin: string | null): boolean {
  if (!origin) return false;
  const test = isTestKey(app.publishable_key);
  if (LOOPBACK_RE.test(origin) && !test) return false;
  if (app.origins.includes(origin)) return true;
  return test && LOCALHOST_RE.test(origin) && app.origins.includes(LOCALHOST_WILDCARD);
}

/**
 * Preflight: the browser doesn't send `x-hana-key` on OPTIONS, so allow the origin if any active app allows it.
 * The real request is then checked against its own app.
 */
export async function anyActiveAppAllowsOrigin(db: D1Database, origin: string): Promise<boolean> {
  const localhost = LOCALHOST_RE.test(origin) ? 1 : 0;
  const loopback = LOOPBACK_RE.test(origin) ? 1 : 0;
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM app_origins o JOIN apps a ON a.id = o.app_id
        WHERE a.status = 'active'
          AND (?3 = 0 OR a.publishable_key LIKE 'pk\\_test\\_%' ESCAPE '\\')
          AND (o.origin = ?1 OR (?2 = 1 AND o.origin = ?4))
        LIMIT 1`,
    )
    .bind(origin, localhost, loopback, LOCALHOST_WILDCARD)
    .first<{ ok: number }>();
  return !!row;
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
