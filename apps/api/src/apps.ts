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
  /** The scope's Google client GET /v1/app hands out, when set (a scope may also hold iOS/Android clients). */
  google_web_client_id: string | null;
  /** A pk_test_ app on a scope a pk_live_ app also uses (see getAppByKey). */
  scope_conflict: boolean;
  origins: string[];
}

export const PUBLISHABLE_KEY_RE = /^pk_(test|live)_[1-9A-HJ-NP-Za-km-z]{16,64}$/u;

// Origin rules live in origins.ts (dev envs, Hana pages); re-exported for callers that only need these.
export { LOCALHOST_WILDCARD, isTestKey, originAllowed } from './origins.ts';

/**
 * The app behind a publishable key, with its origins. `scope_conflict`: a pk_test_ app whose scope is also the scope
 * of a pk_live_ app (the gate refuses it, so test keys and their dev-env privileges never reach a live scope).
 */
export async function getAppByKey(db: D1Database, publishableKey: string): Promise<App | null> {
  const row = await db
    .prepare(
      `SELECT a.id, a.name, a.scope_id, a.publishable_key, a.status, a.plan, a.google_web_client_id, p.per_minute, p.per_day, p.per_ip_minute,
              (a.publishable_key LIKE 'pk\\_test\\_%' ESCAPE '\\'
                AND EXISTS (SELECT 1 FROM apps l WHERE l.scope_id = a.scope_id AND l.publishable_key LIKE 'pk\\_live\\_%' ESCAPE '\\')) AS scope_conflict
         FROM apps a JOIN plans p ON p.id = a.plan
        WHERE a.publishable_key = ?1`,
    )
    .bind(publishableKey)
    .first<Omit<App, 'origins' | 'scope_conflict'> & { scope_conflict: number }>();
  if (!row) return null;
  const { results } = await db.prepare('SELECT origin FROM app_origins WHERE app_id = ?1').bind(row.id).all<{ origin: string }>();
  return { ...row, scope_conflict: row.scope_conflict === 1, origins: results.map((r) => r.origin) };
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
