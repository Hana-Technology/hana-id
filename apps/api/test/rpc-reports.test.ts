// ConsoleRpc.usage, statements and ledger (batch C12, src/usage/reports.ts): they read Neon only, through the owner's
// report functions over the writer binding (their SQL is tested on PGlite in test-usage/reports.test.ts); here the
// transport is replaced so the tests see what is sent. docs/batch-c-spec.md "Tests": ranges over 400 days and more than
// 100 apps refused; another org's rows never returned (the org goes to the function, which filters); `usage`,
// `statements` and `ledger` issue no hot-DB statement; rate-limited per member; never for org_legacy.
import { LEDGER_PAGE } from '@hana-id/console-core';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConsoleRpc } from '../src/rpc/console.ts';
import { ORG_LEDGER_SQL, ORG_REPORT_SQL, ORG_STATEMENTS_SQL, REPORT_LIMITS, reportTransport } from '../src/usage/reports.ts';
import { type DbCount, countingDb, member, newOrg } from './rpc-helpers.ts';

const realRows = reportTransport.rows;
let calls: { sql: string; params: unknown[] }[] = [];
let answer: (sql: string) => Record<string, unknown>[] = () => [];

beforeEach(() => {
  calls = [];
  answer = () => [];
  reportTransport.rows = async (_binding, sql, params) => {
    calls.push({ sql, params });
    return answer(sql);
  };
});
afterEach(() => {
  reportTransport.rows = realRows;
});

const count: DbCount = { reads: 0, batches: 0, statements: 0 };
const rpc = (e: Partial<typeof env> = {}) => new ConsoleRpc(createExecutionContext(), { ...env, DB: countingDb(env.DB, count), ...e } as typeof env);

const reportRow = (over: Record<string, unknown> = {}) => ({
  period: '2026-01-05',
  app_id: 'app_1',
  scope_id: 's1',
  logins: '3',
  derives: '1',
  revokes: '0',
  unlocks: '0',
  owner_actions: '0',
  link_actions: '0',
  active_users: '2',
  new_users: '1',
  identity_tokens: '0',
  failures: { contract_rejected: 1 },
  gas: '32670449867484',
  rejected_gas: '2200000000000',
  error_gas: '0',
  burnt_yocto: '3244726730498400000000',
  rejected_yocto: '220000000000000000000',
  error_yocto: '0',
  usd_micros: '8112',
  rejected_usd_micros: '550',
  near_usd_rate: '2500000',
  rate_source: 'coingecko',
  login_p50: 812,
  login_p95: 1400,
  derive_p50: null,
  derive_p95: null,
  unsettled: '0',
  after_statement: '0',
  ...over,
});

describe('ConsoleRpc.usage', () => {
  it('calls usage.org_report for the member’s org and maps the rows; no hot-DB statement', async () => {
    const org = newOrg();
    answer = () => [reportRow()];
    const before = { ...count };
    const r = await rpc().usage({ ...member(), orgId: org, from: '2026-01-01', to: '2026-01-31', by: 'day', appIds: ['app_1'] });
    expect(r).toEqual({
      ok: true,
      rows: [
        {
          orgId: org,
          appId: 'app_1',
          scopeId: 's1',
          period: '2026-01-05',
          logins: 3,
          derives: 1,
          revokes: 0,
          unlocks: 0,
          ownerActions: 0,
          linkActions: 0,
          identityTokens: 0,
          activeUsers: 2,
          newUsers: 1,
          failuresByCode: { contract_rejected: 1 },
          tgas: '32.670449867484',
          relayedRejectedTgas: '2.2',
          errorTgas: '0',
          burntYocto: '3244726730498400000000',
          relayedRejectedBurntYocto: '220000000000000000000',
          usdMicros: '8112',
          relayedRejectedUsdMicros: '550',
          p50: { login: 812 },
          p95: { login: 1400 },
          unsettled: 0,
          afterStatement: 0,
        },
      ],
    });
    expect(calls).toEqual([{ sql: ORG_REPORT_SQL, params: [org, '2026-01-01', '2026-01-31', 'day', ['app_1']] }]);
    expect(count).toEqual(before);
  });

  it('refuses more than 400 days, more than 100 apps and an inverted range before Neon', async () => {
    const org = newOrg();
    const base = { ...member(), orgId: org, by: 'day' as const };
    for (const bad of [
      { ...base, from: '2025-01-01', to: '2026-02-05' },
      { ...base, from: '2026-02-01', to: '2026-01-01' },
      { ...base, from: '2026-01-01', to: '2026-01-31', appIds: Array.from({ length: 101 }, (_, i) => `app_${i}`) },
    ]) {
      expect(await rpc().usage(bad)).toMatchObject({ ok: false, code: 'bad_request' });
    }
    expect(calls).toEqual([]);
    expect(await rpc().usage({ ...base, from: '2025-01-01', to: '2026-02-04' })).toMatchObject({ ok: true });
  });

  it('takes member actors only, never for org_legacy, and needs the ledger binding', async () => {
    const input = { orgId: newOrg(), from: '2026-01-01', to: '2026-01-02', by: 'month' };
    expect(await rpc().usage({ ...input, actor: { kind: 'hana', id: 'staff', email: 'staff@hana.example' }, requestId: 'req_12345678', clientIp: '1.2.3.4' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await rpc().usage({ ...member(), ...input, orgId: 'org_legacy' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await rpc({ USAGE_DB: undefined }).usage({ ...member(), ...input })).toMatchObject({ ok: false, code: 'internal' });
    expect(calls).toEqual([]);
  });

  it('is rate-limited per member', async () => {
    const m = member();
    const max = REPORT_LIMITS[0]!.max;
    const input = { ...m, orgId: newOrg(), from: '2026-01-01', to: '2026-01-02', by: 'day' as const };
    for (let k = 0; k < max; k++) expect((await rpc().usage({ ...input, requestId: `req_limit_${k}` })).ok).toBe(true);
    expect(await rpc().usage(input)).toMatchObject({ ok: false, code: 'rate_limited' });
    // Another member of the same org isn't held back.
    expect((await rpc().usage({ ...input, ...member() })).ok).toBe(true);
  });

  it('a Neon failure is internal, never a half answer', async () => {
    reportTransport.rows = async () => {
      throw new Error('connection refused');
    };
    expect(await rpc().usage({ ...member(), orgId: newOrg(), from: '2026-01-01', to: '2026-01-02', by: 'day' })).toEqual({ ok: false, code: 'internal' });
  });
});

describe('ConsoleRpc.statements and ledger', () => {
  it('lists the org’s statements with their totals; refuses totals that don’t match the stored shape', async () => {
    const org = newOrg();
    const totals = {
      v: 1,
      orgId: org,
      orgName: 'Acme',
      month: '2026-01',
      asOf: 1_800_000_000_000,
      network: 'testnet',
      rows: [],
      sum: { logins: 0, derives: 0, revokes: 0, unlocks: 0, ownerActions: 0, linkActions: 0, identityTokens: 0, newUsers: 0, tgas: '0', relayedRejectedTgas: '0', errorTgas: '0', near: '0', relayedRejectedNear: '0', usd: '0', relayedRejectedUsd: '0', unsettled: 0 },
      billed: { tgas: '0', near: '0', usd: '0' },
      notBilled: { relayedRejectedTgas: '0', relayedRejectedNear: '0', relayedRejectedUsd: '0' },
    };
    answer = () => [{ month: '2026-01', as_of_ms: '1800000000000', csv_key: 'k.csv', csv_sha256: 'ab'.repeat(32), pdf_key: 'k.pdf', pdf_sha256: 'cd'.repeat(32), totals, issued_by: 'staff@hana.example', issued_at_ms: '1800000001000' }];
    const before = { ...count };
    const r = await rpc().statements({ ...member(), orgId: org });
    expect(r).toEqual({ ok: true, statements: [{ orgId: org, month: '2026-01', asOf: 1_800_000_000_000, csvSha256: 'ab'.repeat(32), pdfSha256: 'cd'.repeat(32), issuedBy: 'staff@hana.example', issuedAt: 1_800_000_001_000, totals }] });
    expect(calls).toEqual([{ sql: ORG_STATEMENTS_SQL, params: [org] }]);
    expect(count).toEqual(before);
    answer = () => [{ month: '2026-01', as_of_ms: '1', csv_key: 'k', csv_sha256: 'ab'.repeat(32), pdf_key: null, pdf_sha256: null, totals: { v: 2 }, issued_by: 's', issued_at_ms: '1' }];
    expect(await rpc().statements({ ...member(), orgId: org })).toEqual({ ok: false, code: 'internal' });
  });

  it('pages the ledger with a cursor and pins every page to one as_of', async () => {
    const org = newOrg();
    const row = (k: number) => ({ request_id: `req_${String(k).padStart(8, '0')}`, at_ms: String(1_800_000_000_000 + k), org_id: org, scope_id: 's1', app_id: 'app_1', endpoint: 'login', outcome: 'ok', relayed: false, near_tx: null, gas_status: 'none', gas_burnt: null, tokens_burnt: null });
    answer = () => Array.from({ length: LEDGER_PAGE }, (_, k) => row(k));
    const before = { ...count };
    const first = await rpc().ledger({ ...member(), orgId: org, month: '2026-01' });
    if (!first.ok) throw new Error(first.code);
    expect(first.rows).toHaveLength(LEDGER_PAGE);
    expect(first.next).toBe(`req_${String(LEDGER_PAGE - 1).padStart(8, '0')},${1_800_000_000_000 + LEDGER_PAGE - 1}`);
    expect(calls[0]!.sql).toBe(ORG_LEDGER_SQL);
    expect(calls[0]!.params).toEqual([org, '2026-01-01', new Date(first.asOf).toISOString(), null, LEDGER_PAGE]);
    answer = () => [row(5000)];
    const second = await rpc().ledger({ ...member(), orgId: org, month: '2026-01', asOf: first.asOf, after: first.next });
    expect(second).toMatchObject({ ok: true, asOf: first.asOf });
    expect(second.ok && second.next).toBeFalsy();
    expect(calls[1]!.params).toEqual([org, '2026-01-01', new Date(first.asOf).toISOString(), first.next, LEDGER_PAGE]);
    expect(count).toEqual(before);
    expect(await rpc().ledger({ ...member(), orgId: org, month: '2026-1' })).toMatchObject({ ok: false, code: 'bad_request' });
  });
});
