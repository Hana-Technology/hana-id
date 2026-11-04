// The C12 staff routes and crons in the Worker (the ledger work itself runs on PGlite in test-ops/): every report,
// statement, rate and export route needs a staff Access JWT and a ledger (503 `ledger_unavailable` without one); the
// statement download checks the file against its frozen hash; the rate override is audited through the real console's
// StaffRpc.recordStaffAction; the 15-minute and daily triggers reach their runs and log a missing binding.
import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import worker from '../src/index.ts';
import { type LedgerStore, ledgerSource } from '../src/ledger.ts';
import { FIFTEEN_MINUTES } from '../src/crons.ts';
import { isDailyTick } from '../src/ledger-cron.ts';
import { adminRequest, envWith, json, stubNetwork, useFakeEmail } from './helpers.ts';
import { retentionStub } from './retention-stub.ts';

/** A ledger store that answers empty, with `over` replacing methods; every call is recorded. */
function stubStore(over: Partial<LedgerStore> = {}, calls: string[] = []): LedgerStore {
  const base: LedgerStore = {
    settlementQueue: async () => [],
    relayedWithTx: async () => [],
    recordSettlement: async () => true,
    recordTry: async () => {},
    addSettlementAlert: async () => {},
    settlementAlerts: async () => [],
    markSettlementAlerted: async () => {},
    settlementBacklog: async () => ({ pending: 0, oldestAt: null }),
    lastNonceCheck: async () => null,
    relayedWithNonce: async () => false,
    hasRelayedRows: async () => false,
    relayedSince: async () => 0,
    recordNonceCheck: async () => {},
    nonceChecks: async () => [],
    markNonceAlerted: async () => {},
    ratesBetween: async () => [],
    insertFetchedRate: async () => true,
    overrideRate: async () => 7,
    rateOverrides: async () => [],
    rejectionRates: async () => [],
    addRejectionAlert: async () => true,
    rejectionAlerts: async () => [],
    markRejectionAlerted: async () => {},
    ensurePartitions: async () => 0,
    partitionsAhead: async () => 12,
    report: async () => [],
    ledgerPage: async () => [],
    statements: async () => [],
    blockers: async () => ({ pending: 0, missingRateDays: [] }),
    insertStatement: async () => 'ok',
    unnoticedStatements: async () => [],
    markStatementNoticed: async () => {},
    // The retention job and screen are tested in retention.test.ts and test-ops/; here the month is done.
    retention: retentionStub({ done: true }),
    close: async () => {},
    ...over,
  };
  return new Proxy(base, {
    get(t, p) {
      const v = Reflect.get(t, p) as unknown;
      if (typeof v !== 'function' || typeof p !== 'string') return v;
      return (...args: unknown[]) => {
        calls.push(p);
        return (v as (...a: unknown[]) => unknown)(...args);
      };
    },
  });
}

const ORG = 'org_reportsTest1';
let calls: string[];
beforeEach(async () => {
  await stubNetwork();
  calls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

const withStore = (over: Partial<LedgerStore> = {}) => vi.spyOn(ledgerSource, 'open').mockImplementation(async () => stubStore(over, calls));

describe('the C12 routes', () => {
  it('need a staff Access JWT; without a ledger they answer 503 ledger_unavailable', async () => {
    expect((await adminRequest(`/api/reports?org=${ORG}&from=2026-01-01&to=2026-01-31`, { jwt: null })).status).toBe(401);
    const r = await adminRequest(`/api/reports?org=${ORG}&from=2026-01-01&to=2026-01-31`);
    expect(r.status).toBe(503);
    expect(await json(r)).toMatchObject({ error: { code: 'ledger_unavailable' } });
    for (const path of [`/api/statements?org=${ORG}`, `/api/statements/${ORG}/2026-01`, '/api/rates?month=2026-01']) expect((await adminRequest(path)).status, path).toBe(503);
  });

  it('GET /api/reports reads usage.org_report for any org and refuses a range over 400 days before the ledger', async () => {
    let args: unknown[] = [];
    withStore({
      report: async (...a) => {
        args = a;
        return [{ period: '2026-01', app_id: 'app_1', scope_id: 's1', logins: '4', derives: '0', revokes: '0', unlocks: '0', owner_actions: '0', link_actions: '0', active_users: '3', new_users: '1', identity_tokens: '0', failures: {}, gas: '1000000000000', rejected_gas: '0', error_gas: '0', burnt_yocto: '1', rejected_yocto: '0', error_yocto: '0', usd_micros: '0', rejected_usd_micros: '0', near_usd_rate: null, rate_source: null, login_p50: 5, login_p95: 9, derive_p50: null, derive_p95: null, unsettled: '0', after_statement: '2' }];
      },
    });
    const r = await adminRequest(`/api/reports?org=${ORG}&from=2026-01-01&to=2026-01-31&by=month&apps=app_1`);
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ rows: [{ orgId: ORG, appId: 'app_1', period: '2026-01', logins: 4, activeUsers: 3, tgas: '1', afterStatement: 2 }] });
    expect(args).toEqual([ORG, '2026-01-01', '2026-01-31', 'month', ['app_1'], null]);
    calls.length = 0;
    const bad = await adminRequest(`/api/reports?org=${ORG}&from=2025-01-01&to=2026-02-05`);
    expect(bad.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('serves a statement file only when it still matches its frozen sha256', async () => {
    const bytes = new TextEncoder().encode('month,org_id\n2026-01,org_x\n');
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const key = `statements/${ORG}/2026-01/2026-02-03T00:00:00.000Z.csv`;
    await (env as unknown as Env).STATEMENTS!.put(key, bytes);
    const row = (csvSha: string) => ({ month: '2026-01', as_of_ms: '1', csv_key: key, csv_sha256: csvSha, pdf_key: null, pdf_sha256: null, totals: {}, issued_by: 's', issued_at_ms: '1' });
    withStore({ statements: async () => [row(sha)] });
    const ok = await adminRequest(`/api/statements/${ORG}/2026-01.csv`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-hana-sha256')).toBe(sha);
    expect(await ok.text()).toBe('month,org_id\n2026-01,org_x\n');
    expect((await adminRequest(`/api/statements/${ORG}/2026-01.pdf`)).status).toBe(404);
    vi.restoreAllMocks();
    await stubNetwork();
    withStore({ statements: async () => [row('00'.repeat(32))] });
    const tampered = await adminRequest(`/api/statements/${ORG}/2026-01.csv`);
    expect(tampered.status).toBe(500);
    expect(await json(tampered)).toMatchObject({ error: { message: expect.stringMatching(/does not match its statement hash/u) } });
  });

  it('GET /api/statements/:org/:month of a month not issued answers its blockers', async () => {
    withStore({ blockers: async () => ({ pending: 3, missingRateDays: ['2026-01-31'] }) });
    const r = await adminRequest(`/api/statements/${ORG}/2026-01`);
    expect(await json(r)).toEqual({ statement: null, issuableFrom: Date.UTC(2026, 1, 3), blockers: { pending: 3, missingRateDays: ['2026-01-31'] } });
    // Issuing is refused (the rules themselves are tested on PGlite).
    const issue = await adminRequest(`/api/statements/${ORG}/2026-01/issue`, { body: {} });
    expect(issue.status).toBe(409);
  });

  it('PUT /api/rates/:day: CSRF-checked, validated, the override and its audit row in the real console', async () => {
    let args: unknown[] = [];
    withStore({
      overrideRate: async (...a) => {
        args = a;
        return 41;
      },
    });
    expect((await adminRequest('/api/rates/2026-01-10', { method: 'PUT', body: { usd: '2.5', reason: 'Provider outage, contract source' }, csrf: false })).status).toBe(403);
    for (const body of [{ usd: 2.5, reason: 'Provider outage, contract source' }, { usd: '2.5', reason: 'short' }, { usd: '0', reason: 'Provider outage, contract source' }, { usd: '1.1234567', reason: 'Provider outage, contract source' }]) {
      expect((await adminRequest('/api/rates/2026-01-10', { method: 'PUT', body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await adminRequest('/api/rates/2026-02-30', { method: 'PUT', body: { usd: '2.5', reason: 'Provider outage, contract source' } })).status).toBe(400);
    const r = await adminRequest('/api/rates/2026-01-10', { method: 'PUT', body: { usd: '2.345678', reason: 'Provider outage, contract source' } });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ day: '2026-01-10', usdMicros: '2345678', source: 'manual', overrideId: 41 });
    expect(args).toEqual(['2026-01-10', 2_345_678n, 'staff@hana.example', 'Provider outage, contract source']);
    const audit = await env.CONSOLE_TEST_DB.prepare("SELECT action, target, details_json, actor_kind, actor_email FROM audit_log WHERE action = 'rate.overridden' ORDER BY seq DESC LIMIT 1").first<Record<string, string>>();
    expect(audit).toEqual({ action: 'rate.overridden', target: '2026-01-10', details_json: JSON.stringify({ day: '2026-01-10', usdMicros: '2345678', overrideId: 41 }), actor_kind: 'hana', actor_email: 'staff@hana.example' });
    // A frozen month (a statement exists) is 409.
    vi.restoreAllMocks();
    await stubNetwork();
    withStore({ overrideRate: async () => Promise.reject(Object.assign(new Error('frozen'), { code: '42501' })) });
    expect((await adminRequest('/api/rates/2026-01-10', { method: 'PUT', body: { usd: '2.5', reason: 'Provider outage, contract source' } })).status).toBe(409);
  });

  it('the security screen shows the ledger part: nonce checks, alerts, backlog and partitions', async () => {
    withStore({ partitionsAhead: async () => 1, settlementBacklog: async () => ({ pending: 4, oldestAt: 5 }) });
    const r = await json<{ ledger: Record<string, unknown> }>(await adminRequest('/api/security'));
    expect(r.ledger).toMatchObject({ nonceChecks: [], rejectionAlerts: [], settlementAlerts: [], settlementBacklog: { pending: 4, oldestAt: 5 }, partitionsAhead: 1, partitionsLow: true, relayerAccountSet: true });
  });
});

describe('the C12 crons', () => {
  const DAILY_TICK = Date.UTC(2026, 10, 5, 0, 30);
  const run = async (cron: string, e: Env = env as unknown as Env, scheduledTime = Date.UTC(2026, 10, 5, 3, 15)) => {
    const lines: Record<string, unknown>[] = [];
    const spy = (level: 'log' | 'error' | 'warn') => vi.spyOn(console, level).mockImplementation((s: unknown) => void lines.push(JSON.parse(String(s)) as Record<string, unknown>));
    spy('log');
    spy('error');
    spy('warn');
    await worker.scheduled(createScheduledController({ cron, scheduledTime }), e);
    return lines;
  };

  it('without USAGE_DB, the 15-minute run (the daily one too) is skipped with an error line each time', async () => {
    for (const t of [undefined, DAILY_TICK]) {
      const lines = await run(FIFTEEN_MINUTES, env as unknown as Env, t);
      expect(lines.filter((l) => l.event === 'ledger_cron').map((l) => [l.level, l.code])).toEqual([['error', 'usage_db_missing'], ['info', undefined]]);
      // The run's budget line: nothing taken (no connection, no ledger, so no step ran).
      expect(lines.find((l) => l.event === 'ledger_cron' && l.step === 'budget')).toMatchObject({ count: 0, calls: {} });
    }
  });

  it('the daily work runs in the 00:30 UTC tick only', () => {
    expect(isDailyTick(DAILY_TICK)).toBe(true);
    expect(isDailyTick(DAILY_TICK + 14 * 60_000)).toBe(true);
    for (const t of [DAILY_TICK - 15 * 60_000, DAILY_TICK + 15 * 60_000, DAILY_TICK + 12 * 3_600_000]) expect(isDailyTick(t)).toBe(false);
  });

  it('the 15-minute run reads the pool keys from the real API, then settles; its 00:30 tick checks, keeps partitions, fetches rates', async () => {
    useFakeEmail();
    withStore();
    const fifteen = await run(FIFTEEN_MINUTES);
    expect(fifteen.filter((l) => l.event === 'ledger_cron').map((l) => [l.step, l.outcome])).toEqual([
      ['retention', 'ok'],
      ['alerts', 'ok'],
      ['retention_alerts', 'ok'],
      ['statement_notices', 'ok'],
      ['settlement', 'ok'],
      ['budget', 'ok'],
    ]);
    // The real API's relayerKeys over the service binding is one call of the run's budget (D380).
    expect(fifteen.find((l) => l.event === 'ledger_cron' && l.step === 'budget')).toMatchObject({ count: 1, calls: { relayer_keys: 1 } });
    expect(calls).toContain('settlementQueue');
    calls.length = 0;
    // The rate source isn't reachable from the test: the fetch fails and is counted, never thrown.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('no', { status: 503 }));
    const daily = await run(FIFTEEN_MINUTES, env as unknown as Env, DAILY_TICK);
    expect(daily.filter((l) => l.event === 'ledger_cron').map((l) => [l.step, l.outcome])).toEqual([
      ['nonce_check', 'ok'],
      ['rejection_rate', 'ok'],
      ['partitions', 'ok'],
      ['retention', 'ok'],
      ['alerts', 'ok'],
      ['retention_alerts', 'ok'],
      ['statement_notices', 'ok'],
      ['rates', 'ok'],
      ['settlement', 'ok'],
      ['budget', 'ok'],
    ]);
    expect(calls).toEqual(expect.arrayContaining(['rejectionRates', 'ensurePartitions', 'ratesBetween']));
    // Without RELAYER_ACCOUNT the steps that need it are skipped and logged.
    const lines = await run(FIFTEEN_MINUTES, envWith({ RELAYER_ACCOUNT: undefined } as never) as unknown as Env);
    expect(lines.find((l) => l.step === 'relayer')).toMatchObject({ outcome: 'skipped', code: 'relayer_account_missing' });
    expect(lines.some((l) => l.step === 'settlement')).toBe(false);
  });

  it('the 5-minute trigger still runs the C8 cron', async () => {
    useFakeEmail();
    const lines = await run('*/5 * * * *');
    expect(lines.some((l) => l.event === 'cron' && l.step === 'done')).toBe(true);
    expect(lines.some((l) => l.event === 'ledger_cron')).toBe(false);
  });
});

