// The staff Support ID lookup (batch C15, D394–D396): POST /api/support/lookup in the admin Worker, over the real API
// (AdminRpc.supportLookup) and the real console (StaffRpc.recordStaffAction); the ledger reads themselves run on PGlite
// (test-ops/support.test.ts). Staff only, CSRF-checked, the audit row before any read, and the ledger part degrading to
// "ledger unavailable" without USAGE_DB (sandbox-dev's capture is off). The email join (D399) over the real email
// issuer's DirectoryRpc: each identity's row read with the staff JWT and the same ticket, audited by the issuer as
// `support_lookup` naming the request.
import { SUPPORT_REQUEST_IDS_MAX, UNVERIFIED_CLAIM_WARNING, formatSupportId } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailedAudit } from '../src/feed.ts';
import { type LedgerStore, ledgerSource } from '../src/ledger.ts';
import type { RouteCtx } from '../src/routes.ts';
import worker from '../src/index.ts';
import { SUPPORT_EMAILS_MAX, type SupportLookupAnswer as SupportLookupView, supportLookupRoute } from '../src/support.ts';
import { ADMIN, ALIAS, CSRF, STAFF_EMAIL, STAFF_SUB, adminRequest, downBinding, envWith, json, overrideBinding, seedHotApp, staffJwt, stubNetwork, uid, useFakeEmail } from './helpers.ts';

beforeEach(async () => {
  await stubNetwork();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A wallet-directory user in the hot DB behind the real API (ids in the stored formats; the code is chosen). */
async function directoryUser(scope: string, code: string, identities: { provider: string; sub: string | null }[] = [{ provider: 'google', sub: `sub-${uid()}` }]) {
  const n = uid().toLowerCase().replace(/[^0-9a-hjkmnp-tv-z]/gu, '0');
  const internalId = `hu_${n.padEnd(26, '0').slice(0, 26)}`;
  const userId = `u1_${uid().replace(/[^A-Za-z0-9]/gu, 'A').padEnd(21, 'A').slice(0, 21)}A`;
  const now = Date.now();
  await env.HOT_DB.batch([
    env.HOT_DB.prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)').bind(internalId, userId, code, scope, now),
    ...identities.map((i, k) =>
      env.HOT_DB.prepare("INSERT INTO end_user_identities (scope_id, identity_key, user_id, provider, sub, role, status, effective_at, first_seen_at, observed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?8)").bind(
        scope,
        `${k.toString(16).padStart(2, '0')}${n}`.padEnd(64, 'a').slice(0, 64),
        internalId,
        i.provider,
        i.sub,
        k === 0 ? 'root' : 'member',
        k === 0 ? null : now - 1000,
        now,
      ),
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
      // The issuer's rule, so the same ticket opens the email join (D399).
      { query: q, ticket: 'ZD-1234 refund' },
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
    const issuer = overrideBinding(env.ISSUER!, { get: async () => (apiCalls.push('issuer.get'), { ok: false, code: 'not_found' }) });
    const ctx = (over: Partial<typeof env>): RouteCtx => ({
      request: new Request('https://admin.test/api/support/lookup', { method: 'POST' }),
      env: envWith({ API: api, ISSUER: issuer, ...over }),
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

/** The issuer's audit rows of one admin request (the email join names it as `lookup`). */
const issuerRowsOf = async (requestId: string) =>
  (await env.ISSUER_TEST_DB.prepare("SELECT staff, action, ticket, detail FROM email_admin_audit WHERE json_extract(detail, '$.lookup') = ? ORDER BY id").bind(requestId).all<{ staff: string; action: string; ticket: string; detail: string }>()).results;
const consoleRequestId = async (target: string) =>
  (await env.CONSOLE_TEST_DB.prepare("SELECT request_id FROM audit_log WHERE action = 'support.lookup' AND target = ? ORDER BY seq DESC LIMIT 1").bind(target).first<{ request_id: string }>())!.request_id;
async function seedIssuer(rows: { provider: 'email' | 'google'; sub: string; email: string; verified?: boolean }[]): Promise<void> {
  const now = Date.now();
  await env.ISSUER_TEST_DB.batch(
    rows.map((r) =>
      env.ISSUER_TEST_DB.prepare('INSERT INTO user_emails (provider, sub, email, email_verified, hosted, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(r.provider, r.sub, r.email, r.verified === false ? 0 : 1, r.provider === 'google' ? 0 : null, now - 2000, now - 1000),
    ),
  );
}
async function lookupWith(e: typeof env, body: unknown): Promise<Response> {
  const headers = new Headers(CSRF);
  headers.set('cf-access-jwt-assertion', await staffJwt());
  return worker.fetch(new Request(`${ADMIN}/api/support/lookup`, { method: 'POST', headers, body: JSON.stringify(body) }), e);
}

describe('POST /api/support/lookup: the email join (D399)', () => {
  it('reads each identity’s directory row with the same ticket; the issuer audits it as support_lookup naming the request', async () => {
    const app = await seedHotApp();
    const g = `g-${uid()}`;
    const e = `e1.${uid()}`;
    const missing = `e1.${uid()}`;
    const u = await directoryUser(app.scope, code(), [
      { provider: 'google', sub: g },
      { provider: 'email', sub: e },
      { provider: 'email', sub: missing },
      { provider: 'google', sub: null },
    ]);
    await seedIssuer([
      { provider: 'google', sub: g, email: `g.${g}@example.com` },
      { provider: 'email', sub: e, email: `e.${uid()}@example.com` },
    ]);
    const r = await adminRequest('/api/support/lookup', { body: { query: u.userId, ticket: 'ZD-5501' } });
    expect(r.status).toBe(200);
    const v = await json<SupportLookupView>(r);
    // Every identity with a sub, in the directory's order; one seen on chain only has no key to read.
    expect(v.emails).toEqual([
      { provider: 'google', sub: g, found: true, email: `g.${g}@example.com`, emailVerified: true, hosted: false, unverifiedClaim: false, firstSeenMs: expect.any(Number), lastSeenMs: expect.any(Number) },
      expect.objectContaining({ provider: 'email', sub: e, found: true, emailVerified: true, hosted: null }),
      { provider: 'email', sub: missing, found: false, reason: 'not_found' },
    ]);
    expect(v.unverifiedWarning).toBeUndefined();
    expect(v.emailsNote).toBeUndefined();
    // The issuer's rows: the staff member, the lookup's ticket, the action that says why, and the console row's request.
    const requestId = await consoleRequestId(u.userId);
    const rows = await issuerRowsOf(requestId);
    expect(rows.map((x) => [x.staff, x.action, x.ticket])).toEqual([
      [STAFF_EMAIL, 'support_lookup', 'ZD-5501'],
      [STAFF_EMAIL, 'support_lookup', 'ZD-5501'],
      [STAFF_EMAIL, 'support_lookup', 'ZD-5501'],
    ]);
    expect(rows.map((x) => JSON.parse(x.detail))).toEqual(
      expect.arrayContaining([
        { provider: 'google', sub: g, lookup: requestId, found: 1 },
        { provider: 'email', sub: missing, lookup: requestId, found: 0 },
      ]),
    );
  });

  it('marks a Google account’s unverified claim with the CLI’s warning', async () => {
    const app = await seedHotApp();
    const g = `g-${uid()}`;
    const u = await directoryUser(app.scope, code(), [{ provider: 'google', sub: g }]);
    await seedIssuer([{ provider: 'google', sub: g, email: `claim.${g}@example.com`, verified: false }]);
    const v = await json<SupportLookupView>(await adminRequest('/api/support/lookup', { body: { query: u.internalId, ticket: 'T-11' } }));
    expect(v.emails[0]).toMatchObject({ found: true, emailVerified: false, unverifiedClaim: true });
    expect(v.unverifiedWarning).toBe(UNVERIFIED_CLAIM_WARNING);
  });

  it('without the issuer, or with it down or refusing the staff identity, the lookup still answers and says why', async () => {
    const app = await seedHotApp();
    const u = await directoryUser(app.scope, code());
    const none = await lookupWith(envWith({ ISSUER: undefined }), { query: u.userId, ticket: 'T-12' });
    expect(none.status).toBe(200);
    const nv = await json<SupportLookupView>(none);
    expect([nv.matches.length, nv.emails.map((x) => x.found || x.reason), nv.emailsNote]).toEqual([1, ['directory_unavailable'], expect.stringMatching(/No email issuer/u)]);
    const down = await json<SupportLookupView>(await lookupWith(envWith({ ISSUER: downBinding() }), { query: u.userId, ticket: 'T-13' }));
    expect(down.emails.map((x) => x.found || x.reason)).toEqual(['directory_unavailable']);
    for (const [code_, reason] of [
      ['not_staff', 'directory_refused'],
      ['unauthenticated', 'directory_refused'],
      ['access_unavailable', 'directory_unavailable'],
      ['internal', 'failed'],
    ] as const) {
      const e = envWith({ ISSUER: overrideBinding(env.ISSUER!, { get: async () => ({ ok: false, code: code_ }) }) });
      const v = await json<SupportLookupView>(await lookupWith(e, { query: u.userId, ticket: 'T-14' }));
      expect(v.emails.map((x) => x.found || x.reason), code_).toEqual([reason]);
      expect(v.matches).toHaveLength(1);
    }
  });

  it('past the staff member’s row budget: rate_limited, the alias emailed once, a note with the window', async () => {
    const fake = useFakeEmail();
    const app = await seedHotApp();
    const u = await directoryUser(app.scope, code(), [
      { provider: 'google', sub: `g-${uid()}` },
      { provider: 'email', sub: `e1.${uid()}` },
    ]);
    const e = envWith({ ISSUER: overrideBinding(env.ISSUER!, { get: async () => ({ ok: false, code: 'rate_limited', budget: { window: '1h', limit: 500, retryAfterMs: 10 * 60_000 } }) }) });
    const v = await json<SupportLookupView>(await lookupWith(e, { query: u.userId, ticket: 'T-15' }));
    expect(v.emails.map((x) => x.found || x.reason)).toEqual(['rate_limited', 'rate_limited']);
    expect(v.emailsNote).toMatch(/500 identities an hour.*10 min/u);
    expect(fake.sent.map((m) => m.to)).toEqual([ALIAS]);
  });

  it(`reads at most ${SUPPORT_EMAILS_MAX} identities per lookup (the request's call budget); the rest are not_read`, async () => {
    const app = await seedHotApp();
    const ids = Array.from({ length: SUPPORT_EMAILS_MAX + 3 }, () => ({ provider: 'email', sub: `e1.${uid()}` }));
    const u = await directoryUser(app.scope, code(), ids);
    const asked: unknown[] = [];
    const e = envWith({ ISSUER: overrideBinding(env.ISSUER!, { get: async (c) => (asked.push(c), { ok: false, code: 'not_found' }) }) });
    const v = await json<SupportLookupView>(await lookupWith(e, { query: u.userId, ticket: 'T-16' }));
    expect(asked).toHaveLength(SUPPORT_EMAILS_MAX);
    expect(asked[0]).toMatchObject({ ticket: 'T-16', purpose: 'support_lookup', provider: 'email', accessJwt: expect.any(String), requestId: expect.stringMatching(/^req_/u) });
    expect(v.emails.filter((x) => !x.found && x.reason === 'not_read')).toHaveLength(3);
    expect(v.emailsNote).toMatch(new RegExp(`first ${SUPPORT_EMAILS_MAX} identities`, 'u'));
  });

  it('a lookup with no match reads nothing from the issuer', async () => {
    const asked: unknown[] = [];
    const e = envWith({ ISSUER: overrideBinding(env.ISSUER!, { get: async (c) => (asked.push(c), { ok: false, code: 'not_found' }) }) });
    const v = await json<SupportLookupView>(await lookupWith(e, { query: `HANA-${code().slice(0, 4)}-${code().slice(4)}`, ticket: 'T-17' }));
    expect([v.matches, v.emails, asked]).toEqual([[], [], []]);
  });

});
