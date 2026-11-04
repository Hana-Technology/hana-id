// The hourly guarded-change job (docs/batch-c-spec.md "Guarded changes" → Lifecycle; build plan C3):
// - records each announced change whose clock has passed `active_from`, once (`status = 'active'`,
//   `activated_recorded_at`, `app_changes <kind>.activated`). Nothing waits for this: an origin is in force by the
//   predicate `active_from <= now` (apps.ts) and a policy or raw signing by batch B's `matured()` (vault/settings.ts),
//   so the job changes no answer the gate gives. It also promotes a matured pending policy or raw-signing value into
//   the stored column (pending columns cleared) and ends the policy_set it replaced;
// - cancels a change not announced within ANNOUNCE_WITHIN_MS of its proposal (`system`), so a stuck notice can't leave
//   a change waiting to go live much later: the origin row it added is deleted and the version bumped.
//
// Each change is one D1 batch (one transaction). Every write after the first is conditioned on the first having
// happened in this run (`activated_recorded_at` / `cancelled_at` = this run's `now`), and each `app_changes` row has a
// request id derived from the change, so two overlapping runs record a change once: the second one's batch writes
// nothing or fails on the unique request id and rolls back.
import type { Env } from '../env.ts';
import { log } from '../log.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A change not announced within this long of its proposal is cancelled. */
export const ANNOUNCE_WITHIN_MS = 7 * DAY_MS;
/** At most this many changes per kind of work per run (the rest wait for the next run). */
export const GUARDED_BATCH = 100;

interface DueChange {
  id: string;
  app_id: string;
  kind: 'origin_add' | 'policy_set' | 'raw_sign_on';
  origin: string | null;
  policy_json: string | null;
  policy_id: string | null;
  active_from: number;
  auto_approve_policy: string | null;
  auto_approve_pending: string | null;
  auto_approve_effective_at: number | null;
  raw_sign: string;
  raw_sign_pending: string | null;
  raw_sign_effective_at: number | null;
}

interface StaleChange {
  id: string;
  app_id: string;
  kind: 'origin_add' | 'policy_set' | 'raw_sign_on';
  origin: string | null;
}

export interface GuardedRun {
  activated: number;
  superseded: number;
  expired: number;
}

/** An `app_changes` row for change `?1`, written only when `condition` (over `g`, the change) holds. */
function ledgerFor(db: D1Database, changeId: string, kind: string, detail: string, condition: string, requestId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id)
       SELECT ?2, a.org_id, a.id, a.scope_id, ?3, ${detail}, 'system', 'cron', ?4
         FROM guarded_changes g JOIN apps a ON a.id = g.app_id
        WHERE g.id = ?1 AND ${condition}`,
    )
    .bind(changeId, now, kind, requestId);
}

const ACTIVATED = (now: number) => `g.status = 'active' AND g.activated_recorded_at = ${now}`;
const ACTIVATED_DETAIL = "json_object('changeId', g.id, 'kind', g.kind, 'origin', g.origin, 'policyId', g.policy_id, 'activeFrom', g.active_from)";

/** Whether the change's value is in force now, by the predicates the API serves with (stored, or pending and matured). */
function inForce(c: DueChange, now: number): boolean {
  if (c.kind === 'origin_add') return true;
  if (c.kind === 'policy_set') {
    return c.auto_approve_policy === c.policy_json || (c.auto_approve_pending === c.policy_json && c.auto_approve_effective_at !== null && c.auto_approve_effective_at <= now);
  }
  return c.raw_sign === 'approval' || (c.raw_sign_pending === 'approval' && c.raw_sign_effective_at !== null && c.raw_sign_effective_at <= now);
}

function activationBatch(db: D1Database, c: DueChange, now: number): D1PreparedStatement[] {
  const activate = db
    .prepare("UPDATE guarded_changes SET status = 'active', activated_recorded_at = ?2 WHERE id = ?1 AND status = 'pending' AND active_from <= ?2")
    .bind(c.id, now);
  const kind = c.kind === 'origin_add' ? 'origin.activated' : c.kind === 'policy_set' ? 'policy.activated' : 'raw_sign.activated';
  const recorded = `EXISTS (SELECT 1 FROM guarded_changes WHERE id = ?1 AND status = 'active' AND activated_recorded_at = ?2)`;
  const stmts: D1PreparedStatement[] = [];
  if (c.kind === 'policy_set') {
    // The active policy_set this one replaces ends (only while this one is still pending, so a second run ends nothing).
    stmts.push(
      db
        .prepare(
          `UPDATE guarded_changes SET status = 'ended', ended_at = ?3
            WHERE app_id = ?2 AND kind = 'policy_set' AND status = 'active' AND id != ?1
              AND EXISTS (SELECT 1 FROM guarded_changes WHERE id = ?1 AND status = 'pending')`,
        )
        .bind(c.id, c.app_id, now),
      db
        .prepare(
          `INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id)
           SELECT ?3, a.org_id, a.id, a.scope_id, 'policy.ended', json_object('changeId', g.id, 'policyId', g.policy_id, 'replacedBy', ?1), 'system', 'cron', 'cron:ended:' || g.id
             FROM guarded_changes g JOIN apps a ON a.id = g.app_id
            WHERE g.app_id = ?2 AND g.kind = 'policy_set' AND g.status = 'ended' AND g.ended_at = ?3 AND g.id != ?1
              AND NOT EXISTS (SELECT 1 FROM app_changes WHERE request_id = 'cron:ended:' || g.id)`,
        )
        .bind(c.id, c.app_id, now),
    );
  }
  stmts.push(activate);
  if (c.kind === 'policy_set') {
    stmts.push(
      db
        .prepare(
          `UPDATE apps SET auto_approve_policy = auto_approve_pending, auto_approve_pending = NULL, auto_approve_effective_at = NULL
            WHERE id = ?3 AND auto_approve_pending = ?4 AND auto_approve_effective_at <= ?2 AND ${recorded}`,
        )
        .bind(c.id, now, c.app_id, c.policy_json),
    );
  } else if (c.kind === 'raw_sign_on') {
    stmts.push(
      db
        .prepare(
          `UPDATE apps SET raw_sign = 'approval', raw_sign_pending = NULL, raw_sign_effective_at = NULL
            WHERE id = ?3 AND raw_sign_pending = 'approval' AND raw_sign_effective_at <= ?2 AND ${recorded}`,
        )
        .bind(c.id, now, c.app_id),
    );
  }
  stmts.push(ledgerFor(db, c.id, kind, ACTIVATED_DETAIL, ACTIVATED(now), `cron:activated:${c.id}`, now));
  return stmts;
}

/**
 * A due change whose value is no longer in force or pending in `apps` (a turn-off or a direct D1 write cleared it
 * without ending the change): it never took effect, so it is cancelled by `system` rather than recorded as active.
 */
function supersededBatch(db: D1Database, c: DueChange, now: number): D1PreparedStatement[] {
  return [
    db
      .prepare("UPDATE guarded_changes SET status = 'cancelled', cancelled_by = 'system', cancelled_at = ?2 WHERE id = ?1 AND status = 'pending'")
      .bind(c.id, now),
    ledgerFor(
      db,
      c.id,
      'change.cancelled',
      "json_object('changeId', g.id, 'kind', g.kind, 'policyId', g.policy_id, 'reason', 'not_in_force')",
      `g.status = 'cancelled' AND g.cancelled_by = 'system' AND g.cancelled_at = ${now}`,
      `cron:cancelled:${c.id}`,
      now,
    ),
  ];
}

function expiryBatch(db: D1Database, c: StaleChange, now: number): D1PreparedStatement[] {
  const cancelled = `EXISTS (SELECT 1 FROM guarded_changes WHERE id = ?1 AND status = 'cancelled' AND cancelled_by = 'system' AND cancelled_at = ?2)`;
  const stmts = [
    db
      .prepare(
        "UPDATE guarded_changes SET status = 'cancelled', cancelled_by = 'system', cancelled_at = ?2 WHERE id = ?1 AND status = 'pending' AND notified_at IS NULL",
      )
      .bind(c.id, now),
  ];
  if (c.kind === 'origin_add') {
    stmts.push(
      db.prepare(`DELETE FROM app_origins WHERE app_id = ?3 AND change_id = ?1 AND active_from IS NULL AND ${cancelled}`).bind(c.id, now, c.app_id),
      db.prepare(`UPDATE apps SET origins_version = origins_version + 1 WHERE id = ?3 AND ${cancelled}`).bind(c.id, now, c.app_id),
    );
  } else {
    // Nothing was written to the app's settings before the announcement; the version still bumps (cancel bumps).
    stmts.push(db.prepare(`UPDATE apps SET settings_version = settings_version + 1 WHERE id = ?3 AND ${cancelled}`).bind(c.id, now, c.app_id));
  }
  stmts.push(
    ledgerFor(
      db,
      c.id,
      'change.cancelled',
      "json_object('changeId', g.id, 'kind', g.kind, 'origin', g.origin, 'policyId', g.policy_id, 'reason', 'not_announced')",
      `g.status = 'cancelled' AND g.cancelled_by = 'system' AND g.cancelled_at = ${now}`,
      `cron:cancelled:${c.id}`,
      now,
    ),
  );
  return stmts;
}

/** Runs one batch; a failure (an overlapping run's unique request id, D1 down) is logged and skipped. */
async function apply(db: D1Database, stmts: D1PreparedStatement[], changeId: string, what: string): Promise<boolean> {
  try {
    await db.batch(stmts);
    return true;
  } catch {
    log({ event: 'guarded_change_cron', outcome: 'error', code: 'write_failed', guardedChangeId: changeId, what }, 'error');
    return false;
  }
}

/** The hourly job. Returns what it did (tests); throws only when it can't read D1. */
export async function guardedChangesMaintenance(env: Pick<Env, 'DB'>, now = Date.now()): Promise<GuardedRun> {
  const db = env.DB;
  const run: GuardedRun = { activated: 0, superseded: 0, expired: 0 };
  const { results: due } = await db
    .prepare(
      `SELECT g.id, g.app_id, g.kind, g.origin, g.policy_json, g.policy_id, g.active_from,
              a.auto_approve_policy, a.auto_approve_pending, a.auto_approve_effective_at, a.raw_sign, a.raw_sign_pending, a.raw_sign_effective_at
         FROM guarded_changes g JOIN apps a ON a.id = g.app_id
        WHERE g.status = 'pending' AND g.active_from IS NOT NULL AND g.active_from <= ?1
        ORDER BY g.active_from, g.id LIMIT ?2`,
    )
    .bind(now, GUARDED_BATCH)
    .all<DueChange>();
  for (const c of due) {
    if (inForce(c, now)) {
      if (await apply(db, activationBatch(db, c, now), c.id, 'activate')) run.activated++;
    } else if (await apply(db, supersededBatch(db, c, now), c.id, 'supersede')) run.superseded++;
  }
  const { results: stale } = await db
    .prepare(
      `SELECT id, app_id, kind, origin FROM guarded_changes
        WHERE status = 'pending' AND notified_at IS NULL AND proposed_at <= ?1
        ORDER BY proposed_at, id LIMIT ?2`,
    )
    .bind(now - ANNOUNCE_WITHIN_MS, GUARDED_BATCH)
    .all<StaleChange>();
  for (const c of stale) if (await apply(db, expiryBatch(db, c, now), c.id, 'expire')) run.expired++;
  if (run.activated || run.superseded || run.expired) log({ event: 'guarded_change_cron', outcome: 'ok', ...run });
  return run;
}
