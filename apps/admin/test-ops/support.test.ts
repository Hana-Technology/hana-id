// The Support ID lookup's ledger reads (batch C15, D384, D385; console-core support.ts) on the real migrations as
// usage_admin: a uid's ok login, session and derive events over the window, newest first and capped; the request IDs'
// events whatever their outcome, each marked whether it carries a match's uid; never the uid itself. The indexes they
// read are Neon 0007's (`events_uid_at`, the primary key's request_id), so no migration of C15's own (D362).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from '../../api/test-usage/db.ts';
import { SUPPORT_ACTIVITY_SQL, SUPPORT_REQUESTS_SQL, type SupportLookupResult, internalIdOf, uidHexOfInternalId, withSupportLedger } from '@hana-id/console-core';
import type { LedgerStore } from '../src/ledger.ts';
import { insertEvent, ledgerDb } from './fakes.ts';

let db: TestDb;
let store: LedgerStore;
const DAY = 86_400_000;
const now = Date.now();
const monthKey = (t: number): string => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
beforeAll(async () => {
  ({ db, store } = await ledgerDb([...new Set([monthKey(now - 60 * DAY), monthKey(now - 30 * DAY), monthKey(now)])]));
});
afterAll(async () => {
  await db.close();
});

const hexOf = (k: number): string => uidHexOfInternalId(internalIdOf(new Uint8Array(16).fill(k)));

describe('the Support ID lookup’s ledger reads', () => {
  it('lists a uid’s ok events in the window, newest first, at most the limit; never another uid’s or an older one', async () => {
    const mine = 0x11;
    const a = await insertEvent(db, { at: now - 3 * DAY, uid: mine, endpoint: 'login', relayed: true, latency: 800 });
    const b = await insertEvent(db, { at: now - DAY, uid: mine, endpoint: 'derive', latency: 400 });
    const c = await insertEvent(db, { at: now - 2 * DAY, uid: mine, endpoint: 'session' });
    await insertEvent(db, { at: now - 45 * DAY, uid: mine, endpoint: 'login' });
    await insertEvent(db, { at: now - DAY, uid: 0x12, endpoint: 'login' });
    await insertEvent(db, { at: now - DAY, outcome: 'rejected', code: 'nonce_mismatch', endpoint: 'login' });
    const rows = await store.support.activity(hexOf(mine), now - 30 * DAY, 400);
    expect(rows.map((r) => r.requestId)).toEqual([b.rid, c.rid, a.rid]);
    expect(rows[2]).toEqual({ requestId: a.rid, at: a.at, appId: 'app_1', endpoint: 'login', status: 200, latencyMs: 800, relayed: true, nearTx: a.tx });
    expect(Object.keys(rows[0]!)).not.toContain('uid');
    expect((await store.support.activity(hexOf(mine), now - 30 * DAY, 2)).map((r) => r.requestId)).toEqual([b.rid, c.rid]);
    expect(await store.support.activity(hexOf(mine), now - 60 * DAY, 400)).toHaveLength(4);
    expect(await store.support.activity(hexOf(0x13), now - 30 * DAY, 400)).toEqual([]);
  });

  it('lists the request IDs’ events whatever their outcome, marks the ones a match made, and never selects the uid', async () => {
    const mine = 0x21;
    const ok = await insertEvent(db, { at: now - DAY, uid: mine, endpoint: 'login' });
    const failed = await insertEvent(db, { at: now - DAY + 1000, outcome: 'error', code: 'near_error', endpoint: 'derive' });
    const someoneElse = await insertEvent(db, { at: now - DAY + 2000, uid: 0x22, endpoint: 'session' });
    const rows = await store.support.requests([ok.rid, failed.rid, someoneElse.rid, 'req_unknown_xx'], [hexOf(mine)], 100);
    expect(rows.map((r) => [r.requestId, r.outcome, r.code, r.byMatch])).toEqual([
      [someoneElse.rid, 'ok', null, false],
      [failed.rid, 'error', 'near_error', false],
      [ok.rid, 'ok', null, true],
    ]);
    for (const r of rows) expect(Object.keys(r)).not.toContain('uid');
    expect(await store.support.requests([], [hexOf(mine)], 100)).toEqual([]);
  });

  it('the lookup view: activity per match, the request IDs not found, and "ledger unavailable" without a reader', async () => {
    const k = 0x31;
    const e = await insertEvent(db, { at: now - DAY, uid: k, endpoint: 'login' });
    const result = { query: { kind: 'supportId', code: 'ABCDEFGH' }, since: now - 30 * DAY, truncated: false, matches: [{ user: { internalId: internalIdOf(new Uint8Array(16).fill(k)) } }] } as unknown as SupportLookupResult;
    const v = await withSupportLedger(result, { days: 30, requestIds: [e.rid, 'req_nothing_x', e.rid], reader: store.support });
    expect(v.ledger).toEqual({ available: true });
    expect(v.activity[0]!.map((r) => r.requestId)).toEqual([e.rid]);
    expect(v.requests!.map((r) => [r.requestId, r.byMatch])).toEqual([[e.rid, true]]);
    expect(v.requestsNotFound).toEqual(['req_nothing_x']);
    const off = await withSupportLedger(result, { days: 30, requestIds: [], reader: null });
    expect([off.ledger, off.activity, off.requests]).toEqual([{ available: false, reason: 'ledger unavailable' }, [null], null]);
  });

  it('the queries are plain SELECTs on usage.events through the uid index and the primary key (usage_admin may run them)', async () => {
    for (const sql of [SUPPORT_ACTIVITY_SQL, SUPPORT_REQUESTS_SQL]) {
      expect(sql).toMatch(/^SELECT /u);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b|SELECT[^,]*\buid\b,/u);
    }
    // With sequential scans off the planner must find an index for each partition: events_uid_at is usable here.
    await db.exec('SET enable_seqscan = off');
    try {
      const sql = SUPPORT_ACTIVITY_SQL.replace('$1', `'${hexOf(1)}'`).replace('$2::timestamptz', `'${new Date(now - DAY).toISOString()}'::timestamptz`).replace('$3', '10');
      const plan = (await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`)).map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/uid/u);
      expect(plan).not.toMatch(/Seq Scan/u);
    } finally {
      await db.exec('RESET enable_seqscan');
    }
  });
});
