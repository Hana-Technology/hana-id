// The auth-origin pages (docs/batch-b-spec.md "Origins and pages"): where each one is served, the file the per-env build
// writes for it, and its CSP. The build puts the policy in a <meta> CSP, so the built files are locked down whoever
// serves them; the Worker (apps/api src/pages/host.ts) sends the full policy and the other headers itself
// (frame-ancestors only works as a header).
import type { HanaEnv } from '../hana-env.ts';
import { GOOGLE_TOKENINFO_ORIGIN } from './google.ts';

export type AuthPageName = 'login' | 'email' | 'callback' | 'approve' | 'export';

export interface AuthPage {
  readonly name: AuthPageName;
  /** The path on authOrigin. */
  readonly path: string;
  /** The HTML file, relative to the auth origin's root dist/pages/<env>/auth. */
  readonly file: string;
  readonly title: string;
}

export const AUTH_PAGES: readonly AuthPage[] = Object.freeze([
  { name: 'login', path: '/login', file: 'login.html', title: 'Sign in with Hana' },
  { name: 'email', path: '/login/email', file: 'login/email.html', title: 'Sign in with email' },
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

type CspEnv = Pick<HanaEnv, 'apiUrl' | 'rpc' | 'rpcFallback' | 'emailIssuerUrl'>;

/**
 * What the page may fetch: the API (callback, email, export), Google's tokeninfo (callback, with an email issuer), the
 * email issuer (email), the NEAR RPC and Google's JWKS (export). apps/api src/pages/host.ts sends the same lists in
 * the header policy: a browser enforces both, so they must agree.
 */
export function connectSources(env: CspEnv, page: AuthPageName): string[] {
  switch (page) {
    case 'login':
      // The popup checks the vault's message, shows the method chooser and goes to Google or to /login/email; it
      // fetches nothing (D77).
      return [];
    case 'email':
      // The email step: the issuer's start, resend and verify (no other origin), and the relay write to the API. An
      // env without an email issuer gets the API only, and the page stops at once.
      return env.emailIssuerUrl ? [originOf(env.emailIssuerUrl), originOf(env.apiUrl)] : [originOf(env.apiUrl)];
    case 'callback':
      // token_first (D270, auth/google.ts accessTokenSub): the callback asks Google's tokeninfo for the access token's
      // `sub`. Only an env with an email issuer can run it (the vault sends the follow-up key only there), so only
      // such an env's callback may reach tokeninfo; it is listed whatever GOOGLE_EMAIL_FLOW says, so the flow's switch
      // stays one line and the header policy (which can't read the flow) always matches this one.
      return env.emailIssuerUrl ? [originOf(env.apiUrl), GOOGLE_TOKENINFO_ORIGIN] : [originOf(env.apiUrl)];
    case 'export':
      // Both NEAR providers: the window falls back to rpcFallback, and a linked identity's path is read on both
      // (D263). The Worker's header policy lists the same; a browser enforces both policies, so the meta one must too.
      return [
        originOf(env.apiUrl),
        originOf(env.rpc),
        ...(env.rpcFallback && originOf(env.rpcFallback) !== originOf(env.rpc) ? [originOf(env.rpcFallback)] : []),
        GOOGLE_CERTS_ORIGIN,
      ];
    case 'approve':
      // The popup decodes and renders what the vault sent; it fetches nothing.
      return [];
  }
}

/** The page's CSP directives without frame-ancestors (the part a <meta> CSP can carry). */
export function authPageMetaCsp(env: CspEnv, page: AuthPageName): string {
  const connect = connectSources(env, page);
  return [...BASE_CSP, ...(connect.length > 0 ? [`connect-src ${connect.join(' ')}`] : [])].join('; ');
}

/**
 * The page's full CSP, as the Worker must send it: the meta policy plus `frame-ancestors 'none'` (no auth page may be
 * framed). The spec's table, kept here so the meta policy is tested against it.
 */
export const authPageCsp = (env: CspEnv, page: AuthPageName): string => `${authPageMetaCsp(env, page)}; frame-ancestors 'none'`;
