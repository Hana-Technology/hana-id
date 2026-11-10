// Monthly statements (src/statements.ts, statement.ts, statement-pdf.ts) on the real migrations as usage_admin:
// docs/batch-c-spec.md "Tests: Usage ledger": refused before the 3rd, with an unsettled event or a missing rate; a
// second issue refused; a rate change refused once the month has a statement; late events excluded by as_of and listed;
// the golden CSV (byte-stable: quoting, injection cases, negative numbers unprefixed, scope rows, totals); the ledger
// CSV's final gas for the same as_of equals the statement's tgas and near; and D92: the CSV, the PDF and the on-screen
// statement show identical totals and the CSV's sha256, the rejected line separate and marked not billed. Hana Home's
// billing (D461, D585–D588): an active app's "Hana Home logins" line and its totals, and Hana's own org after the app is gone.
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
  // pdf-lib writes `stream\n…\nendstream`: no optional `\r` here, or a compressed stream that ends in 0x0d loses its last byte.
  for (const m of raw.matchAll(/stream\n([\s\S]*?)\nendstream/gu)) {
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
    const totalLines = lines.filter((l) => l.split(',')[8] === 'total').map((l) => l.split(','));
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
  // The older rows name no `kind` (a report from before migrations-usage 0008): an app's, else a scope's owner actions.
  const DAY_ROWS = [
        row({ app_id: null, scope_id: 's1', kind: 'home', home_logins: 1, logins: 0, derives: 0, unlocks: 0, owner_actions: 0, identity_tokens: 0, active_users: 0, new_users: 0, failures: {}, gas: '38500000000000', rejected_gas: '0', burnt_yocto: '3850000000000000000000', rejected_yocto: '0', usd_micros: '9625', rejected_usd_micros: '0', login_p50: null, login_p95: null, derive_p50: null, derive_p95: null, period: '2026-01-02' }),
        row({ app_id: null, scope_id: 's1', period: '2026-01-02', logins: 0, derives: 0, unlocks: 0, owner_actions: 1, identity_tokens: 0, active_users: 0, new_users: 0, failures: {}, login_p50: null, login_p95: null, derive_p50: null, derive_p95: null }),
        row({ app_id: 'app_2', scope_id: 's2', period: '2026-01-03', failures: {} }),
        row({}),
        row({ app_id: 'app_3', period: '2026-01-02', gas: '0', rejected_gas: '0', burnt_yocto: '0', rejected_yocto: '0', usd_micros: '0', rejected_usd_micros: '0', failures: {} }),
  ];
  const MONTH_ROWS = [
        row({ app_id: null, scope_id: 's1', kind: 'home', home_logins: 1, logins: 0, derives: 0, unlocks: 0, owner_actions: 0, identity_tokens: 0, active_users: 0, new_users: 0, failures: {}, gas: '38500000000000', rejected_gas: '0', burnt_yocto: '3850000000000000000000', rejected_yocto: '0', usd_micros: '9625', rejected_usd_micros: '0', login_p50: null, login_p95: null, derive_p50: null, derive_p95: null, period: '2026-01', near_usd_rate: null, rate_source: null }),
        row({ period: '2026-01', near_usd_rate: null, rate_source: null }),
        row({ app_id: 'app_2', scope_id: 's2', period: '2026-01', failures: {}, near_usd_rate: null, rate_source: null }),
        row({ app_id: 'app_3', period: '2026-01', gas: '0', rejected_gas: '0', burnt_yocto: '0', rejected_yocto: '0', usd_micros: '0', rejected_usd_micros: '0', failures: {}, near_usd_rate: null, rate_source: null }),
        row({ app_id: null, scope_id: 's1', period: '2026-01', logins: 0, derives: 0, unlocks: 0, owner_actions: 1, identity_tokens: 0, active_users: 0, new_users: 0, failures: {}, login_p50: null, login_p95: null, derive_p50: null, derive_p95: null, near_usd_rate: null, rate_source: null }),
  ];
  const built = () => buildStatement({ orgId: 'org_golden', orgName: 'Golden "Org", Ltd', month: '2026-01', asOf: Date.UTC(2026, 1, 3, 0, 0, 0, 123), network: 'testnet', apps, dayRows: DAY_ROWS, monthRows: MONTH_ROWS });

  const GOLDEN = [
    'month,org_id,org_name,scope_id,app_id,app_name,environment,row_kind,day,logins,derives,revokes,unlocks,owner_actions,link_actions,identity_tokens,home_logins,mau,new_users,failures_by_code,tgas,relayed_rejected_tgas,error_tgas,near,relayed_rejected_near,near_usd_rate,rate_source,usd,relayed_rejected_usd,login_p50_ms,login_p95_ms,derive_p50_ms,derive_p95_ms,unsettled,as_of',
    `2026-01,org_golden,"Golden ""Org"", Ltd",s1,app_1,"'=cmd|""/C calc""!A0",live,app,2026-01-02,2,1,0,1,0,0,3,0,,1,bad_token=2;timeout=1,32.670449867484,2.2,0,0.0032447267304984,0.00022,2.5,coingecko,0.008112,0.00055,812,1400,2000,2000,0,2026-02-03T00:00:00.123Z`,
    `2026-01,org_golden,"Golden ""Org"", Ltd",s2,app_2,"'@x, -x",test,app,2026-01-03,2,1,0,1,0,0,3,0,,1,,32.670449867484,2.2,0,0.0032447267304984,0.00022,2.5,coingecko,0.008112,0.00055,812,1400,2000,2000,0,2026-02-03T00:00:00.123Z`,
    `2026-01,org_golden,"Golden ""Org"", Ltd",s1,app_3,-5,live,app,2026-01-02,2,1,0,1,0,0,3,0,,1,,0,0,0,0,0,2.5,coingecko,0,0,812,1400,2000,2000,0,2026-02-03T00:00:00.123Z`,
    `2026-01,org_golden,"Golden ""Org"", Ltd",s1,,,live,scope,2026-01-02,0,0,0,0,1,0,0,0,,0,,32.670449867484,2.2,0,0.0032447267304984,0.00022,2.5,coingecko,0.008112,0.00055,,,,,0,2026-02-03T00:00:00.123Z`,
    `2026-01,org_golden,"Golden ""Org"", Ltd",s1,,,live,home,2026-01-02,0,0,0,0,0,0,0,1,,0,,38.5,0,0,0.00385,0,2.5,coingecko,0.009625,0,,,,,0,2026-02-03T00:00:00.123Z`,
    `2026-01,org_golden,"Golden ""Org"", Ltd",s1,app_1,"'=cmd|""/C calc""!A0",live,app,total,2,1,0,1,0,0,3,0,2,1,bad_token=2;timeout=1,32.670449867484,2.2,0,0.0032447267304984,0.00022,,,0.008112,0.00055,812,1400,2000,2000,0,2026-02-03T00:00:00.123Z`,
    `2026-01,org_golden,"Golden ""Org"", Ltd",s2,app_2,"'@x, -x",test,app,total,2,1,0,1,0,0,3,0,2,1,,32.670449867484,2.2,0,0.0032447267304984,0.00022,,,0.008112,0.00055,812,1400,2000,2000,0,2026-02-03T00:00:00.123Z`,
    `2026-01,org_golden,"Golden ""Org"", Ltd",s1,app_3,-5,live,app,total,2,1,0,1,0,0,3,0,2,1,,0,0,0,0,0,,,0,0,812,1400,2000,2000,0,2026-02-03T00:00:00.123Z`,
    `2026-01,org_golden,"Golden ""Org"", Ltd",s1,,,live,scope,total,0,0,0,0,1,0,0,0,,0,,32.670449867484,2.2,0,0.0032447267304984,0.00022,,,0.008112,0.00055,,,,,0,2026-02-03T00:00:00.123Z`,
    `2026-01,org_golden,"Golden ""Org"", Ltd",s1,,,live,home,total,0,0,0,0,0,0,0,1,,0,,38.5,0,0,0.00385,0,,,0.009625,0,,,,,0,2026-02-03T00:00:00.123Z`,
  ].join('\n') + '\n';

  it('matches the golden bytes, in the fixed order, whatever order the rows come in', async () => {
    const a = built();
    expect(a.csv).toBe(GOLDEN);
    expect(a.lines).toBe(10);
    // Byte-stable: the same rows in another order give the same bytes and hash.
    const inputs = { orgId: 'org_golden', orgName: 'Golden "Org", Ltd', month: '2026-01', asOf: Date.UTC(2026, 1, 3, 0, 0, 0, 123), network: 'testnet', apps };
    const first = buildStatement({ ...inputs, dayRows: DAY_ROWS, monthRows: MONTH_ROWS });
    const shuffled = buildStatement({ ...inputs, dayRows: [...DAY_ROWS].reverse(), monthRows: [...MONTH_ROWS].reverse() });
    expect(shuffled.csv).toBe(first.csv);
    expect(await sha256Hex(new TextEncoder().encode(shuffled.csv))).toBe(await sha256Hex(new TextEncoder().encode(GOLDEN)));
    expect(a.totals.sum).toMatchObject({ tgas: '136.511349602452', relayedRejectedTgas: '6.6', usd: '0.033961', relayedRejectedUsd: '0.00165', ownerActions: 1, homeLogins: 1 });
    // The Home line is a row of its own, last, after the scope's owner actions, with the gas of the Home logins only.
    expect(a.totals.rows.map((r) => [r.kind, r.appId ?? r.scopeId, r.homeLogins, r.tgas])).toEqual([
      ['app', 'app_1', 0, '32.670449867484'],
      ['app', 'app_2', 0, '32.670449867484'],
      ['app', 'app_3', 0, '0'],
      ['scope', 's1', 0, '32.670449867484'],
      ['home', 's1', 1, '38.5'],
    ]);
    expect(a.totals.billed).toEqual({ tgas: '129.911349602452', near: '0.0129241801914952', usd: '0.032311' });
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


describe('Hana Home logins on a statement (D461, D585–D588)', () => {
  const PARTNER = 'org_homepartner';
  const HANA = 'org_hanainternal';
  const FEB = '2025-02';
  const AT = utc('2025-03-04T00:00:00.000Z');
  const rpcs = fakeRpcs({ orgName: 'Partner', apps: [{ id: 'app_h1', name: 'Wallet app', scopeId: 'sh1', environment: 'live' }] });
  const bucket = new FakeBucket();
  const deps = { store, api: rpcs.api, console: rpcs.console, bucket, network: 'testnet', staff: STAFF, now: AT };
  const HOME_GAS = 38_500_000_000_000n;
  const HOME_TOKENS = 3_850_000_000_000_000_000_000n;

  beforeAll(async () => {
    // `deps.store` was read before the file's beforeAll ran.
    deps.store = store;
    await rates('2025-02-01', '2025-02-28');
    // The partner's active app: a login, and three Home derives of its scope written for the partner's org (one of them
    // relayed and rejected: `ckd_failed`), plus an owner action in the same scope.
    const login = await insertEvent(db, { org: PARTNER, app: 'app_h1', scope: 'sh1', at: utc('2025-02-03T10:00:00Z'), relayed: true, uid: 7 });
    const h1 = await insertEvent(db, { org: PARTNER, endpoint: 'home_login', scope: 'sh1', at: utc('2025-02-03T11:00:00Z'), relayed: true });
    const h2 = await insertEvent(db, { org: PARTNER, endpoint: 'home_login', scope: 'sh1', at: utc('2025-02-20T11:00:00Z'), relayed: true });
    const failed = await insertEvent(db, { org: PARTNER, endpoint: 'home_login', scope: 'sh1', at: utc('2025-02-21T11:00:00Z'), relayed: true, outcome: 'error', code: 'ckd_failed' });
    const owner = await insertEvent(db, { org: PARTNER, endpoint: 'owner_action', scope: 'sh1', at: utc('2025-02-22T00:00:00Z'), relayed: true });
    await settle(login, 30_000_000_000_000n, 3_000_000_000_000_000_000_000n);
    await settle(h1, HOME_GAS, HOME_TOKENS);
    await settle(h2, HOME_GAS, HOME_TOKENS);
    await settle(failed, 20_000_000_000_000n, 2_000_000_000_000_000_000_000n);
    await settle(owner, 5_000_000_000_000n, 500_000_000_000_000_000_000n);
    // Hana's own org: derives of a scope whose app is gone, and of a suspended app's scope (the API chose the org).
    const gone = await insertEvent(db, { org: HANA, endpoint: 'home_login', scope: 'sgone', at: utc('2025-02-05T00:00:00Z'), relayed: true });
    const suspended = await insertEvent(db, { org: HANA, endpoint: 'home_login', scope: 'ssusp', at: utc('2025-02-06T00:00:00Z'), relayed: true });
    await settle(gone, HOME_GAS, HOME_TOKENS);
    await settle(suspended, HOME_GAS, HOME_TOKENS);
  });

  it('an active app’s org: its own line with the Home logins’ count and gas, in the report, the CSV, the totals and the PDF', async () => {
    const month = await store.report(PARTNER, '2025-02-01', '2025-02-28', 'month', null, null);
    expect(month.map((r) => [r.kind, r.app_id, r.scope_id, Number(r.logins), Number(r.owner_actions), Number(r.home_logins), r.gas])).toEqual([
      ['app', 'app_h1', 'sh1', 1, 0, 0, '30000000000000'],
      ['scope', null, 'sh1', 0, 1, 0, '5000000000000'],
      ['home', null, 'sh1', 0, 0, 2, '97000000000000'],
    ]);
    // Per day too: the two days with an ok Home login and the day of the failed one.
    const days = (await store.report(PARTNER, '2025-02-01', '2025-02-28', 'day', null, null)).filter((r) => r.kind === 'home');
    expect(days.map((r) => [r.period, Number(r.home_logins), r.gas, r.error_gas])).toEqual([
      ['2025-02-03', 1, '38500000000000', '0'],
      ['2025-02-20', 1, '38500000000000', '0'],
      ['2025-02-21', 0, '20000000000000', '20000000000000'],
    ]);
    // An app filter leaves the Home line out, as it leaves owner actions out: neither has an app.
    expect((await store.report(PARTNER, '2025-02-01', '2025-02-28', 'month', ['app_h1'], null)).map((r) => r.kind)).toEqual(['app']);

    const issued = await issueStatement(deps, PARTNER, FEB);
    if (!issued.ok) throw new Error(issued.error);
    const t = issued.statement.totals;
    expect(t.rows.map((r) => [r.kind, r.appId ?? r.scopeId, r.homeLogins, r.tgas, r.mau])).toEqual([
      ['app', 'app_h1', 0, '30', 1],
      ['scope', 'sh1', 0, '5', undefined],
      ['home', 'sh1', 2, '97', undefined],
    ]);
    // 97 Tgas = 9.7 mNEAR at 2.5 USD: the Home line's own USD, and part of the org's sum and of what is billed (an
    // errored relay's gas is billed like any other's, D324; only relayed-then-rejected gas is not).
    expect(t.rows[2]).toMatchObject({ near: '0.0097', usd: '0.02425', errorTgas: '20', relayedRejectedTgas: '0', failures: { ckd_failed: 1 } });
    expect(t.sum).toMatchObject({ logins: 1, ownerActions: 1, homeLogins: 2, tgas: '132', near: '0.0132', usd: '0.033' });
    expect(t.billed).toEqual({ tgas: '132', near: '0.0132', usd: '0.033' });

    const csv = new TextDecoder().decode(bucket.objects.get(issued.statement.csvKey)!.bytes).trimEnd().split('\n').map((l) => l.split(','));
    const col = (name: (typeof STATEMENT_CSV_COLUMNS)[number]) => STATEMENT_CSV_COLUMNS.indexOf(name);
    const homeTotal = csv.find((c) => c[col('row_kind')] === 'home' && c[col('day')] === 'total')!;
    expect([homeTotal[col('scope_id')], homeTotal[col('app_id')], homeTotal[col('home_logins')], homeTotal[col('logins')], homeTotal[col('tgas')], homeTotal[col('usd')], homeTotal[col('mau')]]).toEqual(['sh1', '', '2', '0', '97', '0.02425', '']);
    expect(csv.filter((c) => c[col('row_kind')] === 'home').map((c) => c[col('day')])).toEqual(['2025-02-03', '2025-02-20', '2025-02-21', 'total']);

    const view = statementView(issued.statement);
    expect(view.table.map((r) => r.label)).toEqual(['Wallet app (app_h1)', 'Owner actions, scope sh1', 'Hana Home logins, scope sh1']);
    expect(view.tableColumns).toContain('Home logins');
    expect(view.table[2]!.cells[view.tableColumns.indexOf('Home logins')]).toBe('2');
    expect(view.summary).toContainEqual(['Hana Home logins', '2']);
    const text = pdfText(bucket.objects.get(issued.statement.pdfKey!)!.bytes);
    expect(text).toContain('Hana Home logins, scope sh1');
    expect(text).toContain('Home logins: 2');
    expect(text).toContain('Hana Home logins:\n2');
    expect(text).toContain('users of these apps opening their wallet from Hana Home');
    // The ledger CSV for the same as_of reconciles, Home rows included.
    const ledger = (await ledgerCsv(store, PARTNER, FEB, AT))!;
    expect(formatTgas(ledger.finalGas)).toBe(t.sum.tgas);
    expect(ledger.csv).toContain(',home_login,ok,true,');
  });

  it('Hana’s own org after the app is gone, and for a suspended app: the Home lines and totals are Hana’s, and none of it is on the partner’s', async () => {
    const rows = await store.report(HANA, '2025-02-01', '2025-02-28', 'month', null, null);
    expect(rows.map((r) => [r.kind, r.app_id, r.scope_id, Number(r.home_logins), r.gas, r.usd_micros])).toEqual([
      ['home', null, 'sgone', 1, '38500000000000', '9625'],
      ['home', null, 'ssusp', 1, '38500000000000', '9625'],
    ]);
    const built = buildStatement({ orgId: HANA, orgName: 'Hana (internal)', month: FEB, asOf: AT, network: 'testnet', apps: new Map(), dayRows: await store.report(HANA, '2025-02-01', '2025-02-28', 'day', null, AT), monthRows: await store.report(HANA, '2025-02-01', '2025-02-28', 'month', null, AT) });
    expect(built.totals.sum).toMatchObject({ homeLogins: 2, logins: 0, tgas: '77', usd: '0.01925' });
    expect(statementView({ csvSha256: 'ab'.repeat(32), totals: built.totals }).table.map((r) => r.label)).toEqual(['Hana Home logins, scope sgone', 'Hana Home logins, scope ssusp']);
    // The partner's report for the same month names neither scope.
    expect((await store.report(PARTNER, '2025-02-01', '2025-02-28', 'month', null, null)).map((r) => r.scope_id)).toEqual(['sh1', 'sh1', 'sh1']);
  });

  it('a statement with no Home line renders exactly as before: no Home column, no Home summary line, no Home note', async () => {
    const plain = buildStatement({ orgId: 'org_plain', orgName: 'Plain', month: FEB, asOf: AT, network: 'mainnet', apps: new Map(), dayRows: [], monthRows: [] });
    const view = statementView({ csvSha256: 'ab'.repeat(32), totals: plain.totals });
    expect(view.tableColumns).toEqual(['Logins', 'Derives', 'Owner actions', 'MAU', 'New users', 'Tgas', 'NEAR', 'USD', 'Unsettled']);
    expect(view.summary.map(([k]) => k)).not.toContain('Hana Home logins');
    expect(view.notes.join(' ')).not.toMatch(/Hana Home/u);
    // And its stored totals carry no Home field at all: the shape a reader from before this change expects.
    const withApp = buildStatement({ orgId: 'org_plain', orgName: 'Plain', month: FEB, asOf: AT, network: 'mainnet', apps: new Map(), dayRows: [], monthRows: await store.report('org_acme', '2025-01-01', '2025-01-31', 'month', null, null) });
    expect(withApp.totals.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(withApp.totals)).not.toContain('homeLogins');
    expect(JSON.stringify(withApp.totals)).not.toContain('"home"');
  });
});
