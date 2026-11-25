// D931 (piece P10 of docs/partner-platform-spec.md, A15; D914, D917): a second person's confirmation of web addresses
// that would otherwise wait at least 24 h after their email.
//
// - ConsoleRpc.confirmOrigins: a console `owner` (the console checks the role, fresh, in the step-up's callback) who is
//   an on-chain owner of the app's scope (checked here, uncached, just before the batch: `confirmStepUp`) confirms, with
//   a fresh Google sign-in whose nonce is the `origin.confirm` layout over exactly these changes
//   (console-core `originConfirmDigest`), a set of 1 to 20 web addresses of one app and one proposing request that
//   the platform asked for, or that staff added to a platform-created app or a shared wallet (four eyes). A member actor
//   only: the platform, staff, the system and a link never confirm this way.
// - AdminRpc.confirmStaffOrigins: a second staff member (another Access subject and another email than the proposer's,
//   with a reason) confirms a staff set under four eyes; never a platform proposal.
// - The confirmation's notice (AdminRpc.confirmationNotices → the admin Worker's email to the alias, every security
//   contact and every owner → ackConfirmationNotice, `system` only), with one removal link per web address, valid 7
//   days (ConsoleRpc.removalPreview and removeOriginByLink, the `link` actor; a GET of the page removes nothing).
// - ConsoleRpc.getConfirmation: the page the email's Confirm link opens (reads only).
//
// Every rule is in the commit predicate as well as in the plan read (a cancel, a key revocation, a switch-off, a freeze,
// a staff suspension or a deletion landing in between makes the confirmation write nothing), and the database holds it
// again (migration 0034: `origin_confirmations`' insert trigger, and the earliest-time triggers that let `active_from`
// move earlier only to a recorded confirmation's time). Anything the caller can't see (another org's change, another
// app's, one that doesn't exist) answers one identical `not_found`.
import {
  type ConfirmationChange,
  type ConfirmationNotice,
  type ConfirmationView,
  type ConfirmProposer,
  CONFIRM_OTHER_APPS_SHOWN,
  ORIGIN_CONFIRM_LIMITS,
  ORIGIN_REMOVAL_LINK_MS,
  bytesEqual,
  fromB64url,
  hex,
  nonceOf,
  originConfirmDigest,
  originDisplay,
  personEmailKey,
  sha256,
} from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { placedStub } from '../placement.ts';
import { KEY_IN_FORCE } from '../platform/keys.ts';
import { type Writer, actorId, closeChanges, commitOnApp, committed, expectReplay, refuse, refuseReplay, replayRow, runWrite, RpcRefusal } from './cas.ts';
import type { HotDb } from './db.ts';
import { type Q, q, raw } from './sql.ts';
import { confirmStepUp, releaseStepUp, verifyStepUpToken } from './step-up.ts';

/** What every change the caller can't see answers, word for word (another org's, another app's, none at all). */
export const NOT_VISIBLE = 'No such web address waiting on this app';

/** One listed change as the plan read sees it (`found` 0: not on this app, or no such change). */
interface PlanChange {
  id: string;
  found: number;
  kind: string | null;
  origin: string | null;
  status: string | null;
  proposed_by_kind: string | null;
  proposed_by: string | null;
  notified_at: number | null;
  active_from: number | null;
  waiver: string | null;
  expedited_by: string | null;
  request_id: string | null;
  platform_wait: number | null;
  has_platform_wait: number;
  staff_wait: number | null;
  has_staff_wait: number;
  staff_by: string | null;
  staff_email_key: string | null;
  confirmed: number;
  key_in_force: number;
}

interface ConfirmPlan {
  replay: string | null;
  app_id: string | null;
  org_id: string | null;
  scope_id: string | null;
  deleted_at: number | null;
  suspended_by: number;
  created_by_kind: string | null;
  environment: string | null;
  frozen: number;
  enabled: number;
  changes: string;
}

/**
 * The plan read: the app (in the caller's org), the org's freeze and switch, and each listed change on that app with
 * its waits, whether it is confirmed, and (a platform proposal) whether its key is in force with the app in its reach.
 */
async function planConfirm(db: HotDb, w: Writer, i: { orgId: string; appId: string; changeIds: readonly string[] }): Promise<{ plan: ConfirmPlan; changes: PlanChange[] }> {
  const ids = JSON.stringify(i.changeIds);
  const r = await db.first<ConfirmPlan>(
    q`SELECT ${replayRow(w.requestId)} AS replay, a.id AS app_id, a.org_id, a.scope_id, a.deleted_at, COALESCE(a.suspended_by, 0) AS suspended_by, a.created_by_kind, s.environment,
             COALESCE((SELECT po.frozen FROM platform_orgs po WHERE po.org_id = a.org_id), 0) AS frozen,
             COALESCE((SELECT po.enabled FROM platform_orgs po WHERE po.org_id = a.org_id), 0) AS enabled,
             (SELECT json_group_array(json_object(
                 'id', ids.value, 'found', g.id IS NOT NULL, 'kind', g.kind, 'origin', g.origin, 'status', g.status, 'proposed_by_kind', g.proposed_by_kind,
                 'proposed_by', g.proposed_by, 'notified_at', g.notified_at, 'active_from', g.active_from, 'waiver', g.waiver, 'expedited_by', g.expedited_by,
                 'request_id', g.request_id, 'platform_wait', pw.unconfirmed_active_from, 'has_platform_wait', pw.change_id IS NOT NULL,
                 'staff_wait', sw.unconfirmed_active_from, 'has_staff_wait', sw.change_id IS NOT NULL, 'staff_by', sw.proposed_by, 'staff_email_key', sw.proposer_email_key,
                 'confirmed', oc.change_id IS NOT NULL,
                 'key_in_force', EXISTS (SELECT 1 FROM platform_keys k WHERE k.id = g.proposed_by AND k.org_id = a.org_id AND ${KEY_IN_FORCE('k', w.now)}
                                           AND EXISTS (SELECT 1 FROM json_each(k.scopes_json) ks WHERE ks.value = a.scope_id))))
                FROM json_each(${ids}) ids
                LEFT JOIN guarded_changes g ON g.id = ids.value AND g.app_id = a.id
                LEFT JOIN platform_origin_waits pw ON pw.change_id = g.id
                LEFT JOIN staff_origin_waits sw ON sw.change_id = g.id
                LEFT JOIN origin_confirmations oc ON oc.change_id = g.id) AS changes
        FROM (SELECT 1) LEFT JOIN apps a ON a.id = ${i.appId} AND a.org_id = ${i.orgId} LEFT JOIN scopes s ON s.scope_id = a.scope_id`,
  );
  if (w.expect) w.expect.appId = i.appId;
  refuseReplay(r?.replay, w);
  if (!r || r.app_id === null) return refuse('not_found', NOT_VISIBLE);
  return { plan: r, changes: JSON.parse(r.changes) as PlanChange[] };
}

/** Who confirms: an owner (a member with a step-up) or a second staff member. */
type Confirmer = { kind: 'member'; id: string; sub: string; emailKey: string; tokenSha256: string; stepUpId: string | null } | { kind: 'hana'; id: string; emailKey: string; reason: string };

/**
 * The checks every listed change must pass, in code (the commit predicate and the database repeat them). Returns the
 * set's proposer kind and proposing request. Throws: `not_found` (one identical answer for anything not on this app),
 * `bad_request` (two requests), `not_pending` (a visible change that can't be confirmed now), `forbidden` (the
 * proposer confirming, staff confirming the platform's, the org frozen), `conflict` (the key, the switch, a Journear
 * suspension).
 */
function checkSet(plan: ConfirmPlan, changes: PlanChange[], who: Confirmer, now: number): { proposer: ConfirmProposer; request: string; keyId: string | null } {
  if (plan.deleted_at !== null) refuse('not_found', NOT_VISIBLE);
  if (changes.some((c) => c.found !== 1 || c.kind !== 'origin_add')) refuse('not_found', NOT_VISIBLE);
  const requests = new Set(changes.map((c) => c.request_id));
  if (requests.size !== 1) refuse('bad_request', 'Confirm the web addresses of one request at a time (they came in separate requests)');
  const kinds = new Set(changes.map((c) => (c.proposed_by_kind === 'platform' ? 'platform' : c.proposed_by_kind === 'hana' && c.has_staff_wait === 1 ? 'hana' : 'other')));
  if (kinds.has('other') || kinds.size !== 1) refuse('not_pending', 'Only web addresses your backend asked for, or that Journear staff added to a shared wallet, wait to be confirmed');
  const proposer = [...kinds][0] as ConfirmProposer;
  if (who.kind === 'hana' && proposer !== 'hana') refuse('forbidden', 'Only an owner of the organisation confirms a web address its backend asked for, in the partner portal');
  for (const c of changes) {
    if (c.status !== 'pending') refuse('not_pending', c.status === 'cancelled' ? 'This web address was cancelled' : 'This web address is already working or was removed');
    if (c.confirmed === 1) refuse('not_pending', 'This web address is already confirmed');
    if (c.notified_at === null || c.active_from === null) refuse('not_pending', 'Its email hasn’t gone out yet, so it can’t be confirmed yet: try again in a few minutes');
    if (c.active_from !== null && c.active_from <= now) refuse('not_pending', 'This web address is already working');
    if (c.waiver !== null || c.expedited_by !== null) refuse('not_pending', 'This web address can’t be confirmed');
    if (proposer === 'platform' && (c.has_platform_wait !== 1 || c.platform_wait === null)) refuse('not_pending', 'This web address can’t be confirmed');
    if (proposer === 'hana' && c.staff_wait === null) refuse('not_pending', 'This web address can’t be confirmed');
    if (c.proposed_by === who.id) refuse('forbidden', 'The person who added this web address can’t confirm it: a second person must');
    // Four eyes (D917): never the staff member who added it, by Access subject or by email; an owner signed in with that
    // staff member's email is the same person too.
    if (proposer === 'hana' && (c.staff_by === who.id || c.staff_email_key === who.emailKey)) refuse('forbidden', 'The staff member who added this web address can’t confirm it: a second staff member, or an owner of the organisation, must');
  }
  if (plan.frozen === 1) refuse('forbidden', 'Journear has frozen this organisation');
  if ((plan.suspended_by & 3) !== 0) refuse('conflict', 'Journear has suspended this app, so its web addresses can’t be confirmed');
  let keyId: string | null = null;
  if (proposer === 'platform') {
    if (plan.enabled !== 1) refuse('conflict', 'Journear has switched the platform off for this organisation');
    if (plan.created_by_kind !== 'platform' || plan.environment !== 'test') refuse('not_found', NOT_VISIBLE);
    if (changes.some((c) => c.key_in_force !== 1)) refuse('conflict', 'The platform key that asked for these web addresses no longer works here');
    keyId = changes[0]!.proposed_by;
  }
  return { proposer, request: changes[0]!.request_id!, keyId };
}

/**
 * The commit predicate (on the app row `a`): every listed change still qualifies, counted against the list's length,
 * with the app's and the org's state as the plan read saw them; the database's insert trigger then holds it again.
 */
function confirmPredicate(w: Writer, i: { orgId: string; ids: string; n: number; request: string; proposer: ConfirmProposer }, who: Confirmer): Q {
  const platform = q`g.proposed_by_kind = 'platform' AND ${who.kind === 'member' ? raw('1') : raw('0')}
      AND EXISTS (SELECT 1 FROM platform_origin_waits pw WHERE pw.change_id = g.id AND pw.unconfirmed_active_from IS NOT NULL)
      AND EXISTS (SELECT 1 FROM platform_keys k WHERE k.id = g.proposed_by AND k.org_id = a.org_id AND ${KEY_IN_FORCE('k', w.now)}
                    AND EXISTS (SELECT 1 FROM json_each(k.scopes_json) ks WHERE ks.value = a.scope_id))`;
  const staff = q`g.proposed_by_kind = 'hana'
      AND EXISTS (SELECT 1 FROM staff_origin_waits sw WHERE sw.change_id = g.id AND sw.unconfirmed_active_from IS NOT NULL
                    AND sw.proposed_by IS NOT ${who.id} AND sw.proposer_email_key IS NOT ${who.emailKey})`;
  const appState =
    i.proposer === 'platform'
      ? q`a.created_by_kind = 'platform' AND (SELECT environment FROM scopes WHERE scope_id = a.scope_id) = 'test'
          AND EXISTS (SELECT 1 FROM platform_orgs po WHERE po.org_id = a.org_id AND po.enabled = 1 AND po.frozen = 0)`
      : raw('1');
  return q`a.deleted_at IS NULL AND (a.suspended_by & 3) = 0 AND ${appState}
    AND NOT EXISTS (SELECT 1 FROM platform_orgs fo WHERE fo.org_id = a.org_id AND fo.frozen = 1)
    AND (SELECT COUNT(*) FROM guarded_changes g WHERE g.id IN (SELECT value FROM json_each(${i.ids})) AND g.app_id = a.id
           AND g.request_id = ${i.request} AND g.kind = 'origin_add' AND g.status = 'pending' AND g.notified_at IS NOT NULL
           AND g.active_from > ${w.now} AND g.waiver IS NULL AND g.expedited_by IS NULL AND g.proposed_by IS NOT ${who.id}
           AND NOT EXISTS (SELECT 1 FROM origin_confirmations oc WHERE oc.change_id = g.id)
           AND ((${platform}) OR (${staff}))) = ${i.n}`;
}

/** The batch: the ledger row, the confirmation rows, the changes' `active_from` = now, the gate's rows = now. */
function confirmBatch(w: Writer, i: { orgId: string; appId: string; ids: string; n: number; request: string; proposer: ConfirmProposer; keyId: string | null; changes: { changeId: string; origin: string }[] }, who: Confirmer): Q[] {
  const when = committed(w.requestId);
  const detail: Record<string, unknown> = { changes: i.changes, proposalRequestId: i.request, proposedBy: i.proposer, ...(i.keyId ? { keyId: i.keyId } : {}), ...(who.kind === 'hana' ? { reason: who.reason } : {}) };
  const sub = who.kind === 'member' ? who.sub : null;
  const token = who.kind === 'member' ? who.tokenSha256 : null;
  const stepUp = who.kind === 'member' ? who.stepUpId : null;
  const reason = who.kind === 'hana' ? who.reason : null;
  return [
    commitOnApp(w, { kind: 'origin.confirmed', detail }, i.appId, i.orgId, confirmPredicate(w, i, who)),
    q`INSERT INTO origin_confirmations (change_id, app_id, origin, proposal_request_id, request_id, confirmed_by_kind, confirmed_by, confirmed_sub, confirmed_email_key, token_sha256, step_up_id, reason, confirmed_at)
      SELECT g.id, g.app_id, g.origin, g.request_id, ${w.requestId}, ${who.kind}, ${who.id}, ${sub}, ${who.emailKey}, ${token}, ${stepUp}, ${reason}, ${w.now}
        FROM guarded_changes g WHERE g.id IN (SELECT value FROM json_each(${i.ids})) AND g.app_id = ${i.appId} AND ${when}`,
    // The changes first, so the gate's rows see the confirmation (migration 0034's triggers allow exactly its time).
    q`UPDATE guarded_changes SET active_from = ${w.now}
       WHERE id IN (SELECT change_id FROM origin_confirmations WHERE request_id = ${w.requestId}) AND status = 'pending' AND ${when}`,
    q`UPDATE app_origins SET active_from = ${w.now}
       WHERE app_id = ${i.appId} AND change_id IN (SELECT change_id FROM origin_confirmations WHERE request_id = ${w.requestId}) AND ${when}`,
  ];
}

const limiter = (env: Env, name: string) => placedStub(env, env.RATE_LIMITER, name);

/**
 * The confirmations' own limits (ORIGIN_CONFIRM_LIMITS), per member (or staff member) and per org, each attempt
 * counted before anything is read. Fails closed: a limiter that can't answer refuses the confirmation (nothing urgent
 * waits on it: the web address still comes into force after its 24 h).
 */
async function admitConfirm(env: Env, w: Writer, orgId: string): Promise<void> {
  const hour = 3_600_000;
  try {
    const m = await limiter(env, `origin-confirm:actor:${w.actor.kind}:${actorId(w.actor)}`).hit([{ name: 'origin-confirm:actor:hour', windowMs: hour, max: ORIGIN_CONFIRM_LIMITS.memberPerHour }], w.now);
    if (!m.ok) refuse('rate_limited', 'Too many confirmations from you in the last hour: try again later');
    const o = await limiter(env, `origin-confirm:org:${orgId}`).hit([{ name: 'origin-confirm:org:hour', windowMs: hour, max: ORIGIN_CONFIRM_LIMITS.orgPerHour }], w.now);
    if (!o.ok) refuse('rate_limited', 'Too many confirmations in this organisation in the last hour: try again later');
  } catch (err) {
    if (err instanceof RpcRefusal) throw err;
    log({ event: 'origin_confirm_limiter_failed', requestId: w.requestId, orgId }, 'error');
    refuse('rate_limited', 'Confirmations can’t be checked just now: try again in a minute');
  }
}

const listed = (changes: PlanChange[]) => [...changes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((c) => ({ changeId: c.id, origin: c.origin! }));

/**
 * ConsoleRpc.confirmOrigins: an owner's confirmation, bound to the step-up of kind `origin.confirm` over exactly these
 * changes. In force at once. The token is verified (signature, console audience, at most 300 s old, the member's own
 * `sub`) before anything is read; its nonce, the on-chain owner (uncached) and its single use are checked after every
 * other check, so a refusal never uses it up.
 */
export async function confirmOrigins(db: HotDb, env: Env, w: Writer, i: { orgId: string; appId: string; changeIds: readonly string[]; stepUpJwt: string; stepUpId?: string | undefined }) {
  expectReplay(w, ['origin.confirmed']);
  if (w.actor.kind !== 'member') return refuse('forbidden', 'Only an owner of the organisation confirms a web address, in the partner portal');
  await admitConfirm(env, w, i.orgId);
  const token = await verifyStepUpToken(env, i.stepUpJwt, w.actor, w.now);
  const { plan, changes } = await planConfirm(db, w, i);
  const who: Confirmer = { kind: 'member', id: actorId(w.actor), sub: token.sub, emailKey: personEmailKey(w.actor.email), tokenSha256: token.hash, stepUpId: i.stepUpId ?? null };
  const set = checkSet(plan, changes, who, w.now);
  const list = listed(changes);
  const expectedNonce = nonceOf(await originConfirmDigest({ signer: env.SIGNER_ACCOUNT, env: env.ENV_NAME, orgId: i.orgId, appId: i.appId, scopeId: plan.scope_id!, changes: list }));
  await confirmStepUp(env, token, { expectedNonce, scopeId: plan.scope_id! });
  w.sub = token.sub;
  const ids = JSON.stringify(list.map((c) => c.changeId));
  try {
    await runWrite(db, w, confirmBatch(w, { orgId: i.orgId, appId: i.appId, ids, n: list.length, request: set.request, proposer: set.proposer, keyId: set.keyId, changes: list }, who));
  } catch (err) {
    if (!w.wrote) await releaseStepUp(env, token);
    throw err;
  }
  return { confirmedAt: w.now, changes: list.map((c) => ({ ...c, ...originDisplay(c.origin) })) };
}

/**
 * AdminRpc.confirmStaffOrigins: a second staff member confirms web addresses another staff member added to a
 * platform-created app or a shared wallet (four eyes, D917): another Access subject and another email than the
 * proposer's (held here, in the commit predicate and in the database), with a reason. In force at once.
 */
export async function confirmStaffOrigins(db: HotDb, env: Env, w: Writer, i: { orgId: string; appId: string; changeIds: readonly string[]; reason: string }) {
  expectReplay(w, ['origin.confirmed']);
  if (w.actor.kind !== 'hana') return refuse('forbidden', 'Only Journear staff confirm here');
  await admitConfirm(env, w, i.orgId);
  const { plan, changes } = await planConfirm(db, w, i);
  const who: Confirmer = { kind: 'hana', id: w.actor.id, emailKey: personEmailKey(w.actor.email), reason: i.reason.trim() };
  const set = checkSet(plan, changes, who, w.now);
  const list = listed(changes);
  const ids = JSON.stringify(list.map((c) => c.changeId));
  await runWrite(db, w, confirmBatch(w, { orgId: i.orgId, appId: i.appId, ids, n: list.length, request: set.request, proposer: set.proposer, keyId: null, changes: list }, who));
  return { confirmedAt: w.now, changes: list.map((c) => ({ ...c, ...originDisplay(c.origin) })) };
}

// ---- the confirmation page's view ----

interface ViewRow {
  change_id: string | null;
  app_id: string;
  app_name: string;
  scope_id: string;
  environment: 'test' | 'live';
  shared: number;
  deleted_at: number | null;
  request_id: string;
  proposed_by_kind: string;
  proposed_by: string;
  proposed_at: number;
  second_person: number;
  staff_email_key: string | null;
  key_label: string | null;
  changes: string;
  others: string;
  others_total: number;
}

/**
 * ConsoleRpc.getConfirmation: the change (of the caller's org), its app, who asked and when, every web address of that
 * proposing request on that app with its state, and the other apps of a shared wallet. One read; changes nothing.
 * A change that isn't a platform proposal or a staff one under four eyes, or isn't the org's, is `not_found`.
 */
export async function getConfirmation(db: HotDb, i: { orgId: string; changeId: string }, now: number, viewerEmailKey?: string): Promise<{ confirmation: ConfirmationView }> {
  const r = await db.first<ViewRow>(
    q`SELECT g.id AS change_id, a.id AS app_id, a.name AS app_name, a.scope_id, s.environment, s.app_user_ids AS shared, a.deleted_at,
             g.request_id, g.proposed_by_kind, g.proposed_by, g.proposed_at, EXISTS (SELECT 1 FROM staff_origin_waits sw WHERE sw.change_id = g.id) AS second_person,
             (SELECT sw.proposer_email_key FROM staff_origin_waits sw WHERE sw.change_id = g.id) AS staff_email_key,
             CASE WHEN g.proposed_by_kind = 'platform' THEN (SELECT pk.label FROM platform_keys pk WHERE pk.id = g.proposed_by AND pk.org_id = a.org_id) END AS key_label,
             (SELECT json_group_array(json_object('id', o.id, 'origin', o.origin, 'status', o.status, 'notified_at', o.notified_at, 'active_from', o.active_from,
                                                   'confirmed_at', oc.confirmed_at, 'waited', COALESCE(pw.unconfirmed_active_from, sw2.unconfirmed_active_from)))
                FROM (SELECT * FROM guarded_changes WHERE app_id = g.app_id AND request_id = g.request_id AND kind = 'origin_add' ORDER BY origin LIMIT 20) o
                LEFT JOIN origin_confirmations oc ON oc.change_id = o.id
                LEFT JOIN platform_origin_waits pw ON pw.change_id = o.id
                LEFT JOIN staff_origin_waits sw2 ON sw2.change_id = o.id) AS changes,
             (SELECT json_group_array(name) FROM (SELECT x.name FROM apps x WHERE x.scope_id = a.scope_id AND x.id != a.id AND x.deleted_at IS NULL ORDER BY x.name LIMIT ${CONFIRM_OTHER_APPS_SHOWN})) AS others,
             (SELECT COUNT(*) FROM apps x WHERE x.scope_id = a.scope_id AND x.id != a.id AND x.deleted_at IS NULL) AS others_total
        FROM guarded_changes g JOIN apps a ON a.id = g.app_id AND a.org_id = ${i.orgId} JOIN scopes s ON s.scope_id = a.scope_id
       WHERE g.id = ${i.changeId} AND g.kind = 'origin_add'
         AND (g.proposed_by_kind = 'platform' OR EXISTS (SELECT 1 FROM staff_origin_waits sw WHERE sw.change_id = g.id))`,
  );
  if (!r || r.change_id === null || r.deleted_at !== null) return refuse('not_found', NOT_VISIBLE);
  const rows = JSON.parse(r.changes) as { id: string; origin: string; status: string; notified_at: number | null; active_from: number | null; confirmed_at: number | null; waited: number | null }[];
  // D917: the viewer who added a staff proposal (by email) is never its second person.
  const self = viewerEmailKey !== undefined && r.staff_email_key !== null && r.staff_email_key === viewerEmailKey;
  const changes = rows.map((c): ConfirmationChange => {
    const inForce = c.status === 'active' || (c.status === 'pending' && c.active_from !== null && c.active_from <= now);
    const state: ConfirmationChange['state'] = c.status === 'cancelled' ? 'cancelled' : c.status === 'ended' ? 'ended' : inForce ? 'in_force' : c.notified_at === null ? 'waiting_announcement' : 'waiting';
    const v: ConfirmationChange = { changeId: c.id, ...originDisplay(c.origin), state, activeFrom: c.confirmed_at ?? c.waited ?? c.active_from, confirmable: state === 'waiting' && c.confirmed_at === null && !self };
    if (c.confirmed_at !== null) v.confirmedAt = c.confirmed_at;
    return v;
  });
  const view: ConfirmationView = {
    app: { id: r.app_id, name: r.app_name, scopeId: r.scope_id, environment: r.environment, sharedScope: r.shared === 1, otherApps: JSON.parse(r.others) as string[], otherAppsTotal: r.others_total },
    requestId: r.request_id,
    proposedByKind: r.proposed_by_kind === 'platform' ? 'platform' : 'hana',
    proposedAt: r.proposed_at,
    changes,
  };
  if (r.proposed_by_kind === 'platform') {
    view.keyId = r.proposed_by;
    view.keyLabel = r.key_label;
  }
  if (self) view.sameAsProposer = true;
  return { confirmation: view };
}

// ---- the confirmation's notice ----

interface NoticeRow {
  request_id: string;
  confirmed_at: number;
  app_id: string;
  app_name: string;
  org_id: string;
  scope_id: string;
  environment: 'test' | 'live';
  confirmed_by_kind: 'member' | 'hana';
  confirmed_by: string;
  proposed_by_kind: string;
  proposed_by: string;
  key_label: string | null;
  contacts: string;
  changes: string;
}

/**
 * AdminRpc.confirmationNotices: the confirmations whose notice hasn't gone out, one per confirmation call (its ledger
 * request id), oldest first, each with the org's security contacts (the admin Worker adds the alias and every owner).
 */
export async function confirmationNotices(db: HotDb, limit: number): Promise<ConfirmationNotice[]> {
  const rows = await db.all<NoticeRow>(
    q`SELECT f.request_id, f.confirmed_at, f.app_id, a.name AS app_name, a.org_id, a.scope_id, s.environment, f.confirmed_by_kind, f.confirmed_by, g.proposed_by_kind, g.proposed_by,
             CASE WHEN g.proposed_by_kind = 'platform' THEN (SELECT pk.label FROM platform_keys pk WHERE pk.id = g.proposed_by AND pk.org_id = a.org_id) END AS key_label,
             (SELECT json_group_array(email) FROM (SELECT email FROM org_security_contacts WHERE org_id = a.org_id ORDER BY email)) AS contacts,
             (SELECT json_group_array(json_object('changeId', x.change_id, 'origin', x.origin)) FROM (SELECT change_id, origin FROM origin_confirmations WHERE request_id = f.request_id ORDER BY change_id) x) AS changes
        FROM (SELECT request_id, MIN(confirmed_at) AS confirmed_at, MIN(change_id) AS first_change, app_id, confirmed_by_kind, confirmed_by
                FROM origin_confirmations WHERE notice_at IS NULL GROUP BY request_id ORDER BY MIN(confirmed_at), request_id LIMIT ${limit}) f
        JOIN guarded_changes g ON g.id = f.first_change JOIN apps a ON a.id = f.app_id JOIN scopes s ON s.scope_id = a.scope_id
       ORDER BY f.confirmed_at, f.request_id`,
  );
  return rows.map((r) => {
    const n: ConfirmationNotice = {
      requestId: r.request_id,
      app: { id: r.app_id, name: r.app_name, orgId: r.org_id, scopeId: r.scope_id, environment: r.environment },
      contacts: JSON.parse(r.contacts) as string[],
      confirmedByKind: r.confirmed_by_kind,
      confirmedBy: r.confirmed_by,
      confirmedAt: r.confirmed_at,
      proposedByKind: r.proposed_by_kind === 'platform' ? 'platform' : 'hana',
      changes: (JSON.parse(r.changes) as { changeId: string; origin: string }[]).map((c) => ({ changeId: c.changeId, ...originDisplay(c.origin) })),
    };
    if (r.proposed_by_kind === 'platform') {
      n.keyId = r.proposed_by;
      n.keyLabel = r.key_label;
    } else n.proposedBy = r.proposed_by;
    return n;
  });
}

const blob = (b64: string): ArrayBuffer => {
  const b = fromB64url(b64);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/**
 * AdminRpc.ackConfirmationNotice (`system` only): the notice went out to every recipient. Stores each removal link's
 * sha256 and its end (7 days), once; the list must be exactly the confirmation's web addresses.
 */
export async function ackConfirmationNotice(db: HotDb, w: Writer, i: { requestId: string; removals: readonly { changeId: string; removalTokenHash: string }[] }) {
  if (w.actor.kind !== 'system') return refuse('forbidden', 'Only the notice job acks a confirmation notice');
  const rows = await db.all<{ change_id: string; notice_at: number | null }>(q`SELECT change_id, notice_at FROM origin_confirmations WHERE request_id = ${i.requestId} ORDER BY change_id`);
  if (rows.length === 0) return refuse('not_found', 'No such confirmation');
  if (rows.some((r) => r.notice_at !== null)) return refuse('not_pending', 'This confirmation’s notice was already acked');
  const want = rows.map((r) => r.change_id);
  const got = [...new Set(i.removals.map((x) => x.changeId))].sort();
  if (got.length !== i.removals.length || got.length !== want.length || got.some((c, k) => c !== want[k])) return refuse('bad_request', 'The removal links must name exactly the confirmation’s web addresses, once each');
  const until = w.now + ORIGIN_REMOVAL_LINK_MS;
  const results = await db.batch(
    i.removals.map((x) => q`UPDATE origin_confirmations SET notice_at = ${w.now}, removal_token_hash = ${blob(x.removalTokenHash)}, removal_until = ${until} WHERE change_id = ${x.changeId} AND request_id = ${i.requestId} AND notice_at IS NULL`),
  );
  if (results.some((r) => (r.meta.changes ?? 0) !== 1)) return refuse('not_pending', 'This confirmation’s notice was acked meanwhile');
  return { removalUntil: until };
}

// ---- the removal link ----

interface RemovalPlan {
  replay: string | null;
  change_id: string | null;
  app_id: string;
  app_name: string;
  org_id: string;
  origin: string;
  status: string;
  active_from: number | null;
  deleted_at: number | null;
  origins_version: number;
  confirmed_at: number;
  confirmed_by_kind: 'member' | 'hana';
  confirmed_by: string;
  removal_until: number | null;
  hash_hex: string | null;
  row_present: number;
}

const REMOVAL_REFUSED = 'This link is not valid for this web address';

/** The link's plan read: the confirmation, its change, app and gate row; the token against the stored sha256 (constant time). */
async function planRemoval(db: HotDb, w: Writer, i: { changeId: string; token: string }): Promise<{ r: RemovalPlan; hashHex: string }> {
  const r = await db.first<RemovalPlan>(
    q`SELECT ${replayRow(w.requestId)} AS replay, oc.change_id, a.id AS app_id, a.name AS app_name, a.org_id, oc.origin, g.status, g.active_from, a.deleted_at, a.origins_version,
             oc.confirmed_at, oc.confirmed_by_kind, oc.confirmed_by, oc.removal_until, hex(oc.removal_token_hash) AS hash_hex,
             EXISTS (SELECT 1 FROM app_origins ao WHERE ao.app_id = oc.app_id AND ao.change_id = oc.change_id) AS row_present
        FROM (SELECT 1) LEFT JOIN origin_confirmations oc ON oc.change_id = ${i.changeId}
        LEFT JOIN guarded_changes g ON g.id = oc.change_id LEFT JOIN apps a ON a.id = oc.app_id`,
  );
  if (w.expect) w.expect.appId = r?.app_id ?? null;
  refuseReplay(r?.replay, w);
  let presented: Uint8Array;
  try {
    presented = await sha256(fromB64url(i.token));
  } catch {
    return refuse('forbidden', REMOVAL_REFUSED);
  }
  const stored = r?.hash_hex && r.hash_hex.length === 64 ? Uint8Array.from(r.hash_hex.match(/../gu)!.map((h) => Number.parseInt(h, 16))) : null;
  if (!r || r.change_id === null || stored === null || !bytesEqual(presented, stored)) return refuse('forbidden', REMOVAL_REFUSED);
  if (r.removal_until === null || r.removal_until <= w.now) refuse('forbidden', 'This link has expired: an owner can remove the web address in the partner portal');
  if (r.deleted_at !== null) refuse('not_found', 'The app was deleted');
  return { r, hashHex: hex(presented).toUpperCase() };
}

const stillThere = (r: RemovalPlan): boolean => (r.status === 'pending' || r.status === 'active') && r.row_present === 1;

/** ConsoleRpc.removalPreview: what the removal page shows (the app, the web address, who confirmed and when). Reads only. */
export async function removalPreview(db: HotDb, w: Writer, i: { changeId: string; token: string }) {
  const { r } = await planRemoval(db, w, i);
  return {
    removal: {
      changeId: r.change_id!,
      appName: r.app_name,
      ...originDisplay(r.origin),
      confirmedAt: r.confirmed_at,
      confirmedByKind: r.confirmed_by_kind,
      /** A member's console user id (the console names them, from the org's members), or "hana". */
      confirmedBy: r.confirmed_by_kind === 'member' ? r.confirmed_by : 'hana',
      orgId: r.org_id,
      until: r.removal_until!,
      removable: stillThere(r),
    },
  };
}

/**
 * ConsoleRpc.removeOriginByLink: the confirmation notice's one-click removal link, valid 7 days: the web address stops
 * at once (as `removeOrigins`: its gate row goes, its change ends, one `origin.removed` ledger row with the `link`
 * actor). Single use (a web address already removed answers `not_pending`); the token is held in the commit predicate.
 */
export async function removeOriginByLink(db: HotDb, w: Writer, i: { changeId: string; token: string }) {
  expectReplay(w, ['origin.removed'], undefined, { kind: 'link', id: i.changeId });
  const { r, hashHex } = await planRemoval(db, w, i);
  if (!stillThere(r)) refuse('not_pending', 'This web address was already removed');
  const list = JSON.stringify([r.origin]);
  const detail = { origins: [{ origin: r.origin, wasInForce: r.active_from !== null && r.active_from <= w.now }], changeId: r.change_id, byLink: 'confirmation_notice' };
  await runWrite(db, w, [
    commitOnApp(
      w,
      { kind: 'origin.removed', detail },
      r.app_id,
      null,
      q`a.origins_version = ${r.origins_version} AND a.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM origin_confirmations oc WHERE oc.change_id = ${r.change_id} AND oc.app_id = a.id AND hex(oc.removal_token_hash) = ${hashHex} AND oc.removal_until > ${w.now})
        AND EXISTS (SELECT 1 FROM app_origins ao WHERE ao.app_id = a.id AND ao.change_id = ${r.change_id})`,
    ),
    q`UPDATE apps SET origins_version = origins_version + 1 WHERE id = ${r.app_id} AND ${committed(w.requestId)}`,
    closeChanges(q`app_id = ${r.app_id} AND kind = 'origin_add' AND origin IN (SELECT value FROM json_each(${list}))`, w),
    q`DELETE FROM app_origins WHERE app_id = ${r.app_id} AND origin IN (SELECT value FROM json_each(${list})) AND ${committed(w.requestId)}`,
  ]);
  return { removed: { changeId: r.change_id!, appName: r.app_name, ...originDisplay(r.origin) } };
}
