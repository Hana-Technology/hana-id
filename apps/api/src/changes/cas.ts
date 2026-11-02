// Compare-and-swap writes with `app_changes` as the commit point (docs/batch-c-spec.md §RPC "Compare-and-swap writes";
// the CLI's protocol, D207). Every RPC write is one D1 batch (one serialised transaction):
//
// 1. the write's `app_changes` row, inserted only while the compare-and-swap predicate holds (the expected version,
//    the row as read) — or whenever a row with this request id already exists: that insert then violates
//    `app_changes.request_id UNIQUE` and the whole batch aborts, so a replayed request id writes nothing and is
//    answered `already_applied`, whatever the predicate says now;
// 2. every later statement only if that row exists (`committed`). Within the batch it can only be this write's own row
//    (a pre-existing one aborted the batch in step 1), so nothing runs on the strength of an earlier call;
// 3. the commit insert's own change count says whether the write applied; 0 means the state moved since the plan read
//    (`version_conflict`), and nothing else in the batch ran.
//
// No statement depends on another's row count inside SQL (`changes()`); only the D1 result of the commit insert is read,
// in code, after the transaction.
import type { Actor, RpcCode } from '@hana-id/console-core';
import type { HotDb } from './db.ts';
import { type Q, q, raw } from './sql.ts';

/** A refusal with an RpcCode, thrown by the writers and answered `{ok: false, code, error}` by the entrypoints. */
export class RpcRefusal extends Error {
  constructor(
    readonly code: RpcCode,
    message: string,
  ) {
    super(message);
    this.name = 'RpcRefusal';
  }
}

export const refuse = (code: RpcCode, message: string): never => {
  throw new RpcRefusal(code, message);
};

/** Who wrote, as `app_changes` records it (the console's member, Hana staff, a cron, or an emailed link). */
export interface Writer {
  actor: Actor;
  requestId: string;
  now: number;
}

/** The actor columns of `app_changes`. `actor_sub` is only an API-verified step-up's sub (C6), never set here. */
export const actorId = (a: Actor): string => a.id;

/** This write's commit row exists (only ever this batch's own: see the header). */
export const committed = (requestId: string): Q => q`EXISTS (SELECT 1 FROM app_changes WHERE request_id = ${requestId})`;

/** A row with this request id exists: the commit insert then runs and fails on the unique request id (header, 1). */
const replayed = (requestId: string): Q => q`EXISTS (SELECT 1 FROM app_changes WHERE request_id = ${requestId})`;

export interface CommitRow {
  kind: string;
  /** Allowlisted fields only, as JSON (a plain object), or a SQL expression that builds the JSON from the source row. */
  detail: Record<string, unknown> | Q;
}

const detailOf = (d: CommitRow['detail']): Q => ('sql' in d && 'args' in d && Array.isArray((d as Q).args) ? (d as Q) : q`${JSON.stringify(d)}`);

/**
 * The commit row of a write on app `appId` (org, app and scope ids from the apps row `a`), inserted iff `predicate`
 * holds for `a` (or the request id was used before). `orgId` restricts it to the caller's org (ConsoleRpc and the
 * AdminRpc org methods); null for the AdminRpc methods that take an app id alone.
 */
export function commitOnApp(w: Writer, row: CommitRow, appId: string, orgId: string | null, predicate: Q): Q {
  const org = orgId === null ? raw('1') : q`a.org_id = ${orgId}`;
  return q`INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id)
    SELECT ${w.now}, a.org_id, a.id, a.scope_id, ${row.kind}, ${detailOf(row.detail)}, ${w.actor.kind}, ${actorId(w.actor)}, ${w.requestId}
      FROM apps a WHERE a.id = ${appId} AND ((${org} AND ${predicate}) OR ${replayed(w.requestId)})`;
}

/**
 * The commit row of a write on guarded change `changeId` (`g`, joined with its app `a`), inserted iff `predicate`
 * holds (or the request id was used before).
 */
export function commitOnChange(w: Writer, row: CommitRow, changeId: string, orgId: string | null, predicate: Q, actor?: { kind: string; id: string }): Q {
  const org = orgId === null ? raw('1') : q`a.org_id = ${orgId}`;
  return q`INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id)
    SELECT ${w.now}, a.org_id, a.id, a.scope_id, ${row.kind}, ${detailOf(row.detail)}, ${actor?.kind ?? w.actor.kind}, ${actor?.id ?? actorId(w.actor)}, ${w.requestId}
      FROM guarded_changes g JOIN apps a ON a.id = g.app_id WHERE g.id = ${changeId} AND ((${org} AND ${predicate}) OR ${replayed(w.requestId)})`;
}

/** The commit row of a write that is not on one app (an org's contacts, a scope's org, a whole org's suspension). */
export function commitOn(w: Writer, row: CommitRow, ids: { orgId: string; appId?: string | null; scopeId?: string | null }, predicate: Q): Q {
  return q`INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id)
    SELECT ${w.now}, ${ids.orgId}, ${ids.appId ?? null}, ${ids.scopeId ?? null}, ${row.kind}, ${detailOf(row.detail)}, ${w.actor.kind}, ${actorId(w.actor)}, ${w.requestId}
     WHERE (${predicate}) OR ${replayed(w.requestId)}`;
}

/** `seq` of the row a request id already wrote, or null. Selected by every plan read (`replay_seq`). */
export const replaySeq = (requestId: string): Q => q`(SELECT seq FROM app_changes WHERE request_id = ${requestId})`;

/** Answers a replayed request id found by the plan read. */
export function refuseReplay(seq: number | null | undefined): void {
  if (seq !== null && seq !== undefined) refuse('already_applied', `Request already applied (app_changes seq ${seq})`);
}

/**
 * Runs a write's batch (its first statement the commit row). Returns the D1 results when the write applied. A moved
 * state is `version_conflict`; a replayed request id (the batch aborted on the unique request id) `already_applied`.
 */
export async function runWrite(db: HotDb, requestId: string, stmts: readonly Q[]): Promise<D1Result[]> {
  let results: D1Result[];
  try {
    results = await db.batch(stmts);
  } catch (err) {
    // The batch rolled back. Only a used request id is answered; anything else is the caller's internal error.
    const seen = await db.first<{ seq: number }>(q`SELECT seq FROM app_changes WHERE request_id = ${requestId}`);
    if (seen) refuse('already_applied', `Request already applied (app_changes seq ${seen.seq})`);
    throw err;
  }
  if ((results[0]?.meta.changes ?? 0) !== 1) refuse('version_conflict', 'The app changed since it was read: read it again');
  return results;
}

/** In force by the API's predicate: recorded active, or pending with its clock passed (the cron records it later). */
export const IN_FORCE = (now: number): Q => q`(status = 'active' OR (status = 'pending' AND active_from IS NOT NULL AND active_from <= ${now}))`;
/** Pending and not yet in force: what a cancel can still stop, and what "one pending change per kind" counts. */
export const NOT_YET = (now: number, alias = ''): Q => {
  const p = alias ? `${alias}.` : '';
  return q`(${raw(p)}status = 'pending' AND (${raw(p)}active_from IS NULL OR ${raw(p)}active_from > ${now}))`;
};

/**
 * Closes an app's open guarded changes matching `where` (a removal or a turn-off): those in force end, the others are
 * cancelled (they never took effect), all only if this write committed.
 */
export function closeChanges(where: Q, w: Writer): Q {
  const f = IN_FORCE(w.now);
  return q`UPDATE guarded_changes SET status = CASE WHEN ${f} THEN 'ended' ELSE 'cancelled' END,
            ended_at = CASE WHEN ${f} THEN ${w.now} END,
            cancelled_at = CASE WHEN ${f} THEN NULL ELSE ${w.now} END,
            cancelled_by = CASE WHEN ${f} THEN NULL ELSE ${actorId(w.actor)} END
      WHERE ${where} AND status IN ('pending', 'active') AND ${committed(w.requestId)}`;
}
