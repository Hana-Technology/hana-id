// Partner origins as the vault sees them: which parent may use an app's vault (x-hana-parent-origin, share origins)
// and which origins may frame the vault page (frame-ancestors, inlined `origins`). Same rules as apps.ts
// `originAllowed`, plus the batch B dev-env rule: loopback origins (and the `http://localhost:*` wildcard) only for
// pk_test_ keys and only in envs whose name starts with `local` or `sandbox`.
import { type App, LOCALHOST_WILDCARD, isTestKey, originAllowed } from '../apps.ts';

/** Mirrors @hana-id/env `isDevEnv` (that package is Node-only). Tied to the env name, so no flag can enable it. */
export const isDevEnv = (envName: string): boolean => /^(local|sandbox)/u.test(envName);

const LOOPBACK_RE = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:(\d{1,5}|\*))?$/u;
/**
 * What may appear in a CSP source list and the inlined config: a bare lowercase http(s) origin, or the localhost
 * wildcard. Anything else in D1 (whitespace, `;`, `,`, quotes, paths) is dropped rather than injected into a header.
 */
const SAFE_ORIGIN_RE = /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:\d{1,5})?$/u;

/** At most this many origins per app are served (frame-ancestors and the inlined config). */
export const MAX_APP_ORIGINS = 20;

export const isLoopbackOrigin = (origin: string): boolean => LOOPBACK_RE.test(origin);

/** A parent (or share) origin the app allows in this env. */
export function parentOriginAllowed(envName: string, app: Pick<App, 'publishable_key' | 'origins'>, origin: string | null): boolean {
  if (!origin) return false;
  if (isLoopbackOrigin(origin) && !isDevEnv(envName)) return false;
  return originAllowed(app, origin);
}

/**
 * The app's origins that may embed its vault in this env, sorted (stable headers): loopback ones only for pk_test_ in
 * dev envs, malformed ones never.
 */
export function servedOrigins(envName: string, app: Pick<App, 'publishable_key' | 'origins'>): string[] {
  const loopbackOk = isTestKey(app.publishable_key) && isDevEnv(envName);
  return [...new Set(app.origins)].filter((o) => (o === LOCALHOST_WILDCARD || SAFE_ORIGIN_RE.test(o)) && (loopbackOk || !isLoopbackOrigin(o))).sort();
}

/**
 * A pk_test_ app whose scope is also a pk_live_ app's scope is refused everywhere (test and live apps never share
 * addresses). One indexed lookup, only for pk_test_ keys.
 */
export async function scopeConflict(db: D1Database, app: Pick<App, 'publishable_key' | 'scope_id'>): Promise<boolean> {
  if (!isTestKey(app.publishable_key)) return false;
  const row = await db
    .prepare(`SELECT 1 AS hit FROM apps WHERE scope_id = ?1 AND publishable_key LIKE 'pk\\_live\\_%' ESCAPE '\\' LIMIT 1`)
    .bind(app.scope_id)
    .first<{ hit: number }>();
  return row !== null;
}
