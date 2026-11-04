// Partner origins as the vault sees them: which parent may use an app's vault (x-hana-parent-origin, share origins)
// and which origins may frame the vault page (frame-ancestors, inlined `origins`). The rules are origins.ts's (exact
// match; loopback origins and the `http://localhost:*` wildcard only for test-scope apps in `local*`/`sandbox*` envs).
import type { App } from '../apps.ts';
import { LOCALHOST_WILDCARD, isDevEnv, isLoopbackOrigin, isTestApp, originAllowed } from '../origins.ts';

/**
 * What may appear in a CSP source list and the inlined config: a bare lowercase http(s) origin, or the localhost
 * wildcard. Anything else in D1 (whitespace, `;`, `,`, quotes, paths) is dropped rather than injected into a header.
 */
const SAFE_ORIGIN_RE = /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:\d{1,5})?$/u;

/** At most this many origins per app are served (frame-ancestors and the inlined config). */
export const MAX_APP_ORIGINS = 20;

/** A parent (or share) origin the app allows in this env. */
export function parentOriginAllowed(envName: string, app: Pick<App, 'environment' | 'origins'>, origin: string | null): boolean {
  return originAllowed(app, origin, isDevEnv(envName));
}

/**
 * The app's origins that may embed its vault in this env, sorted (stable headers): loopback ones (the localhost
 * wildcard included) only for test-scope apps in dev envs, malformed ones never.
 */
export function servedOrigins(envName: string, app: Pick<App, 'environment' | 'origins'>): string[] {
  const loopbackOk = isTestApp(app) && isDevEnv(envName);
  const loopback = (o: string) => o === LOCALHOST_WILDCARD || isLoopbackOrigin(o);
  return [...new Set(app.origins)].filter((o) => (o === LOCALHOST_WILDCARD || SAFE_ORIGIN_RE.test(o)) && (loopbackOk || !loopback(o))).sort();
}
