// Neon compute on the free plan (D872; docs/operations.md "Neon compute on the free plan"): with `NEON_PLAN` set, every
// usage-ledger connection of the API (and, through `AdminRpc.neonWake`, of the admin Worker) is noted in D1 as a
// wake-up, so the month's compute-hours can be ESTIMATED without Neon's API (packages/console-core/src/neon-compute.ts
// has the model and its limits). One UPSERT per wake-up on the month's row; at 70% and 90% of the allowance one
// `neon_compute_high` security event each a month, which the admin's feed emails. Without NEON_PLAN nothing is written.
//
// Never on a response's path: the usage write is after the response already (`waitUntil`), a cron run's note is at
// its end. Never throws; a failed note is logged (`neon_wake_failed`) and only makes the estimate lower.
import { NEON_ALERT_PCTS, NEON_RUN_KEYS, NEON_SUSPEND_MS, type NeonRunKey, type NeonStatus, alertLevel, allowancePct, awakeMsAt, computeHours, neonMonth, neonPlanOf } from '@hana-id/console-core';
import { eventId } from '../changes/guard.ts';
import type { Env } from '../env.ts';
import { log } from '../log.ts';

/**
 * The month's row after one wake-up `[?2, ?3]` (?3: the connection's close plus NEON_SUSPEND_MS), in one statement: a
 * wake-up after the open window closes it into `closed_ms` and opens its own; one inside it extends it. SQLite's SET
 * reads the row as it was before the update, so the three CASEs agree.
 */
export const NEON_WAKE_SQL = `INSERT INTO neon_compute (month, closed_ms, win_start, win_end, windows, alerted, updated_at) VALUES (?1, 0, ?2, ?3, 1, 0, ?4)
  ON CONFLICT (month) DO UPDATE SET
    closed_ms = CASE WHEN excluded.win_start > neon_compute.win_end THEN neon_compute.closed_ms + (neon_compute.win_end - neon_compute.win_start) ELSE neon_compute.closed_ms END,
    win_start = CASE WHEN excluded.win_start > neon_compute.win_end THEN excluded.win_start ELSE neon_compute.win_start END,
    win_end = CASE WHEN excluded.win_start > neon_compute.win_end THEN excluded.win_end ELSE MAX(neon_compute.win_end, excluded.win_end) END,
    windows = neon_compute.windows + CASE WHEN excluded.win_start > neon_compute.win_end THEN 1 ELSE 0 END,
    updated_at = excluded.updated_at
  RETURNING closed_ms, win_start, win_end, alerted`;

interface WakeRow {
  closed_ms: number;
  win_start: number;
  win_end: number;
  alerted: number;
}

/**
 * Notes that the ledger was open from `startMs` to `endMs`, and raises `neon_compute_high` for each threshold the
 * month's estimate has newly reached. Only with NEON_PLAN. Never throws.
 */
export async function noteNeonWake(env: Pick<Env, 'DB' | 'NEON_PLAN'>, startMs: number, endMs: number, now: number = Date.now()): Promise<void> {
  const plan = neonPlanOf(env.NEON_PLAN);
  if (!plan) return;
  try {
    const month = neonMonth(startMs);
    const row = await env.DB.prepare(NEON_WAKE_SQL).bind(month, startMs, Math.max(startMs, endMs) + NEON_SUSPEND_MS, now).first<WakeRow>();
    if (!row) return;
    const hours = computeHours(awakeMsAt({ closedMs: row.closed_ms, winStart: row.win_start, winEnd: row.win_end }, Math.max(now, endMs)), plan.computeUnits);
    const pct = allowancePct(hours, plan);
    const level = alertLevel(pct);
    if (level <= row.alerted) return;
    // Each threshold newly reached gets its event (fixed id per month and threshold: a repeat is ignored), then the
    // row remembers the level, so later wake-ups write nothing more.
    for (const t of NEON_ALERT_PCTS) {
      if (t <= row.alerted || t > level) continue;
      const detail = { month, threshold: t, hoursUsed: Math.round(hours * 10) / 10, allowanceHours: plan.computeHoursPerMonth, computeUnits: plan.computeUnits, estimate: true };
      await env.DB.prepare("INSERT OR IGNORE INTO security_events (id, detected_at, kind, detail_json) VALUES (?1, ?2, 'neon_compute_high', ?3)")
        .bind(await eventId('neon_compute_high', month, String(t)), now, JSON.stringify(detail))
        .run();
    }
    await env.DB.prepare('UPDATE neon_compute SET alerted = ?2 WHERE month = ?1 AND alerted < ?2').bind(month, level).run();
    log({ event: 'neon_compute_high', outcome: 'ok', code: `pct_${level}` }, 'warn');
  } catch {
    log({ event: 'neon_wake_failed', code: 'd1_unavailable' }, 'warn');
  }
}

/** Runs `fn` (one ledger connection) and notes its wake-up after it, whatever it answered. */
export async function withNeonWake<T>(env: Pick<Env, 'DB' | 'NEON_PLAN'>, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    await noteNeonWake(env, start, Date.now());
  }
}

/** Stores the admin runs' records handed with their wake-up (a newer one only). Never throws. */
export async function storeAdminRuns(env: Pick<Env, 'DB'>, runs: { key: NeonRunKey; value: string }[], now: number = Date.now()): Promise<void> {
  if (runs.length === 0) return;
  try {
    await env.DB.batch(
      runs.map((r) =>
        env.DB.prepare(
          'INSERT INTO neon_admin_runs (key, value_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at WHERE excluded.updated_at >= neon_admin_runs.updated_at',
        ).bind(r.key, r.value, now),
      ),
    );
  } catch {
    log({ event: 'neon_wake_failed', code: 'runs_unwritten' }, 'warn');
  }
}

/** `ApiSystemStatus.neon`: the month's row and the admin runs' records; `off` without NEON_PLAN, `error` when D1 fails. */
export async function neonStatus(env: Pick<Env, 'DB' | 'NEON_PLAN'>, now: number = Date.now()): Promise<NeonStatus> {
  const plan = neonPlanOf(env.NEON_PLAN);
  if (!plan) return { state: 'off' };
  try {
    const month = neonMonth(now);
    const [row, runs] = await Promise.all([
      env.DB.prepare('SELECT closed_ms, win_start, win_end, windows, alerted, updated_at FROM neon_compute WHERE month = ?1').bind(month).first<WakeRow & { windows: number; updated_at: number }>(),
      env.DB.prepare('SELECT key, value_json, updated_at FROM neon_admin_runs').all<{ key: string; value_json: string; updated_at: number }>(),
    ]);
    const out: Partial<Record<NeonRunKey, { value: string; updatedAt: number }>> = {};
    for (const r of runs.results) if ((NEON_RUN_KEYS as readonly string[]).includes(r.key)) out[r.key as NeonRunKey] = { value: r.value_json, updatedAt: Number(r.updated_at) };
    return {
      state: 'on',
      plan,
      readAt: now,
      month,
      row: row ? { closedMs: Number(row.closed_ms), winStart: Number(row.win_start), winEnd: Number(row.win_end), windows: Number(row.windows), alerted: Number(row.alerted), updatedAt: Number(row.updated_at) } : null,
      runs: out,
    };
  } catch {
    return { state: 'error' };
  }
}
