// Partner labels' share of the hourly job (D894), as the guarded changes' (guarded/cron.ts):
// - records each version whose time has come and that no review holds, once (`active`, `activated_recorded_at`,
//   `app_changes labels.activated`, a `label_live` security event), and ends the entry's older version in force
//   (`replaced`). Nothing waits for this: `GET /v1/app` serves by the predicate (labels/sql.ts IN_FORCE);
// - lapses a version not announced within 7 days of its proposal (`not_announced`), and one review still holds 7 days
//   after its time (`not_reviewed`), each with its `change.cancelled` row (its reason in the detail).
// Each version is one D1 batch; every write after the first only if the first happened in this run, and each ledger row
// has a request id derived from the version, so two overlapping runs record a version once.
import type { Env } from '../env.ts';
import { eventId } from '../changes/guard.ts';
import { log } from '../log.ts';
import { IN_FORCE, LABEL_LAPSE_MS, REVIEW_HELD, labelTablesExist } from './sql.ts';
import { prepare } from '../changes/sql.ts';

export const LABEL_CRON_BATCH = 100;

export interface LabelsRun {
  activated: number;
  lapsed: number;
}

interface Due {
  id: string;
  label_id: string;
  org_id: string;
  scope_id: string;
  active_from: number;
}

async function apply(db: D1Database, stmts: D1PreparedStatement[], id: string, what: string): Promise<boolean> {
  try {
    await db.batch(stmts);
    return true;
  } catch {
    log({ event: 'labels_cron', outcome: 'error', code: 'write_failed', labelChangeId: id, what }, 'error');
    return false;
  }
}

export async function labelsMaintenance(env: Pick<Env, 'DB'>, now = Date.now()): Promise<LabelsRun> {
  const db = env.DB;
  const run: LabelsRun = { activated: 0, lapsed: 0 };
  if (!(await labelTablesExist(db))) {
    log({ event: 'labels_cron', outcome: 'rejected', code: 'migration_0025_not_applied' }, 'warn');
    return run;
  }
  const inForce = IN_FORCE('c', now);
  const { results: due } = await prepare(
    db,
    { sql: `SELECT c.id, c.label_id, c.org_id, c.scope_id, c.active_from FROM label_changes c WHERE c.status = 'pending' AND ${inForce.sql} ORDER BY c.active_from, c.id LIMIT ?`, args: [...inForce.args, LABEL_CRON_BATCH] },
  ).all<Due>();
  for (const c of due) {
    const recorded = `EXISTS (SELECT 1 FROM label_changes WHERE id = ?1 AND status = 'active' AND activated_recorded_at = ?2)`;
    const live = await eventId('label_live', c.id);
    const stmts = [
      // The review hold is checked again in the statement itself: a review_on or an Allow landing between the job's read
      // and this batch is never overridden.
      db.prepare(`UPDATE label_changes SET status = 'active', activated_recorded_at = ?2 WHERE id = ?1 AND status = 'pending' AND notified_at IS NOT NULL AND active_from <= ?2 AND NOT ${REVIEW_HELD('label_changes').sql}`).bind(c.id, now),
      // The entry's older versions in force end: this one replaced them.
      db.prepare(`UPDATE label_changes SET status = 'ended', end_reason = 'replaced', ended_at = ?2 WHERE label_id = ?3 AND id != ?1 AND status = 'active' AND active_from <= ?4 AND ${recorded}`).bind(c.id, now, c.label_id, c.active_from),
      db
        .prepare(
          `INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id)
           SELECT ?2, ?3, NULL, ?4, 'labels.activated', json_object('changeId', ?1, 'labelId', ?5, 'activeFrom', ?6), 'system', 'cron', ?7 WHERE ${recorded}`,
        )
        .bind(c.id, now, c.org_id, c.scope_id, c.label_id, c.active_from, `cron:labels:activated:${c.id}`),
      db
        .prepare(`INSERT OR IGNORE INTO security_events (id, detected_at, kind, org_id, scope_id, detail_json) SELECT ?3, ?2, 'label_live', ?4, ?5, json_object('changeId', ?1, 'labelId', ?6) WHERE ${recorded}`)
        .bind(c.id, now, live, c.org_id, c.scope_id, c.label_id),
    ];
    if (await apply(db, stmts, c.id, 'activate')) run.activated++;
  }
  const held = REVIEW_HELD('c').sql;
  const { results: stale } = await db
    .prepare(
      `SELECT c.id, c.label_id, c.org_id, c.scope_id, CASE WHEN c.notified_at IS NULL THEN 'not_announced' ELSE 'not_reviewed' END AS reason FROM label_changes c
        WHERE c.status = 'pending' AND ((c.notified_at IS NULL AND c.proposed_at <= ?1) OR (c.notified_at IS NOT NULL AND c.active_from <= ?1 AND ${held}))
        ORDER BY c.proposed_at, c.id LIMIT ?2`,
    )
    .bind(now - LABEL_LAPSE_MS, LABEL_CRON_BATCH)
    .all<Due & { reason: 'not_announced' | 'not_reviewed' }>();
  for (const c of stale) {
    const lapsed = `EXISTS (SELECT 1 FROM label_changes WHERE id = ?1 AND status = 'lapsed' AND cancelled_at = ?2 AND cancelled_by = 'system')`;
    const stmts = [
      // Re-checked in the statement: an Allow (or review turned off) landing after the read keeps the version.
      db
        .prepare(
          `UPDATE label_changes SET status = 'lapsed', end_reason = ?3, cancelled_at = ?2, cancelled_by = 'system'
            WHERE id = ?1 AND status = 'pending' AND ((?3 = 'not_announced' AND notified_at IS NULL AND proposed_at <= ?4) OR (?3 = 'not_reviewed' AND notified_at IS NOT NULL AND active_from <= ?4 AND ${REVIEW_HELD('label_changes').sql}))`,
        )
        .bind(c.id, now, c.reason, now - LABEL_LAPSE_MS),
      db.prepare(`UPDATE scopes SET labels_version = labels_version + 1 WHERE scope_id = ?3 AND ${lapsed}`).bind(c.id, now, c.scope_id),
      db
        .prepare(
          `INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id)
           SELECT ?2, ?3, NULL, ?4, 'change.cancelled', json_object('changeId', ?1, 'kind', 'label_set', 'labelId', ?5, 'reason', ?6), 'system', 'cron', ?7 WHERE ${lapsed}`,
        )
        .bind(c.id, now, c.org_id, c.scope_id, c.label_id, c.reason, `cron:labels:lapsed:${c.id}`),
    ];
    if (await apply(db, stmts, c.id, 'lapse')) run.lapsed++;
  }
  if (run.activated || run.lapsed) log({ event: 'labels_cron', outcome: 'ok', ...run });
  return run;
}
