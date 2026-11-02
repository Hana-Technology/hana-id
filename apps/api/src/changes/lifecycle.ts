// A guarded change's life after its proposal (docs/batch-c-spec.md "Guarded changes" → Lifecycle, Waivers, Notice and
// cancel, Expedite): the admin Worker's blocking notice (pendingNotices → send → ackNotice, which starts the clock), the
// cancel by an owner, by Hana staff or by the emailed link, and Hana's expedite of a member proposal. Activation and
// the 7-day expiry are the hourly job's (guarded/cron.ts).
//
// Versions: a cancel bumps the origins or settings version (it changes the set of origin rows or the settings); the
// ack and the expedite never do, so an owner's step-up in flight survives them.
import { bytesEqual, fromB64url, hex, sha256 } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { LOCALHOST_WILDCARD, isDevEnv, isLoopbackOrigin } from '../origins.ts';
import { PRODUCTION_NETWORK } from '../guarded/config.ts';
import { type Writer, actorId, commitOnChange, committed, refuseReplay, refuse, replaySeq, runWrite } from './cas.ts';
import type { HotDb } from './db.ts';
import { requireChangeConfig } from './origins.ts';
import { type Q, q, raw } from './sql.ts';
import { CHANGE_COLUMNS, type ChangeRow, changeView } from './views.ts';

interface ChangePlan extends ChangeRow {
  replay_seq: number | null;
  change_id: string | null;
  org_id: string | null;
  scope_id: string | null;
  deleted_at: number | null;
  environment: 'test' | 'live' | null;
  token_hash_hex: string | null;
}

/** The plan read of a change write: the change, its app (in `orgId` when given) and scope, and the replay check. */
async function planChange(db: HotDb, i: { changeId: string; orgId: string | null; requestId: string }): Promise<ChangePlan> {
  const org = i.orgId === null ? raw('1') : q`a.org_id = ${i.orgId}`;
  const cols = CHANGE_COLUMNS.split(', ').map((c) => `g.${c}`).join(', ');
  const r = await db.first<ChangePlan>(
    q`SELECT ${replaySeq(i.requestId)} AS replay_seq, g.id AS change_id, ${raw(cols)}, a.org_id, a.scope_id, a.deleted_at, s.environment, hex(g.cancel_token_hash) AS token_hash_hex
        FROM (SELECT 1) LEFT JOIN guarded_changes g ON g.id = ${i.changeId}
        LEFT JOIN apps a ON a.id = g.app_id AND ${org} LEFT JOIN scopes s ON s.scope_id = a.scope_id`,
  );
  refuseReplay(r?.replay_seq);
  if (!r || r.change_id === null || r.org_id === null) return refuse('not_found', 'No such change');
  return r;
}

const notInForce = (c: Pick<ChangeRow, 'status' | 'active_from'>, now: number): boolean => c.status === 'pending' && (c.active_from === null || c.active_from > now);

// ---- cancel ----

/**
 * Cancels a pending change that isn't in force yet: its origin row goes, or the pending settings value it wrote is
 * cleared (only while it is still that change's and still in the future), the version bumps, `app_changes
 * change.cancelled`. A change in force is ended by removing it (removeOrigins, turnOff), not cancelled.
 */
function cancelBatch(w: Writer, c: ChangePlan, orgId: string | null, extra: Q, actor?: { kind: string; id: string }, cancelledBy?: string): Q[] {
  const by = cancelledBy ?? actorId(w.actor);
  const stmts: Q[] = [
    commitOnChange(
      w,
      { kind: 'change.cancelled', detail: { changeId: c.id, kind: c.kind, origin: c.origin, policyId: c.policy_id, by: actor?.kind ?? w.actor.kind } },
      c.id,
      orgId,
      q`g.status = 'pending' AND (g.active_from IS NULL OR g.active_from > ${w.now}) AND a.deleted_at IS NULL AND ${extra}`,
      actor,
    ),
    q`UPDATE guarded_changes SET status = 'cancelled', cancelled_by = ${by}, cancelled_at = ${w.now} WHERE id = ${c.id} AND status = 'pending' AND ${committed(w.requestId)}`,
  ];
  if (c.kind === 'origin_add') {
    stmts.push(
      q`DELETE FROM app_origins WHERE app_id = ${c.app_id} AND change_id = ${c.id} AND (active_from IS NULL OR active_from > ${w.now}) AND ${committed(w.requestId)}`,
      q`UPDATE apps SET origins_version = origins_version + 1 WHERE id = ${c.app_id} AND ${committed(w.requestId)}`,
    );
  } else if (c.kind === 'policy_set') {
    const mine = q`(auto_approve_pending = ${c.policy_json} AND auto_approve_effective_at > ${w.now})`;
    stmts.push(
      q`UPDATE apps SET settings_version = settings_version + 1,
               auto_approve_pending = CASE WHEN ${mine} THEN NULL ELSE auto_approve_pending END,
               auto_approve_effective_at = CASE WHEN ${mine} THEN NULL ELSE auto_approve_effective_at END
         WHERE id = ${c.app_id} AND ${committed(w.requestId)}`,
    );
  } else {
    const mine = q`(raw_sign_pending = 'approval' AND raw_sign_effective_at > ${w.now})`;
    stmts.push(
      q`UPDATE apps SET settings_version = settings_version + 1,
               raw_sign_pending = CASE WHEN ${mine} THEN NULL ELSE raw_sign_pending END,
               raw_sign_effective_at = CASE WHEN ${mine} THEN NULL ELSE raw_sign_effective_at END
         WHERE id = ${c.app_id} AND ${committed(w.requestId)}`,
    );
  }
  return stmts;
}

const cancelledRow = (c: ChangeRow, w: Writer, by: string): ChangeRow => ({ ...c, status: 'cancelled', cancelled_by: by, cancelled_at: w.now });

/** ConsoleRpc.cancelChange (an owner) and the AdminRpc org method (Hana staff): any pending change of the org's apps. */
export async function cancelChange(db: HotDb, w: Writer, i: { orgId: string; changeId: string }) {
  const c = await planChange(db, { changeId: i.changeId, orgId: i.orgId, requestId: w.requestId });
  if (c.deleted_at !== null) refuse('not_found', 'The app is deleted');
  if (!notInForce(c, w.now)) refuse('not_pending', c.status === 'pending' ? 'The change is already in force: remove it instead' : `The change is ${c.status}`);
  await runWrite(db, w.requestId, cancelBatch(w, c, i.orgId, raw('1')));
  return { change: changeView(cancelledRow(c, w, actorId(w.actor))) };
}

/**
 * ConsoleRpc.cancelChangeByLink: the emailed link's token T, checked against the stored sha256(T) (constant time), valid
 * until `active_from`, single use (a cancelled change is no longer pending). Recorded with the `link` actor.
 */
export async function cancelChangeByLink(db: HotDb, w: Writer, i: { changeId: string; token: string }) {
  const c = await planChange(db, { changeId: i.changeId, orgId: null, requestId: w.requestId });
  const presented = await sha256(fromB64url(i.token));
  // An unannounced change has no link yet; a wrong token and no token look the same to the caller.
  if (c.token_hash_hex === null || !bytesEqual(presented, hexBytes(c.token_hash_hex))) refuse('forbidden', 'This cancel link is not valid for this change');
  if (c.deleted_at !== null) refuse('not_found', 'The app is deleted');
  if (!notInForce(c, w.now)) refuse('not_pending', c.status === 'pending' ? 'The change is already in force' : `The change is ${c.status}`);
  const link = { kind: 'link', id: c.id };
  await runWrite(db, w.requestId, cancelBatch(w, c, null, q`hex(g.cancel_token_hash) = ${hex(presented).toUpperCase()}`, link, 'link'));
  return { change: changeView(cancelledRow(c, w, 'link')) };
}

function hexBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let k = 0; k < out.length; k++) out[k] = Number.parseInt(h.slice(2 * k, 2 * k + 2), 16);
  return out;
}

// ---- notices ----

export interface Notice {
  change: ReturnType<typeof changeView>;
  contacts: string[];
  /** What the notice describes besides the change (an additive field, D226). */
  app: { id: string; name: string; orgId: string; scopeId: string; environment: 'test' | 'live' };
  /** policy_set: the proposed policy (canonical JSON, parsed), for the notice's description of it. */
  policy?: unknown;
}

/** AdminRpc.pendingNotices: every pending change not yet announced (oldest first), with its org's security contacts. */
export async function pendingNotices(db: HotDb, limit: number): Promise<Notice[]> {
  const cols = CHANGE_COLUMNS.split(', ').map((c) => `g.${c}`).join(', ');
  const rows = await db.all<ChangeRow & { app_name: string; org_id: string; scope_id: string; environment: 'test' | 'live'; contacts: string }>(
    q`SELECT ${raw(cols)}, a.name AS app_name, a.org_id, a.scope_id, s.environment,
             (SELECT json_group_array(email) FROM (SELECT email FROM org_security_contacts WHERE org_id = a.org_id ORDER BY email)) AS contacts
        FROM guarded_changes g JOIN apps a ON a.id = g.app_id JOIN scopes s ON s.scope_id = a.scope_id
       WHERE g.status = 'pending' AND g.notified_at IS NULL AND a.deleted_at IS NULL
       ORDER BY g.proposed_at, g.id LIMIT ${limit}`,
  );
  return rows.map((r) => {
    const n: Notice = {
      change: changeView(r),
      contacts: JSON.parse(r.contacts) as string[],
      app: { id: r.app_id, name: r.app_name, orgId: r.org_id, scopeId: r.scope_id, environment: r.environment },
    };
    if (r.policy_json !== null) n.policy = JSON.parse(r.policy_json) as unknown;
    return n;
  });
}

/**
 * The `no_session` waiver (spec "Waivers"), decided inside the acking statements themselves so nothing can change in
 * between (C3 review M1), and fail closed. Only for a candidate: a member proposal with a verified step-up (C6 records
 * `proposer_sub`), or a Hana proposal marked at proposal time, which only createApp does for the initial origins of a
 * scope row it created. Granted only while the scope shows no sign that a user has a key in it: `first_session_at` is
 * NULL (the API writes it at every session-pool relay attempt, D209), no origin of the scope's apps is or was in force
 * other than those proposed in the same request, and no app of the scope has a vault share, a usage row or an identity
 * count. The same rule as the CLI's `app:changes:announce` (scripts/lib/admin-sql.ts `noSessionWaiver`, D206); C4
 * replaces the legacy `usage` check in both before migration 0007 drops that table.
 */
export function noSessionWaiver(t: string, now: number): Q {
  const T = raw(t);
  const scope = raw(`(SELECT scope_id FROM apps WHERE id = ${t}.app_id)`);
  const scopeApps = raw(`(SELECT id FROM apps WHERE scope_id = (SELECT scope_id FROM apps WHERE id = ${t}.app_id))`);
  return q`(((${T}.waiver = 'no_session' AND ${T}.proposed_by_kind = 'hana') OR (${T}.proposed_by_kind = 'member' AND ${T}.proposer_sub IS NOT NULL))
    AND (SELECT first_session_at FROM scopes WHERE scope_id = ${scope}) IS NULL
    AND NOT EXISTS (SELECT 1 FROM guarded_changes o WHERE o.app_id IN ${scopeApps} AND o.kind = 'origin_add'
                     AND o.active_from IS NOT NULL AND o.active_from <= ${now} AND o.request_id != ${T}.request_id)
    AND NOT EXISTS (SELECT 1 FROM app_origins ao WHERE ao.app_id IN ${scopeApps} AND ao.active_from IS NOT NULL AND ao.active_from <= ${now}
                     AND (ao.change_id IS NULL OR ao.change_id NOT IN (SELECT gr.id FROM guarded_changes gr WHERE gr.request_id = ${T}.request_id)))
    AND NOT EXISTS (SELECT 1 FROM vault_shares WHERE app_id IN ${scopeApps})
    AND NOT EXISTS (SELECT 1 FROM usage WHERE app_id IN ${scopeApps})
    AND NOT EXISTS (SELECT 1 FROM identity_usage WHERE app_id IN ${scopeApps}))`;
}

/**
 * The `loopback` waiver: a loopback origin (or the localhost wildcard) proposed by a member on a test scope, in a dev
 * env on a non-production network. Its inputs never change (the origin, the scope's environment, the env), so it is
 * decided in code. Hana proposals never get it (spec "Staff proposals": no waiver except createApp's no_session).
 */
export function loopbackWaiver(env: Env, network: string, c: Pick<ChangeRow, 'kind' | 'origin' | 'proposed_by_kind'>, environment: 'test' | 'live'): boolean {
  return (
    c.proposed_by_kind === 'member' &&
    c.kind === 'origin_add' &&
    c.origin !== null &&
    (c.origin === LOCALHOST_WILDCARD || isLoopbackOrigin(c.origin)) &&
    environment === 'test' &&
    isDevEnv(env.ENV_NAME) &&
    network !== PRODUCTION_NETWORK
  );
}

/**
 * AdminRpc.ackNotice: the admin Worker's notice was accepted by the email provider for every recipient. In one CAS
 * batch: `notified_at`, `active_from` (now + appChangeDelayMs, or now under a waiver), the cancel link's token hash, and
 * the change's effect in the hot DB: the origin row's `active_from`, or the app's pending policy or raw signing with
 * `*_effective_at = active_from` (a matured pending value is first kept as the stored one, so an ack never takes a
 * value in force away). No version bump.
 */
export async function ackNotice(db: HotDb, env: Env, w: Writer, i: { changeId: string; cancelTokenHash: string }) {
  const config = requireChangeConfig(env);
  const c = await planChange(db, { changeId: i.changeId, orgId: null, requestId: w.requestId });
  if (c.deleted_at !== null) refuse('not_found', 'The app is deleted');
  if (c.status !== 'pending' || c.notified_at !== null) refuse('not_pending', c.status === 'pending' ? 'The change is already announced' : `The change is ${c.status}`);
  const hash = fromB64url(i.cancelTokenHash);
  const blob = hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength) as ArrayBuffer;
  const later = w.now + config.delayMs;
  const loopback = loopbackWaiver(env, config.network, c, c.environment ?? 'live');
  const at = (t: string): Q => (loopback ? q`${w.now}` : q`CASE WHEN ${noSessionWaiver(t, w.now)} THEN ${w.now} ELSE ${later} END`);
  const waiver = (t: string): Q => (loopback ? q`'loopback'` : q`CASE WHEN ${noSessionWaiver(t, w.now)} THEN 'no_session' END`);
  const activeFrom = q`(SELECT active_from FROM guarded_changes WHERE id = ${c.id})`;
  const stmts: Q[] = [
    commitOnChange(
      w,
      {
        kind: 'change.announced',
        detail: q`json_object('changeId', g.id, 'kind', g.kind, 'origin', g.origin, 'policyId', g.policy_id, 'activeFrom', ${at('g')}, 'waiver', ${waiver('g')}, 'channel', 'email')`,
      },
      c.id,
      null,
      q`g.status = 'pending' AND g.notified_at IS NULL AND a.deleted_at IS NULL`,
    ),
    q`UPDATE guarded_changes SET notified_at = ${w.now}, active_from = ${at('guarded_changes')}, waiver = ${waiver('guarded_changes')}, cancel_token_hash = ${blob}
       WHERE id = ${c.id} AND status = 'pending' AND notified_at IS NULL AND ${committed(w.requestId)}`,
  ];
  if (c.kind === 'origin_add') {
    stmts.push(q`UPDATE app_origins SET active_from = ${activeFrom} WHERE app_id = ${c.app_id} AND change_id = ${c.id} AND active_from IS NULL AND ${committed(w.requestId)}`);
  } else if (c.kind === 'policy_set') {
    stmts.push(
      q`UPDATE apps SET auto_approve_policy = CASE WHEN auto_approve_pending IS NOT NULL AND auto_approve_effective_at <= ${w.now} THEN auto_approve_pending ELSE auto_approve_policy END,
               auto_approve_pending = ${c.policy_json}, auto_approve_effective_at = ${activeFrom}
         WHERE id = ${c.app_id} AND ${committed(w.requestId)}`,
    );
  } else {
    stmts.push(
      q`UPDATE apps SET raw_sign = CASE WHEN raw_sign_pending = 'approval' AND raw_sign_effective_at <= ${w.now} THEN 'approval' ELSE raw_sign END,
               raw_sign_pending = 'approval', raw_sign_effective_at = ${activeFrom}
         WHERE id = ${c.app_id} AND ${committed(w.requestId)}`,
    );
  }
  stmts.push(q`SELECT ${raw(CHANGE_COLUMNS)} FROM guarded_changes WHERE id = ${c.id}`);
  const results = await runWrite(db, w.requestId, stmts);
  const row = results[results.length - 1]!.results[0] as ChangeRow;
  return { change: changeView(row) };
}

// ---- expedite ----

/**
 * AdminRpc.expediteChange: only an announced, pending, member-proposed change not yet in force. Sets `active_from = now`
 * (and the matching `*_effective_at`), records the staff id and the reason, `app_changes change.expedited` (the feed).
 * Staff proposals are never expedited.
 */
export async function expediteChange(db: HotDb, w: Writer, i: { changeId: string; reason: string }) {
  const c = await planChange(db, { changeId: i.changeId, orgId: null, requestId: w.requestId });
  if (c.deleted_at !== null) refuse('not_found', 'The app is deleted');
  if (c.proposed_by_kind !== 'member') refuse('forbidden', 'Only a member-proposed change can be expedited');
  if (c.status !== 'pending' || c.notified_at === null) refuse('not_pending', 'Only an announced, pending change can be expedited');
  if (c.active_from !== null && c.active_from <= w.now) refuse('not_pending', 'The change is already in force');
  const reason = i.reason.trim();
  const stmts: Q[] = [
    commitOnChange(
      w,
      { kind: 'change.expedited', detail: { changeId: c.id, kind: c.kind, origin: c.origin, policyId: c.policy_id, reason, wasActiveFrom: c.active_from } },
      c.id,
      null,
      q`g.status = 'pending' AND g.notified_at IS NOT NULL AND g.proposed_by_kind = 'member' AND g.active_from > ${w.now} AND a.deleted_at IS NULL`,
    ),
    q`UPDATE guarded_changes SET active_from = ${w.now}, expedited_by = ${actorId(w.actor)}, expedite_reason = ${reason} WHERE id = ${c.id} AND ${committed(w.requestId)}`,
  ];
  if (c.kind === 'origin_add') {
    stmts.push(q`UPDATE app_origins SET active_from = ${w.now} WHERE app_id = ${c.app_id} AND change_id = ${c.id} AND ${committed(w.requestId)}`);
  } else if (c.kind === 'policy_set') {
    stmts.push(q`UPDATE apps SET auto_approve_effective_at = ${w.now} WHERE id = ${c.app_id} AND auto_approve_pending = ${c.policy_json} AND ${committed(w.requestId)}`);
  } else {
    stmts.push(q`UPDATE apps SET raw_sign_effective_at = ${w.now} WHERE id = ${c.app_id} AND raw_sign_pending = 'approval' AND ${committed(w.requestId)}`);
  }
  await runWrite(db, w.requestId, stmts);
  return { change: changeView({ ...c, active_from: w.now, expedited_by: actorId(w.actor) }) };
}

export { notInForce };
