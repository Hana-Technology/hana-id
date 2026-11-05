// The Support ID lookup's shared pieces (support.ts; batch C15, D384–D387): what a lookup starts from, the RPC and BFF
// inputs (the ticket is stored, so never an address), the ledger rows' mapping (never a uid), and how the ledger part
// joins the directory part, degrading to "ledger unavailable".
import { describe, expect, it } from 'vitest';
import {
  LEDGER_UNAVAILABLE,
  SUPPORT_ACTIVITY_MAX,
  SUPPORT_ACTIVITY_SQL,
  SUPPORT_REQUESTS_SQL,
  SUPPORT_REQUEST_ROWS_MAX,
  type SupportLedgerReader,
  type SupportLookupResult,
  internalIdOf,
  parseSupportQuery,
  sqlSupportLedger,
  supportActivityOf,
  supportLookupBody,
  supportLookupInput,
  supportRequestOf,
  supportSince,
  uidHexOfInternalId,
  userSharesInput,
  withSupportLedger,
} from '../src/index.ts';

const staff = { actor: { kind: 'hana' as const, id: 'access-sub', email: 'staff@hana.example' }, requestId: 'req_12345678', clientIp: '198.51.100.1' };
const UID = Uint8Array.from({ length: 16 }, (_, i) => i * 16 + 1);
const INTERNAL = internalIdOf(UID);

describe('parseSupportQuery', () => {
  it('reads a Support ID any way a person types it, a User ID exactly, an internal id in any case', () => {
    for (const s of ['HANA-ABCD-1234', 'hana-abcd-1234', 'abcd1234', 'ABCD-1234', ' hana abcd 1234 ', 'HANA-ABCD-I234']) expect(parseSupportQuery(s), s).toEqual({ kind: 'supportId', code: 'ABCD1234' });
    expect(parseSupportQuery('u1_EcoIFjT5lAWZsk0862e8Tg')).toEqual({ kind: 'userId', userId: 'u1_EcoIFjT5lAWZsk0862e8Tg' });
    expect(parseSupportQuery(INTERNAL.toUpperCase().replace('HU_', 'hu_'))).toEqual({ kind: 'internalId', internalId: INTERNAL });
  });

  it('refuses a wallet address, a sub, an email address and anything else', () => {
    for (const s of ['0x' + '1'.repeat(40), `G${'A'.repeat(55)}`, '110000000000000000001', 'e1.alice', 'alice@example.com', 'HANA-ABC', '', 'x'.repeat(300)]) expect(parseSupportQuery(s), s).toBeNull();
  });
});

describe('inputs', () => {
  it('AdminRpc.supportLookup: a query and an optional window of 1–731 days; nothing else', () => {
    expect(supportLookupInput.safeParse({ ...staff, query: 'HANA-ABCD-1234' }).success).toBe(true);
    expect(supportLookupInput.safeParse({ ...staff, query: 'HANA-ABCD-1234', days: 731 }).success).toBe(true);
    for (const bad of [{ days: 0 }, { days: 732 }, { days: 1.5 }, { requestIds: [] }]) expect(supportLookupInput.safeParse({ ...staff, query: 'x', ...bad }).success, JSON.stringify(bad)).toBe(false);
    expect(userSharesInput.safeParse({ ...staff, appId: 'app_1', path: 's1#google#1#0' }).success).toBe(true);
  });

  it('the BFF body: a ticket of printable characters with no address (it is stored), up to 20 request IDs', () => {
    expect(supportLookupBody.safeParse({ query: 'q', ticket: 'ZD-1234 refund' }).success).toBe(true);
    for (const ticket of ['', 'a@b.example', ' T', 'T ', 'x'.repeat(65), 'tab\there', 'é']) expect(supportLookupBody.safeParse({ query: 'q', ticket }).success, ticket).toBe(false);
    expect(supportLookupBody.safeParse({ query: 'q', ticket: 'T', requestIds: Array.from({ length: 20 }, (_, i) => `req_${String(i).padStart(8, '0')}`) }).success).toBe(true);
    expect(supportLookupBody.safeParse({ query: 'q', ticket: 'T', requestIds: Array.from({ length: 21 }, (_, i) => `req_${String(i).padStart(8, '0')}`) }).success).toBe(false);
    expect(supportLookupBody.safeParse({ query: 'q', ticket: 'T', requestIds: ['short'] }).success).toBe(false);
    expect(supportLookupBody.safeParse({ query: 'q', ticket: 'T', actor: {} }).success).toBe(false);
  });
});

describe('the ledger part', () => {
  it('maps rows without a uid, the uid as 32 hex characters of the internal id', () => {
    expect(uidHexOfInternalId(INTERNAL)).toBe(Buffer.from(UID).toString('hex'));
    expect(() => uidHexOfInternalId('hu_x')).toThrow(TypeError);
    const a = supportActivityOf({ request_id: 'req_1', at: new Date(5000), app_id: 'app_1', endpoint: 'login', status: 200, latency_ms: 12, relayed: true, near_tx: 'tx', uid: 'never' });
    expect(a).toEqual({ requestId: 'req_1', at: 5000, appId: 'app_1', endpoint: 'login', status: 200, latencyMs: 12, relayed: true, nearTx: 'tx' });
    const r = supportRequestOf({ request_id: 'req_2', at: '1970-01-01T00:00:06.000Z', org_id: 'org_a', app_id: null, scope_id: 's1', endpoint: 'owner_action', outcome: 'error', code: 'near_error', status: 502, latency_ms: 1, relayed: false, near_tx: null, by_match: true });
    expect(r).toMatchObject({ at: 6000, appId: null, outcome: 'error', byMatch: true });
    expect(() => supportActivityOf({ at: 'not a time' })).toThrow();
    // Neither query selects the uid as a column (the requests' only use of it is the by_match comparison).
    for (const sql of [SUPPORT_ACTIVITY_SQL, SUPPORT_REQUESTS_SQL]) {
      const columns = sql.slice('SELECT '.length, sql.indexOf(' FROM usage.events')).replace(/COALESCE\(uid = ANY .*\) AS by_match/u, 'by_match');
      expect(columns).not.toMatch(/\buid\b/u);
    }
  });

  it('sqlSupportLedger passes the parameters the SQL names', async () => {
    const seen: unknown[][] = [];
    const reader = sqlSupportLedger(async (sql, params) => (seen.push([sql, ...params]), []));
    await reader.activity('ab'.repeat(16), 1000, SUPPORT_ACTIVITY_MAX);
    await reader.requests(['req_12345678'], ['ab'.repeat(16)], SUPPORT_REQUEST_ROWS_MAX);
    expect(await reader.requests([], [], 1)).toEqual([]);
    expect(seen).toEqual([
      [SUPPORT_ACTIVITY_SQL, 'ab'.repeat(16), new Date(1000).toISOString(), SUPPORT_ACTIVITY_MAX],
      [SUPPORT_REQUESTS_SQL, ['req_12345678'], ['ab'.repeat(16)], SUPPORT_REQUEST_ROWS_MAX],
    ]);
  });

  const result = (n: number): SupportLookupResult => ({ query: { kind: 'supportId', code: 'ABCD1234' }, since: supportSince(10 * 86_400_000), truncated: false, matches: Array.from({ length: n }, () => ({ user: { internalId: INTERNAL } })) as unknown as SupportLookupResult['matches'] });

  it('withSupportLedger: each match’s events, the request IDs (deduplicated) and those with no event', async () => {
    const reader: SupportLedgerReader = {
      activity: async (u) => [{ requestId: `act-${u.slice(0, 4)}`, at: 1, appId: 'a', endpoint: 'login', status: 200, latencyMs: 1, relayed: false, nearTx: null }],
      requests: async (ids) => ids.filter((i) => i !== 'req_missing1').map((requestId) => ({ requestId, at: 1, orgId: 'o', appId: 'a', scopeId: 's', endpoint: 'login', outcome: 'rejected', code: 'x', status: 400, latencyMs: 1, relayed: false, nearTx: null, byMatch: false })),
    };
    const v = await withSupportLedger(result(2), { days: 30, requestIds: ['req_found01', 'req_missing1', 'req_found01'], reader });
    expect(v.ledger).toEqual({ available: true });
    expect(v.activity.map((a) => a!.length)).toEqual([1, 1]);
    expect(v.requests!.map((r) => r.requestId)).toEqual(['req_found01']);
    expect(v.requestsNotFound).toEqual(['req_missing1']);
    expect(v.days).toBe(30);
  });

  it('degrades to "ledger unavailable" without a reader or when a read fails, keeping the directory part', async () => {
    const none = await withSupportLedger(result(1), { days: 30, requestIds: ['req_found01'], reader: null });
    expect([none.ledger, none.activity, none.requests, none.requestsNotFound, none.matches.length]).toEqual([{ available: false, reason: LEDGER_UNAVAILABLE }, [null], null, [], 1]);
    const why = await withSupportLedger(result(1), { days: 30, requestIds: [], reader: null, unavailable: 'ledger unavailable: USAGE_DB is not bound' });
    expect(why.ledger).toEqual({ available: false, reason: 'ledger unavailable: USAGE_DB is not bound' });
    const failing: SupportLedgerReader = { activity: async () => Promise.reject(new Error('timeout')), requests: async () => [] };
    const failed = await withSupportLedger(result(1), { days: 30, requestIds: [], reader: failing });
    expect(failed.ledger).toEqual({ available: false, reason: `${LEDGER_UNAVAILABLE}: the read failed` });
  });
});
