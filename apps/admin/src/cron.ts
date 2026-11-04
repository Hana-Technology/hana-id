// The 5-minute cron (docs/batch-c-spec.md "Crons": admin, every 5 min): the blocking notices first (they hold guarded
// changes, invites and owner grants back), then the security feed, then the on-chain watcher, sharing one budget of
// outbound calls (D280). Each step runs on its own: a failing one is logged and the others still run. The notices need
// no Neon; the feed and the watcher keep their state in `ops` (USAGE_DB) and are skipped, with an error line each run,
// without it. The settlement (15 min), daily and monthly jobs come with C12 and C13.
import type { Env } from './env.ts';
import { outbound } from './email/sender.ts';
import { runFeed } from './feed.ts';
import { errorName, log } from './log.ts';
import { Budget, RUN_BUDGET } from './mail.ts';
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
}

export async function everyFiveMinutes(env: Env, now = Date.now()): Promise<RunSummary> {
  const budget = new Budget();
  const sender = outbound.email(env);
  if (!sender.configured) log({ event: 'cron', step: 'email', outcome: 'skipped', code: 'email_api_key_missing' }, 'error');
  const notices = await runNotices(env, sender, budget);
  const acked = (notices.changes?.acked ?? 0) + (notices.members?.acked ?? 0);
  const failed = (notices.changes?.failed ?? 0) + (notices.members?.failed ?? 0);
  const summary: RunSummary = { at: now, notices: notices.changes || notices.members ? { acked, failed } : null, feed: false, watcher: false, budgetLeft: 0 };
  let ops: OpsStore | null = null;
  try {
    ops = await opsSource.open(env.USAGE_DB);
    if (!ops) log({ event: 'cron', step: 'ops', outcome: 'skipped', code: 'usage_db_missing' }, 'error');
  } catch (err) {
    log({ event: 'cron', step: 'ops', outcome: 'error', code: 'ops_unavailable', error: errorName(err) }, 'error');
  }
  if (ops) {
    try {
      await runFeed(env, ops, sender, budget);
      summary.feed = true;
      try {
        const w = await runWatcher(env, ops, sender, budget, now);
        summary.watcher = true;
        log({ event: 'watcher', step: 'run', outcome: w.failed ? 'rejected' : 'ok', count: w.scopes, sent: w.pendingNotified + w.diffsNotified, failed: w.failed });
      } catch (err) {
        log({ event: 'watcher', step: 'run', outcome: 'error', error: errorName(err) }, 'error');
      }
      summary.budgetLeft = budget.remaining;
      await ops.setState(CRON_LAST_RUN, JSON.stringify(summary)).catch((err: unknown) => log({ event: 'cron', step: 'last_run', outcome: 'error', error: errorName(err) }, 'warn'));
    } finally {
      await ops.close();
    }
  }
  summary.budgetLeft = budget.remaining;
  log({ event: 'cron', step: 'done', outcome: 'ok', count: acked, failed, sent: RUN_BUDGET - budget.remaining });
  return summary;
}
