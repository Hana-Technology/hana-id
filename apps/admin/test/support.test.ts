// The staff Support ID lookup (batch C15, D394–D396): POST /api/support/lookup in the admin Worker, over the real API
// (AdminRpc.supportLookup) and the real console (StaffRpc.recordStaffAction); the ledger reads themselves run on PGlite
// (test-ops/support.test.ts). Staff only, CSRF-checked, the audit row before any read, and the ledger part degrading to
// "ledger unavailable" without USAGE_DB (sandbox-dev's capture is off).
import { SUPPORT_REQUEST_IDS_MAX, formatSupportId, type SupportLookupView } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailedAudit } from '../src/feed.ts';
import { type LedgerStore, ledgerSource } from '../src/ledger.ts';
import type { RouteCtx } from '../src/routes.ts';
import { supportLookupRoute } from '../src/support.ts';
import { STAFF_EMAIL, STAFF_SUB, adminRequest, downBinding, envWith, json, overrideBinding, seedHotApp, stubNetwork, uid } from './helpers.ts';

beforeEach(async () => {
  await stubNetwork();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A wallet-directory user in the hot DB behind the real API (ids in the stored formats; the code is chosen). */
async function directoryUser(scope: string, code: string) {
  const n = uid().toLowerCase().replace(/[^0-9a-hjkmnp-tv-z]/gu, '0');
  const internalId = `hu_${n.padEnd(26, '0').slice(0, 26)}`;
  const userId = `u1_${uid().replace(/[^A-Za-z0-9]/gu, 'A').padEnd(21, 'A').slice(0, 21)}A`;
  const now = Date.now();
  await env.HOT_DB.batch([
    env.HOT_DB.prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)').bind(internalId, userId, code, scope, now),
    env.HOT_DB.prepare("INSERT INTO end_user_identities (scope_id, identity_key, user_id, provider, sub, role, status, effective_at, first_seen_at, observed_at) VALUES (?1, ?2, ?3, 'google', ?4, 'root', 'active', NULL, ?5, ?5)").bind(
      scope,
      n.padEnd(64, 'a').slice(0, 64),
      internalId,
      `sub-${uid()}`,
      now,
    ),
  ]);
  return { internalId, userId, supportId: formatSupportId(code) };
}

const code = (): string => uid().toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/gu, '0').padEnd(8, '0').slice(-8);

const auditRows = (requestTarget: string) =>
  env.CONSOLE_TEST_DB.prepare("SELECT org_id, actor_kind, actor_id, actor_email, target, details_json FROM audit_log WHERE action = 'support.lookup' AND target = ?").bind(requestTarget).all<Record<string, unknown>>().then((r) => r.results);

function store(over: Partial<LedgerStore['support']> = {}): LedgerStore {
  return { support: { activity: async () => [], requests: async () => [], ...over }, close: async () => {} } as unknown as LedgerStore;
}

describe('POST /api/support/lookup', () => {
  it('needs a staff Access JWT and the CSRF headers, and is POST only', async () => {
    expect((await adminRequest('/api/support/lookup', { body: { query: 'HANA-0000-0000', ticket: 'T-1' }, jwt: null })).status).toBe(401);
    expect((await adminRequest('/api/support/lookup', { body: { query: 'HANA-0000-0000', ticket: 'T-1' }, csrf: false })).status).toBe(403);
    // POST only: a code never lands in a URL.
    expect((await adminRequest('/api/support/lookup')).status).toBe(405);
  });

  it('refuses a body without a ticket, a ticket with an address, a query that names no user id and too many request IDs, before any audit row', async () => {
    const q = `HANA-${code().slice(0, 4)}-${code().slice(0, 4)}`;
    const bad: Record<string, unknown>[] = [
      { query: q },
      { query: q, ticket: 'alice@example.com' },
      { query: q, ticket: ' T-1' },
      { query: '0x' + 'a'.repeat(40), ticket: 'T-1' },
      { query: 'a-google-sub', ticket: 'T-1' },
      { query: q, ticket: 'T-1', requestIds: Array.from({ length: SUPPORT_REQUEST_IDS_MAX + 1 }, (_, i) => `req_${String(i).padStart(8, '0')}`) },
      { query: q, ticket: 'T-1', requestIds: ['short'] },
      { query: q, ticket: 'T-1', days: 0 },
      { query: q, ticket: 'T-1', extra: 1 },
    ];
    for (const body of bad) {
      const r = await adminRequest('/api/support/lookup', { body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(await auditRows(q)).toEqual([]);
  });

  it('records the lookup (org-less, the staff identity, the ticket) and answers the directory part with "ledger unavailable" without USAGE_DB', async () => {
    const app = await seedHotApp();
    const c = code();
    const u = await directoryUser(app.scope, c);
    const r = await adminRequest('/api/support/lookup', { body: { query: u.supportId.toLowerCase().replaceAll('-', ''), ticket: 'ZD-1234', requestIds: ['req_aaaaaaaa'] } });
    expect(r.status).toBe(200);
    const v = await json<SupportLookupView>(r);
    expect(v.matches.map((m) => m.user.userId)).toEqual([u.userId]);
    expect(v.matches[0]!.apps.map((a) => a.appId)).toEqual([app.id]);
    expect(v.ledger).toEqual({ available: false, reason: expect.stringMatching(/^ledger unavailable/u) });
    expect([v.activity, v.requests, v.requestsNotFound, v.days]).toEqual([[null], null, [], 30]);
    // The audit row names the query as a Support ID (whatever the case typed), never an address or a sub.
    expect(await auditRows(u.supportId)).toEqual([
      { org_id: null, actor_kind: 'hana', actor_id: STAFF_SUB, actor_email: STAFF_EMAIL, target: u.supportId, details_json: JSON.stringify({ by: 'supportId', ticket: 'ZD-1234', requestIds: 1, days: 30 }) },
    ]);
  });

  it('adds each match’s ok events and the request IDs’ events from the ledger, and the IDs it has no event for', async () => {
    const app = await seedHotApp();
    const u = await directoryUser(app.scope, code());
    const seen: unknown[][] = [];
    vi.spyOn(ledgerSource, 'open').mockImplementation(async () =>
      store({
        activity: async (...a) => {
          seen.push(['activity', ...a]);
          return [{ requestId: 'req_login001', at: 1, appId: app.id, endpoint: 'login', status: 200, latencyMs: 900, relayed: true, nearTx: 'tx1' }];
        },
        requests: async (...a) => {
          seen.push(['requests', ...a]);
          return [{ requestId: 'req_failed01', at: 2, orgId: app.org, appId: app.id, scopeId: app.scope, endpoint: 'login', outcome: 'rejected', code: 'nonce_mismatch', status: 400, latencyMs: 30, relayed: false, nearTx: null, byMatch: false }];
        },
      }),
    );
    const r = await adminRequest('/api/support/lookup', { body: { query: u.userId, ticket: 'ZD-9', requestIds: ['req_failed01', 'req_missing1', 'req_failed01'], days: 7 } });
    expect(r.status).toBe(200);
    const v = await json<SupportLookupView>(r);
    expect(v.ledger).toEqual({ available: true });
    expect(v.activity).toEqual([[expect.objectContaining({ requestId: 'req_login001', nearTx: 'tx1' })]]);
    expect(v.requests).toEqual([expect.objectContaining({ requestId: 'req_failed01', code: 'nonce_mismatch', byMatch: false })]);
    expect(v.requestsNotFound).toEqual(['req_missing1']);
    // The ledger is asked by the internal id's 16 bytes (hex), over the window, and with the matches' uids.
    const uidHex = expect.stringMatching(/^[0-9a-f]{32}$/u);
    expect(seen).toEqual([
      ['activity', uidHex, v.since, 400],
      ['requests', ['req_failed01', 'req_missing1'], [uidHex], 100],
    ]);
    expect(v.since).toBeLessThanOrEqual(Date.now() - 7 * 86_400_000 + 60_000);
  });

  it('still answers the directory part when the ledger read fails or the connection does', async () => {
    const app = await seedHotApp();
    const u = await directoryUser(app.scope, code());
    vi.spyOn(ledgerSource, 'open').mockImplementation(async () => store({ activity: async () => Promise.reject(new Error('boom')) }));
    const failed = await json<SupportLookupView>(await adminRequest('/api/support/lookup', { body: { query: u.internalId, ticket: 'T-2' } }));
    expect([failed.matches.length, failed.ledger]).toEqual([1, { available: false, reason: 'ledger unavailable: the read failed' }]);
    vi.restoreAllMocks();
    await stubNetwork();
    vi.spyOn(ledgerSource, 'open').mockImplementation(async () => Promise.reject(new Error('no route')));
    const down = await json<SupportLookupView>(await adminRequest('/api/support/lookup', { body: { query: u.internalId, ticket: 'T-3' } }));
    expect([down.matches.length, down.ledger]).toEqual([1, { available: false, reason: 'ledger unavailable: no connection' }]);
  });

  it('reads nothing when the audit row can’t be written (the console down or refusing)', async () => {
    const app = await seedHotApp();
    const u = await directoryUser(app.scope, code());
    const apiCalls: string[] = [];
    const api = overrideBinding(env.API, { supportLookup: async () => (apiCalls.push('supportLookup'), { ok: true, query: {}, since: 0, matches: [], truncated: false }) });
    const ctx = (over: Partial<typeof env>): RouteCtx => ({
      request: new Request('https://admin.test/api/support/lookup', { method: 'POST' }),
      env: envWith({ API: api, ...over }),
      staff: { actor: { kind: 'hana', id: STAFF_SUB, email: STAFF_EMAIL }, requestId: `req_${uid()}`, clientIp: '198.51.100.9' },
      url: new URL('https://admin.test/api/support/lookup'),
      params: {},
      body: { query: u.supportId, ticket: 'T-4' },
    });
    const down = await supportLookupRoute(ctx({ CONSOLE: downBinding() }));
    expect(down.status).toBe(503);
    const refusing = await supportLookupRoute(ctx({ CONSOLE: overrideBinding(env.CONSOLE, { recordStaffAction: async () => ({ ok: false, code: 'internal' }) }) }));
    expect(refusing.status).toBe(500);
    expect(apiCalls).toEqual([]);
  });

  it('a lookup’s audit row is never emailed by the feed', () => {
    expect(emailedAudit({ action: 'support.lookup' } as Parameters<typeof emailedAudit>[0])).toBe(false);
  });
});
