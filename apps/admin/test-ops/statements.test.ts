// Monthly statements (src/statements.ts, statement.ts, statement-pdf.ts) on the real migrations as usage_admin:
// docs/batch-c-spec.md "Tests: Usage ledger": refused before the 3rd, with an unsettled event or a missing rate; a
// second issue refused; a rate change refused once the month has a statement; late events excluded by as_of and listed;
// the golden CSV (byte-stable: quoting, injection cases, negative numbers unprefixed, scope rows, totals); the ledger
// CSV's final gas for the same as_of equals the statement's tgas and near; and D92: the CSV, the PDF and the on-screen
// statement show identical totals and the CSV's sha256, the rejected line separate and marked not billed.
import { inflateSync } from 'node:zlib';
import { type ReportSqlRow, STATEMENT_CSV_COLUMNS, formatNear, formatTgas, statementView } from '@hana-id/console-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from '../../api/test-usage/db.ts';
import { runStatementNotices } from '../src/alerts.ts';
import type { LedgerStore } from '../src/ledger.ts';
import { Budget } from '../src/mail.ts';
import { buildStatement } from '../src/statement.ts';
import { statementPdf } from '../src/statement-pdf.ts';
import { exportLedger, issuableFrom, issueStatement, ledgerCsv, sha256Hex, statementKey } from '../src/statements.ts';
import { ALIAS, FakeBucket, FakeEmail, STAFF, fakeRpcs, insertEvent, ledgerDb, utc } from './fakes.ts';

let db: TestDb;
let store: LedgerStore;
beforeAll(async () => {
  ({ db, store } = await ledgerDb(['2025_01', '2025_02', '2025_03']));
});
afterAll(async () => {
  await db.close();
});

const ORG = 'org_acme';
const JAN = '2025-01';
const ISSUE_AT = utc('2025-02-04T00:00:00.000Z');

/** Every PDF text run (the content streams inflated, their hex strings decoded from WinAnsi). */
function pdfText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1');
  const out: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/gu)) {
    let body: string;
    try {
      body = inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const t of body.matchAll(/<([0-9A-Fa-f]*)> Tj/gu)) out.push(Buffer.from(t[1]!, 'hex').toString('latin1'));
  }
  return out.join('\n');
}

const rates = async (from: string, to: string, micros = 2_500_000) =>
  db.query("INSERT INTO usage.near_usd_rates (day, usd_micros, source) SELECT d::date, $3, 'coingecko' FROM generate_series($1::date, $2::date, interval '1 day') d ON CONFLICT DO NOTHING", [from, to, micros]);
const settle = (e: { rid: string; at: number; tx: string | null }, gas: bigint, tokens: bigint) =>
  store.recordSettlement({ requestId: e.rid, at: e.at, nearTx: e.tx!, result: 'final', gasBurnt: gas, tokensBurnt: tokens });

describe('issuing a statement', () => {
  const rpcs = fakeRpcs({ billingEmail: 'billing@acme.example', apps: [{ id: 'app_1', name: 'Acme web', scopeId: 's1', environment: 'live' }, { id: 'app_2', name: '=HYPERLINK("x")', scopeId: 's1', environment: 'live' }] });
  const bucket = new FakeBucket();
  const deps = (now: number) => ({ store, api: rpcs.api, console: rpcs.console, bucket, network: 'testnet', staff: STAFF, now });
  let pending: { rid: string; at: number; tx: string | null };

  beforeAll(async () => {
    const a = await insertEvent(db, { org: ORG, app: 'app_1', at: utc('2025-01-05T10:00:00Z'), relayed: true, uid: 1, latency: 700 });
    const b = await insertEvent(db, { org: ORG, app: 'app_1', at: utc('2025-01-05T11:00:00Z'), relayed: true, outcome: 'rejected', code: 'contract_rejected' });
    const c = await insertEvent(db, { org: ORG, app: 'app_2', at: utc('2025-01-31T23:59:59.999Z'), endpoint: 'derive', relayed: true, uid: 2, latency: 2100 });
    const o = await insertEvent(db, { org: ORG, app: null, scope: 's1', endpoint: 'owner_action', at: utc('2025-01-20T00:00:00Z'), relayed: true });
    await insertEvent(db, { org: ORG, app: 'app_1', at: utc('2025-01-06T00:00:00Z'), outcome: 'rejected', code: 'bad_token' });
    await settle(a, 30_000_000_000_000n, 3_000_000_000_000_000_000_000n);
    await settle(b, 2_200_000_000_000n, 220_000_000_000_000_000_000n);
    await settle(c, 12_345_678_901_234n, 1_234_567_890_123_400_000_000n);
    await settle(o, 5_000_000_000_000n, 500_000_000_000_000_000_000n);
    pending = await insertEvent(db, { org: ORG, app: 'app_1', at: utc('2025-01-10T00:00:00Z'), relayed: true });
    // Another org's event in the same month never enters the statement.
    await insertEvent(db, { org: 'org_other', app: 'app_9', at: utc('2025-01-05T10:00:00Z') });
  });

  it('is refused before the 3rd of the next month 00:00 UTC', async () => {
    expect(issuableFrom(JAN)).toBe(utc('2025-02-03T00:00:00.000Z'));
    expect(await issueStatement(deps(utc('2025-02-02T23:59:59.999Z')), ORG, JAN)).toMatchObject({ ok: false, code: 'conflict', error: expect.stringMatching(/2025-02-03T00:00:00\.000Z/u) });
  });

  it('is refused while a relayed event of the month has no settlement, then while a day has no rate', async () => {
    expect(await issueStatement(deps(ISSUE_AT), ORG, JAN)).toMatchObject({ ok: false, code: 'conflict', error: '1 relayed event(s) of 2025-01 are not settled yet' });
    await store.recordSettlement({ requestId: pending.rid, at: pending.at, nearTx: pending.tx!, result: 'unsettled', reason: 'not_final' });
    await rates('2025-01-01', '2025-01-30');
    expect(await issueStatement(deps(ISSUE_AT), ORG, JAN)).toMatchObject({ ok: false, code: 'conflict', error: 'No NEAR/USD rate for 2025-01-31' });
    await rates('2025-01-31', '2025-01-31');
    expect(bucket.objects.size).toBe(0);
  });

  let issued: Awaited<ReturnType<typeof issueStatement>>;
  it('issues: CSV and PDF under new keys with their sha256s, the totals, the audit row; a second issue refused', async () => {
    issued = await issueStatement(deps(ISSUE_AT), ORG, JAN);
    if (!issued.ok) throw new Error(issued.error);
    const s = issued.statement;
    expect(s.csvKey).toBe(statementKey(ORG, JAN, ISSUE_AT, 'csv'));
    expect(s.csvKey).toBe('statements/org_acme/2025-01/2025-02-04T00:00:00.000Z.csv');
    const csv = bucket.objects.get(s.csvKey)!.bytes;
    const pdf = bucket.objects.get(s.pdfKey!)!.bytes;
    expect(await sha256Hex(csv)).toBe(s.csvSha256);
    expect(await sha256Hex(pdf)).toBe(s.pdfSha256);
    expect(s.asOf).toBe(ISSUE_AT);
    expect(s.issuedBy).toBe(STAFF.actor.email);
    expect(issued.auditRecorded).toBe(true);
    expect(rpcs.audit).toEqual([expect.objectContaining({ action: 'statement.issued', orgId: ORG, target: JAN, requestId: `statement_${ORG}_${JAN}`, details: expect.objectContaining({ csvSha256: s.csvSha256, asOf: ISSUE_AT }) })]);
    // The totals: billed excludes the relayed-then-rejected line; the unsettled event is counted, never billed.
    expect(s.totals.sum).toMatchObject({ tgas: '49.545678901234', relayedRejectedTgas: '2.2', unsettled: 1 });
    expect(s.totals.billed.tgas).toBe('47.345678901234');
    expect(s.totals.notBilled.relayedRejectedTgas).toBe('2.2');
    expect(s.totals.rows.map((r) => [r.kind, r.appId ?? r.scopeId, r.mau])).toEqual([
      ['app', 'app_1', 1],
      ['app', 'app_2', 1],
      ['scope', 's1', undefined],
    ]);
    expect(await issueStatement(deps(ISSUE_AT + 1000), ORG, JAN)).toMatchObject({ ok: false, code: 'conflict', error: 'The 2025-01 statement was already issued' });
    expect(bucket.objects.size).toBe(2);
  });

  it('D92: the CSV, the PDF and the on-screen statement show the same totals and the CSV’s sha256; rejected marked not billed', async () => {
    if (!issued.ok) throw new Error('not issued');
    const s = issued.statement;
    const csv = new TextDecoder().decode(bucket.objects.get(s.csvKey)!.bytes);
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe(STATEMENT_CSV_COLUMNS.join(','));
    const totalLines = lines.filter((l) => l.split(',')[7] === 'total').map((l) => l.split(','));
    const col = (name: (typeof STATEMENT_CSV_COLUMNS)[number]) => STATEMENT_CSV_COLUMNS.indexOf(name);
    expect(totalLines.length).toBe(s.totals.rows.length);
    for (const [k, row] of s.totals.rows.entries()) {
      const cells = totalLines[k]!;
      expect([cells[col('tgas')], cells[col('near')], cells[col('usd')], cells[col('relayed_rejected_tgas')], cells[col('logins')], cells[col('mau')]]).toEqual([row.tgas, row.near, row.usd, row.relayedRejectedTgas, String(row.logins), row.mau === undefined ? '' : String(row.mau)]);
    }
    const view = statementView(s);
    const text = pdfText(bucket.objects.get(s.pdfKey!)!.bytes);
    expect(text).toContain(s.csvSha256);
    for (const [label, value] of [...view.header, ...view.summary]) {
      expect(text, label).toContain(`${label}:`);
      expect(text, label).toContain(value);
    }
    for (const r of view.table) for (const [k, c] of r.cells.entries()) expect(text).toContain(`${view.tableColumns[k]}: ${c === '' ? '-' : c}`);
    expect(view.summary).toContainEqual(['Relayed-then-rejected, not billed (Tgas)', '2.2']);
    expect(text).toContain('Testnet usage, valued at the mainnet NEAR/USD price');
    expect(text).toContain('not billed by default');
    // The on-screen statement is rendered from the stored totals: the same as from the issue's answer.
    const stored = (await store.statements(ORG)).find((r) => r.month === JAN)!;
    expect(stored.csv_sha256).toBe(s.csvSha256);
    expect(statementView({ csvSha256: stored.csv_sha256, totals: stored.totals as typeof s.totals })).toEqual(view);
  });

  it('the ledger CSV for the same as_of sums to the statement’s tgas and near, owner actions included', async () => {
    if (!issued.ok) throw new Error('not issued');
    const out = (await ledgerCsv(store, ORG, JAN, ISSUE_AT))!;
    expect(formatTgas(out.finalGas)).toBe(issued.statement.totals.sum.tgas);
    expect(formatNear(out.finalTokens)).toBe(issued.statement.totals.sum.near);
    expect(out.rows).toBe(6);
    expect(out.csv.split('\n')[0]).toBe('request_id,at,org_id,scope_id,app_id,endpoint,outcome,relayed,near_tx,gas_status,gas_burnt,tokens_burnt');
    expect(out.csv).toContain(',owner_action,ok,true,');
    // The export: under exports/ in EXPORTS, with its hash, audited.
    const exportsBucket = new FakeBucket();
    const rpcs2 = fakeRpcs();
    const ex = await exportLedger({ store, bucket: exportsBucket, console: rpcs2.console, staff: STAFF, now: ISSUE_AT + 5000 }, ORG, JAN, ISSUE_AT);
    if (!ex.ok) throw new Error(ex.error);
    expect(ex.key.startsWith(`exports/${ORG}/${JAN}/2025-02-04T00:00:00.000Z-`)).toBe(true);
    expect(await sha256Hex(exportsBucket.objects.get(ex.key)!.bytes)).toBe(ex.sha256);
    expect(ex.finalGas).toBe(out.finalGas.toString());
    expect(rpcs2.audit).toEqual([expect.objectContaining({ action: 'ledger.exported', target: JAN })]);
    expect(await exportLedger({ store, bucket: exportsBucket, console: rpcs2.console, staff: STAFF, now: ISSUE_AT }, ORG, JAN, ISSUE_AT + 1)).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('late events (received after as_of) are excluded and listed as after_statement; the month’s rates are frozen', async () => {
    await insertEvent(db, { org: ORG, app: 'app_1', at: utc('2025-01-15T00:00:00Z'), received: ISSUE_AT + 60_000 });
    const [m] = await store.report(ORG, '2025-01-01', '2025-01-31', 'month', ['app_1'], null);
    expect(Number(m!.after_statement)).toBe(1);
    const asOf = (await store.report(ORG, '2025-01-01', '2025-01-31', 'month', ['app_1'], ISSUE_AT))[0]!;
    expect(Number(asOf.logins)).toBe(Number(m!.logins) - 1);
    // The ledger CSV for the statement's as_of still sums to it.
    if (!issued.ok) throw new Error('not issued');
    expect(formatTgas((await ledgerCsv(store, ORG, JAN, ISSUE_AT))!.finalGas)).toBe(issued.statement.totals.sum.tgas);
    expect((await (async () => {
      try {
        await store.overrideRate('2025-01-10', 1n, 'staff@hana.example', 'too late for January');
        return null;
      } catch (err) {
        return (err as { code?: string }).code;
      }
    })())).toBe('42501');
  });

  it('notifies the org’s security contacts, its billing email and the alias once, with the hash', async () => {
    if (!issued.ok) throw new Error('not issued');
    const email = new FakeEmail();
    expect(await runStatementNotices({ ENV_NAME: 'sandbox-test', CONSOLE_ORIGIN: 'https://console.test', SECURITY_ALIAS: ALIAS, API: rpcs.api as never, CONSOLE: rpcs.console as never }, store, email, new Budget())).toEqual({ sent: 1, failed: 0 });
    expect(email.sent.map((m) => m.to).sort()).toEqual(['billing@acme.example', 'sec@partner.example', ALIAS].sort());
    expect(email.sent[0]!.text).toContain(issued.statement.csvSha256);
    expect(await runStatementNotices({ ENV_NAME: 'sandbox-test', CONSOLE_ORIGIN: 'https://console.test', SECURITY_ALIAS: ALIAS, API: rpcs.api as never, CONSOLE: rpcs.console as never }, store, email, new Budget())).toEqual({ sent: 0, failed: 0 });
  });
});

describe('the golden statement CSV (byte-stable)', () => {
  const row = (over: Partial<ReportSqlRow>): ReportSqlRow => ({
    period: '2026-01-02',
    app_id: 'app_1',
    scope_id: 's1',
    logins: 2,
    derives: 1,
    revokes: 0,
    unlocks: 1,
    owner_actions: 0,
    link_actions: 0,
    active_users: 2,
    new_users: 1,
    identity_tokens: 3,
    failures: { timeout: 1, bad_token: 2 },
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
    derive_p50: 2000,
    derive_p95: 2000,
    unsettled: 0,
    after_statement: 0,
    ...over,
  });
  const apps = new Map([
    ['app_1', { name: '=cmd|"/C calc"!A0', environment: 'live', scopeId: 's1' }],
    ['app_2', { name: '@x, -x', environment: 'test', scopeId: 's2' }],
    ['app_3', { name: '-5', environment: 'live', scopeId: 's1' }],
  ]);
  const DAY_ROWS = [
        row({ app_id: null, scope_id: 's1', period: '2026-01-02', logins: 0, derives: 0, unlocks: 0, owner_actions: 1, identity_tokens: 0, active_users: 0, new_users: 0, failures: {}, login_p50: null, login_p95: null, derive_p50: null, derive_p95: null }),
        row({ app_id: 'app_2', scope_id: 's2', period: '2026-01-03', failures: {} }),
        row({}),
        row({ app_id: 'app_3', period: '2026-01-02', gas: '0', rejected_gas: '0', burnt_yocto: '0', rejected_yocto: '0', usd_micros: '0', rejected_usd_micros: '0', failures: {} }),
  ];
  const MONTH_ROWS = [
        row({ period: '2026-01', near_usd_rate: null, rate_source: null }),
        row({ app_id: 'app_2', scope_id: 's2', period: '2026-01', failures: {}, near_usd_rate: null, rate_source: null }),
        row({ app_id: 'app_3', period: '2026-01', gas: '0', rejected_gas: '0', burnt_yocto: '0', rejected_yocto: '0', usd_micros: '0', rejected_usd_micros: '0', failures: {}, near_usd_rate: null, rate_source: null }),
        row({ app_id: null, scope_id: 's1', period: '2026-01', logins: 0, derives: 0, unlocks: 0, owner_actions: 1, identity_tokens: 0, active_users: 0, new_users: 0, failures: {}, login_p50: null, login_p95: null, derive_p50: null, derive_p95: null, near_usd_rate: null, rate_source: null }),
  ];
  const built = () => buildStatement({ orgId: 'org_golden', orgName: 'Golden "Org", Ltd', month: '2026-01', asOf: Date.UTC(2026, 1, 3, 0, 0, 0, 123), network: 'testnet', apps, dayRows: DAY_ROWS, monthRows: MONTH_ROWS });

  const GOLDEN = [
    'month,org_id,org_name,scope_id,app_id,app_name,environment,day,logins,derives,revokes,unlocks,owner_actions,link_actions,identity_tokens,mau,new_users,failures_by_code,tgas,relayed_rejected_tgas,error_tgas,near,relayed_rejected_near,near_usd_rate,rate_source,usd,relayed_rejected_usd,login_p50_ms,login_p95_ms,derive_p50_ms,derive_p95_ms,unsettled,as_of',
    `2026-01,org_golden,"Golden ""Org"", Ltd",s1,app_1,"'=cmd|""/C calc""!A0",live,2026-01-02,2,1,0,1,0,0,3,,1,bad_token=2;timeout=1,32.670449867484,2.2,0,0.0032447267304984,0.00022,2.5,coingecko,0.008112,0.00055,812,1400,2000,2000,0,2026-02-03T00:00:00.123Z`,
    `2026-01,org_golden,"Golden ""Org"", Ltd",s2,app_2,"'@x, -x",test,2026-01-03,2,1,0,1,0,0,3,,1,,32.670449867484,2.2,0,0.0032447267304984,0.00022,2.5,coingecko,0.008112,0.00055,812,1400,2000,2000,0,2026-02-03T00:00:00.123Z`,
    `2026-01,org_golden,"Golden ""Org"", Ltd",s1,app_3,-5,live,2026-01-02,2,1,0,1,0,0,3,,1,,0,0,0,0,0,2.5,coingecko,0,0,812,1400,2000,2000,0,2026-02-03T00:00:00.123Z`,
    `2026-01,org_golden,"Golden ""Org"", Ltd",s1,,,live,2026-01-02,0,0,0,0,1,0,0,,0,,32.670449867484,2.2,0,0.0032447267304984,0.00022,2.5,coingecko,0.008112,0.00055,,,,,0,2026-02-03T00:00:00.123Z`,
    `2026-01,org_golden,"Golden ""Org"", Ltd",s1,app_1,"'=cmd|""/C calc""!A0",live,total,2,1,0,1,0,0,3,2,1,bad_token=2;timeout=1,32.670449867484,2.2,0,0.0032447267304984,0.00022,,,0.008112,0.00055,812,1400,2000,2000,0,2026-02-03T00:00:00.123Z`,
    `2026-01,org_golden,"Golden ""Org"", Ltd",s2,app_2,"'@x, -x",test,total,2,1,0,1,0,0,3,2,1,,32.670449867484,2.2,0,0.0032447267304984,0.00022,,,0.008112,0.00055,812,1400,2000,2000,0,2026-02-03T00:00:00.123Z`,
    `2026-01,org_golden,"Golden ""Org"", Ltd",s1,app_3,-5,live,total,2,1,0,1,0,0,3,2,1,,0,0,0,0,0,,,0,0,812,1400,2000,2000,0,2026-02-03T00:00:00.123Z`,
    `2026-01,org_golden,"Golden ""Org"", Ltd",s1,,,live,total,0,0,0,0,1,0,0,,0,,32.670449867484,2.2,0,0.0032447267304984,0.00022,,,0.008112,0.00055,,,,,0,2026-02-03T00:00:00.123Z`,
  ].join('\n') + '\n';

  it('matches the golden bytes, in the fixed order, whatever order the rows come in', async () => {
    const a = built();
    expect(a.csv).toBe(GOLDEN);
    expect(a.lines).toBe(8);
    // Byte-stable: the same rows in another order give the same bytes and hash.
    const inputs = { orgId: 'org_golden', orgName: 'Golden "Org", Ltd', month: '2026-01', asOf: Date.UTC(2026, 1, 3, 0, 0, 0, 123), network: 'testnet', apps };
    const first = buildStatement({ ...inputs, dayRows: DAY_ROWS, monthRows: MONTH_ROWS });
    const shuffled = buildStatement({ ...inputs, dayRows: [...DAY_ROWS].reverse(), monthRows: [...MONTH_ROWS].reverse() });
    expect(shuffled.csv).toBe(first.csv);
    expect(await sha256Hex(new TextEncoder().encode(shuffled.csv))).toBe(await sha256Hex(new TextEncoder().encode(GOLDEN)));
    expect(a.totals.sum).toMatchObject({ tgas: '98.011349602452', relayedRejectedTgas: '6.6', usd: '0.024336', relayedRejectedUsd: '0.00165', ownerActions: 1 });
    expect(a.totals.billed).toEqual({ tgas: '91.411349602452', near: '0.0090741801914952', usd: '0.022686' });
  });

  it('refuses a row without USD (a day with gas and no rate): a statement is never issued without one', () => {
    expect(() =>
      buildStatement({ orgId: 'org_x', orgName: 'X', month: '2026-01', asOf: 0, network: 'mainnet', apps, dayRows: [row({ usd_micros: null })], monthRows: [] }),
    ).toThrow(/a day without a rate/u);
  });

  it('the PDF of the golden statement carries every figure of the view', async () => {
    const a = built();
    const sha = await sha256Hex(new TextEncoder().encode(a.csv));
    const view = statementView({ csvSha256: sha, totals: a.totals });
    const text = pdfText(await statementPdf(view, a.totals.asOf));
    for (const [, v] of view.summary) expect(text).toContain(v);
    expect(text).toContain(sha);
    // Text outside WinAnsi is shown as '?', never a failure.
    const odd = statementView({ csvSha256: sha, totals: { ...a.totals, orgName: 'Acme 株式会社 🚀' } });
    expect(pdfText(await statementPdf(odd, 0))).toContain('Acme ????');
  });
});

