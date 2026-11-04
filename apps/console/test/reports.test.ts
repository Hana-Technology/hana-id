// The console's report backend (src/reports.ts, batch C12; the session routes that call it are C9/C10's): the usage
// report, the statement list and on-screen statement, the statement files from STATEMENTS checked against their frozen
// hash, and the ledger CSV streamed page by page at one as_of. The API side (ConsoleRpc.usage / statements / ledger) is
// tested in apps/api; here the binding answers what the tests set.
import { newId, statementTotals, statementView } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env.ts';
import { type ReportCaller, ledgerCsvRoute, statementFileRoute, statementViewRoute, statementsRoute, usageRoute } from '../src/reports.ts';

const ORG = newId('org');
const caller: ReportCaller = { orgId: ORG, actor: { kind: 'member', id: newId('user'), sub: 'sub-1', email: 'viewer@partner.example', sessionHash: 'A'.repeat(43) } };
const info = { requestId: 'req_reports_0001', clientIp: '198.51.100.7', country: null };
const sha = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');

const totals = statementTotals.parse({
  v: 1,
  orgId: ORG,
  orgName: 'Acme',
  month: '2026-01',
  asOf: Date.UTC(2026, 1, 3),
  network: 'testnet',
  rows: [],
  sum: { logins: 1, derives: 0, revokes: 0, unlocks: 0, ownerActions: 0, linkActions: 0, identityTokens: 0, newUsers: 0, tgas: '1', relayedRejectedTgas: '0', errorTgas: '0', near: '0.1', relayedRejectedNear: '0', usd: '0.25', relayedRejectedUsd: '0', unsettled: 0 },
  billed: { tgas: '1', near: '0.1', usd: '0.25' },
  notBilled: { relayedRejectedTgas: '0', relayedRejectedNear: '0', relayedRejectedUsd: '0' },
});

const withApi = (api: Record<string, (c: Record<string, unknown>) => Promise<unknown>>): Env => ({ ...(env as unknown as Env), API: api as unknown as Env['API'] });

describe('usage and statements', () => {
  it('passes the member and the org to ConsoleRpc.usage and answers its rows; an RPC refusal keeps its status', async () => {
    let got: Record<string, unknown> = {};
    const e = withApi({
      usage: async (c) => {
        got = c;
        return { ok: true, rows: [{ period: '2026-01-02' }] };
      },
    });
    const r = await usageRoute(e, info, caller, new URL('https://console.test/api/orgs/x/usage?from=2026-01-01&to=2026-01-31&by=month&apps=app_1,app_2'));
    expect(await r.json()).toEqual({ rows: [{ period: '2026-01-02' }] });
    expect(got).toEqual({ actor: caller.actor, requestId: info.requestId, clientIp: info.clientIp, orgId: ORG, from: '2026-01-01', to: '2026-01-31', by: 'month', appIds: ['app_1', 'app_2'] });
    const refused = await usageRoute(withApi({ usage: async () => ({ ok: false, code: 'rate_limited', error: 'slow down' }) }), info, caller, new URL('https://console.test/x?from=2026-01-01&to=2026-01-02'));
    expect(refused.status).toBe(429);
    expect((await usageRoute(e, info, caller, new URL('https://console.test/x?from=jan'))).status).toBe(400);
  });

  it('lists statements without their file keys; the on-screen statement renders the stored totals', async () => {
    const st = { orgId: ORG, month: '2026-01', asOf: totals.asOf, csvSha256: 'ab'.repeat(32), issuedBy: 'staff@hana.example', issuedAt: 1, totals, csvKey: `statements/${ORG}/2026-01/x.csv` };
    const e = withApi({ statements: async () => ({ ok: true, statements: [st] }) });
    const list = (await (await statementsRoute(e, info, caller)).json()) as { statements: Record<string, unknown>[] };
    expect(list.statements).toEqual([{ orgId: ORG, month: '2026-01', asOf: totals.asOf, csvSha256: 'ab'.repeat(32), issuedBy: 'staff@hana.example', issuedAt: 1 }]);
    const view = (await (await statementViewRoute(e, info, caller, '2026-01')).json()) as { view: unknown };
    expect(view.view).toEqual(statementView(st));
    expect((await statementViewRoute(e, info, caller, '2026-02')).status).toBe(404);
  });

  it('serves a statement file from STATEMENTS only when it matches its hash and lies under the org’s prefix', async () => {
    const bytes = new TextEncoder().encode('month,org_id\n');
    const key = `statements/${ORG}/2026-01/2026-02-03T00:00:00.000Z.csv`;
    await (env as unknown as Env).STATEMENTS!.put(key, bytes);
    const st = (csvSha256: string, csvKey = key) => ({ orgId: ORG, month: '2026-01', asOf: 1, csvSha256, issuedBy: 's', issuedAt: 1, totals, csvKey });
    const good = await statementFileRoute(withApi({ statements: async () => ({ ok: true, statements: [st(await sha(bytes))] }) }), info, caller, '2026-01', 'csv');
    expect(good.status).toBe(200);
    expect(good.headers.get('x-hana-sha256')).toBe(await sha(bytes));
    expect(await good.text()).toBe('month,org_id\n');
    expect((await statementFileRoute(withApi({ statements: async () => ({ ok: true, statements: [st('00'.repeat(32))] }) }), info, caller, '2026-01', 'csv')).status).toBe(500);
    expect((await statementFileRoute(withApi({ statements: async () => ({ ok: true, statements: [st(await sha(bytes), 'statements/org_other/2026-01/x.csv')] }) }), info, caller, '2026-01', 'csv')).status).toBe(404);
    expect((await statementFileRoute(withApi({ statements: async () => ({ ok: true, statements: [st(await sha(bytes))] }) }), info, caller, '2026-01', 'pdf')).status).toBe(404);
  });
});

describe('the ledger CSV', () => {
  const row = (k: number) => ({ requestId: `req_${String(k).padStart(8, '0')}`, at: Date.UTC(2026, 0, 2) + k, orgId: ORG, scopeId: 's1', appId: 'app_1', endpoint: 'login', outcome: 'ok', relayed: true, nearTx: 'Tx1', gasStatus: 'final', gasBurnt: '5', tokensBurnt: '7' });

  it('streams every page at the first page’s as_of, in the spec’s columns', async () => {
    const asked: Record<string, unknown>[] = [];
    const e = withApi({
      ledger: async (c) => {
        asked.push(c);
        return c.after ? { ok: true, rows: [row(2)], asOf: 99 } : { ok: true, rows: [row(1)], next: 'req_00000001,1', asOf: 1_800_000_000_000 };
      },
    });
    const r = await ledgerCsvRoute(e, info, caller, '2026-01', new URL('https://console.test/x'));
    expect(r.headers.get('x-hana-as-of')).toBe('1800000000000');
    const text = await r.text();
    expect(text.split('\n')).toEqual([
      'request_id,at,org_id,scope_id,app_id,endpoint,outcome,relayed,near_tx,gas_status,gas_burnt,tokens_burnt',
      `req_00000001,2026-01-02T00:00:00.001Z,${ORG},s1,app_1,login,ok,true,Tx1,final,5,7`,
      `req_00000002,2026-01-02T00:00:00.002Z,${ORG},s1,app_1,login,ok,true,Tx1,final,5,7`,
      '',
    ]);
    expect(asked.map((a) => [a.after ?? null, a.asOf ?? null])).toEqual([
      [null, null],
      ['req_00000001,1', 1_800_000_000_000],
    ]);
  });

  it('a refused first page is an error; a failed later page ends the CSV with an incomplete line', async () => {
    expect((await ledgerCsvRoute(withApi({ ledger: async () => ({ ok: false, code: 'forbidden' }) }), info, caller, '2026-01', new URL('https://console.test/x'))).status).toBe(403);
    const e = withApi({ ledger: async (c) => (c.after ? { ok: false, code: 'internal' } : { ok: true, rows: [row(1)], next: 'req_00000001,1', asOf: 5 }) });
    const text = await (await ledgerCsvRoute(e, info, caller, '2026-01', new URL('https://console.test/x?asOf=5'))).text();
    expect(text.trimEnd().split('\n').pop()).toBe('# incomplete: a page could not be read; download again');
    expect((await ledgerCsvRoute(e, info, caller, '2026-13', new URL('https://console.test/x'))).status).toBe(400);
  });
});
