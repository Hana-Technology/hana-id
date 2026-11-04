// hana-id-console-<env> (docs/batch-c-spec.md "Topology"): the partner console's Worker. It runs first on every request
// (assets with `run_worker_first`), serves only its own origin (any other host: 404), sends `/api/*` to its backend and
// everything else to the SPA's assets, and sets the console's security headers on every response. Non-GET requests
// need the CSRF checks first, whatever the path.
//
// Batch C7: no public route (`workers_dev: false`, no route until C9) and no sign-in yet. Its backend serves only the
// two session-less emailed-link confirms; every other `/api/*` path is 404 until C9/C10 add the session routes. The
// admin Worker reaches its data through the `StaffRpc` entrypoint (service binding, no route). The hourly cron runs the
// invite, owner-grant and housekeeping jobs.
import { hourly } from './cron.ts';
import { SAFE_METHODS, csrfProblem } from './csrf.ts';
import type { Env } from './env.ts';
import { withSecurityHeaders } from './headers.ts';
import { errorResponse } from './http.ts';
import { type RequestInfo, cancelChangeLink, cancelOwnerGrantLink } from './links.ts';
import { log } from './log.ts';

export { StaffRpc } from './staff-rpc.ts';
export type { Env } from './env.ts';

const RAY_RE = /^[A-Za-z0-9_-]{8,128}$/u;

function requestInfo(request: Request): RequestInfo {
  const ray = request.headers.get('cf-ray');
  const requestId = ray && RAY_RE.test(ray) ? ray : `req_${crypto.randomUUID().replaceAll('-', '')}`;
  const ip = (request.headers.get('cf-connecting-ip') ?? '').trim();
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  return { requestId, clientIp: ip && ip.length <= 64 ? ip : 'unknown', country: typeof cf?.country === 'string' ? cf.country : null };
}

/**
 * The session-less `/api/*` routes (method → handler). Sign-in and the session routes come with C9 and C10; among them
 * C10 routes `POST /api/orgs/:org/apps/:app/logo` to `logoUploadRoute` (logo.ts, batch C11) once it has checked the
 * session, the membership and the owner role (CSRF already takes that path's raw body, csrf.ts).
 */
const API_ROUTES: Record<string, Partial<Record<string, (r: Request, env: Env, info: RequestInfo) => Promise<Response>>>> = {
  '/api/cancel': { POST: cancelChangeLink },
  '/api/owner-grants/cancel': { POST: cancelOwnerGrantLink },
};

async function route(request: Request, env: Env): Promise<{ res: Response; api: boolean }> {
  const url = new URL(request.url);
  const api = url.pathname === '/api' || url.pathname.startsWith('/api/');
  // Host dispatch: this Worker answers for console.origin only.
  if (url.origin !== env.CONSOLE_ORIGIN) return { res: new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }), api: false };
  const info = requestInfo(request);
  const problem = csrfProblem(request, env.CONSOLE_ORIGIN);
  if (problem) {
    log({ event: 'csrf_refused', requestId: info.requestId, code: problem });
    return { res: errorResponse('csrf'), api: true };
  }
  if (api) {
    const routes = API_ROUTES[url.pathname];
    if (!routes) return { res: errorResponse('not_found'), api };
    const handler = routes[request.method];
    if (!handler) return { res: errorResponse('method_not_allowed', undefined, { allow: Object.keys(routes).join(', ') }), api };
    return { res: await handler(request, env, info), api };
  }
  // The SPA: GET and HEAD only (the assets binding serves index.html for any unknown path).
  if (!SAFE_METHODS.has(request.method)) return { res: errorResponse('method_not_allowed', undefined, { allow: 'GET, HEAD' }), api: true };
  return { res: await env.ASSETS.fetch(request), api: false };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let out: { res: Response; api: boolean };
    try {
      out = await route(request, env);
    } catch (err) {
      log({ event: 'console_error', outcome: 'error', error: err instanceof Error ? err.name : 'unknown' }, 'error');
      out = { res: errorResponse('internal'), api: true };
    }
    return withSecurityHeaders(out.res, env.FILES_ORIGIN, { api: out.api });
  },

  /** Hourly (`0 * * * *`): invite expiry, matured owner grants, housekeeping purges, replaced logos. */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    void controller;
    await hourly(env, Date.now());
  },
} satisfies ExportedHandler<Env>;
