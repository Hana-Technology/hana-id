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

/** What a replayed request id must match to be answered `already_applied` (else `conflict`, D229). */
export interface ReplayExpect {
  /** The write's ledger kinds (one of them). */
  kinds: readonly string[];
  /** The app the write is on (undefined: not compared, e.g. a new app's id). */
  appId?: string | null;
  /** The actor recorded, when it isn't the caller's (a link cancel records the change as its actor). */
  actor?: { kind: string; id: string };
}

/** Who wrote, as `app_changes` records it (the console's member, Hana staff, a cron, or an emailed link). */
export interface Writer {
  actor: Actor;
  requestId: string;
  now: number;
  /** Set by each writer before its plan read: what a replay of its request id must match. */
  expect?: ReplayExpect;
  /** Set by runWrite once the write applied (a no-op or a refusal leaves it unset; the breaker refunds those). */
  wrote?: boolean;
}

/** Declares what this write records, for the replay check (call before the plan read). */
export function expectReplay(w: Writer, kinds: readonly string[], appId?: string | null, actor?: { kind: string; id: string }): void {
  w.expect = { kinds, ...(appId === undefined ? {} : { appId }), ...(actor ? { actor } : {}) };
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

/** The row a request id already wrote (JSON: seq, kind, app and actor), or null. Selected by every plan read (`replay`). */
export const replayRow = (requestId: string): Q =>
  q`(SELECT json_object('seq', seq, 'kind', kind, 'app_id', app_id, 'actor_kind', actor_kind, 'actor_id', actor_id) FROM app_changes WHERE request_id = ${requestId})`;

interface StoredReplay {
  seq: number;
  kind: string;
  app_id: string | null;
  actor_kind: string;
  actor_id: string;
}

/**
 * Answers a request id used before: `already_applied` when the stored row is this write's (same kind, app and actor),
 * `conflict` when the id was used for another write (a caller bug: a retry must resend the same call).
 */
export function refuseReplay(row: string | StoredReplay | null | undefined, w: Writer): void {
  if (row === null || row === undefined) return;
  const r: StoredReplay = typeof row === 'string' ? (JSON.parse(row) as StoredReplay) : row;
  const e = w.expect;
  const actor = e?.actor ?? { kind: w.actor.kind, id: actorId(w.actor) };
  const same = !!e && e.kinds.includes(r.kind) && (e.appId === undefined || e.appId === r.app_id) && actor.kind === r.actor_kind && actor.id === r.actor_id;
  if (!same) refuse('conflict', 'This request id was already used for another write: use a new one');
  refuse('already_applied', `Request already applied (app_changes seq ${r.seq})`);
}

/**
 * Runs a write's batch (its first statement the commit row). Returns the D1 results when the write applied. A moved
 * state is `version_conflict`; a replayed request id (the batch aborted on the unique request id) `already_applied`.
 */
export async function runWrite(db: HotDb, w: Writer, stmts: readonly Q[]): Promise<D1Result[]> {
  let results: D1Result[];
  try {
    results = await db.batch(stmts);
  } catch (err) {
    // The batch rolled back. Only a used request id is answered; anything else is the caller's internal error.
    const seen = await db.first<StoredReplay>(q`SELECT seq, kind, app_id, actor_kind, actor_id FROM app_changes WHERE request_id = ${w.requestId}`);
    if (seen) refuseReplay(seen, w);
    throw err;
  }
  if ((results[0]?.meta.changes ?? 0) !== 1) refuse('version_conflict', 'The app changed since it was read: read it again');
  w.wrote = true;
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
