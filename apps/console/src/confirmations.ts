// D931 (piece P10 of docs/partner-platform-spec.md, A11, A15; D914, D917): the partner console's side of a second
// person's confirmation of web addresses.
//
// - `GET /api/confirmations/:changeId/org` (a session): which of the member's organisations the change is in (the
//   email's Confirm link opens `/confirm/:changeId`, a console page that needs the org first). Reads only.
// - `GET /api/orgs/:org/confirmations/:changeId` (any member): the confirmation page's view (the app, who asked and when,
//   every web address of that request with its state, the other apps of a shared wallet) and whether this member may
//   confirm now, with the reason when not. A GET never confirms: the confirmation is the step-up of kind
//   `origin.confirm` (actions.ts), whose callback runs `ConsoleRpc.confirmOrigins`, which checks everything again.
// - `POST /api/remove/preview {changeId, token}` and `POST /api/remove {changeId, token}` (no session: the confirmation
//   notice's removal link; the `link` actor), under the CSRF rules and the per-IP link limit like `/api/cancel`.
//
// Who may confirm (D914, A15): an `owner` of an active org (the role read fresh on each request, and again in the
// step-up's callback) who is an on-chain owner of the app's scope (read here, uncached, to hide Confirm from an owner
// who isn't, as `buildOwnerAction` does; the API's own check at the commit is the one that counts).
import { type Actor, type ConfirmationView, CONFIRM_WORDS, originConfirmDigest, removeOriginByLinkInput } from '@hana-id/console-core';
import { z } from '@hana-id/env/zod';
import { type OrgCaller, actorOf } from './actions.ts';
import { type Writer, auditInsert, entry } from './audit.ts';
import { memberships } from './bff.ts';
import type { Env } from './env.ts';
import { errorResponse, json, readJson } from './http.ts';
import { ipPrefix, ipSubject } from './ip.ts';
import { CONSOLE_LIMIT_PERIOD_S, consoleIpKey } from './limits.ts';
import type { RequestInfo } from './links.ts';
import { log } from './log.ts';
import { NearUnavailable, oidcOwners, viewScope } from './near.ts';
import { peopleOf } from './platform-keys.ts';
import type { Session } from './sessions.ts';

export const CHANGE_ID = 'gc_[A-Za-z0-9]{1,64}';

/** Why this member can't confirm now (shown on the page), or allowed. */
export type ConfirmAbility = { allowed: true } | { allowed: false; reason: string; code: 'forbidden' | 'not_owner' | 'not_pending' | 'near_unavailable' };

const ctxOf = (c: OrgCaller, info: RequestInfo) => ({ actor: actorOf(c.session) as Actor, requestId: info.requestId, clientIp: info.clientIp });

/**
 * Whether this member may confirm the view's waiting web addresses now: an owner of an active org, something left to
 * confirm, and an on-chain owner of the app's scope (read uncached). The API checks every one again at the commit.
 */
export async function confirmAbility(env: Env, c: OrgCaller, view: ConfirmationView): Promise<ConfirmAbility> {
  if (c.role !== 'owner') return { allowed: false, code: 'forbidden', reason: 'Only an owner of your organisation can confirm.' };
  if (c.orgStatus !== 'active') return { allowed: false, code: 'forbidden', reason: 'Journear has frozen your organisation, so web addresses can’t be confirmed.' };
  if (view.sameAsProposer) return { allowed: false, code: 'forbidden', reason: CONFIRM_WORDS.sameAsProposer };
  if (!view.changes.some((ch) => ch.confirmable)) {
    const quiet = view.changes.some((ch) => ch.state === 'waiting_announcement');
    return { allowed: false, code: 'not_pending', reason: quiet ? CONFIRM_WORDS.notAnnounced : 'Nothing here is waiting to be confirmed.' };
  }
  let scope;
  try {
    scope = await viewScope(env, view.app.scopeId);
  } catch (err) {
    if (err instanceof NearUnavailable) return { allowed: false, code: 'near_unavailable', reason: 'We couldn’t check the wallet settings’ owners just now. Try again in a minute.' };
    throw err;
  }
  if (!scope || !oidcOwners(scope).some((o) => o.provider === 'google' && o.sub === c.session.sub)) return { allowed: false, code: 'not_owner', reason: CONFIRM_WORDS.onlyOwner };
  return { allowed: true };
}

/** `GET /api/orgs/:org/confirmations/:changeId`: the view, the people it names, this member's ability. Reads only. */
export async function confirmationRoute(env: Env, info: RequestInfo, c: OrgCaller, changeId: string): Promise<Response> {
  const r = await env.API.getConfirmation({ ...ctxOf(c, info), orgId: c.orgId, changeId });
  if (!r.ok) return errorResponse(r.code, r.error);
  const ability = await confirmAbility(env, c, r.confirmation);
  return json(200, { confirmation: r.confirmation, ability, role: c.role, now: Date.now() });
}

/** `GET /api/confirmations/:changeId/org`: which of the member's organisations the change is in (at most 10 looked through). */
export async function findConfirmationOrgRoute(env: Env, info: RequestInfo, s: Session, changeId: string): Promise<Response> {
  if (!new RegExp(`^${CHANGE_ID}$`, 'u').test(changeId)) return errorResponse('not_found');
  const orgs = (await memberships(env, s, Date.now())).slice(0, 10);
  for (const m of orgs) {
    const r = await env.API.getConfirmation({ actor: actorOf(s), requestId: info.requestId, clientIp: info.clientIp, orgId: m.orgId, changeId });
    if (r.ok) return json(200, { orgId: m.orgId, appId: r.confirmation.app.id });
  }
  return errorResponse('not_found');
}

/**
 * The step-up's action for `origin.confirm` (actions.ts `build`): from the API's view of the first change, exactly the
 * listed changes of that one request on that app, each confirmable, by a member who may confirm. Throws `{code, message}`.
 */
export async function buildConfirmation(env: Env, c: OrgCaller, ctx: { actor: Actor; requestId: string; clientIp: string }, p: { appId: string; changeIds: string[] }, no: (code: string, message: string) => never) {
  if (new Set(p.changeIds).size !== p.changeIds.length) no('bad_request', 'A web address is listed twice');
  const r = await env.API.getConfirmation({ ...ctx, orgId: c.orgId, changeId: p.changeIds[0]! });
  if (!r.ok) return no(r.code, r.error ?? r.code);
  const v = r.confirmation;
  if (v.app.id !== p.appId) no('not_found', 'No such web address waiting on this app');
  const byId = new Map(v.changes.map((x) => [x.changeId, x]));
  for (const id of p.changeIds) {
    const ch = byId.get(id) ?? no('bad_request', 'Confirm the web addresses of one request at a time');
    if (!ch.confirmable) no('not_pending', ch.state === 'waiting_announcement' ? CONFIRM_WORDS.notAnnounced : `${ch.display} isn’t waiting to be confirmed`);
  }
  const ability = await confirmAbility(env, c, v);
  if (!ability.allowed) no(ability.code, ability.reason);
  const ids = [...p.changeIds].sort();
  const changes = ids.map((id) => ({ changeId: id, origin: byId.get(id)!.origin }));
  const digest = await originConfirmDigest({ signer: env.SIGNER_ACCOUNT, env: env.ENV_NAME, orgId: c.orgId, appId: v.app.id, scopeId: v.app.scopeId, changes });
  // D934: the API marks a web address the app may use only inside its other web addresses; the review says so.
  const shown = ids.map((id) => {
    const ch = byId.get(id)!;
    return { changeId: id, origin: ch.origin, display: ch.display, idn: ch.idn, activeFrom: ch.activeFrom, ...(ch.frameOnly ? { frameOnly: true } : {}) };
  });
  return {
    action: { app_id: v.app.id, scope_id: v.app.scopeId, change_ids: ids, origins: changes.map((x) => x.origin), request_id: v.requestId },
    decoded: { appId: v.app.id, appName: v.app.name, scopeId: v.app.scopeId, proposedByKind: v.proposedByKind, ...(v.keyLabel !== undefined ? { keyLabel: v.keyLabel } : {}), changes: shown },
    digest,
  };
}

/** Failures worth an audit row: a refusal of a valid link (too late, already used); wrong tokens are only logged (D244). */
const AUDITED_FAILURES: ReadonlySet<string> = new Set(['not_pending', 'already_applied', 'conflict', 'internal']);

/** `POST /api/remove/preview` and `POST /api/remove` `{changeId, token}`: the confirmation notice's removal link. */
export function removeLinkRoute(what: 'preview' | 'remove') {
  return async (request: Request, env: Env, info: RequestInfo): Promise<Response> => {
    const { success } = await env.CONSOLE_IP_LIMIT.limit({ key: consoleIpKey(env.ENV_NAME, 'link', ipSubject(info.clientIp)) });
    if (!success) return errorResponse('rate_limited', undefined, { 'retry-after': String(CONSOLE_LIMIT_PERIOD_S) });
    const body = await readJson(request);
    if (!body.ok) return errorResponse(body.code);
    const parsed = z.object({ changeId: z.string(), token: z.string() }).strict().safeParse(body.value);
    if (!parsed.success) return errorResponse('bad_request', 'Expected {changeId, token}');
    const input = { actor: { kind: 'link' as const, id: parsed.data.changeId }, requestId: info.requestId, clientIp: info.clientIp, changeId: parsed.data.changeId, token: parsed.data.token };
    if (!removeOriginByLinkInput.safeParse(input).success) return errorResponse('bad_request', 'Expected {changeId, token}');
    if (what === 'preview') {
      let r: Awaited<ReturnType<Env['API']['removalPreview']>>;
      try {
        r = await env.API.removalPreview(input);
      } catch (err) {
        log({ event: 'link_remove', method: 'removalPreview', requestId: info.requestId, outcome: 'error', code: 'internal', error: err instanceof Error ? err.name : 'unknown' }, 'error');
        return errorResponse('internal');
      }
      if (!r.ok) return errorResponse(r.code, r.error);
      // The confirmer by their address only while they are a member of the org; staff are "Journear staff".
      const { orgId, confirmedBy, ...rest } = r.removal;
      const people = r.removal.confirmedByKind === 'member' ? await peopleOf(env, orgId, [confirmedBy]) : {};
      return json(200, { ...rest, confirmedBy: r.removal.confirmedByKind === 'member' ? (people[confirmedBy] ?? null) : 'Journear staff' });
    }
    let r: Awaited<ReturnType<Env['API']['removeOriginByLink']>>;
    try {
      r = await env.API.removeOriginByLink(input);
    } catch (err) {
      log({ event: 'link_remove', method: 'removeOriginByLink', requestId: info.requestId, outcome: 'error', code: 'internal', error: err instanceof Error ? err.name : 'unknown' }, 'error');
      return errorResponse('internal');
    }
    const code = r.ok ? null : r.code;
    log({ event: 'link_remove', method: 'removeOriginByLink', requestId: info.requestId, outcome: r.ok ? 'ok' : 'rejected', ...(code ? { code } : {}) });
    if (r.ok || AUDITED_FAILURES.has(code!)) {
      const w: Writer = { actor: { kind: 'link', id: input.changeId }, requestId: info.requestId, now: Date.now(), ipPrefix: ipPrefix(info.clientIp), country: info.country };
      try {
        await auditInsert(env.CONSOLE_DB, entry(w, 'origin.link_remove', { target: input.changeId, outcome: r.ok ? 'ok' : 'failed', details: { changeId: input.changeId, ...(code ? { code } : {}) } })).run();
      } catch (err) {
        log({ event: 'audit_write_failed', requestId: info.requestId, error: err instanceof Error ? err.name : 'unknown' }, 'warn');
      }
    }
    return r.ok ? json(200, r.removed) : errorResponse(r.code, r.error);
  };
}
