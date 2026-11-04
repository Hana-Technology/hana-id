// The 5-minute cron (docs/batch-c-spec.md "Crons": admin, every 5 min): the blocking notices first (they hold guarded
// changes, invites and owner grants back), then the security feed, then the on-chain watcher, sharing one budget of
// outbound calls (D280, D380): the ledger connection, every RPC, every email and every NEAR read takes one (mail.ts
// says what counts, from Cloudflare's docs), and each job's share is in the run's summary and its `budget` log line.
// Each step runs on its own: a failing one is logged and the others still run. The notices need no Neon; the feed and
// the watcher keep their state in `ops` (USAGE_DB) and are skipped, with an error line each run, without it. The
// settlement, daily and monthly jobs run in the 15-minute trigger (ledger-cron.ts; C12, C13).
import type { Env } from './env.ts';
import { outbound } from './email/sender.ts';
import { runFeed } from './feed.ts';
import { errorName, log } from './log.ts';
import { Budget, RUN_BUDGET, meteredEnv } from './mail.ts';
import { runNotices } from './notices.ts';
import { type OpsStore, opsSource } from './ops.ts';
import { runWatcher } from './watcher.ts';

export const CRON_LAST_RUN = 'cron.last_run';

export interface RunSummary {
  at: number;
  notices: { acked: number; failed: number } | null;
  feed: boolean;
  watcher: boolean;
  budgetLeft: number;
  /** The run's outbound calls per job (D380): `ops` (the connection), `notices`, `feed`, `watcher`. */
  calls: Record<string, number>;
}

export async function everyFiveMinutes(env: Env, now = Date.now()): Promise<RunSummary> {
  const budget = new Budget();
  // Every RPC of the run goes through the budget: the jobs get only metered bindings.
  const menv = meteredEnv(env, budget);
  const sender = outbound.email(env);
  if (!sender.configured) log({ event: 'cron', step: 'email', outcome: 'skipped', code: 'email_api_key_missing' }, 'error');
  // The ops connection's call is set aside first, so the notices can't leave the feed and the watcher without one.
  if (env.USAGE_DB) await budget.as('ops', async () => budget.take());
  const notices = await budget.as('notices', () => runNotices(menv, sender, budget));
  const acked = (notices.changes?.acked ?? 0) + (notices.members?.acked ?? 0);
  const failed = (notices.changes?.failed ?? 0) + (notices.members?.failed ?? 0);
  const summary: RunSummary = { at: now, notices: notices.changes || notices.members ? { acked, failed } : null, feed: false, watcher: false, budgetLeft: 0, calls: {} };
  let ops: OpsStore | null = null;
  try {
    ops = await opsSource.open(env.USAGE_DB);
    if (!ops) log({ event: 'cron', step: 'ops', outcome: 'skipped', code: 'usage_db_missing' }, 'error');
  } catch (err) {
    log({ event: 'cron', step: 'ops', outcome: 'error', code: 'ops_unavailable', error: errorName(err) }, 'error');
  }
  if (ops) {
    try {
      await budget.as('feed', () => runFeed(menv, ops, sender, budget));
      summary.feed = true;
      try {
        const w = await budget.as('watcher', () => runWatcher(menv, ops, sender, budget, now));
        summary.watcher = true;
        log({ event: 'watcher', step: 'run', outcome: w.failed ? 'rejected' : 'ok', count: w.scopes, sent: w.pendingNotified + w.diffsNotified, failed: w.failed });
      } catch (err) {
        log({ event: 'watcher', step: 'run', outcome: 'error', error: errorName(err) }, 'error');
      }
      summary.budgetLeft = budget.remaining;
      summary.calls = { ...budget.used };
      await ops.setState(CRON_LAST_RUN, JSON.stringify(summary)).catch((err: unknown) => log({ event: 'cron', step: 'last_run', outcome: 'error', error: errorName(err) }, 'warn'));
    } finally {
      await ops.close();
    }
  }
  summary.budgetLeft = budget.remaining;
  summary.calls = { ...budget.used };
  log({ event: 'cron', step: 'budget', outcome: 'ok', count: RUN_BUDGET - budget.remaining, calls: summary.calls });
  log({ event: 'cron', step: 'done', outcome: 'ok', count: acked, failed, sent: RUN_BUDGET - budget.remaining });
  return summary;
}
