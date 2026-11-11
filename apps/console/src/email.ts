// An app's Email login page (`GET /api/orgs/:org/apps/:app/email`, any member; build plan batch 9, D444, D447): whether
// email is on for the app (`apps.login_methods`), the scope's email client on chain (`("email", "email:<scope>")`: there,
// or proposed and waiting out its timelock), who may act (an on-chain owner proposes and removes the client) and the
// app's own mail deliverability, per day. The issuer answers the counts for this one app id, and only after the API's
// `getApp` confirmed the app belongs to this org (the partner console's only check on the issuer path, D447): the
// answer is counts, never an address.
import { type Actor, type AppEmailAnswer, type DeliverabilityDay, EMAIL_STATS_DAYS_DEFAULT, emailClientAudOf } from '@hana-id/console-core';
import type { Env } from './env.ts';
import { errorResponse, json } from './http.ts';
import { log } from './log.ts';
import { NearUnavailable, type ScopeView, oidcOwners, viewScope } from './near.ts';

interface RpcCtx {
  actor: Actor;
  requestId: string;
  clientIp: string;
}

const pendingOf = (s: ScopeView, scopeId: string, now: number): { changeId: number; unlockAt: number; executable: boolean } | null => {
  const aud = emailClientAudOf(scopeId);
  const p = s.pending.find((x) => {
    const add = (x.change as { AddClient?: { provider?: unknown; aud?: unknown } }).AddClient;
    return add?.provider === 'email' && add.aud === aud;
  });
  return p ? { changeId: p.id, unlockAt: p.unlock_at_ms, executable: p.unlock_at_ms <= now } : null;
};

export async function appEmailRoute(env: Env, ctx: RpcCtx, orgId: string, appId: string, mySub: string, now: number = Date.now()): Promise<Response> {
  const r = await env.API.getApp({ ...ctx, orgId, appId });
  if (!r.ok) return errorResponse(r.code, r.code === 'not_found' ? 'No such app in this organisation' : r.error);
  if (r.app.deleted) return errorResponse('not_found', 'The app was deleted');
  const app = r.app;
  const available = env.ISSUER !== undefined;
  const emailOn = app.settings.loginMethods === 'google,email' || app.settings.loginMethods === 'email';

  let scope: AppEmailAnswer['scope'] = { unavailable: true };
  try {
    const s = await viewScope(env, app.scopeId);
    if (s) {
      const aud = emailClientAudOf(app.scopeId);
      scope = { clientOnChain: s.clients.some(([p, a]) => p === 'email' && a === aud), pending: pendingOf(s, app.scopeId, now), youAreOnChainOwner: oidcOwners(s).some((o) => o.provider === 'google' && o.sub === mySub) };
    }
  } catch (err) {
    if (!(err instanceof NearUnavailable)) throw err;
    log({ event: 'console_rpc', method: 'viewScope', requestId: ctx.requestId, orgId, outcome: 'error', code: 'near_unavailable' }, 'warn');
  }

  let otherAppsEmailOn = 0;
  const siblings = await env.API.listApps({ ...ctx, orgId });
  if (siblings.ok) otherAppsEmailOn = siblings.apps.filter((a) => a.scopeId === app.scopeId && a.id !== app.id && !a.deleted && a.emailOn === true).length;

  let deliverability: AppEmailAnswer['deliverability'] = { unavailable: true };
  if (env.ISSUER) {
    try {
      const d = await env.ISSUER.deliverability({ requestId: ctx.requestId, appId: app.id, days: EMAIL_STATS_DAYS_DEFAULT });
      if (d.ok) deliverability = { days: d.days };
    } catch {
      log({ event: 'console_rpc', method: 'deliverability', requestId: ctx.requestId, orgId, outcome: 'error', code: 'issuer_unavailable' }, 'warn');
    }
  }
  const body: AppEmailAnswer = { emailOn, scopeId: app.scopeId, scope, otherAppsEmailOn, available, deliverability, now };
  return json(200, body);
}

export type { DeliverabilityDay };
