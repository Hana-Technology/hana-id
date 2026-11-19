// Neon compute on the free plan (D872): an ESTIMATE of the month's compute-hours from our own wake-ups, for an env
// whose usage ledger runs on a Neon plan with a monthly allowance (`usage.neonPlan` in the manifest, the `NEON_PLAN`
// var). Neon's exact figure is only in Neon's console or its API (which needs an API key: none is configured; adding
// one is a decision, docs/operations.md "Neon compute on the free plan").
//
// The model. Neon suspends an idle compute after 5 minutes (fixed on the free plan) and counts compute-hours only
// while it runs. Every time one of our Workers has the ledger open from `startMs` to `endMs`, the compute is assumed
// awake from `startMs` to `endMs + NEON_SUSPEND_MS`. Overlapping windows merge (the API keeps one row per UTC month
// in D1, `neon_compute`: the closed windows' total and the open window), so a cron run and a login a minute apart
// count once. compute-hours = awake hours × the compute's size (0.25 CU on sandbox-dev). What it can't see: Neon's
// own wake-ups (none documented), a wake-up by a tool run by hand (`usage-migrate`, the admin CLI's `support:lookup`),
// and the seconds a compute takes to start. A window spanning two months counts in the month it started. Neon's billing
// period is taken to be the calendar month in UTC (check it in Neon's console: the estimate resets on the 1st).
import { z } from '@hana-id/env/zod';
import { ctx } from './types.ts';

/** Neon's free plan suspends a compute after this much idle time (not configurable on the free plan). */
export const NEON_SUSPEND_MS = 5 * 60_000;
/** The month's estimate at or above these shares of the allowance raises `neon_compute_high`, once each a month. */
export const NEON_ALERT_PCTS = [70, 90] as const;
export type NeonAlertPct = (typeof NEON_ALERT_PCTS)[number];

export interface NeonPlan {
  computeHoursPerMonth: number;
  computeUnits: number;
}

/** `NEON_PLAN` (JSON `{computeHoursPerMonth, computeUnits}`, from the manifest), or null when absent or unusable. */
export function neonPlanOf(raw: string | undefined): NeonPlan | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const h = v.computeHoursPerMonth;
    const u = v.computeUnits;
    if (typeof h !== 'number' || !Number.isInteger(h) || h < 1 || h > 100_000) return null;
    if (typeof u !== 'number' || !Number.isFinite(u) || u < 0.25 || u > 56 || !Number.isInteger(u * 4)) return null;
    return { computeHoursPerMonth: h, computeUnits: u };
  } catch {
    return null;
  }
}

/** The UTC month of a time, `YYYY-MM`: the row (and the allowance) a wake-up counts against. */
export const neonMonth = (t: number): string => new Date(t).toISOString().slice(0, 7);

/** The first instant of the month after `month` (ms, UTC): when the estimate starts again from 0. */
export function nextMonthStart(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1);
}

/**
 * One month's row: the closed windows' total, the open window, how many windows, the highest alert raised, and when
 * counting began (`firstAt`: the month's first noted wake-up; after the 1st on the month of the deploy that turned it on).
 */
export interface NeonMonthRow {
  month: string;
  firstAt: number;
  closedMs: number;
  winStart: number;
  winEnd: number;
  windows: number;
  alerted: number;
}

/**
 * The row after one wake-up `[startMs, endMs]` (the same arithmetic as the API's single UPSERT, which is the one that
 * runs; this is its reference, and what the tests check the SQL against). A wake-up after the open window ends closes
 * it and opens a new one; one inside it extends it. A late report: one that starts before the open window but reaches
 * it moves the window's start back; one that ends before the open window began is added to the closed total on its
 * own (it may overlap a closed window: the estimate errs high, never low). Reports start within an hour of the API's
 * clock (`NEON_WAKE_MAX_SKEW_MS`), which bounds both.
 */
export function addWake(row: NeonMonthRow | null, month: string, startMs: number, endMs: number): NeonMonthRow {
  const end = Math.max(startMs, endMs) + NEON_SUSPEND_MS;
  if (!row) return { month, firstAt: startMs, closedMs: 0, winStart: startMs, winEnd: end, windows: 1, alerted: 0 };
  const firstAt = Math.min(row.firstAt, startMs);
  if (startMs > row.winEnd) return { ...row, firstAt, closedMs: row.closedMs + (row.winEnd - row.winStart), winStart: startMs, winEnd: end, windows: row.windows + 1 };
  if (end < row.winStart) return { ...row, firstAt, closedMs: row.closedMs + (end - startMs) };
  return { ...row, firstAt, winStart: Math.min(row.winStart, startMs), winEnd: Math.max(row.winEnd, end) };
}

/** A wake-up report whose start is further than this from the API's clock is refused (`AdminRpc.neonWake`). */
export const NEON_WAKE_MAX_SKEW_MS = 60 * 60_000;

const monthStart = (month: string): number => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return Date.UTC(y, m - 1, 1);
};

/**
 * The crons wake Neon at 00:00 on the 1st, so a month's first wake-up later than this after it is a late start (the
 * month of the deploy that turned counting on), worth saying on the tile.
 */
export const NEON_PARTIAL_AFTER_MS = 30 * 60_000;
/**
 * A start later than this (48 hours) leaves the month partly counted: the tile says so and claims no share of the
 * allowance. Within it the month counts as whole, the hours before the start assumed awake (`assumedAwakeMs`: at most
 * 48 h, 12 compute-hours at 0.25 CU), so the figure errs high.
 */
export const NEON_LATE_START_MS = 48 * 60 * 60_000;

/** Counting began more than 48 hours into the month: the month's figure is partial (D872). */
export const countedPartly = (month: string, firstAt: number): boolean => firstAt - monthStart(month) > NEON_LATE_START_MS;

/** The time before a late start within 48 hours, added to the estimate as if awake (0 for a start on time or a partial month). */
export function assumedAwakeMs(month: string, firstAt: number): number {
  const lead = firstAt - monthStart(month);
  return lead > 0 && lead <= NEON_LATE_START_MS ? lead : 0;
}

/** The month's estimate at `now`: the awake windows counted, plus the assumed-awake hours of a start within 48 h. */
export function estimateAwakeMs(month: string, row: Pick<NeonMonthRow, 'firstAt' | 'closedMs' | 'winStart' | 'winEnd'>, now: number): number {
  return awakeMsAt(row, now) + assumedAwakeMs(month, row.firstAt);
}

/** The month's estimated awake time at `now`: the closed windows, plus the open one up to now (never beyond its end). */
export function awakeMsAt(row: Pick<NeonMonthRow, 'closedMs' | 'winStart' | 'winEnd'>, now: number): number {
  return row.closedMs + Math.max(0, Math.min(now, row.winEnd) - row.winStart);
}

/** compute-hours for an awake time on a compute of `units` CU. */
export const computeHours = (awakeMs: number, units: number): number => (awakeMs / 3_600_000) * units;

/** The estimate's share of the allowance, in % (not rounded). */
export const allowancePct = (hours: number, plan: NeonPlan): number => (hours / plan.computeHoursPerMonth) * 100;

/** The highest alert level an estimate has reached: 0, 70 or 90. */
export function alertLevel(pct: number): 0 | NeonAlertPct {
  let level: 0 | NeonAlertPct = 0;
  for (const p of NEON_ALERT_PCTS) if (pct >= p) level = p;
  return level;
}

/** What one admin run hands the API with its wake-up, so the System status page needn't open Neon (D872). */
export const NEON_RUN_KEYS = ['cron.last_run', 'ledger_cron.last_run', 'ledger.health'] as const;
export type NeonRunKey = (typeof NEON_RUN_KEYS)[number];
/** A run record's JSON at most (they are a few hundred bytes: counts and timestamps). */
export const NEON_RUN_VALUE_MAX = 4096;

/**
 * `AdminRpc.neonWake` (a `system` or `hana` actor): the admin Worker had the ledger open from `startMs` to `endMs`,
 * with, from a cron run, its record (`cron.last_run`, `ledger_cron.last_run`) and the ledger's health as that run saw it
 * (`ledger.health`: `{at, ok, partitionsAhead, settlement}`).
 */
export const neonWakeInput = ctx
  .extend({
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    runs: z
      .array(z.object({ key: z.enum(NEON_RUN_KEYS), value: z.string().min(2).max(NEON_RUN_VALUE_MAX) }).strict())
      .max(NEON_RUN_KEYS.length)
      .optional(),
  })
  .strict()
  .refine((v) => v.endMs >= v.startMs && v.endMs - v.startMs <= 15 * 60_000, { message: 'endMs is at or after startMs, within 15 minutes' });
export type NeonWakeInput = z.infer<typeof neonWakeInput>;

/** `AdminRpc.neonAdminRun` (a `system` or `hana` actor): one admin run's last record as `neonWake` stored it (D872). */
export const neonAdminRunInput = ctx.extend({ key: z.enum(NEON_RUN_KEYS) }).strict();

/**
 * `ApiSystemStatus.neon` (D872): `off` without NEON_PLAN (nothing noted or shown); `error` when D1 couldn't be read;
 * `on` with the month's row (null before the month's first wake-up) and the admin runs' last records.
 */
export type NeonStatus =
  | { state: 'off' }
  | { state: 'error' }
  | {
      state: 'on';
      plan: NeonPlan;
      /** When the API read it (ms). */
      readAt: number;
      month: string;
      row: { firstAt: number; closedMs: number; winStart: number; winEnd: number; windows: number; alerted: number; updatedAt: number } | null;
      /** The admin runs' records, as their runs handed them (`value` is the run's JSON). */
      runs: Partial<Record<NeonRunKey, { value: string; updatedAt: number }>>;
    };
