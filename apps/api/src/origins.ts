// Who may call which endpoint (docs/batch-b-spec.md, "Origin rule (appGate)"). Two kinds of caller:
// - Hana pages: Origin is VAULT_ORIGIN or AUTH_ORIGIN, each allowed only on the endpoints it uses. They act for the
//   partner page in `x-hana-parent-origin`, which must be one of the app's origins.
// - Partner pages: Origin is one of the app's origins. Everywhere for GET /v1/app; for the session endpoints only
//   with pk_test_ keys and only in dev envs.
// Loopback origins (and the `http://localhost:*` wildcard) are allowed only for pk_test_ keys in dev envs. Dev envs
// are tied to the env name, so no flag can give these privileges to a production env.
import type { App } from './apps.ts';

/** App origin entry that allows any `http://localhost:<port>` (pk_test_ keys in dev envs only). */
export const LOCALHOST_WILDCARD = 'http://localhost:*';
const LOCALHOST_RE = /^http:\/\/localhost(:\d{1,5})?$/u;
/** Loopback hosts as browsers treat them: localhost and its subdomains, 127.0.0.0/8, [::1]. */
const LOOPBACK_RE = /^https?:\/\/(([a-z0-9-]+\.)*localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(:\d{1,5})?$/u;

export const PARENT_ORIGIN_HEADER = 'x-hana-parent-origin';
export const RELAY_KEY_HEADER = 'x-hana-relay-key';

export const isTestKey = (publishableKey: string): boolean => publishableKey.startsWith('pk_test_');
export const isLoopbackOrigin = (origin: string): boolean => LOOPBACK_RE.test(origin);

/**
 * `local*` and `sandbox*` envs. Mirrors `isDevEnv` in packages/env/src/origins.ts (the Worker doesn't import the
 * Node-only manifest package); test/origins.test.ts checks both on the same names.
 */
export function isDevEnv(envName: string): boolean {
  return /^(local|sandbox)/u.test(envName);
}

/**
 * Exact match against the app's origins. Loopback origins, and `http://localhost:<port>` through the wildcard, only
 * for pk_test_ keys in dev envs.
 */
export function originAllowed(app: Pick<App, 'publishable_key' | 'origins'>, origin: string | null, devEnv: boolean): boolean {
  if (!origin) return false;
  const loopbackOk = devEnv && isTestKey(app.publishable_key);
  if (isLoopbackOrigin(origin) && !loopbackOk) return false;
  if (app.origins.includes(origin)) return true;
  return loopbackOk && LOCALHOST_RE.test(origin) && app.origins.includes(LOCALHOST_WILDCARD);
}

export type HanaPage = 'vault' | 'auth';

/** The Hana page an Origin belongs to (VAULT_ORIGIN, AUTH_ORIGIN), or null. Unset or empty vars match nothing. */
export function hanaPage(env: { VAULT_ORIGIN?: string; AUTH_ORIGIN?: string }, origin: string | null): HanaPage | null {
  if (!origin) return null;
  if (env.VAULT_ORIGIN && origin === env.VAULT_ORIGIN) return 'vault';
  if (env.AUTH_ORIGIN && origin === env.AUTH_ORIGIN) return 'auth';
  return null;
}

/**
 * App-gated endpoints the Hana pages call, and which pages call each (docs/batch-b-spec.md, "Endpoints"). The auth
 * origin's export window logs in through /v1/login; the vault also keeps the split flow (/v1/sessions then
 * /v1/derive) behind an env flag until the ship gate decides.
 */
export const HANA_CALLERS: Readonly<Record<string, readonly HanaPage[]>> = {
  '/v1/app': ['vault', 'auth'],
  '/v1/login': ['vault', 'auth'],
  '/v1/sessions': ['vault'],
  '/v1/derive': ['vault'],
  '/v1/sessions/revoke': ['vault'],
};

/** Endpoints partner pages may call with any key, in any env. */
const PARTNER_ENDPOINTS: ReadonlySet<string> = new Set(['/v1/app']);
/** Endpoints partner pages may call only with pk_test_ keys in dev envs (`apps/smoke` until it moves to the vault). */
const PARTNER_DEV_TEST_ENDPOINTS: ReadonlySet<string> = new Set(['/v1/sessions', '/v1/derive', '/v1/sessions/revoke']);

export interface Caller {
  ok: boolean;
  /** Origin to echo in CORS: the Hana origin (also when its parent is refused, so the page can read why), or an allowed partner origin. */
  cors: string | null;
  /** The Hana page that called, or null for a partner page. */
  page: HanaPage | null;
  /** The partner origin the request acts for: `x-hana-parent-origin` from a Hana page, else the Origin itself. */
  parentOrigin: string | null;
}

/** Whether the request's Origin (and, from a Hana page, its parent origin) may call `endpoint` for `app`. */
export function checkCaller(
  env: { ENV_NAME: string; VAULT_ORIGIN?: string; AUTH_ORIGIN?: string },
  app: Pick<App, 'publishable_key' | 'origins'>,
  endpoint: string,
  headers: Headers,
): Caller {
  const devEnv = isDevEnv(env.ENV_NAME);
  const origin = headers.get('origin');
  const page = hanaPage(env, origin);
  if (page && HANA_CALLERS[endpoint]?.includes(page)) {
    const parent = headers.get(PARENT_ORIGIN_HEADER);
    return { ok: originAllowed(app, parent, devEnv), cors: origin, page, parentOrigin: parent };
  }
  const allowed = originAllowed(app, origin, devEnv);
  const permitted = PARTNER_ENDPOINTS.has(endpoint) || (PARTNER_DEV_TEST_ENDPOINTS.has(endpoint) && devEnv && isTestKey(app.publishable_key));
  const ok = allowed && permitted;
  return { ok, cors: ok ? origin : null, page: null, parentOrigin: ok ? origin : null };
}

/**
 * Preflight: the browser doesn't send `x-hana-key` on OPTIONS, so allow the Hana origins, and any origin an active
 * app allows (loopback only through a pk_test_ app, in a dev env). The real request is then checked against its own
 * app and endpoint.
 */
export async function preflightAllows(db: D1Database, env: { ENV_NAME: string; VAULT_ORIGIN?: string; AUTH_ORIGIN?: string }, origin: string | null): Promise<boolean> {
  if (!origin) return false;
  if (hanaPage(env, origin)) return true;
  const loopback = isLoopbackOrigin(origin);
  if (loopback && !isDevEnv(env.ENV_NAME)) return false;
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM app_origins o JOIN apps a ON a.id = o.app_id
        WHERE a.status = 'active'
          AND (?3 = 0 OR a.publishable_key LIKE 'pk\\_test\\_%' ESCAPE '\\')
          AND (o.origin = ?1 OR (?2 = 1 AND o.origin = ?4))
        LIMIT 1`,
    )
    .bind(origin, LOCALHOST_RE.test(origin) ? 1 : 0, loopback ? 1 : 0, LOCALHOST_WILDCARD)
    .first<{ ok: number }>();
  return !!row;
}
