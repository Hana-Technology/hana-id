// The ledger's cron (docs/batch-c-spec.md "Crons"; batch C12), one trigger every 15 minutes (D329):
//
//   every run          the alerts not yet sent, the statement notices, then gas settlement with what is left
//   every run          the nonce cross-check's round of the day, from 00:30 UTC: at most three keys a run (D598)
//   the 00:30 UTC run  first the daily work: the rejection-rate check (the previous day),
//                      `usage.ensure_partitions` (a second keeper beside the API's hourly one, D223); its alerts go out
//                      in the same run, then the NEAR/USD rate, then settlement with what is left
//   from the 1st 01:00 the monthly retention job (retention.ts, C13), until a run of the month completes: after the
//                      daily work and before the alerts (its `retention_failed` goes out in the same run), at most
//                      RETENTION_MAX_CALLS of the budget
//
// The daily and monthly work ride the 15-minute trigger rather than triggers of their own, so the admin Worker has two
// triggers (the free plan allows 5 per account; D329, D360). Each run opens one ledger connection (USAGE_DB, role usage_admin) and
// has one budget of 40 outbound calls (D280, D380): the connection, every RPC (`relayerKeys`, the retention RPCs, each
// statement notice's two reads), every email, `tx` and `view_access_key` read and rate fetch takes one (mail.ts says
// what counts, from Cloudflare's docs); the security work goes first. Each job's share is in the run's summary and its
// `budget` log line. Each step runs on its own (a failing one is logged, the others still run), and a run without
// USAGE_DB, or without RELAYER_ACCOUNT for the steps that need it, is skipped with an error line every time.
import type { Env } from './env.ts';
import { runAlerts, runStatementNotices } from './alerts.ts';
import { outbound } from './email/sender.ts';
import type { LedgerStore } from './ledger.ts';
import { ledgerSource } from './ledger.ts';
import { errorName, log } from './log.ts';
import { Budget, RUN_BUDGET, meteredEnv } from './mail.ts';
import { runLinkJumpAlert } from './link-alerts.ts';
import { nearReader } from './near.ts';
import { runNonceCheck } from './nonce-check.ts';
import { coingecko, runRates } from './rates.ts';
import { runRejectionCheck } from './rejections.ts';
import { type RetentionSummary, isRetentionTick, runRetention, runRetentionAlerts, sendRetentionSkipped } from './retention.ts';
import { systemCtx } from './rpc.ts';
import { type RelayerPool, runSettlement } from './settlement.ts';

/**
 * The run's record in `ops.state` (D425): `{at, budgetLeft, calls, failed}` (the steps that threw), written last on the
 * run's open connection (a query, not an outbound call: D380's budget is unchanged). The System status page reads it.
 */
export const LEDGER_LAST_RUN = 'ledger_cron.last_run';

/** Months the daily run keeps ahead (the API's USAGE_PARTITION_MONTHS: the two keepers agree). */
export const PARTITION_MONTHS = 12;

/** One step, on its own, with the calls it takes counted as its share of the budget. */
async function step<T>(budget: Budget, name: string, run: () => Promise<T>, failed?: string[]): Promise<T | null> {
  try {
    const out = await budget.as(name, run);
    log({ event: 'ledger_cron', step: name, outcome: 'ok' });
    return out;
  } catch (err) {
    failed?.push(name);
    log({ event: 'ledger_cron', step: name, outcome: 'error', error: errorName(err) }, 'error');
    return null;
  }
}

async function withStore<T>(env: Env, budget: Budget, run: string, fn: (store: LedgerStore) => Promise<T>, onMissing?: (code: 'ledger_unavailable' | 'usage_db_missing') => Promise<void>): Promise<T | null> {
  let store: LedgerStore | null;
  try {
    // The run's one Hyperdrive connection: one call of the budget (mail.ts), its queries none.
    if (env.USAGE_DB) await budget.as('ledger', async () => budget.take());
    store = await ledgerSource.open(env.USAGE_DB);
  } catch (err) {
    log({ event: 'ledger_cron', step: run, outcome: 'error', code: 'ledger_unavailable', error: errorName(err) }, 'error');
    await onMissing?.('ledger_unavailable');
    return null;
  }
  if (!store) {
    log({ event: 'ledger_cron', step: run, outcome: 'skipped', code: 'usage_db_missing' }, 'error');
    await onMissing?.('usage_db_missing');
    return null;
  }
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

interface Pools {
  keys: { pool: RelayerPool; publicKey: string }[];
  /** Whether the API writes usage events; undefined from an API that doesn't say (judged as on, as before). */
  capture: boolean | undefined;
}

/** Every pool's public keys from the API, each with its pool (the one source: the API holds the secrets). Null when unreadable. */
async function poolKeys(env: Pick<Env, 'API'>): Promise<Pools | null> {
  try {
    const r = await env.API.relayerKeys(systemCtx());
    if (!r.ok) return null;
    // A pool the API couldn't list (a malformed secret, a key in two pools) loses only its own keys: say so every run.
    if (r.unreadablePools?.length) log({ event: 'ledger_cron', step: 'relayer', outcome: 'error', code: 'relayer_pool_unreadable', target: r.unreadablePools.filter((x) => ['session', 'owner', 'home'].includes(x)).join(',') }, 'error');
    return { keys: r.keys, capture: r.capture };
  } catch {
    return null;
  }
}

/** The run that does the daily work: the 15-minute trigger's tick at 00:30 UTC (any time in [00:30, 00:45)). */
export const isDailyTick = (t: number): boolean => {
  const d = new Date(t);
  return d.getUTCHours() === 0 && d.getUTCMinutes() >= 30 && d.getUTCMinutes() < 45;
};

export interface DailySummary {
  nonce: Awaited<ReturnType<typeof runNonceCheck>> | null;
  rejection: Awaited<ReturnType<typeof runRejectionCheck>> | null;
  partitions: number | null;
  rates: Awaited<ReturnType<typeof runRates>> | null;
}

export interface FifteenSummary {
  daily: DailySummary | null;
  /** The nonce check's share of this run (also `daily.nonce` at the 00:30 run). */
  nonce: Awaited<ReturnType<typeof runNonceCheck>> | null;
  retention: RetentionSummary | null;
  alerts: Awaited<ReturnType<typeof runAlerts>> | null;
  retentionAlerts: Awaited<ReturnType<typeof runRetentionAlerts>> | null;
  notices: Awaited<ReturnType<typeof runStatementNotices>> | null;
  settlement: Awaited<ReturnType<typeof runSettlement>> | null;
  budgetLeft: number;
  /** The run's outbound calls per job (D380): `ledger` (the connection), then each step's name. */
  calls: Record<string, number>;
}

export async function everyFifteenMinutes(env: Env, now = Date.now()): Promise<FifteenSummary | null> {
  const budget = new Budget();
  // Every RPC of the run goes through the budget: the jobs get only metered bindings.
  const menv = meteredEnv(env, budget);
  const sender = outbound.email(env);
  // No ledger at the monthly job's due tick: nothing can be recorded, so say so once (retention.ts).
  const onMissing = async (code: string) => {
    if (!isRetentionTick(now)) return;
    const sent = await budget.as('retention_alerts', () => sendRetentionSkipped(env, sender, budget, now, code === 'usage_db_missing' ? 'USAGE_DB is not bound' : 'the usage ledger is unreachable')).catch(() => false);
    log({ event: 'ledger_cron', step: 'retention', outcome: 'skipped', code, sent: sent ? 1 : 0 }, 'error');
  };
  const failed: string[] = [];
  const track = <T>(name: string, run: () => Promise<T>): Promise<T | null> => step(budget, name, run, failed);
  const out = await withStore(env, budget, 'fifteen', async (store) => {
    const relayer = env.RELAYER_ACCOUNT;
    if (!relayer) log({ event: 'ledger_cron', step: 'relayer', outcome: 'skipped', code: 'relayer_account_missing' }, 'error');
    const pools = relayer ? await budget.as('relayer_keys', () => poolKeys(menv)) : null;
    const keys = pools?.keys ?? null;
    if (relayer && !keys) log({ event: 'ledger_cron', step: 'relayer', outcome: 'skipped', code: 'relayer_keys_unavailable' }, 'error');
    const near = nearReader(env.NEAR_RPC);

    // The nonce check, every run: it reads the day's keys not yet tried, a few a run (nonce-check.ts), so at 00:30 UTC
    // it starts the day's round and later runs finish it; with nothing left it makes no call.
    const nonce = relayer && keys ? await track('nonce_check', () => runNonceCheck({ store, near, keys: keys.map((k) => k.publicKey), relayerAccount: relayer, budget, now, captureOn: pools?.capture })) : null;
    let daily: DailySummary | null = null;
    if (isDailyTick(now)) {
      daily = {
        nonce,
        rejection: await track('rejection_rate', () => runRejectionCheck({ store, now })),
        partitions: await track('partitions', () => store.ensurePartitions(PARTITION_MONTHS)),
        rates: null,
      };
    }
    // The monthly job when due (each RPC one call of the budget, at most RETENTION_MAX_CALLS; its Neon work none).
    const retention = await track('retention', () => runRetention({ store: store.retention, api: menv.API, console: menv.CONSOLE, budget, now }));
    // The alerts before anything slow: a nonce, rejection or retention alert of this run goes out in this run.
    const alerts = await track('alerts', () => runAlerts(env, store, sender, budget, now));
    const retentionAlerts = await track('retention_alerts', () => runRetentionAlerts(env, store.retention, sender, budget, now));
    const notices = await track('statement_notices', () => runStatementNotices(menv, store, sender, budget));
    // The link-rate alert (D448): one RPC and at most one email, only when both fit (a clean stop otherwise).
    await track('link_jump', () => runLinkJumpAlert(menv, store.state, sender, budget, now));
    if (daily) daily.rates = await track('rates', () => runRates({ store, fetchRate: coingecko(env.COINGECKO_API_KEY), budget, now }));
    const settlement = relayer && keys ? await track('settlement', () => runSettlement({ store, near, poolKeys: new Map(keys.map((k) => [k.publicKey, k.pool])), relayerAccount: relayer, signerAccount: env.SIGNER_ACCOUNT, budget, now })) : null;
    const summary = { daily, nonce, retention, alerts, retentionAlerts, notices, settlement, budgetLeft: budget.remaining, calls: { ...budget.used } };
    try {
      await store.state.setState(LEDGER_LAST_RUN, JSON.stringify({ at: now, budgetLeft: summary.budgetLeft, calls: summary.calls, failed }));
    } catch (err) {
      log({ event: 'ledger_cron', step: 'last_run', outcome: 'error', error: errorName(err) }, 'warn');
    }
    return summary;
  }, onMissing);
  log({ event: 'ledger_cron', step: 'budget', outcome: 'ok', count: RUN_BUDGET - budget.remaining, calls: { ...budget.used } });
  return out;
}
