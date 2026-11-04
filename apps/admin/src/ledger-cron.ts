// The ledger's cron (docs/batch-c-spec.md "Crons"; batch C12), one trigger every 15 minutes (D329):
//
//   every run          the alerts not yet sent, the statement notices, then gas settlement with what is left
//   the 00:30 UTC run  first the daily work: the nonce cross-check, the rejection-rate check (the previous day),
//                      `usage.ensure_partitions` (a second keeper beside the API's hourly one, D223); its alerts go out
//                      in the same run, then the NEAR/USD rate, then settlement with what is left
//
// The daily work rides the 15-minute trigger's 00:30 tick rather than a trigger of its own, so the admin Worker has two
// triggers (the free plan allows 5 per account). Each run opens one ledger connection (USAGE_DB, role usage_admin) and
// has one budget of 40 outbound calls (D280): every email, `tx` and `view_access_key` read and rate fetch takes one; the
// security work goes first. Each step runs on its own (a failing one is logged, the others still run), and a run without
// USAGE_DB, or without RELAYER_ACCOUNT for the steps that need it, is skipped with an error line every time.
import type { Env } from './env.ts';
import { runAlerts, runStatementNotices } from './alerts.ts';
import { outbound } from './email/sender.ts';
import type { LedgerStore } from './ledger.ts';
import { ledgerSource } from './ledger.ts';
import { errorName, log } from './log.ts';
import { Budget } from './mail.ts';
import { nearReader } from './near.ts';
import { runNonceCheck } from './nonce-check.ts';
import { coingecko, runRates } from './rates.ts';
import { runRejectionCheck } from './rejections.ts';
import { systemCtx } from './rpc.ts';
import { runSettlement } from './settlement.ts';

/** Months the daily run keeps ahead (the API's USAGE_PARTITION_MONTHS: the two keepers agree). */
export const PARTITION_MONTHS = 12;

async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    const out = await run();
    log({ event: 'ledger_cron', step: name, outcome: 'ok' });
    return out;
  } catch (err) {
    log({ event: 'ledger_cron', step: name, outcome: 'error', error: errorName(err) }, 'error');
    return null;
  }
}

async function withStore<T>(env: Env, run: string, fn: (store: LedgerStore) => Promise<T>): Promise<T | null> {
  let store: LedgerStore | null;
  try {
    store = await ledgerSource.open(env.USAGE_DB);
  } catch (err) {
    log({ event: 'ledger_cron', step: run, outcome: 'error', code: 'ledger_unavailable', error: errorName(err) }, 'error');
    return null;
  }
  if (!store) {
    log({ event: 'ledger_cron', step: run, outcome: 'skipped', code: 'usage_db_missing' }, 'error');
    return null;
  }
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

/** Both pools' public keys from the API (the one source: the API holds the secrets). Null when unreadable. */
async function poolKeys(env: Env): Promise<string[] | null> {
  try {
    const r = await env.API.relayerKeys(systemCtx());
    return r.ok ? r.keys.map((k) => k.publicKey) : null;
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
  alerts: Awaited<ReturnType<typeof runAlerts>> | null;
  notices: Awaited<ReturnType<typeof runStatementNotices>> | null;
  settlement: Awaited<ReturnType<typeof runSettlement>> | null;
  budgetLeft: number;
}

export async function everyFifteenMinutes(env: Env, now = Date.now()): Promise<FifteenSummary | null> {
  return withStore(env, 'fifteen', async (store) => {
    const budget = new Budget();
    const sender = outbound.email(env);
    const relayer = env.RELAYER_ACCOUNT;
    if (!relayer) log({ event: 'ledger_cron', step: 'relayer', outcome: 'skipped', code: 'relayer_account_missing' }, 'error');
    const keys = relayer ? await poolKeys(env) : null;
    if (relayer && !keys) log({ event: 'ledger_cron', step: 'relayer', outcome: 'skipped', code: 'relayer_keys_unavailable' }, 'error');
    const near = nearReader(env.NEAR_RPC);

    let daily: DailySummary | null = null;
    if (isDailyTick(now)) {
      daily = {
        nonce: relayer && keys ? await step('nonce_check', () => runNonceCheck({ store, near, keys, relayerAccount: relayer, budget, now })) : null,
        rejection: await step('rejection_rate', () => runRejectionCheck({ store, now })),
        partitions: await step('partitions', () => store.ensurePartitions(PARTITION_MONTHS)),
        rates: null,
      };
    }
    // The alerts before anything slow: a nonce or rejection alert of this run goes out in this run.
    const alerts = await step('alerts', () => runAlerts(env, store, sender, budget, now));
    const notices = await step('statement_notices', () => runStatementNotices(env, store, sender, budget));
    if (daily) daily.rates = await step('rates', () => runRates({ store, fetchRate: coingecko(env.COINGECKO_API_KEY), budget, now }));
    const settlement = relayer && keys ? await step('settlement', () => runSettlement({ store, near, poolKeys: new Set(keys), relayerAccount: relayer, signerAccount: env.SIGNER_ACCOUNT, budget, now })) : null;
    return { daily, alerts, notices, settlement, budgetLeft: budget.remaining };
  });
}
