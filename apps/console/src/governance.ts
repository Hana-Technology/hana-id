// The partner console's pending-upgrades page (D86; docs/governance-spec.md "Alerts": public notice of an upgrade, owner
// change or withdrawal): `GET /api/orgs/:org/governance/pending-upgrades` (D335). The backend only, batch C14: the route
// needs a session, which C9's session routes resolve before C10 wires this in (no route reaches it until then;
// index.ts), as `logoUploadRoute` waits for its own.
//
// What it answers is `ConsoleRpc.pendingUpgrades`: pending upgrades (code hash, the published release's source commit,
// reproducible-build command and diff, or "not a published release"), owner transfers, withdrawals, delay decreases
// and console-audience additions, each with the time it can take effect. All of it is contract-wide and public on chain,
// and none of it is any org's: no access key, watchdog or cron state (console-core governance.ts). It is still scoped to
// the org in the path: the member must belong to it (checked here again, behind the session route's own membership
// check), and the API charges the call to that org's budget and refuses the legacy org.
import { type Actor, type PendingUpgradesView, orgIdInput } from '@hana-id/console-core';
import type { Env } from './env.ts';
import { type ErrorCode, errorResponse, json } from './http.ts';
import type { RequestInfo } from './links.ts';
import { log } from './log.ts';

export type MemberActor = Extract<Actor, { kind: 'member' }>;

/** The member's current, enabled membership of the org (any role: the page is read-only), or false. */
async function isMember(env: Env, orgId: string, userId: string): Promise<boolean> {
  const row = await env.CONSOLE_DB.prepare('SELECT 1 AS ok FROM members m JOIN orgs o ON o.id = m.org_id JOIN console_users u ON u.id = m.user_id WHERE m.org_id = ? AND m.user_id = ? AND u.disabled_at IS NULL')
    .bind(orgId, userId)
    .first<{ ok: number }>();
  return row !== null;
}

/**
 * `GET /api/orgs/:org/governance/pending-upgrades` for a signed-in member (C10 calls it after the session check). An
 * org the member doesn't belong to, or that doesn't exist, is 404, as the other org routes answer.
 */
export async function pendingUpgradesRoute(env: Env, info: RequestInfo, actor: MemberActor, orgId: string): Promise<Response> {
  if (!orgIdInput.safeParse(orgId).success || actor.kind !== 'member') return errorResponse('not_found');
  if (!(await isMember(env, orgId, actor.id))) {
    log({ event: 'console_rpc', method: 'pendingUpgrades', requestId: info.requestId, orgId, outcome: 'rejected', code: 'not_member' });
    return errorResponse('not_found');
  }
  let r: Awaited<ReturnType<Env['API']['pendingUpgrades']>>;
  try {
    r = await env.API.pendingUpgrades({ actor, requestId: info.requestId, clientIp: info.clientIp, orgId });
  } catch {
    log({ event: 'console_rpc', method: 'pendingUpgrades', requestId: info.requestId, orgId, outcome: 'error', code: 'upstream_unavailable' }, 'error');
    return errorResponse('near_unavailable', 'The governance state could not be read; try again shortly');
  }
  if (!r.ok) {
    log({ event: 'console_rpc', method: 'pendingUpgrades', requestId: info.requestId, orgId, outcome: 'rejected', code: r.code });
    // Our own message, never the API's text.
    return errorResponse(r.code as ErrorCode);
  }
  log({ event: 'console_rpc', method: 'pendingUpgrades', requestId: info.requestId, orgId, outcome: 'ok' });
  const body: { pendingUpgrades: PendingUpgradesView } = { pendingUpgrades: r.pendingUpgrades };
  return json(200, body);
}
