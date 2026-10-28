// The auth-origin pages (docs/batch-b-spec.md "Origins and pages"): where each one is served, the file the per-env build
// writes for it, and its security headers. The build puts the policy in a <meta> CSP as well, so the built files are
// locked down whoever serves them; the Worker sends the full set as headers (frame-ancestors only works as a header).
import type { HanaEnv } from '../hana-env.ts';

export type AuthPageName = 'login' | 'callback' | 'approve' | 'export';

export interface AuthPage {
  readonly name: AuthPageName;
  /** The path on authOrigin. */
  readonly path: string;
  /** The HTML file, relative to dist/pages/<env>. */
  readonly file: string;
  readonly title: string;
}

export const AUTH_PAGES: readonly AuthPage[] = Object.freeze([
  { name: 'login', path: '/login', file: 'login.html', title: 'Sign in with Hana' },
  { name: 'callback', path: '/login/callback', file: 'login/callback.html', title: 'Signing in to Hana' },
  { name: 'approve', path: '/approve', file: 'approve.html', title: 'Review in Hana' },
  { name: 'export', path: '/export', file: 'export.html', title: 'Export your key' },
]);

/** Google's JWKS host, which the export window reads (as the vault does). */
export const GOOGLE_CERTS_ORIGIN = 'https://www.googleapis.com';

/** Every Hana page's base policy (the same list as apps/api vault/page.ts BASE_CSP). */
export const BASE_CSP: readonly string[] = Object.freeze([
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
]);

const originOf = (url: string): string => new URL(url).origin;

/** What the page may fetch: the API (login, callback, export), the NEAR RPC and Google's JWKS (export). */
export function connectSources(env: Pick<HanaEnv, 'apiUrl' | 'rpc'>, page: AuthPageName): string[] {
  switch (page) {
    case 'login':
    case 'callback':
      return [originOf(env.apiUrl)];
    case 'export':
      return [originOf(env.apiUrl), originOf(env.rpc), GOOGLE_CERTS_ORIGIN];
    case 'approve':
      // The popup decodes and renders what the vault sent; it fetches nothing.
      return [];
  }
}

/** The page's CSP directives without frame-ancestors (the part a <meta> CSP can carry). */
export function authPageMetaCsp(env: Pick<HanaEnv, 'apiUrl' | 'rpc'>, page: AuthPageName): string {
  const connect = connectSources(env, page);
  return [...BASE_CSP, ...(connect.length > 0 ? [`connect-src ${connect.join(' ')}`] : [])].join('; ');
}

/** The page's full CSP header: the meta policy plus `frame-ancestors 'none'` (no auth page may be framed). */
export const authPageCsp = (env: Pick<HanaEnv, 'apiUrl' | 'rpc'>, page: AuthPageName): string => `${authPageMetaCsp(env, page)}; frame-ancestors 'none'`;

/**
 * The response headers of an auth page. No COOP header (`unsafe-none`): the login popup must keep `window.opener`
 * across Google's pages where browsers allow it, and the approval and export windows talk to their opener.
 */
export function authPageHeaders(env: Pick<HanaEnv, 'apiUrl' | 'rpc'>, page: AuthPageName): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': authPageCsp(env, page),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
}
