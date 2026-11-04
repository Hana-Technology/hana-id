// SQL helpers of the console's data path. Every write is one D1 batch (one serialised transaction) whose first
// statement inserts its audit_log row only while the write's guard holds: that row is the commit point (D243), as
// app_changes is in the hot DB (apps/api/src/changes/cas.ts):
//
// 1. the audit insert runs `WHERE <guard> OR <this request's row exists>`: a replayed request id then violates
//    `audit_log_request_action` (migration 0002), the whole batch aborts and writes nothing;
// 2. every later statement ends `AND <this request's row exists>` (`gate`), so it runs only if step 1 inserted;
// 3. the audit insert's own change count says whether the write applied; 0 means the guard didn't hold, nothing else
//    ran, and the caller reads the state to say why.
//
// Statements use bare `?` placeholders in text order (SQLite numbers each one after the largest so far), and the
// clock as an integer literal (`lit`), so a fragment such as `ownerNow` can appear anywhere without renumbering.
import { RpcRefusal } from './errors.ts';

/** A SQL fragment and its binds, in text order. */
export interface Frag {
  sql: string;
  binds: unknown[];
}

export const frag = (sql: string, ...binds: unknown[]): Frag => ({ sql, binds });

/** An integer (a time in ms) as a SQL literal. Only ever a number the Worker computed, never input text. */
export function lit(n: number): string {
  if (!Number.isSafeInteger(n)) throw new RangeError(`Not a safe integer: ${n}`);
  return String(n);
}

/**
 * Whether member row `m` is an owner at `now` (docs/batch-c-spec.md "Becoming owner"): `role = 'owner'`, or by
 * predicate an uncancelled, unapplied, announced grant whose `owner_from` has passed (the hourly cron records it
 * later). A pending grant (inside its wait) is a viewer.
 */
export function ownerNow(m: string, now: number): string {
  return `(${m}.role = 'owner' OR EXISTS (SELECT 1 FROM owner_grants og WHERE og.org_id = ${m}.org_id AND og.user_id = ${m}.user_id AND og.cancelled_at IS NULL AND og.applied_at IS NULL AND og.notified_at IS NOT NULL AND og.owner_from <= ${lit(now)}))`;
}

/**
 * Whether org `orgExpr` (a SQL expression) has an owner at `now` who isn't disabled, optionally other than user
 * `exceptUser` (a SQL expression): the last-owner rule and the first-owner exception both count only usable owners.
 */
export function orgHasOwner(orgExpr: string, now: number, exceptUser?: string): string {
  return `EXISTS (SELECT 1 FROM members om JOIN console_users ou ON ou.id = om.user_id WHERE om.org_id = ${orgExpr} AND ou.disabled_at IS NULL${exceptUser ? ` AND om.user_id <> ${exceptUser}` : ''} AND ${ownerNow('om', now)})`;
}

/** The commit gate every later statement of a write ends with. */
export function gate(requestId: string, action: string): Frag {
  return frag('EXISTS (SELECT 1 FROM audit_log WHERE request_id = ? AND action = ?)', requestId, action);
}

/** `<sql> AND <gate>`: `sql` must end in a WHERE clause. */
export function gated(db: D1Database, sql: string, binds: unknown[], g: Frag): D1PreparedStatement {
  return db.prepare(`${sql} AND ${g.sql}`).bind(...binds, ...g.binds);
}

/** Whether a D1 error is a replayed request id (the audit commit row's unique index). */
export function isReplay(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed: audit_log\.request_id/u.test(err.message);
}

/** Runs a write's batch; a replayed request id is `already_applied` (same actor, action and target) or `conflict`. */
export async function runBatch(
  db: D1Database,
  stmts: D1PreparedStatement[],
  replay: { requestId: string; action: string; actorKind: string; actorId: string; target: string | null },
): Promise<D1Result[]> {
  try {
    return await db.batch(stmts);
  } catch (err) {
    if (!isReplay(err)) throw err;
    const row = await db
      .prepare('SELECT actor_kind, actor_id, target FROM audit_log WHERE request_id = ? AND action = ?')
      .bind(replay.requestId, replay.action)
      .first<{ actor_kind: string; actor_id: string; target: string | null }>();
    const same = !!row && row.actor_kind === replay.actorKind && row.actor_id === replay.actorId && (replay.target === null || row.target === replay.target);
    throw new RpcRefusal(same ? 'already_applied' : 'conflict', same ? 'This request was already applied' : 'This request id was used for another write');
  }
}

/** The first statement's change count: whether the write applied. */
export const applied = (results: D1Result[]): boolean => (results[0]?.meta.changes ?? 0) > 0;
