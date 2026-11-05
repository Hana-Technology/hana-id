// hana-id-console-auth-<env> (docs/batch-c-spec.md "Topology", "Google client setup"; D66, D75): the thin Worker of
// `console.authOrigin`, the console Google client's only redirect URI host. It holds no secret, no D1 and no state: it
// forwards `GET /start` and `GET /callback` unchanged to the console Worker's `AuthHandler` entrypoint (service
// binding `CONSOLE`) and serves nothing else, so the origin a Google redirect lands on has no script, no asset and no
// page an XSS on the console could reach. Every response carries the auth origin's headers, set here again over
// whatever the console answered (defence in depth): a CSP that allows nothing, `no-store` and `no-referrer`.
// One more path, answered here without the console: `GET`/`HEAD /.well-known/hana-build`, the build id this Worker
// was deployed with (`{"build": <id> | null}`, the HANA_BUILD var the shared deploy wrapper sets; D384, D406), for
// `deploy-check`. It is JSON under the same headers, so it runs nothing either.
import { BUILD_PATH, buildBody } from '@hana-id/env/build-id';

export interface Env {
  /** `console.authOrigin`: the only host this Worker answers for. */
  AUTH_ORIGIN: string;
  /** The console Worker's `AuthHandler` entrypoint. */
  CONSOLE: Fetcher;
  /** The build id (D406): set only by `run deploy` (`wrangler deploy --var HANA_BUILD:<id>`), never by `gen`. */
  HANA_BUILD?: string;
}

/** The auth origin's CSP (the console's auth-flow.ts AUTH_ORIGIN_CSP; a test compares them). */
export const AUTH_ORIGIN_CSP = "default-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";

export const AUTH_ORIGIN_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': AUTH_ORIGIN_CSP,
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'cross-origin-opener-policy': 'same-origin',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
};

/** The two paths it forwards (GET only); BUILD_PATH is answered here (GET and HEAD). */
export const FORWARDED_PATHS: readonly string[] = ['/start', '/callback'];

function withHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(AUTH_ORIGIN_HEADERS)) out.headers.set(k, v);
  return out;
}

const notFound = (): Response => withHeaders(new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin === env.AUTH_ORIGIN && url.pathname === BUILD_PATH && (request.method === 'GET' || request.method === 'HEAD')) {
      return withHeaders(new Response(request.method === 'HEAD' ? null : buildBody(env.HANA_BUILD), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }));
    }
    if (url.origin !== env.AUTH_ORIGIN || request.method !== 'GET' || !FORWARDED_PATHS.includes(url.pathname)) return notFound();
    try {
      return withHeaders(await env.CONSOLE.fetch(request));
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', event: 'console_auth_forward_failed', error: err instanceof Error ? err.name : 'unknown' }));
      return withHeaders(new Response('Sign-in is unavailable right now. Try again in a few minutes.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
    }
  },
} satisfies ExportedHandler<Env>;
