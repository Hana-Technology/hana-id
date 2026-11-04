// The monthly retention job (D90; docs/batch-c-spec.md "Retention"; batch C13, D360–D369). It rides the 15-minute
// trigger (ledger-cron.ts), as the daily work does (D329): no cron trigger of its own, so the admin Worker keeps two and
// the account stays within the free plan's five. A month's job is due from the 1st, 01:00 UTC, until one run of that
// month completes (`ok`): a run that runs out of its calls ends `partial` and the next 15-minute run continues it; a
// failed run is retried an hour later. Each run is one row of ops.retention_runs (started, finished, rows per table,
// error), shown on the admin's retention screen.
//
// What a run does, in order (each step on its own: a failing one is recorded and the others still run):
//
//   Neon (this run's ledger connection; no outbound call)
//     strip_uids            uids of months that ended 24 months ago, app_users last seen 24 months ago (batches)
//     drop_expired_partitions  months that ended 7 years ago, with their settlements and day counts
//     ops.purge_expired     the admin's own state (400 days, 60 months)
//     retention_due         statements and rates past 7 years, for a person to review (never deleted here)
//   RPC (each call one of the run's outbound calls, D280; at most RETENTION_MAX_CALLS a run)
//     AdminRpc.deletedApps → usage.purge_app_users   apps deleted 30 days ago (a cursor in ops.state)
//     AdminRpc.purgeDirectory                        the wallet directory of scopes left without apps (D363)
//     AdminRpc.purgeAudit, StaffRpc.purgeAudit       audit rows past 60 months, in batches (D364)
//
// Not here: the email issuer's directory and its staff audit, which this Worker has no binding to. They are the
// operator's `admin <env> retention:issuer` (D365); the screen says so. Every number is a count; nothing here reads
// a uid, a sub, an address or a wallet.
import { RETENTION_BATCH, auditCutoff, deletedAppCutoff } from '@hana-id/console-core';
import type { AdminRpcClient, Env, StaffRpcClient } from './env.ts';
import { retentionFailed } from './email/ledger-messages.ts';
import type { MailContext } from './email/messages.ts';
import type { EmailSender } from './email/sender.ts';
import { errorName } from './log.ts';
import { type Budget, recipients, sendToAll } from './mail.ts';
import type { RetentionRows, RetentionRun, RetentionStore } from './retention-store.ts';
import { systemCtx } from './rpc.ts';

/** The job's hour (UTC) on the 1st of each month (the spec's 01:00). */
export const RETENTION_HOUR_UTC = 1;
/** Outbound calls (RPCs) one run may take from the 15-minute run's 40; the rest is the next run's. */
export const RETENTION_MAX_CALLS = 12;
/** strip_uids: rows per call and calls per run (Neon over the run's connection: no outbound call). */
export const STRIP_BATCH = 10_000;
export const STRIP_CALLS = 20;
/** After a failed run, the next attempt waits this long. */
export const RETRY_AFTER_FAILURE_MS = 60 * 60_000;
/** A run still `running` after this long was killed mid-way: closed as failed (`abandoned`). */
export const STALE_RUN_MS = 30 * 60_000;
/** No complete run this long after the month's due time: `retention_failed` (overdue), once a month. */
export const OVERDUE_AFTER_MS = 24 * 60 * 60_000;
/** At most one failure digest per this period; every failure is on the screen at once. */
export const ALERT_EVERY_MS = 24 * 60 * 60_000;

export const DELETED_APPS_CURSOR_KEY = 'retention.deleted_apps_after';
export const ALERTED_AT_KEY = 'retention.alerted_at';
export const OVERDUE_ALERTED_KEY = 'retention.overdue_alerted';

const pad = (n: number) => String(n).padStart(2, '0');
/** `YYYY-MM` of `t` in UTC. */
export const monthKey = (t: number): string => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};
/** The 1st of `t`'s month at RETENTION_HOUR_UTC. */
export const dueAt = (t: number): number => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, RETENTION_HOUR_UTC);
};
/** The next month's due time. */
export const nextDueAt = (t: number): number => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, RETENTION_HOUR_UTC);
};
/** The 15-minute trigger's run at the due time: the 1st, [01:00, 01:15) UTC. */
export const isRetentionTick = (t: number): boolean => t >= dueAt(t) && t < dueAt(t) + 15 * 60_000;

export type DueState =
  | { due: true; month: string; continuing: boolean }
  | { due: false; month: string; why: 'not_yet' | 'done' | 'running' | 'retry_later'; nextAt: number };

/** Whether this month's job should run now, and why not. */
export async function dueState(store: RetentionStore, now: number): Promise<DueState> {
  const month = monthKey(now);
  if (now < dueAt(now)) return { due: false, month, why: 'not_yet', nextAt: dueAt(now) };
  if (await store.monthDone(month)) return { due: false, month, why: 'done', nextAt: nextDueAt(now) };
  const last = await store.latestRun(month);
  if (last?.status === 'running') return { due: false, month, why: 'running', nextAt: now };
  if (last?.status === 'failed' && (last.finishedAt ?? last.startedAt) > now - RETRY_AFTER_FAILURE_MS) {
    return { due: false, month, why: 'retry_later', nextAt: (last.finishedAt ?? last.startedAt) + RETRY_AFTER_FAILURE_MS };
  }
  return { due: true, month, continuing: last?.status === 'partial' };
}

export interface RetentionDeps {
  store: RetentionStore;
  api: Pick<AdminRpcClient, 'purgeAudit' | 'deletedApps' | 'purgeDirectory'>;
  console: Pick<StaffRpcClient, 'purgeAudit'>;
  budget: Budget;
  now: number;
}

export interface RetentionSummary {
  ran: boolean;
  why?: string;
  runId?: number;
  status?: RetentionRun['status'];
  calls: number;
  rows?: RetentionRows;
  error?: string | null;
}

class StepError extends Error {}
/** A step's error as recorded: the step and a code (an RPC code, a SQLSTATE or a class name), never a message. */
const errorCode = (err: unknown): string => {
  if (err instanceof StepError) return err.message;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code) ? `pg_${code}` : errorName(err);
};

/** Runs the month's job when it is due. Returns what it did; never throws for a step's failure. */
export async function runRetention(d: RetentionDeps): Promise<RetentionSummary> {
  await d.store.closeStale(d.now - STALE_RUN_MS, d.now);
  const state = await dueState(d.store, d.now);
  if (!state.due) return { ran: false, why: state.why, calls: 0 };
  const id = await d.store.startRun(state.month, d.now);
  if (id === null) return { ran: false, why: 'running', calls: 0 };

  const rows: RetentionRows = {};
  const add = (k: string, n: number) => void (rows[k] = Number(rows[k] ?? 0) + n);
  const errors: string[] = [];
  let incomplete = false;
  let calls = 0;
  /** One outbound call, if the run and the 15-minute budget still have one; null when out of calls. */
  const rpc = async <T extends object>(step: string, call: () => Promise<({ ok: true } & T) | { ok: false; code: string }>): Promise<T | null> => {
    if (calls >= RETENTION_MAX_CALLS || !d.budget.take()) {
      incomplete = true;
      return null;
    }
    calls++;
    const r = await call();
    if (!r.ok) throw new StepError(`${step}: ${r.code}`);
    return r as T;
  };
  const step = async (name: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      errors.push(err instanceof StepError ? err.message : `${name}: ${errorCode(err)}`);
    }
  };

  await step('strip_uids', async () => {
    for (let k = 0; k < STRIP_CALLS; k++) {
      const r = await d.store.stripUids(STRIP_BATCH);
      add('uidsStripped', r.events);
      add('appUsersExpired', r.appUsers);
      if (!r.more) return;
    }
    incomplete = true;
  });
  await step('drop_expired_partitions', async () => {
    const r = await d.store.dropExpiredPartitions();
    add('partitionsDropped', r.partitions);
    add('settlementsDeleted', r.settlements);
    add('identityTokensDeleted', r.identityTokens);
    add('emailCountsDeleted', r.emailCounts);
    add('settlementAlertsDeleted', r.settlementAlerts);
    add('settlementTriesDeleted', r.settlementTries);
  });
  await step('ops', async () => {
    const r = await d.store.purgeOps();
    add('nonceChecksDeleted', r.nonceChecks);
    add('rejectionAlertsDeleted', r.rejectionAlerts);
    add('scopeWatchDeleted', r.scopeWatch);
    add('retentionRunsDeleted', r.retentionRuns);
    add('erasuresDeleted', r.erasures);
  });
  await step('retention_due', async () => {
    const r = await d.store.due();
    rows.due = { statements: r.statements, rates: r.rates, rateOverrides: r.rateOverrides, oldestStatement: r.oldestStatement };
  });

  await step('deleted_apps', async () => {
    let after = (await d.store.getState(DELETED_APPS_CURSOR_KEY)) ?? undefined;
    for (;;) {
      const page = await rpc<{ appIds: string[]; next?: string; more: boolean }>('deleted_apps', () =>
        d.api.deletedApps({ ...systemCtx(), before: deletedAppCutoff(d.now), limit: RETENTION_BATCH, ...(after ? { after } : {}) }),
      );
      if (!page) return;
      for (const app of page.appIds) {
        add('appUsersPurged', await d.store.purgeAppUsers(app));
        add('deletedAppsPurged', 1);
      }
      // The cursor moves only once every app of the page was purged.
      if (page.next) {
        after = page.next;
        await d.store.setState(DELETED_APPS_CURSOR_KEY, after);
      }
      if (!page.more) return;
    }
  });
  await step('directory', async () => {
    for (;;) {
      const r = await rpc<{ scopes: number; users: number; wallets: number; identities: number }>('directory', () => d.api.purgeDirectory({ ...systemCtx(), before: deletedAppCutoff(d.now), limit: RETENTION_BATCH }));
      if (!r) return;
      add('directoryScopes', r.scopes);
      add('directoryUsers', r.users);
      add('directoryWallets', r.wallets);
      add('directoryIdentities', r.identities);
      if (r.users < RETENTION_BATCH) return;
    }
  });
  await step('api_audit', async () => {
    for (;;) {
      const r = await rpc<{ appChanges: number; guardedChanges: number }>('api_audit', () => d.api.purgeAudit({ ...systemCtx(), before: auditCutoff(d.now), limit: RETENTION_BATCH }));
      if (!r) return;
      add('appChangesDeleted', r.appChanges);
      add('guardedChangesDeleted', r.guardedChanges);
      if (r.appChanges < RETENTION_BATCH && r.guardedChanges < RETENTION_BATCH) return;
    }
  });
  await step('console_audit', async () => {
    for (;;) {
      const r = await rpc<{ auditLog: number; ownerGrants: number }>('console_audit', () => d.console.purgeAudit({ ...systemCtx(), before: auditCutoff(d.now), limit: RETENTION_BATCH }));
      if (!r) return;
      add('auditLogDeleted', r.auditLog);
      add('ownerGrantsDeleted', r.ownerGrants);
      if (r.auditLog < RETENTION_BATCH && r.ownerGrants < RETENTION_BATCH) return;
    }
  });

  rows.calls = calls;
  const status = errors.length ? 'failed' : incomplete ? 'partial' : 'ok';
  const error = errors.length ? errors.join('; ').slice(0, 500) : null;
  // The scheduled time, or the real end when later (a run takes seconds; the tests' clocks are ahead of the real one).
  await d.store.finishRun(id, status, rows, error, Math.max(d.now, Date.now()));
  return { ran: true, runId: id, status, calls, rows, error };
}

const mail = (env: Pick<Env, 'ENV_NAME' | 'CONSOLE_ORIGIN'>): MailContext => ({ env: env.ENV_NAME, consoleOrigin: env.CONSOLE_ORIGIN });

/**
 * `retention_failed` to the security alias (spec "Email": direct): failed runs not yet emailed, as one digest at most
 * every ALERT_EVERY_MS (a failure whose month has since completed is marked without an email: the screen keeps it);
 * and once a month, a month with no complete run OVERDUE_AFTER_MS after its due time (runs that keep ending partial, or
 * none at all). Each send takes the alias's one call; a refused send is retried by the next run.
 */
export async function runRetentionAlerts(
  env: Pick<Env, 'ENV_NAME' | 'CONSOLE_ORIGIN' | 'SECURITY_ALIAS'>,
  store: RetentionStore,
  sender: EmailSender,
  budget: Budget,
  now: number,
): Promise<{ sent: number; failed: number }> {
  const out = { sent: 0, failed: 0 };
  const to = recipients(env.SECURITY_ALIAS);
  const failures = await store.unalertedFailures(20);
  const done = new Map<string, boolean>();
  const monthDone = async (m: string): Promise<boolean> => {
    const known = done.get(m);
    if (known !== undefined) return known;
    const v = await store.monthDone(m);
    done.set(m, v);
    return v;
  };
  const recovered: number[] = [];
  const open: RetentionRun[] = [];
  for (const f of failures) {
    if (await monthDone(f.month)) recovered.push(f.id);
    else open.push(f);
  }
  await store.markAlerted(recovered, now);
  if (open.length) {
    const last = Number((await store.getState(ALERTED_AT_KEY)) ?? 0);
    if (!last || now - last >= ALERT_EVERY_MS) {
      const r = await sendToAll(sender, budget, to, retentionFailed(mail(env), { kind: 'failed', runs: open, retryAfterMs: RETRY_AFTER_FAILURE_MS }), `retention_failed:${open.map((f) => f.id).join(',')}`);
      if (r.allAccepted) {
        await store.markAlerted(
          open.map((f) => f.id),
          now,
        );
        await store.setState(ALERTED_AT_KEY, String(now));
        out.sent++;
      } else out.failed++;
    }
  }
  const month = monthKey(now);
  if (now >= dueAt(now) + OVERDUE_AFTER_MS && !(await monthDone(month)) && (await store.getState(OVERDUE_ALERTED_KEY)) !== month) {
    const latest = await store.latestRun(month);
    const r = await sendToAll(sender, budget, to, retentionFailed(mail(env), { kind: 'overdue', month, dueAt: dueAt(now), latest }), `retention_overdue:${month}`);
    if (r.allAccepted) {
      await store.setState(OVERDUE_ALERTED_KEY, month);
      out.sent++;
    } else out.failed++;
  }
  return out;
}

/**
 * The due run found no ledger (USAGE_DB missing, or Neon unreachable): nothing can be recorded, so `retention_failed`
 * goes out from the due tick only (the provider's idempotency key drops a repeat). Later runs retry silently; the
 * overdue alert covers a month that still has no complete run a day later.
 */
export async function sendRetentionSkipped(env: Pick<Env, 'ENV_NAME' | 'CONSOLE_ORIGIN' | 'SECURITY_ALIAS'>, sender: EmailSender, budget: Budget, now: number, reason: string): Promise<boolean> {
  const r = await sendToAll(sender, budget, recipients(env.SECURITY_ALIAS), retentionFailed(mail(env), { kind: 'skipped', month: monthKey(now), reason }), `retention_skipped:${monthKey(now)}`);
  return r.allAccepted;
}
