// `AuthHandler` (docs/batch-c-spec.md "Topology"): the console's entrypoint for its auth origin. The thin console-auth
// Worker (apps/console-auth) serves `console.authOrigin` and forwards `GET /start` and `GET /callback` here unchanged
// over a service binding; nothing else binds it, and it has no route of its own. It answers only for the auth origin,
// only those two paths and only GET, with the auth origin's headers (no script, no assets, `no-store`), so sign-in's
// state lives in one Worker and one D1 while the redirect URI sits on an origin with no page an XSS could run on.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { authOriginHeaders, callback, startFlow, staticPage } from './auth-flow.ts';
import type { Env } from './env.ts';
import { log } from './log.ts';
import { requestInfo } from './request-info.ts';

/** The response with the auth origin's headers set (replacing any it had). */
function withAuthHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(authOriginHeaders())) out.headers.set(k, v);
  return out;
}

export async function handleAuthOrigin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== env.CONSOLE_AUTH_ORIGIN || request.method !== 'GET' || (url.pathname !== '/start' && url.pathname !== '/callback')) {
    return withAuthHeaders(new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
  }
  const info = requestInfo(request);
  try {
    return withAuthHeaders(url.pathname === '/start' ? await startFlow(request, env, info) : await callback(request, env, info));
  } catch (err) {
    log({ event: 'auth_origin_error', requestId: info.requestId, outcome: 'error', error: err instanceof Error ? err.name : 'unknown' }, 'error');
    return staticPage(env.CONSOLE_ORIGIN, 503);
  }
}

export class AuthHandler extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return handleAuthOrigin(request, this.env);
  }
}
