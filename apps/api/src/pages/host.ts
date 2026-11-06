// Thin Workers for the two Hana page origins, for envs whose origins can't be routes on the API Worker (sandbox-dev on
// workers.dev; docs/batch-b-spec.md "Order of work" step 0). One Worker per origin, each deployed with only that
// origin's built pages as its static-assets binding (`packages/web/dist/pages/<env>/vault` or `/auth`, see
// scripts/pages-wrangler.ts), so neither origin can serve the other's pages:
//
// - vaultOrigin: `GET /vault` goes to the API Worker through the `API` service binding with the request unchanged (its
//   URL keeps the vault origin, which vault/page.ts checks), so the page is rendered there per request with the app's
//   D1 config inlined and its `frame-ancestors`. Every other path is a static asset (the vault bundle).
// - authOrigin: `/login`, `/login/email`, `/login/callback`, `/approve` and `/export` are the built HTML files (`<path>.html`), served
//   with each page's CSP and headers. Every other path is a static asset.
//
// - both: `GET /.well-known/hana-build` is `{"build": <id> | null}`, the build id the Worker was deployed with
//   (HANA_BUILD, ../build.ts, D384), for `deploy-check`; the bundles carry their own (the vault's `/vault.js` banner,
//   the auth pages' `<meta name="hana-build">`).
//
// Nothing else is served: no other path reaches the API (so `{vaultOrigin}/v1/*` is not the API), HTML files are never
// served under their own names (only on their page route, with its headers), a request on any other host (a preview
// URL) gets 404, and only GET and HEAD are allowed.
import { MAINNET_DEMO_BALANCE_ORIGINS } from '@hana-id/core/demo-config';
import { BUILD_PATH, deployedBuild } from '../build.ts';
import { log } from '../log.ts';
import { BASE_CSP, GOOGLE_CERTS_ORIGIN, VAULT_PAGE_PATH, originOf, pageHeaders } from '../vault/page.ts';

/** The vault origin's Worker (wrangler.vault.jsonc). */
export interface VaultHostEnv {
  /** Manifest `vaultOrigin`: the only origin this Worker answers on. */
  VAULT_ORIGIN: string;
  /** Static assets: packages/web/dist/pages/<env>/vault. */
  ASSETS: Fetcher;
  /** Service binding to the API Worker, which renders `/vault`. */
  API: Fetcher;
  /** The build id, set only by the `deploy:pages` script (../build.ts); served at BUILD_PATH. */
  HANA_BUILD?: string;
}

/** The auth origin's Worker (wrangler.auth.jsonc). */
export interface AuthHostEnv {
  /** Manifest `authOrigin`: the only origin this Worker answers on. */
  AUTH_ORIGIN: string;
  /** Manifest `apiUrl` and `rpc` (and `rpcFallback` when set), for the pages' CSP `connect-src`. */
  API_URL: string;
  NEAR_RPC: string;
  NEAR_RPC_FALLBACK?: string;
  /**
   * Email login (manifest `emailIssuer`, D230): the issuer's origin, `/login/email`'s only connect-src besides the API.
   * Unset: that page gets the API alone (it then stops at once, as its build does).
   */
  EMAIL_ISSUER_URL?: string;
  /**
   * Batch C11: manifest `files.origin`, where app logos live; the logo pages' (AUTH_LOGO_PATHS) only `img-src` besides
   * 'self' and data:. Unset in an env without the dashboard blocks.
   */
  FILES_ORIGIN?: string;
  /**
   * The mainnet demo (D426, D427): '1' in a dev env on testnet only (scripts/pages-wrangler.ts), where `/approve` may
   * read a demo wallet's balance from Hana's two pinned public endpoints (core MAINNET_DEMO_BALANCE_ORIGINS), as the
   * build's meta policy says. Unset: `/approve` fetches nothing.
   */
  MAINNET_DEMO_BALANCE?: string;
  /** Static assets: packages/web/dist/pages/<env>/auth. */
  ASSETS: Fetcher;
  /** The build id, set only by the `deploy:pages` script (../build.ts); served at BUILD_PATH. */
  HANA_BUILD?: string;
}

/** Google's tokeninfo, which the callback page calls under token_first (packages/web auth/google.ts). */
export const GOOGLE_TOKENINFO_ORIGIN = 'https://oauth2.googleapis.com';

/** Each auth page's directives on top of the base policy (docs/batch-b-spec.md "Origins and pages"). */
/** `origins.rpc` is the NEAR RPC origin, or the primary and fallback origins separated by a space. */
export function authPageDirectives(pathname: string, origins: { api: string; rpc: string; emailIssuer?: string | null; demoBalance?: boolean }): string[] | null {
  switch (pathname) {
    case '/login/callback':
      // token_first (D270): the callback asks Google's tokeninfo for the access token's `sub`, in an env with an email
      // issuer only. packages/web src/auth/pages.ts's meta policy lists the same: a browser enforces both.
      return ["frame-ancestors 'none'", `connect-src ${origins.api}${origins.emailIssuer ? ` ${GOOGLE_TOKENINFO_ORIGIN}` : ''}`];
    case '/login/email':
      // The email step (build plan batch 8a): the issuer's start, resend and verify, and the relay write to the API.
      return ["frame-ancestors 'none'", `connect-src ${origins.emailIssuer ? `${origins.emailIssuer} ` : ''}${origins.api}`];
    // The login popup fetches nothing (D77).
    case '/login':
      return ["frame-ancestors 'none'"];
    // The approval popup decodes and renders what the vault sent; in a dev testnet env it may also read a mainnet demo
    // wallet's balance from Hana's two pinned endpoints (packages/web src/auth/pages.ts lists the same).
    case '/approve':
      return origins.demoBalance ? ["frame-ancestors 'none'", `connect-src ${MAINNET_DEMO_BALANCE_ORIGINS.join(' ')}`] : ["frame-ancestors 'none'"];
    case '/export':
      return ["frame-ancestors 'none'", `connect-src ${origins.api} ${origins.rpc} ${GOOGLE_CERTS_ORIGIN}`];
    default:
      return null;
  }
}

/**
 * The auth pages that show the app's name and so its logo (batch C11): their `img-src` adds FILES_ORIGIN. packages/web
 * src/auth/pages.ts LOGO_PAGES lists the same pages for the meta policy: a browser enforces both, so they must agree.
 * The callback shows no app and loads no image from elsewhere.
 */
export const AUTH_LOGO_PATHS: readonly string[] = ['/login', '/login/email', '/approve', '/export'];

/** The auth pages' routes; each is served from the built file `<route>.html`. */
export const AUTH_PAGE_PATHS = ['/login', '/login/email', '/login/callback', '/approve', '/export'] as const;

const ERROR_HTML = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Hana ID</title></head><body></body></html>\n';

/** Headers of every response that isn't a page or an asset: nothing to run, frame or sniff. */
function plainHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'text/plain; charset=utf-8',
    'content-security-policy': [...BASE_CSP, "frame-ancestors 'none'"].join('; '),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...extra,
  };
}

const notFound = (head: boolean): Response => new Response(head ? null : 'Not found\n', { status: 404, headers: plainHeaders() });

const methodNotAllowed = (): Response => new Response('Method not allowed\n', { status: 405, headers: plainHeaders({ allow: 'GET, HEAD' }) });

/** 503 page (no config script, framed nowhere): the vault script finds no config, so the SDK raises `vault_unavailable`. */
const unavailable = (head: boolean): Response =>
  new Response(head ? null : ERROR_HTML, { status: 503, headers: pageHeaders(["frame-ancestors 'none'"]) });

/**
 * The policy of every static asset: should one ever be opened as a document (an SVG, XML or XHTML file in the build,
 * opened directly or framed), it runs nothing, loads nothing and can't be framed. Browsers don't apply a response's
 * CSP to the scripts and styles a page loads, so the pages' own bundles are unaffected (a Web Worker script would be:
 * none is built).
 */
export const ASSET_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

/**
 * A static asset (scripts, styles, images) as the assets binding has it, plus ASSET_CSP, `nosniff`, `no-referrer`
 * and a same-origin CORP (only the origin's own pages load them). HTML is refused: pages exist only on their routes.
 */
/**
 * No Hana origin ever sets a cookie: whatever a binding answers (the assets binding, the API Worker behind /vault),
 * a `Set-Cookie` header is dropped before the response leaves the page Worker.
 */
export function withoutCookies(res: Response): Response {
  if (!res.headers.has('set-cookie')) return res;
  const headers = new Headers(res.headers);
  headers.delete('set-cookie');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function staticAsset(request: Request, assets: Fetcher, head: boolean): Promise<Response> {
  if (new URL(request.url).pathname.toLowerCase().endsWith('.html')) return notFound(head);
  const res = await assets.fetch(request);
  // 304 answers a conditional request for an asset already in the browser's cache.
  if (res.status !== 200 && res.status !== 304) {
    await res.body?.cancel();
    return notFound(head);
  }
  if (/^\s*text\/html\b/iu.test(res.headers.get('content-type') ?? '')) {
    await res.body?.cancel();
    return notFound(head);
  }
  if (head) await res.body?.cancel();
  const headers = new Headers(res.headers);
  headers.delete('set-cookie');
  headers.set('content-security-policy', ASSET_CSP);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('cross-origin-resource-policy', 'same-origin');
  return new Response(head ? null : res.body, { status: res.status, headers });
}

/** BUILD_PATH: the Worker's build id as JSON, uncached, with the headers of a response that runs nothing. */
function buildResponse(value: string | undefined, head: boolean): Response {
  return new Response(head ? null : `${JSON.stringify({ build: deployedBuild(value) })}\n`, { status: 200, headers: plainHeaders({ 'content-type': 'application/json; charset=utf-8' }) });
}

/** Common gate: only the configured origin, only GET and HEAD. Returns the refusal, or null to go on. */
function gate(request: Request, origin: string): Response | null {
  const head = request.method === 'HEAD';
  if (new URL(request.url).origin !== origin) return notFound(head);
  if (request.method !== 'GET' && !head) return methodNotAllowed();
  return null;
}

export async function handleVaultHost(request: Request, env: VaultHostEnv): Promise<Response> {
  const refused = gate(request, env.VAULT_ORIGIN);
  if (refused) return refused;
  const head = request.method === 'HEAD';
  const { pathname } = new URL(request.url);
  if (pathname === BUILD_PATH) return buildResponse(env.HANA_BUILD, head);
  if (pathname === VAULT_PAGE_PATH) {
    try {
      return withoutCookies(await env.API.fetch(request));
    } catch {
      log({ event: 'vault_host', endpoint: VAULT_PAGE_PATH, outcome: 'error', status: 503, code: 'api_unavailable' }, 'error');
      return unavailable(head);
    }
  }
  return staticAsset(request, env.ASSETS, head);
}

export async function handleAuthHost(request: Request, env: AuthHostEnv): Promise<Response> {
  const refused = gate(request, env.AUTH_ORIGIN);
  if (refused) return refused;
  const head = request.method === 'HEAD';
  const url = new URL(request.url);
  if (url.pathname === BUILD_PATH) return buildResponse(env.HANA_BUILD, head);
  if (!(AUTH_PAGE_PATHS as readonly string[]).includes(url.pathname)) return staticAsset(request, env.ASSETS, head);
  const api = originOf(env.API_URL);
  const primary = originOf(env.NEAR_RPC);
  const fallback = env.NEAR_RPC_FALLBACK ? originOf(env.NEAR_RPC_FALLBACK) : null;
  // The export window falls back to rpcFallback when the primary fails (Q9): both are in its connect-src.
  const rpc = primary && (!env.NEAR_RPC_FALLBACK || fallback) ? (fallback && fallback !== primary ? `${primary} ${fallback}` : primary) : null;
  const emailIssuer = env.EMAIL_ISSUER_URL ? originOf(env.EMAIL_ISSUER_URL) : null;
  // A malformed EMAIL_ISSUER_URL breaks only the email step's page (never a looser policy there); the other pages don't
  // use it.
  const issuerBroken = url.pathname === '/login/email' && !!env.EMAIL_ISSUER_URL && !emailIssuer;
  const directives = api && rpc && !issuerBroken ? authPageDirectives(url.pathname, { api, rpc, emailIssuer, demoBalance: env.MAINNET_DEMO_BALANCE === '1' }) : null;
  if (!directives) {
    log({ event: 'auth_page', endpoint: url.pathname, outcome: 'error', status: 503, code: 'misconfigured' }, 'error');
    return unavailable(head);
  }
  // Only the file's bytes are taken from the binding: the headers are this page's, whatever the build shipped.
  const asset = await env.ASSETS.fetch(new Request(new URL(`${url.pathname}.html`, url.origin), { method: 'GET' }));
  if (asset.status !== 200) {
    await asset.body?.cancel();
    log({ event: 'auth_page', endpoint: url.pathname, outcome: 'error', status: 503, code: 'page_missing' }, 'error');
    return unavailable(head);
  }
  if (head) await asset.body?.cancel();
  return new Response(head ? null : asset.body, { status: 200, headers: pageHeaders(directives, {}, logoImgOrigins(url.pathname, env.FILES_ORIGIN)) });
}

/**
 * The files origin for a logo page's `img-src`, or none. A FILES_ORIGIN that isn't an origin is left out (and logged):
 * the page then shows no logo but still works, with the stricter policy, never a looser one.
 */
function logoImgOrigins(pathname: string, filesOrigin: string | undefined): string[] {
  if (!filesOrigin || !AUTH_LOGO_PATHS.includes(pathname)) return [];
  const origin = originOf(filesOrigin);
  if (!origin) {
    log({ event: 'auth_page', endpoint: pathname, outcome: 'error', status: 200, code: 'files_origin_misconfigured' }, 'error');
    return [];
  }
  return [origin];
}
