// The monthly retention job (src/retention.ts; batch C13, D90) on the real migrations as usage_admin, with fake
// AdminRpc / StaffRpc clients and email sender: docs/batch-c-spec.md "Tests: Usage ledger" retention rows (each monthly
// run recorded in ops.retention_runs, a failure alerted and shown) and the build plan's C13 tests: the job's
// idempotence, its failure email, and that it stays within the 15-minute run's call budget (D280).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestDb } from '../../api/test-usage/db.ts';
import { RETENTION_BATCH, userEventsCutoff } from '@hana-id/console-core';
import type { Env } from '../src/env.ts';
import { outbound } from '../src/email/sender.ts';
import { type LedgerStore, ledgerSource } from '../src/ledger.ts';
import { everyFifteenMinutes } from '../src/ledger-cron.ts';
import { Budget, RUN_BUDGET } from '../src/mail.ts';
import {
  ALERT_EVERY_MS,
  DELETED_APPS_CURSOR_KEY,
  OVERDUE_AFTER_MS,
  RETENTION_MAX_CALLS,
  RETRY_AFTER_FAILURE_MS,
  STALE_RUN_MS,
  dueState,
  isRetentionTick,
  runRetention,
  runRetentionAlerts,
} from '../src/retention.ts';
import type { RetentionStore } from '../src/retention-store.ts';
import { ALIAS, FakeEmail, ledgerDb } from './fakes.ts';

let db: TestDb;
let store: LedgerStore;
let r: RetentionStore;
beforeAll(async () => {
  ({ db, store } = await ledgerDb());
  r = store.retention;
});
afterAll(async () => {
  await db.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The due time of a month (the 1st, 01:00 UTC) for a year and month far from the others in this file. */
const due = (y: number, m: number) => Date.UTC(y, m - 1, 1, 1, 0);
const env = { ENV_NAME: 'sandbox-test', CONSOLE_ORIGIN: 'https://console.test', SECURITY_ALIAS: ALIAS };
type Ans = { ok: false; code: string } | ({ ok: true } & Record<string, unknown>);

/** AdminRpc and StaffRpc as the job calls them: answers set per test, every call recorded with its input. */
function fakeRpcs(o: { deleted?: string[][]; full?: boolean; fail?: Partial<Record<'deletedApps' | 'purgeDirectory' | 'userEvents' | 'apiAudit' | 'consoleAudit', string>> } = {}) {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const full = o.full ?? false;
  const pages = [...(o.deleted ?? [])];
  const n = (k: number) => (full ? RETENTION_BATCH : k);
  const answer = (method: string, input: Record<string, unknown>, failKey: keyof NonNullable<typeof o.fail>, ok: () => Record<string, unknown>): Promise<never> => {
    calls.push({ method, input });
    const code = o.fail?.[failKey];
    return Promise.resolve((code ? { ok: false, code } : { ok: true, ...ok() }) as Ans as never);
  };
  return {
    calls,
    api: {
      deletedApps: (c: unknown) =>
        answer('deletedApps', c as Record<string, unknown>, 'deletedApps', () => {
          if (full) return { appIds: [], next: `1:app_page${calls.length}`, more: true };
          const page = pages.shift() ?? [];
          return { appIds: page, ...(page.length ? { next: `1:${page[page.length - 1]}` } : {}), more: pages.length > 0 };
        }),
      purgeDirectory: (c: unknown) => answer('purgeDirectory', c as Record<string, unknown>, 'purgeDirectory', () => ({ scopes: 1, users: n(2), wallets: n(3), identities: n(2) })),
      purgeUserEvents: (c: unknown) => answer('purgeUserEvents', c as Record<string, unknown>, 'userEvents', () => ({ expired: n(4), deadScopes: n(1) })),
      purgeAudit: (c: unknown) => answer('apiPurgeAudit', c as Record<string, unknown>, 'apiAudit', () => ({ appChanges: n(5), guardedChanges: n(1) })),
    },
    console: {
      purgeAudit: (c: unknown) => answer('consolePurgeAudit', c as Record<string, unknown>, 'consoleAudit', () => ({ auditLog: n(7), ownerGrants: n(0) })),
    },
  };
}
const job = (rpcs: ReturnType<typeof fakeRpcs>, now: number, budget = new Budget()) => runRetention({ store: r, api: rpcs.api, console: rpcs.console, budget, now });
const runsOf = async (month: string) => (await r.runs(100)).filter((x) => x.month === month);

describe('when the monthly job runs', () => {
  it('not before the 1st 01:00 UTC; then once: a complete run makes the month done, the next month runs again', async () => {
    const t = due(2031, 1);
    expect(await dueState(r, t - MIN)).toMatchObject({ due: false, why: 'not_yet', nextAt: t });
    expect(isRetentionTick(t)).toBe(true);
    expect(isRetentionTick(t + 15 * MIN)).toBe(false);
    expect(isRetentionTick(due(2031, 1) + DAY)).toBe(false);
    const rpcs = fakeRpcs();
    expect(await job(rpcs, t - MIN)).toMatchObject({ ran: false, why: 'not_yet', calls: 0 });
    expect(rpcs.calls).toEqual([]);

    const first = await job(rpcs, t + 5 * MIN);
    expect(first).toMatchObject({ ran: true, status: 'ok', error: null });
    const [run] = await runsOf('2031-01');
    expect(run).toMatchObject({ status: 'ok', startedAt: t + 5 * MIN, finishedAt: t + 5 * MIN, error: null, alertedAt: null });
    expect(run!.rows).toMatchObject({ directoryUsers: 2, directoryWallets: 3, userEventsExpired: 4, userEventsDeadScopes: 1, appChangesDeleted: 5, guardedChangesDeleted: 1, auditLogDeleted: 7, ownerGrantsDeleted: 0, calls: 5 });
    expect(run!.rows.due).toEqual({ statements: 0, rates: 0, rateOverrides: 0, oldestStatement: null });

    // Idempotent: every later run of the month does nothing and calls nothing.
    const before = rpcs.calls.length;
    for (const later of [t + 20 * MIN, t + 2 * DAY, t + 20 * DAY]) expect(await job(rpcs, later)).toMatchObject({ ran: false, why: 'done', calls: 0 });
    expect(rpcs.calls.length).toBe(before);
    expect(await runsOf('2031-01')).toHaveLength(1);

    // The next month runs again (and its purges find what is left: here, the fakes' counts).
    expect(await job(rpcs, due(2031, 2))).toMatchObject({ ran: true, status: 'ok' });
  });

  it('passes the D90 cutoffs: 60 months for the audit purges, 24 months for user events, 30 days for deleted apps; a system actor', async () => {
    const t = due(2031, 3) + MIN;
    const rpcs = fakeRpcs();
    await job(rpcs, t);
    const byMethod = Object.fromEntries(rpcs.calls.map((c) => [c.method, c.input]));
    expect(byMethod.apiPurgeAudit).toMatchObject({ before: Date.UTC(2026, 2, 1, 1, 1), limit: RETENTION_BATCH, actor: { kind: 'system' } });
    expect(byMethod.consolePurgeAudit).toMatchObject({ before: Date.UTC(2026, 2, 1, 1, 1), limit: RETENTION_BATCH });
    expect(byMethod.deletedApps).toMatchObject({ before: t - 30 * DAY });
    expect(byMethod.purgeDirectory).toMatchObject({ before: t - 30 * DAY });
    expect(byMethod.purgeUserEvents).toMatchObject({ before: Date.UTC(2029, 2, 1, 1, 1), deletedBefore: t - 30 * DAY, limit: RETENTION_BATCH, actor: { kind: 'system' } });
    expect(byMethod.purgeUserEvents!.before).toBe(userEventsCutoff(t));
  });

  it('purges the ledger’s app_users of the deleted apps it is given and keeps the cursor for next month', async () => {
    const uid = (k: number) => Buffer.from(new Uint8Array(16).fill(k));
    for (const [app, k] of [['app_gone1', 1], ['app_gone1', 2], ['app_gone2', 3], ['app_alive', 4]] as const) {
      await db.query("INSERT INTO usage.app_users (app_id, uid, first_seen, last_seen) VALUES ($1, $2, now()::date, now()::date)", [app, uid(k)]);
    }
    const rpcs = fakeRpcs({ deleted: [['app_gone1'], ['app_gone2']] });
    const out = await job(rpcs, due(2031, 4));
    expect(out.rows).toMatchObject({ deletedAppsPurged: 2, appUsersPurged: 3 });
    expect((await db.query<{ a: string }>('SELECT DISTINCT app_id AS a FROM usage.app_users ORDER BY 1')).map((x) => x.a)).toContain('app_alive');
    expect(await db.query("SELECT 1 FROM usage.app_users WHERE app_id IN ('app_gone1', 'app_gone2')")).toEqual([]);
    expect(await r.getState(DELETED_APPS_CURSOR_KEY)).toBe('1:app_gone2');
    const next = fakeRpcs();
    await job(next, due(2031, 5));
    expect(next.calls.find((c) => c.method === 'deletedApps')!.input).toMatchObject({ after: '1:app_gone2' });
  });
});

describe('the user events step (readiness 7.17)', () => {
  it('continues in batches while a page is full, and a failure is recorded as its step while the others run', async () => {
    const t = due(2031, 12);
    const rpcs = fakeRpcs();
    let pages = 0;
    rpcs.api.purgeUserEvents = (c: unknown) => {
      rpcs.calls.push({ method: 'purgeUserEvents', input: c as Record<string, unknown> });
      pages++;
      return Promise.resolve({ ok: true, expired: pages < 3 ? RETENTION_BATCH : 7, deadScopes: pages === 1 ? RETENTION_BATCH : 0 } as never);
    };
    const out = await job(rpcs, t);
    expect(out).toMatchObject({ status: 'ok' });
    expect(pages).toBe(3);
    expect(out.rows).toMatchObject({ userEventsExpired: 2 * RETENTION_BATCH + 7, userEventsDeadScopes: RETENTION_BATCH });

    const failing = fakeRpcs({ fail: { userEvents: 'internal' } });
    const failed = await job(failing, due(2032, 2));
    expect(failed).toMatchObject({ status: 'failed', error: 'user_events: internal' });
    expect(failed.rows).toMatchObject({ directoryUsers: 2, appChangesDeleted: 5, auditLogDeleted: 7 });
    // The month completes on the retry (so this failure is never emailed by the alert tests below).
    expect(await job(fakeRpcs(), due(2032, 2) + RETRY_AFTER_FAILURE_MS)).toMatchObject({ status: 'ok' });
  });
});

describe('the call budget (D280)', () => {
  it('takes at most RETENTION_MAX_CALLS of the 15-minute run’s budget; ends partial and the next run continues', async () => {
    const t = due(2031, 6);
    const rpcs = fakeRpcs({ full: true });
    const budget = new Budget();
    const out = await job(rpcs, t, budget);
    expect(out).toMatchObject({ ran: true, status: 'partial', calls: RETENTION_MAX_CALLS });
    expect(rpcs.calls).toHaveLength(RETENTION_MAX_CALLS);
    expect(budget.remaining).toBe(RUN_BUDGET - RETENTION_MAX_CALLS);
    expect(await dueState(r, t + 15 * MIN)).toMatchObject({ due: true, continuing: true });
    // A run with less left in the budget takes only that.
    const small = new Budget(3);
    const second = await job(rpcs, t + 15 * MIN, small);
    expect(second).toMatchObject({ status: 'partial', calls: 3 });
    expect(small.remaining).toBe(0);
    // No budget at all: the Neon steps still run (they make no outbound call), the RPC steps wait.
    const none = await job(rpcs, t + 30 * MIN, new Budget(0));
    expect(none).toMatchObject({ status: 'partial', calls: 0 });
    // Once the RPCs have nothing left, a run completes.
    const done = await job(fakeRpcs(), t + 45 * MIN);
    expect(done).toMatchObject({ status: 'ok' });
    expect((await runsOf('2031-06')).map((x) => x.status)).toEqual(['ok', 'partial', 'partial', 'partial']);
  });

  it('a whole 15-minute run at the due time stays within its 40 calls with the retention job in it', async () => {
    const t = due(2031, 7);
    const rpcs = fakeRpcs({ full: true });
    vi.spyOn(outbound, 'email').mockReturnValue(new FakeEmail());
    vi.spyOn(ledgerSource, 'open').mockResolvedValue({ ...store, close: async () => {} });
    const sum = await everyFifteenMinutes({ ...env, EMAIL_FROM: 'Hana <no-reply@hana.example>', API: rpcs.api, CONSOLE: rpcs.console } as unknown as Env, t);
    expect(sum!.retention).toMatchObject({ ran: true, status: 'partial', calls: RETENTION_MAX_CALLS });
    expect(RUN_BUDGET - sum!.budgetLeft).toBe(RETENTION_MAX_CALLS);
    expect(rpcs.calls).toHaveLength(RETENTION_MAX_CALLS);
    // The next 15-minute run continues it, again within its own budget.
    const next = await everyFifteenMinutes({ ...env, EMAIL_FROM: 'Hana <no-reply@hana.example>', API: fakeRpcs().api, CONSOLE: fakeRpcs().console } as unknown as Env, t + 15 * MIN);
    expect(next!.retention).toMatchObject({ ran: true, status: 'ok' });
    expect(next!.budgetLeft).toBeGreaterThanOrEqual(RUN_BUDGET - RETENTION_MAX_CALLS);
  });
});

describe('a failure (spec "Email": direct retention_failed)', () => {
  it('records the failed step, runs the others, emails the alias once, retries an hour later; recovered failures are not emailed', async () => {
    const t = due(2031, 8);
    const failing = fakeRpcs({ fail: { purgeDirectory: 'internal' } });
    const out = await job(failing, t);
    expect(out).toMatchObject({ ran: true, status: 'failed', error: 'directory: internal' });
    // The other steps did their part.
    expect(out.rows).toMatchObject({ appChangesDeleted: 5, auditLogDeleted: 7 });
    expect(failing.calls.map((c) => c.method)).toEqual(['deletedApps', 'purgeDirectory', 'purgeUserEvents', 'apiPurgeAudit', 'consolePurgeAudit']);
    expect(out.rows).toMatchObject({ userEventsExpired: 4 });

    const email = new FakeEmail();
    expect(await runRetentionAlerts(env, r, email, new Budget(), t)).toEqual({ sent: 1, failed: 0 });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ to: ALIAS });
    expect(email.sent[0]!.subject).toMatch(/Retention job failed \(1 run\)/u);
    expect(email.sent[0]!.text).toContain('directory: internal');
    // Not again for the same failure.
    expect(await runRetentionAlerts(env, r, email, new Budget(), t + MIN)).toEqual({ sent: 0, failed: 0 });

    // Retried only an hour after the failure.
    expect(await dueState(r, t + 30 * MIN)).toMatchObject({ due: false, why: 'retry_later', nextAt: t + RETRY_AFTER_FAILURE_MS });
    expect(await job(failing, t + 30 * MIN)).toMatchObject({ ran: false, why: 'retry_later' });
    expect(await job(failing, t + RETRY_AFTER_FAILURE_MS)).toMatchObject({ ran: true, status: 'failed' });
    // A second failure within a day of the first email waits (the screen shows it at once)…
    expect(await runRetentionAlerts(env, r, email, new Budget(), t + RETRY_AFTER_FAILURE_MS)).toEqual({ sent: 0, failed: 0 });
    expect(email.sent).toHaveLength(1);
    // …and once the month completes, it is marked without an email.
    expect(await job(fakeRpcs(), t + 2 * RETRY_AFTER_FAILURE_MS)).toMatchObject({ status: 'ok' });
    expect(await runRetentionAlerts(env, r, email, new Budget(), t + ALERT_EVERY_MS + MIN)).toEqual({ sent: 0, failed: 0 });
    expect(email.sent).toHaveLength(1);
    expect(await r.unalertedFailures(10)).toEqual([]);
  });

  it('a refused send is retried by the next run; an RPC that throws is a failure too', async () => {
    const t = due(2031, 9);
    const rpcs = fakeRpcs();
    rpcs.console.purgeAudit = () => Promise.reject(new TypeError('binding gone'));
    expect(await job(rpcs, t)).toMatchObject({ status: 'failed', error: 'console_audit: TypeError' });
    const email = new FakeEmail();
    email.failFor.add(ALIAS);
    // More than a day after the previous test's email.
    const later = t + MIN;
    expect(await runRetentionAlerts(env, r, email, new Budget(), later)).toEqual({ sent: 0, failed: 1 });
    email.failFor.clear();
    expect(await runRetentionAlerts(env, r, email, new Budget(), later + 15 * MIN)).toEqual({ sent: 1, failed: 0 });
    expect(email.sent[0]!.text).toContain('console_audit: TypeError');
  });

  it('overdue: a month with no complete run a day after it was due is emailed once', async () => {
    const t = due(2031, 10);
    await job(fakeRpcs({ full: true }), t); // partial
    const email = new FakeEmail();
    expect(await runRetentionAlerts(env, r, email, new Budget(), t + OVERDUE_AFTER_MS - MIN)).toEqual({ sent: 0, failed: 0 });
    expect(await runRetentionAlerts(env, r, email, new Budget(), t + OVERDUE_AFTER_MS)).toEqual({ sent: 1, failed: 0 });
    expect(email.sent[0]!.subject).toMatch(/Retention job overdue for 2031-10/u);
    expect(email.sent[0]!.text).toContain('partial');
    expect(await runRetentionAlerts(env, r, email, new Budget(), t + OVERDUE_AFTER_MS + HOUR)).toEqual({ sent: 0, failed: 0 });
    expect(email.sent).toHaveLength(1);
  });

  it('skipped: no ledger at the due tick emails once; other ticks do not', async () => {
    const email = new FakeEmail();
    vi.spyOn(outbound, 'email').mockReturnValue(email);
    const noLedger = { ...env, EMAIL_FROM: 'Hana <no-reply@hana.example>' } as unknown as Env;
    expect(await everyFifteenMinutes(noLedger, due(2031, 11) + 5 * MIN)).toBeNull();
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.subject).toMatch(/Retention job skipped for 2031-11/u);
    expect(email.sent[0]!.text).toContain('USAGE_DB is not bound');
    expect(await everyFifteenMinutes(noLedger, due(2031, 11) + 20 * MIN)).toBeNull();
    expect(email.sent).toHaveLength(1);
  });
});

describe('one run at a time', () => {
  it('a second run while one is running does nothing; a run killed mid-way is closed as abandoned and the job goes on', async () => {
    const t = due(2032, 1);
    const id = await r.startRun('2032-01', t);
    expect(id).not.toBeNull();
    expect(await r.startRun('2032-01', t)).toBeNull();
    expect(await job(fakeRpcs(), t + 5 * MIN)).toMatchObject({ ran: false, why: 'running' });
    // Past STALE_RUN_MS the next run closes it, and (an hour after, as for any failure) runs.
    const later = t + STALE_RUN_MS + MIN;
    expect(await job(fakeRpcs(), later)).toMatchObject({ ran: false, why: 'retry_later' });
    const [closed] = await runsOf('2032-01');
    expect(closed).toMatchObject({ status: 'failed', error: 'abandoned: the run did not finish' });
    expect(await job(fakeRpcs(), later + RETRY_AFTER_FAILURE_MS)).toMatchObject({ ran: true, status: 'ok' });
  });
});
