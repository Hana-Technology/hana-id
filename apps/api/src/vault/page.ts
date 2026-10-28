// The vault page, `GET {VAULT_ORIGIN}/vault?pk=<publishable key>` (docs/batch-b-spec.md "Origins and pages"): the
// hidden iframe that holds the keys. The HTML is rendered per request so it can inline the app's D1 config (no chain
// RPC, so a reload unlocks with one API call) and set `frame-ancestors` to the app's origins. Its script is a static
// asset from @hana-id/web, loaded with `'self'`; until that bundle is built the script path simply 404s.
import { type App, PUBLISHABLE_KEY_RE, getAppByKey } from '../apps.ts';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { MAX_APP_ORIGINS, servedOrigins } from './origins.ts';
import { type AppSettings, effectiveSettings, getSettingsRow } from './settings.ts';

export const VAULT_PAGE_PATH = '/vault';
/** The vault bundle @hana-id/web serves from the static-assets binding. */
export const VAULT_SCRIPT_PATH = '/vault.js';
const GOOGLE_CERTS_ORIGIN = 'https://www.googleapis.com';

/** Every Hana page's base policy. */
export const BASE_CSP = ["default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'", "base-uri 'none'", "form-action 'none'"];

/** The non-executable config the vault script reads from `<script type="application/json" id="hana-config">`. */
export interface VaultConfig {
  v: 1;
  appId: string;
  appName: string;
  scopeId: string;
  origins: string[];
  settings: AppSettings;
  publishableKey: string;
  serverTimeMs: number;
}

/** Whether a request is for the vault page: the path on the vault origin itself (never on the API's own host). */
export function isVaultPageRequest(request: Request, env: Pick<Env, 'VAULT_ORIGIN'>): boolean {
  if (!env.VAULT_ORIGIN) return false;
  const url = new URL(request.url);
  return url.origin === env.VAULT_ORIGIN && url.pathname === VAULT_PAGE_PATH;
}

/**
 * JSON that can't end its `<script>` element or open another: `<`, `>`, `&`, U+2028 and U+2029 become `\u` escapes,
 * which JSON.parse reads back unchanged. Partner-controlled strings (app name, origins) stay inside the JSON.
 */
export function jsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** The headers every Hana page carries, with this page's extra directives. */
export function pageHeaders(directives: string[], extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': [...BASE_CSP, ...directives].join('; '),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...extra,
  };
}

const ERROR_HTML = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Hana ID</title></head><body></body></html>\n';

/** 403 or 503 with no config script: the vault script then does nothing and the SDK raises `vault_unavailable`. */
function errorPage(status: number, requestId: string, appId: string | undefined, code: string, head: boolean): Response {
  log({ event: 'vault_page', requestId, appId, outcome: status >= 500 ? 'error' : 'rejected', status, code }, status >= 500 ? 'error' : 'info');
  return new Response(head ? null : ERROR_HTML, { status, headers: pageHeaders(["frame-ancestors 'none'"], { 'x-request-id': requestId }) });
}

export function renderVaultHtml(config: VaultConfig): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>Hana ID</title>',
    `<script type="application/json" id="hana-config">${jsonForHtml(config)}</script>`,
    `<script type="module" src="${VAULT_SCRIPT_PATH}"></script>`,
    '</head>',
    '<body></body>',
    '</html>',
    '',
  ].join('\n');
}

export async function handleVaultPage(request: Request, env: Env, requestId: string): Promise<Response> {
  const head = request.method === 'HEAD';
  const key = new URL(request.url).searchParams.get('pk');
  if (!key || !PUBLISHABLE_KEY_RE.test(key)) return errorPage(403, requestId, undefined, 'unknown_app', head);
  const apiOrigin = originOf(env.API_URL);
  const rpcOrigin = originOf(env.NEAR_RPC);
  if (!apiOrigin || !rpcOrigin) return errorPage(503, requestId, undefined, 'misconfigured', head);

  let app: App | null;
  let settings: AppSettings;
  try {
    app = await getAppByKey(env.DB, key);
    if (!app) return errorPage(403, requestId, undefined, 'unknown_app', head);
    if (app.status !== 'active') return errorPage(403, requestId, app.id, 'app_suspended', head);
    const row = await getSettingsRow(env.DB, app.id);
    if (!row) return errorPage(403, requestId, app.id, 'unknown_app', head);
    settings = effectiveSettings(row, app.id, Date.now());
  } catch {
    return errorPage(503, requestId, undefined, 'config_unavailable', head);
  }
  // getAppByKey: a pk_test_ app whose scope a pk_live_ app also uses (test and live apps never share addresses).
  if (app.scope_conflict) return errorPage(403, requestId, app.id, 'scope_conflict', head);

  const origins = servedOrigins(env.ENV_NAME, app);
  // The admin CLI refuses more; an app over the cap is refused rather than served a partial list.
  if (origins.length > MAX_APP_ORIGINS) return errorPage(403, requestId, app.id, 'too_many_origins', head);
  const config: VaultConfig = {
    v: 1,
    appId: app.id,
    appName: app.name,
    scopeId: app.scope_id,
    origins,
    settings,
    publishableKey: app.publishable_key,
    serverTimeMs: Date.now(),
  };
  const frameAncestors = origins.length > 0 ? origins.join(' ') : "'none'";
  log({ event: 'vault_page', requestId, appId: app.id, outcome: 'ok', status: 200 });
  return new Response(head ? null : renderVaultHtml(config), {
    status: 200,
    headers: pageHeaders([`frame-ancestors ${frameAncestors}`, `connect-src ${apiOrigin} ${rpcOrigin} ${GOOGLE_CERTS_ORIGIN}`], {
      'cross-origin-resource-policy': 'cross-origin',
      'x-request-id': requestId,
    }),
  });
}
