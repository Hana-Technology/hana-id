// Neon compute on the free plan (D872; docs/operations.md "Neon compute on the free plan"). The usage ledger (Neon)
// suspends its compute after 5 idle minutes, and the free plan allows 100 compute-hours a month. Two settings, both
// from the manifest:
//
//   OPS_EVERY_MINUTES  `admin.opsEveryMinutes`: 5 (absent: the default) or 15 (testnet only, with `usage.neonPlan`).
//                      At 15 the 5-minute trigger sends the blocking notices every run (they need no Neon) but opens
//                      the ledger for the feed and the watcher only in the run at :00, :15, :30 and :45, the minute the
//                      15-minute ledger run (and, at :00, the API's hourly ledger work) wakes Neon anyway: one wake-up
//                      serves all. Each run keeps its own invocation and budget of 40 calls (D280), as before. A
//                      quarter-hour run that didn't report, or reported its feed or watcher failed, is caught up once
//                      by the next 5-minute run (`catchUpDue`, from the record the API keeps: no Neon to decide).
//   NEON_PLAN          `usage.neonPlan`: with it each time this Worker had the ledger open is reported to the API
//                      (`AdminRpc.neonWake`, one RPC), which keeps the month's estimate; the cron runs hand over their
//                      records and the ledger's health with it, so the System status page needn't open Neon.
import { type NeonRunKey, neonPlanOf } from '@hana-id/console-core';
import type { Budget } from './mail.ts';
import type { Env } from './env.ts';
import { log } from './log.ts';
import { systemCtx } from './rpc.ts';

/** The feed and watcher interval: 15 only when the var says exactly that; anything else is the default 5 (more monitoring). */
export const opsEveryMinutesOf = (env: Pick<Env, 'OPS_EVERY_MINUTES'>): 5 | 15 => (env.OPS_EVERY_MINUTES === '15' ? 15 : 5);

const MIN = 60_000;
/** A trigger's minute, to the nearest 5 minutes (a `scheduledTime` a little off the minute still lands on its tick). */
export const tickOf = (scheduledTime: number): number => Math.round(scheduledTime / (5 * MIN)) * 5 * MIN;

/**
 * Whether a 5-minute run at `scheduledTime` opens the ledger for the feed and the watcher: every run at the default,
 * else only the run whose tick is a quarter hour (Cloudflare's `scheduledTime` is the trigger's minute, so the :15 run
 * of `*\/5` and the run of `*\/15` share it).
 */
export const opsDueAt = (env: Pick<Env, 'OPS_EVERY_MINUTES'>, scheduledTime: number): boolean => opsEveryMinutesOf(env) === 5 || (tickOf(scheduledTime) / MIN) % 15 === 0;

/** The part of a 5-minute run's record (`cron.last_run`) the catch-up reads. */
export interface OpsRecord {
  at: number;
  feed: boolean;
  watcher: boolean;
}

/**
 * At 15, whether this (off-quarter) run catches up the feed and the watcher: the quarter hour's run didn't report
 * (no record since the quarter began: missed, crashed, or its report lost), or reported a failed feed or watcher and
 * nothing has caught up since (a record within the quarter's first 5 minutes). So at most one extra wake-up a quarter,
 * and a healthy run is never repeated.
 */
export function catchUpDue(rec: OpsRecord | null, scheduledTime: number): boolean {
  const tick = tickOf(scheduledTime);
  const quarter = tick - (tick % (15 * MIN));
  if (!rec) return true;
  if (rec.at < quarter) return true;
  return rec.at < quarter + 5 * MIN && !(rec.feed && rec.watcher);
}

/** The last 5-minute run's record from the API (`AdminRpc.neonAdminRun`): one call, set aside by the caller. Null when absent or unreadable. */
export async function lastOpsRecord(env: Pick<Env, 'API'>): Promise<{ ok: true; rec: OpsRecord | null } | { ok: false }> {
  try {
    const r = await env.API.neonAdminRun({ ...systemCtx(), key: 'cron.last_run' });
    if (!r.ok) {
      log({ event: 'neon_wake', step: 'last_run', outcome: 'rejected', code: r.code }, 'warn');
      return { ok: false };
    }
    if (!r.run) return { ok: true, rec: null };
    const v = JSON.parse(r.run.value) as Record<string, unknown>;
    return { ok: true, rec: typeof v.at === 'number' ? { at: v.at, feed: v.feed === true, watcher: v.watcher === true } : null };
  } catch {
    log({ event: 'neon_wake', step: 'last_run', outcome: 'error', code: 'upstream_unavailable' }, 'warn');
    return { ok: false };
  }
}

/** For the 5-minute run (cron.ts): due at its tick, else (at 15, with NEON_PLAN) a catch-up when `catchUpDue`. One call for the read, taken here. */
export async function opsDueOrCatchUp(env: Pick<Env, 'API' | 'OPS_EVERY_MINUTES' | 'NEON_PLAN' | 'USAGE_DB'>, budget: Budget, scheduledTime: number): Promise<{ due: boolean; catchUp: boolean }> {
  if (opsDueAt(env, scheduledTime)) return { due: true, catchUp: false };
  if (!tracksNeon(env) || !budget.takeRpc()) return { due: false, catchUp: false };
  const last = await lastOpsRecord(env);
  // The API unreadable: no catch-up (the next quarter hour runs as usual).
  const catchUp = last.ok && catchUpDue(last.rec, scheduledTime);
  return { due: catchUp, catchUp };
}

/** Whether this env reports its ledger wake-ups (NEON_PLAN set and readable, the ledger bound). */
export const tracksNeon = (env: Pick<Env, 'NEON_PLAN' | 'USAGE_DB'>): boolean => env.USAGE_DB !== undefined && neonPlanOf(env.NEON_PLAN) !== null;

/**
 * Reports one wake-up `[startMs, endMs]` to the API (unmetered: a cron run takes this call from its budget when it
 * starts, `budget.takeRpc()` under `neon_mark`). Never throws; false when it wasn't noted.
 */
export async function reportNeonWake(env: Pick<Env, 'API' | 'NEON_PLAN' | 'USAGE_DB'>, startMs: number, endMs: number, runs: { key: NeonRunKey; value: string }[] = []): Promise<boolean> {
  if (!tracksNeon(env)) return false;
  try {
    const r = await env.API.neonWake({ ...systemCtx(), startMs, endMs: Math.min(Math.max(endMs, startMs), startMs + 15 * 60_000), ...(runs.length ? { runs } : {}) });
    if (!r.ok) log({ event: 'neon_wake', outcome: 'rejected', code: r.code }, 'warn');
    return r.ok && r.noted;
  } catch {
    log({ event: 'neon_wake', outcome: 'error', code: 'upstream_unavailable' }, 'warn');
    return false;
  }
}

/**
 * Opens a staff request's store (the clock read before the connection) whose `close` also reports the wake-up (a page
 * that opened the ledger; the page's answer waits for that one RPC). The store as it is without NEON_PLAN.
 */
export async function openTracked<S extends { close(): Promise<void> }>(env: Pick<Env, 'API' | 'NEON_PLAN' | 'USAGE_DB'>, open: () => Promise<S | null>): Promise<S | null> {
  const startMs = Date.now();
  return trackedStore(env, await open(), startMs);
}

/** `openTracked`'s wrapper for a store already open since `startMs`. */
export function trackedStore<S extends { close(): Promise<void> }>(env: Pick<Env, 'API' | 'NEON_PLAN' | 'USAGE_DB'>, store: S | null, startMs: number): S | null {
  if (!store || !tracksNeon(env)) return store;
  // The stores are plain objects of functions (ops.ts sqlOps, ledger.ts sqlLedger): a copy with its own close.
  const close = store.close.bind(store);
  return {
    ...store,
    close: async () => {
      await close();
      await reportNeonWake(env, startMs, Date.now());
    },
  };
}
