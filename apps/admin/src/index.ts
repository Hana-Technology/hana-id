// hana-id-admin-<env> (docs/batch-c-spec.md "Topology", "Hana admin console"): the Hana staff console's Worker. It runs
// first on every request (assets with `run_worker_first`), serves only its own origin (any other host: 404), and sets
// the admin headers on every response. Every `/api/*` request needs a valid Cloudflare Access JWT of a listed staff
// member (access.ts), then the CSRF checks for a non-GET, then goes to the staff BFF (routes.ts) with that person as
// the RPC actor. Everything else is the SPA (public/). The 5-minute cron sends the blocking notices, the security feed
// and the on-chain watcher's emails (cron.ts). Nothing calls into this Worker: it has no entrypoint.
import { checkStaff } from './access.ts';
import { everyFiveMinutes } from './cron.ts';
import { SAFE_METHODS, csrfProblem } from './csrf.ts';
import type { Env } from './env.ts';
import { withSecurityHeaders } from './headers.ts';
import { errorResponse } from './http.ts';
import { errorName, log } from './log.ts';
import { handleApi } from './routes.ts';

export type { Env } from './env.ts';

const RAY_RE = /^[A-Za-z0-9_-]{8,128}$/u;

export function requestIdOf(request: Request): string {
  const ray = request.headers.get('cf-ray');
  return ray && RAY_RE.test(ray) ? ray : `req_${crypto.randomUUID().replaceAll('-', '')}`;
}

function clientIpOf(request: Request): string {
  const ip = (request.headers.get('cf-connecting-ip') ?? '').trim();
  return ip && ip.length <= 64 ? ip : 'unknown';
}

const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });

async function route(request: Request, env: Env): Promise<{ res: Response; api: boolean }> {
  const url = new URL(request.url);
  // Host dispatch: this Worker answers for admin.origin only.
  if (url.origin !== env.ADMIN_ORIGIN) return { res: notFound(), api: false };
  const api = url.pathname === '/api' || url.pathname.startsWith('/api/');
  const requestId = requestIdOf(request);
  if (api) {
    const staff = await checkStaff(request, env, requestId);
    if (!staff.ok) return { res: errorResponse(staff.code), api };
    const problem = csrfProblem(request, env.ADMIN_ORIGIN);
    if (problem) {
      log({ event: 'csrf_refused', requestId, code: problem });
      return { res: errorResponse('csrf'), api };
    }
    return { res: await handleApi(request, env, { actor: staff.actor, requestId, clientIp: clientIpOf(request) }), api };
  }
  const problem = csrfProblem(request, env.ADMIN_ORIGIN);
  if (problem) {
    log({ event: 'csrf_refused', requestId, code: problem });
    return { res: errorResponse('csrf'), api: true };
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
      log({ event: 'admin_error', outcome: 'error', error: errorName(err) }, 'error');
      out = { res: errorResponse('internal'), api: true };
    }
    return withSecurityHeaders(out.res, env.FILES_ORIGIN, { api: out.api });
  },

  // Every 5 minutes (scripts/gen-wrangler.ts CRON): blocking notices, the feed, the watcher.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    void controller;
    await everyFiveMinutes(env);
  },
} satisfies ExportedHandler<Env>;
