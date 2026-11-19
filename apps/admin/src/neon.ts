// Neon compute on the free plan (D872; docs/operations.md "Neon compute on the free plan"). The usage ledger (Neon)
// suspends its compute after 5 idle minutes, and the free plan allows 100 compute-hours a month. Two settings, both
// from the manifest:
//
//   OPS_EVERY_MINUTES  `admin.opsEveryMinutes`: 5 (absent: the default) or 15 (testnet only). At 15 the 5-minute
//                      trigger sends the blocking notices every run (they need no Neon) but opens the ledger for the
//                      feed and the watcher only in the run at :00, :15, :30 and :45, the minute the 15-minute ledger
//                      run (and, at :00, the API's hourly ledger work) wakes Neon anyway: one wake-up serves all. Each
//                      run keeps its own invocation and budget of 40 calls (D280), as before.
//   NEON_PLAN          `usage.neonPlan`: with it each time this Worker had the ledger open is reported to the API
//                      (`AdminRpc.neonWake`, one RPC), which keeps the month's estimate; the cron runs hand over their
//                      records and the ledger's health with it, so the System status page needn't open Neon.
import { type NeonRunKey, neonPlanOf } from '@hana-id/console-core';
import type { Env } from './env.ts';
import { log } from './log.ts';
import { systemCtx } from './rpc.ts';

/** The feed and watcher interval: 15 only when the var says exactly that; anything else is the default 5 (more monitoring). */
export const opsEveryMinutesOf = (env: Pick<Env, 'OPS_EVERY_MINUTES'>): 5 | 15 => (env.OPS_EVERY_MINUTES === '15' ? 15 : 5);

/**
 * Whether a 5-minute run at `scheduledTime` opens the ledger for the feed and the watcher: every run at the default,
 * else only the run whose scheduled minute is a multiple of 15 (Cloudflare's `scheduledTime` is the trigger's minute,
 * so the :15 run of `*\/5` and the run of `*\/15` share it).
 */
export const opsDueAt = (env: Pick<Env, 'OPS_EVERY_MINUTES'>, scheduledTime: number): boolean => opsEveryMinutesOf(env) === 5 || new Date(scheduledTime).getUTCMinutes() % 15 === 0;

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
 * A staff request's store whose `close` also reports the wake-up (a page that opened the ledger). The store as it is
 * without NEON_PLAN.
 */
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
