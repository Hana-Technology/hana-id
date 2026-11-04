// hana-id-console-<env> (docs/batch-c-spec.md "Topology"): the partner console's Worker. It runs first on every request
// (assets with `run_worker_first`), serves only its own origin (any other host: 404), sends `/api/*` to its backend and
// everything else to the SPA's assets, and sets the console's security headers on every response. Non-GET requests
// need the CSRF checks first, whatever the path.
//
// Batch C9: partner sign-in and the read-only console. The backend serves sign-in (`/api/auth/*`, with the auth origin's
// `/start` and `/callback` reaching `AuthHandler` through console-auth), `GET /api/me`, the read-only org views and the
// two session-less emailed-link confirms; the write routes come with C10. The admin Worker reaches the console's data
// through the `StaffRpc` entrypoint (service binding, no route). The hourly cron runs the invite, owner-grant and
// housekeeping jobs.
import { actionStatus, startStepUp } from './actions.ts';
import { authLimited, createLoginFlow } from './auth-flow.ts';
import { isOrgReadPath, me, memberships, orgRoute, sessionOf } from './bff.ts';
import { hourly } from './cron.ts';
import { SAFE_METHODS, csrfProblem } from './csrf.ts';
import type { Env } from './env.ts';
import { withSecurityHeaders } from './headers.ts';
import { errorResponse } from './http.ts';
import { type RequestInfo, cancelChangeLink, cancelOwnerGrantLink } from './links.ts';
import { log } from './log.ts';
import { requestInfo } from './request-info.ts';
import { type Session } from './sessions.ts';
import { completeSignIn, logout } from './sign-in.ts';
import { runOrgRoute, writeRoutesFor } from './writes.ts';
import { CONSOLE_LIMIT_PERIOD_S } from './limits.ts';

export { AuthHandler } from './auth-handler.ts';
export { StaffRpc } from './staff-rpc.ts';
export type { Env } from './env.ts';

type Handler = (r: Request, env: Env, info: RequestInfo) => Promise<Response>;
type SessionHandler = (r: Request, env: Env, info: RequestInfo, s: Session) => Promise<Response>;

/**
 * The session-less `/api/*` routes (method → handler): sign-in and the emailed links. The signed-in org routes are
 * bff.ts (C9's reads) and writes.ts (C10: step-ups, owner writes, scopes, logos, users); a path none of them names is
 * 404, a known path with another method 405.
 */
const API_ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  '/api/auth/start': { POST: createLoginFlow },
  '/api/auth/complete': { GET: completeSignIn },
  '/api/cancel': { POST: cancelChangeLink },
  '/api/owner-grants/cancel': { POST: cancelOwnerGrantLink },
};

/** The routes that need a session (401 `unauthenticated` without one). */
const SESSION_ROUTES: Record<string, Partial<Record<string, SessionHandler>>> = {
  '/api/auth/logout': { POST: logout },
  '/api/me': { GET: (_r, env, _i, s) => me(env, s, Date.now()) },
};

/** `/api/actions/:id` (GET: the outcome) and `/api/actions/:id/google` (POST: the fresh sign-in's start). */
const ACTION_ROUTE = /^\/api\/actions\/([^/]{1,64})(\/google)?$/u;

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const info = requestInfo(request);
  const plain = API_ROUTES[url.pathname];
  const withSession = SESSION_ROUTES[url.pathname];
  const action = ACTION_ROUTE.exec(url.pathname);
  const write = plain || withSession || isOrgReadPath(url.pathname) ? null : writeRoutesFor(url.pathname, env);
  const routes =
    plain ??
    withSession ??
    (isOrgReadPath(url.pathname) ? { GET: true } : undefined) ??
    (action ? (action[2] ? { POST: true } : { GET: true }) : undefined) ??
    (write ? Object.fromEntries(write.defs.map((d) => [d.method, true])) : undefined);
  if (!routes) return errorResponse('not_found');
  if (!Object.hasOwn(routes, request.method)) return errorResponse('method_not_allowed', undefined, { allow: Object.keys(routes).join(', ') });
  if (plain) return plain[request.method]!(request, env, info);
  // The fresh sign-in's start creates an auth flow, so it shares sign-in's per-IP flood limit (before the session read).
  if (action?.[2] && (await authLimited(env, info))) return errorResponse('rate_limited', undefined, { 'retry-after': String(CONSOLE_LIMIT_PERIOD_S) });
  const now = Date.now();
  const session = await sessionOf(env, request, now);
  if (!session) return errorResponse('unauthenticated', 'Sign in again');
  if (withSession) return withSession[request.method]!(request, env, info, session);
  if (action) return action[2] ? startStepUp(env, info, session, action[1]!) : actionStatus(env, session, action[1]!);
  if (write) {
    const [membership] = await memberships(env, session, now, write.orgId);
    if (!membership) return errorResponse('not_found');
    const def = write.defs.find((d) => d.method === request.method)!;
    return runOrgRoute(def, write.rest, request, env, info, { orgId: write.orgId, orgStatus: membership.status, role: membership.role, session });
  }
  return (await orgRoute(url, env, info, session, now)) ?? errorResponse('not_found');
}

async function route(request: Request, env: Env): Promise<{ res: Response; api: boolean }> {
  const url = new URL(request.url);
  const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
  // Host dispatch: this Worker answers for console.origin only.
  if (url.origin !== env.CONSOLE_ORIGIN) return { res: new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }), api: false };
  const problem = csrfProblem(request, env.CONSOLE_ORIGIN);
  if (problem) {
    log({ event: 'csrf_refused', requestId: requestInfo(request).requestId, code: problem });
    return { res: errorResponse('csrf'), api: true };
  }
  if (isApi) return { res: await api(request, env, url), api: true };
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
