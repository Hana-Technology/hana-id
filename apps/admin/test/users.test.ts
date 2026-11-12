// The staff Users screen (C8b; D275 as confirmed 2026-11-05; spec "Users and Support ID" → "Users screen", "Tests"):
// the BFF over the real email issuer's DirectoryRpc (which checks the staff JWT itself and audits every read in its own
// D1), the real API's wallet directory (AdminRpc.findUsers, appNames) and the chain's get_identity / get_account (the
// suite's fake RPC). The ticket is required to open a user, to search by sub or a full address and to find a user in
// the wallet directory (audited first in the console, D410), and optional to browse; budget refusals email the alias;
// a failed chain read is "chain unavailable", never a guessed path; unverified Google claims carry the CLI's warning.
// The Hana Home names (D714): a list's in one AdminRpc.profileNames call, an opened identity's too, a failed read
// leaving the page up and marked.
import { UNVERIFIED_CLAIM_WARNING, internalIdOf, supportIdOf } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.ts';
import { ADMIN, ALIAS, CSRF, STAFF_EMAIL, adminRequest, downBinding, envWith, identityViews, json, nearCalls, overrideBinding, seedHotApp, setNearDown, staffJwt, stubNetwork, useFakeEmail, viewKey } from './helpers.ts';

beforeEach(async () => {
  await stubNetwork();
  setNearDown(false);
  identityViews.clear();
  nearCalls.length = 0;
  await env.ISSUER_TEST_DB.batch(['user_emails', 'user_email_apps', 'email_admin_audit'].map((t) => env.ISSUER_TEST_DB.prepare(`DELETE FROM ${t}`)));
  await env.HOT_DB.prepare('DELETE FROM home_profiles').run();
});
afterEach(() => vi.restoreAllMocks());

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const stellarAddress = () => `G${[...crypto.getRandomValues(new Uint8Array(55))].map((b) => B32[b % 32]).join('')}`;
const hex64 = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');

interface DirSeed {
  provider: 'email' | 'google';
  sub: string;
  email: string;
  verified?: boolean;
  hosted?: boolean | null;
  seen?: number;
  apps?: { appId: string; scopeId: string }[];
}
async function seedDirectory(...rows: DirSeed[]): Promise<void> {
  const db = env.ISSUER_TEST_DB;
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    const seen = r.seen ?? Date.now();
    stmts.push(
      db.prepare('INSERT INTO user_emails (provider, sub, email, email_verified, hosted, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(r.provider, r.sub, r.email, r.verified === false ? 0 : 1, r.hosted === undefined ? (r.provider === 'google' ? 0 : null) : r.hosted === null ? null : r.hosted ? 1 : 0, seen - 1000, seen),
    );
    for (const a of r.apps ?? []) stmts.push(db.prepare('INSERT INTO user_email_apps (provider, sub, app_id, scope_id, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?)').bind(r.provider, r.sub, a.appId, a.scopeId, seen - 500, seen));
  }
  await db.batch(stmts);
}

/** A wallet-directory user in the hot DB: root identity (and members), wallets; its three ids. */
async function seedWalletUser(scope: string, identities: { provider: string; sub: string | null; role?: 'root' | 'member'; key?: string }[]) {
  const internalId = internalIdOf(crypto.getRandomValues(new Uint8Array(16)));
  const userId = `u1_${b64url(crypto.getRandomValues(new Uint8Array(16)))}`;
  const supportCode = supportIdOf(userId).replace('HANA-', '').replace('-', '');
  const now = Date.now();
  const stellar = stellarAddress();
  const db = env.HOT_DB;
  const stmts = [
    db.prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)').bind(internalId, userId, supportCode, scope, now - 5000, now),
    db.prepare("INSERT INTO end_user_wallets (user_id, chain, address, key_index, first_seen_at, last_used_at) VALUES (?, 'stellar', ?, 0, ?, ?)").bind(internalId, stellar, now - 5000, now),
  ];
  const keys: string[] = [];
  for (const i of identities) {
    const key = i.key ?? hex64();
    keys.push(key);
    stmts.push(
      db.prepare("INSERT INTO end_user_identities (scope_id, identity_key, user_id, provider, sub, role, status, effective_at, first_seen_at, observed_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)").bind(scope, key, internalId, i.provider, i.sub, i.role ?? 'root', i.role === 'member' ? now - 1000 : null, now - 5000, now),
    );
  }
  await db.batch(stmts);
  return { internalId, userId, supportId: supportIdOf(userId), stellar, keys };
}

/** A Hana Home name (migration 0021's `home_profiles`), as the API's Home endpoint stores it. */
async function seedName(provider: string, sub: string, givenName: string | null, familyName: string | null): Promise<void> {
  await env.HOT_DB.prepare('INSERT INTO home_profiles (provider, sub, given_name, family_name, updated_at) VALUES (?, ?, ?, ?, ?)').bind(provider, sub, givenName, familyName, Date.now()).run();
}

const issuerAudit = async () => (await env.ISSUER_TEST_DB.prepare('SELECT staff, action, ticket, detail FROM email_admin_audit ORDER BY id').all<{ staff: string; action: string; ticket: string | null; detail: string }>()).results;

/** A request to the Worker with another env (ISSUER replaced or removed). */
async function requestWith(e: typeof env, path: string, body: unknown): Promise<Response> {
  const headers = new Headers(CSRF);
  headers.set('cf-access-jwt-assertion', await staffJwt());
  return worker.fetch(new Request(`${ADMIN}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), e);
}

describe('POST /api/users/search (the issuer’s directory)', () => {
  it('finds by address, verified rows first, unverified claims flagged with the CLI’s warning; audited at the issuer as the staff member', async () => {
    const now = Date.now();
    await seedDirectory(
      { provider: 'google', sub: '9001', email: 'pat@example.com', verified: false, seen: now },
      { provider: 'google', sub: '9002', email: 'pat@example.com', verified: true, hosted: true, seen: now - 50 },
      { provider: 'email', sub: 'e1.pat', email: 'pat@example.com', seen: now - 100 },
    );
    // A full address names one person: without a ticket it is refused before the issuer is called (D410).
    const bare = await adminRequest('/api/users/search', { body: { q: 'Pat@Example.com' } });
    expect(bare.status).toBe(400);
    expect((await json<{ error: { message: string } }>(bare)).error.message).toMatch(/support reference \(ticket\) is required to search by sub or by a full address/u);
    expect(await issuerAudit()).toEqual([]);
    const res = await adminRequest('/api/users/search', { body: { q: 'Pat@Example.com', ticket: 'ZD-1' } });
    expect(res.status).toBe(200);
    const body = await json<{ users: { sub: string; unverifiedClaim: boolean; email: string }[]; unverifiedWarning: string }>(res);
    expect(body.users.map((u) => [u.sub, u.unverifiedClaim])).toEqual([
      ['9002', false],
      ['e1.pat', false],
      ['9001', true],
    ]);
    expect(body.unverifiedWarning).toBe(UNVERIFIED_CLAIM_WARNING);
    const audit = await issuerAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ staff: STAFF_EMAIL, action: 'user_search', ticket: 'ZD-1' });
    expect(audit[0]!.detail).not.toMatch(/pat|example/u);
    expect(JSON.parse(audit[0]!.detail)).toMatchObject({ q: { match: 'exact' }, rows: 3 });
  });

  it('passes the optional ticket and the filters through; refuses what the issuer refuses (a 2-character term)', async () => {
    await seedDirectory({ provider: 'email', sub: 'e1.q1', email: 'quinn@corp.example', apps: [{ appId: 'app_q', scopeId: 's1' }] }, { provider: 'google', sub: '9100', email: 'quinn@corp.example' });
    const r = await json<{ users: { sub: string }[] }>(await adminRequest('/api/users/search', { body: { q: 'corp', provider: 'email', appId: 'app_q', ticket: 'ZD-77', limit: 500 } }));
    expect(r.users.map((u) => u.sub)).toEqual(['e1.q1']);
    expect((await issuerAudit())[0]).toMatchObject({ ticket: 'ZD-77' });
    const short = await adminRequest('/api/users/search', { body: { q: 'co' } });
    expect(short.status).toBe(400);
    expect((await json<{ error: { code: string } }>(short)).error.code).toBe('bad_request');
  });

  it('a sub filter names one identity: refused without a ticket (any other filters too), before the issuer reads; a substring browses without one (D410)', async () => {
    await seedDirectory({ provider: 'google', sub: '9300', email: 'sam@corp.example' });
    for (const body of [{ sub: '9300' }, { sub: '9300', provider: 'google' }, { q: 'corp', sub: '9300' }, { sub: '9300', ticket: 'has space' }]) {
      const r = await adminRequest('/api/users/search', { body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(await json(r))).not.toContain('sam@');
    }
    expect(await issuerAudit()).toEqual([]);
    const ok = await json<{ users: { sub: string; email: string }[] }>(await adminRequest('/api/users/search', { body: { sub: '9300', ticket: 'ZD-93' } }));
    expect(ok.users.map((u) => u.email)).toEqual(['sam@corp.example']);
    const browse = await json<{ users: { sub: string }[] }>(await adminRequest('/api/users/search', { body: { q: 'corp' } }));
    expect(browse.users.map((u) => u.sub)).toEqual(['9300']);
    expect((await issuerAudit()).map((a) => a.ticket)).toEqual(['ZD-93', null]);
    // The issuer holds the same rule on its own, for a caller that skips the BFF's check.
    const direct = await env.ISSUER!.search({ requestId: 'req_direct01', accessJwt: await staffJwt(), sub: '9300' });
    expect(direct).toMatchObject({ ok: false, code: 'bad_request', error: expect.stringMatching(/required to search by sub/u) });
  });

  it('is POST only with the CSRF checks; no address goes in a URL', async () => {
    expect((await adminRequest('/api/users/search?q=a@b.example')).status).toBe(405);
    expect((await adminRequest('/api/users/search', { body: {}, csrf: false })).status).toBe(403);
  });

  it('without an ISSUER binding, or with the issuer down: 503 directory_unavailable', async () => {
    for (const e of [envWith({ ISSUER: undefined }), envWith({ ISSUER: downBinding() })]) {
      const res = await requestWith(e, '/api/users/search', { q: 'someone@example.com', ticket: 'T-0' });
      expect(res.status).toBe(503);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('directory_unavailable');
    }
  });

  it('an issuer that refuses the staff identity this Worker accepted (config drift) is 502 directory_refused', async () => {
    for (const code of ['unauthenticated', 'not_staff']) {
      const e = envWith({ ISSUER: overrideBinding(env.ISSUER!, { search: async () => ({ ok: false, code }) }) });
      const res = await requestWith(e, '/api/users/search', {});
      expect(res.status).toBe(502);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('directory_refused');
    }
  });

  it('a budget refusal is 429 with Retry-After, and the security alias is emailed (directory_budget), once per window', async () => {
    // One instant for both requests: the alert's window is the minute it opens, rounded (users.ts budgetAlert), so two
    // requests on a running clock can fall either side of a rounding edge and count as two windows.
    const t = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t);
    const fake = useFakeEmail();
    const budget = { window: '1h', limit: 500, retryAfterMs: 20 * 60_000 };
    const e = envWith({ ISSUER: overrideBinding(env.ISSUER!, { search: async () => ({ ok: false, code: 'rate_limited', budget }) }) });
    const res = await requestWith(e, '/api/users/search', {});
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe(String(20 * 60));
    expect((await json<{ error: { message: string } }>(res)).error.message).toMatch(/500 identities an hour/u);
    expect(fake.sent.map((m) => m.to)).toEqual([ALIAS]);
    expect(fake.sent[0]!.subject).toContain(`User directory budget reached by ${STAFF_EMAIL}`);
    expect(fake.sent[0]!.text).toMatch(/500 identities an hour/u);
    await requestWith(e, '/api/users/search', {});
    // The repeat (same staff member and window) is not sent again from this isolate (D401: SendGrid has no idempotency
    // key); a fresh isolate may send it once more.
    expect(fake.attempts).toHaveLength(1);
  });
});

describe('POST /api/users/search: the page’s Hana Home names (D714)', () => {
  it('each row’s name from one AdminRpc.profileNames call for the page’s identities; a row with none is null', async () => {
    await seedDirectory({ provider: 'google', sub: '9401', email: 'ann@names.example' }, { provider: 'email', sub: 'e1.ann', email: 'ann@names.example' }, { provider: 'google', sub: '9402', email: 'bo@names.example' });
    await seedName('google', '9401', 'Ann', 'Lee');
    await seedName('email', 'e1.ann', null, 'Lee');
    await seedName('google', 'unrelated', 'Zed', null);
    const asked: unknown[] = [];
    const api = overrideBinding(env.API, { profileNames: (c: unknown) => (asked.push(c), env.API.profileNames(c)) });
    const res = await requestWith(envWith({ API: api }), '/api/users/search', { q: 'names.example' });
    expect(res.status).toBe(200);
    const body = await json<{ users: { sub: string; name: unknown }[]; namesError?: string }>(res);
    expect(Object.fromEntries(body.users.map((u) => [u.sub, u.name]))).toEqual({ '9401': { givenName: 'Ann', familyName: 'Lee' }, 'e1.ann': { givenName: null, familyName: 'Lee' }, '9402': null });
    expect(body.namesError).toBeUndefined();
    expect(asked).toHaveLength(1);
    const identities = (asked[0] as { identities: { provider: string; sub: string }[] }).identities;
    expect(identities.map((i) => `${i.provider}:${i.sub}`).sort()).toEqual(['email:e1.ann', 'google:9401', 'google:9402']);
    expect(asked[0]).toMatchObject({ actor: { kind: 'hana' } }); // the staff member's context (rpc.ts staffCtx)
  });

  it('asks the issuer for at most 50 rows (one names call covers them), the default page when none is asked', async () => {
    const limits: unknown[] = [];
    const issuer = overrideBinding(env.ISSUER!, { search: (c: unknown) => (limits.push((c as { limit?: unknown }).limit), env.ISSUER!.search(c as never)) });
    for (const body of [{ limit: 100 }, { limit: 20 }, {}]) expect((await requestWith(envWith({ ISSUER: issuer }), '/api/users/search', body)).status).toBe(200);
    expect(limits).toEqual([50, 20, 50]);
  });

  it('an empty page makes no names call', async () => {
    let calls = 0;
    const api = overrideBinding(env.API, { profileNames: async () => (calls++, { ok: true, names: [] }) });
    const body = await json<{ users: unknown[]; namesError?: string }>(await requestWith(envWith({ API: api }), '/api/users/search', { q: 'nobody-here' }));
    expect([body.users, body.namesError, calls]).toEqual([[], undefined, 0]);
  });

  it('a failed names read leaves the list up: rows without `name`, the answer marked `namesError`', async () => {
    await seedDirectory({ provider: 'google', sub: '9501', email: 'cy@names.example' });
    await seedName('google', '9501', 'Cy', null);
    for (const [profileNames, code] of [
      [async () => Promise.reject(new Error('Service unavailable')), 'upstream_unavailable'],
      [async () => ({ ok: false, code: 'internal', error: 'x' }), 'internal'],
    ] as const) {
      const res = await requestWith(envWith({ API: overrideBinding(env.API, { profileNames }) }), '/api/users/search', { q: 'names.example' });
      expect(res.status).toBe(200);
      const body = await json<{ users: Record<string, unknown>[]; namesError?: string }>(res);
      expect(body.users.map((u) => u.email)).toEqual(['cy@names.example']);
      expect('name' in body.users[0]!).toBe(false);
      expect(body.namesError).toBe(code);
    }
  });

  it('a name passes as its two parts only; no log line carries it', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    await seedDirectory({ provider: 'google', sub: '9601', email: 'di@names.example' });
    const api = overrideBinding(env.API, { profileNames: async () => ({ ok: true, names: [{ provider: 'google', sub: '9601', givenName: 'Quietname', familyName: null, extra: 'x' }] }) });
    const body = await json<{ users: { name: unknown }[] }>(await requestWith(envWith({ API: api }), '/api/users/search', { q: 'names.example' }));
    expect(body.users[0]!.name).toEqual({ givenName: 'Quietname', familyName: null });
    await requestWith(envWith({ API: overrideBinding(env.API, { profileNames: async () => Promise.reject(new Error('down')) }) }), '/api/users/search', { q: 'names.example' });
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toMatch(/Quietname|9601|names\.example/u);
  });
});

describe('POST /api/users/get (one identity, the ticket required)', () => {
  it('refuses without a support reference before reading anything', async () => {
    for (const body of [{ provider: 'google', sub: '1' }, { provider: 'google', sub: '1', ticket: '' }, { provider: 'google', sub: '1', ticket: 'has space' }, { provider: 'apple', sub: '1', ticket: 'T-1' }]) {
      const res = await adminRequest('/api/users/get', { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await issuerAudit()).toEqual([]);
  });

  it('the row, its apps by name, the wallet directory’s ids and wallets, and the on-chain path per scope with the block height', async () => {
    const app = await seedHotApp();
    const other = await seedHotApp();
    await seedDirectory({ provider: 'google', sub: '7001', email: 'owner@example.com', verified: true, hosted: true, apps: [{ appId: app.id, scopeId: app.scope }, { appId: other.id, scopeId: other.scope }] });
    const w = await seedWalletUser(app.scope, [{ provider: 'google', sub: '7001' }, { provider: 'email', sub: 'e1.member', role: 'member' }]);
    // Scope 1: the root of an account with an email member; scope 2: chain unavailable.
    identityViews.set(viewKey('get_identity', app.scope, 'google', '7001'), { key: w.keys[0], status: 'own', opened: true, root: null, effective_at_ms: null, account_epoch: 1 });
    identityViews.set(viewKey('get_account', app.scope, 'google', '7001'), { root: { provider: 'google', sub: '7001' }, members: [{ key: w.keys[1], provider: 'email', effective_at_ms: 5, active: true, auto: true }], epoch: 1, unlinked: [] });

    const res = await adminRequest('/api/users/get', { body: { provider: 'google', sub: '7001', ticket: 'SUP-1' } });
    expect(res.status).toBe(200);
    const d = await json<Record<string, any>>(res);
    expect(d.user).toMatchObject({ provider: 'google', sub: '7001', email: 'owner@example.com', emailVerified: true, hosted: true, unverifiedClaim: false, appCount: 2 });
    expect(d.warning).toBeUndefined();
    const byId = new Map((d.apps as { appId: string }[]).map((a) => [a.appId, a]));
    expect(byId.get(app.id)).toMatchObject({ name: `Test ${app.id}`, orgId: app.org, environment: 'test', scopeId: app.scope });
    expect(d.walletUsers).toHaveLength(1);
    expect(d.walletUsers[0]).toMatchObject({ userId: w.userId, supportId: w.supportId, internalId: w.internalId, scopeId: app.scope });
    expect(d.walletUsers[0].wallets[0]).toMatchObject({ chain: 'stellar', address: w.stellar });
    const s1 = (d.chain as { scopeId: string }[]).find((c) => c.scopeId === app.scope) as Record<string, any>;
    expect(s1).toMatchObject({ ok: true, status: 'own', opened: true, blockHeight: 4242, path: `${app.scope}#google#7001#0` });
    expect(s1.account.members).toEqual([{ key: w.keys[1], provider: 'email', active: true, effectiveAtMs: 5, sub: 'e1.member' }]);
    const s2 = (d.chain as { scopeId: string }[]).find((c) => c.scopeId === other.scope);
    expect(s2).toEqual({ scopeId: other.scope, ok: false, reason: 'chain_unavailable' });
    // Audited at the issuer: the view, the ticket, {provider, sub}.
    const audit = await issuerAudit();
    expect(audit.map((r) => [r.staff, r.action, r.ticket])).toEqual([[STAFF_EMAIL, 'user_view', 'SUP-1']]);
    expect(JSON.parse(audit[0]!.detail)).toEqual({ provider: 'google', sub: '7001', found: 1 });
  });

  it('a member: the path is its account root’s, with the root to open; pending shows when it takes effect', async () => {
    const app = await seedHotApp();
    await seedDirectory({ provider: 'email', sub: 'e1.m', email: 'm@example.com', apps: [{ appId: app.id, scopeId: app.scope }] });
    identityViews.set(viewKey('get_identity', app.scope, 'email', 'e1.m'), { key: hex64(), status: 'pending', opened: false, root: { provider: 'google', sub: '8001' }, effective_at_ms: 9_999, account_epoch: 2 });
    const d = await json<Record<string, any>>(await adminRequest('/api/users/get', { body: { provider: 'email', sub: 'e1.m', ticket: 'T-2' } }));
    // get_account answered null for this fake: the path still stands, read from get_identity.
    expect(d.chain[0]).toMatchObject({ ok: true, status: 'pending', path: `${app.scope}#google#8001#0`, root: { provider: 'google', sub: '8001' }, effectiveAtMs: 9_999, account: null });
  });

  it('an active member: the root’s path, the account read live with its members', async () => {
    const app = await seedHotApp();
    const memberKey = hex64();
    await seedDirectory({ provider: 'email', sub: 'e1.mem', email: 'mem@example.com', apps: [{ appId: app.id, scopeId: app.scope }] });
    identityViews.set(viewKey('get_identity', app.scope, 'email', 'e1.mem'), { key: memberKey, status: 'member', opened: false, root: { provider: 'google', sub: '8100' }, effective_at_ms: 100, account_epoch: 3 });
    identityViews.set(viewKey('get_account', app.scope, 'email', 'e1.mem'), { root: { provider: 'google', sub: '8100' }, members: [{ key: memberKey, provider: 'email', effective_at_ms: 100, active: true, auto: false }], epoch: 3, unlinked: [] });
    const d = await json<Record<string, any>>(await adminRequest('/api/users/get', { body: { provider: 'email', sub: 'e1.mem', ticket: 'T-8' } }));
    expect(d.chain[0]).toMatchObject({ ok: true, status: 'member', opened: false, path: `${app.scope}#google#8100#0`, root: { provider: 'google', sub: '8100' }, account: { root: { provider: 'google', sub: '8100' }, epoch: 3 } });
    // The wallet directory doesn't know this member yet: its sub stays unknown rather than guessed.
    expect(d.chain[0].account.members).toEqual([{ key: memberKey, provider: 'email', active: true, effectiveAtMs: 100, sub: null }]);
  });

  it('no admin log line carries the address, the sub or the ticket', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    await seedDirectory({ provider: 'google', sub: '66601', email: 'quiet.person@private.example' });
    await adminRequest('/api/users/search', { body: { q: 'quiet.person@private.example', ticket: 'TCK-ADM-1' } });
    await adminRequest('/api/users/get', { body: { provider: 'google', sub: '66601', ticket: 'TCK-ADM-2' } });
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toMatch(/quiet|private\.example|66601|TCK-ADM|staff@hana/u);
  });

  it('NEAR down: every scope "chain unavailable", never a guessed path', async () => {
    const app = await seedHotApp();
    await seedDirectory({ provider: 'email', sub: 'e1.n', email: 'n@example.com', apps: [{ appId: app.id, scopeId: app.scope }] });
    identityViews.set(viewKey('get_identity', app.scope, 'email', 'e1.n'), { key: hex64(), status: 'own', opened: true, root: null, effective_at_ms: null, account_epoch: 0 });
    setNearDown(true);
    const d = await json<Record<string, any>>(await adminRequest('/api/users/get', { body: { provider: 'email', sub: 'e1.n', ticket: 'T-3' } }));
    expect(d.chain).toEqual([{ scopeId: app.scope, ok: false, reason: 'chain_unavailable' }]);
    expect(JSON.stringify(d.chain)).not.toContain('#');
  });

  it('an unverified Google claim carries the warning; an identity without a directory row still shows its wallets', async () => {
    const app = await seedHotApp();
    await seedDirectory({ provider: 'google', sub: '7100', email: 'claim@example.com', verified: false });
    const d = await json<Record<string, any>>(await adminRequest('/api/users/get', { body: { provider: 'google', sub: '7100', ticket: 'T-4' } }));
    expect(d.user.unverifiedClaim).toBe(true);
    expect(d.warning).toBe(UNVERIFIED_CLAIM_WARNING);

    const w = await seedWalletUser(app.scope, [{ provider: 'google', sub: '7200' }]);
    identityViews.set(viewKey('get_identity', app.scope, 'google', '7200'), { key: w.keys[0], status: 'own', opened: true, root: null, effective_at_ms: null, account_epoch: 0 });
    const none = await adminRequest('/api/users/get', { body: { provider: 'google', sub: '7200', ticket: 'T-5' } });
    expect(none.status).toBe(200);
    const n = await json<Record<string, any>>(none);
    expect(n.user).toBeNull();
    expect(n.walletUsers.map((u: { userId: string }) => u.userId)).toEqual([w.userId]);
    expect(n.chain[0]).toMatchObject({ ok: true, path: `${app.scope}#google#7200#0` });
    // The miss was audited too.
    expect(JSON.parse((await issuerAudit()).at(-1)!.detail)).toEqual({ provider: 'google', sub: '7200', found: 0 });
  });

  it('the identity’s Hana Home name (D714), with or without a directory row; null for none; `nameError` when unread', async () => {
    const app = await seedHotApp();
    await seedDirectory({ provider: 'google', sub: '7601', email: 'named@example.com', apps: [{ appId: app.id, scopeId: app.scope }] });
    await seedName('google', '7601', 'Nadia', 'Rahman');
    const w = await seedWalletUser(app.scope, [{ provider: 'google', sub: '7601' }, { provider: 'email', sub: 'e1.nadia', role: 'member' }]);
    await seedName('email', 'e1.nadia', 'Nad', null);
    const d = await json<Record<string, any>>(await adminRequest('/api/users/get', { body: { provider: 'google', sub: '7601', ticket: 'T-N1' } }));
    expect(d.name).toEqual({ givenName: 'Nadia', familyName: 'Rahman' });
    expect(d.nameError).toBeUndefined();
    // The wallet directory's user carries the account's name and each identity's (StaffUser, the API's).
    expect(d.walletUsers[0]).toMatchObject({ userId: w.userId, name: { givenName: 'Nadia', familyName: 'Rahman' } });
    expect(d.walletUsers[0].identities.map((i: { sub: string; name: unknown }) => [i.sub, i.name])).toEqual([
      ['7601', { givenName: 'Nadia', familyName: 'Rahman' }],
      ['e1.nadia', { givenName: 'Nad', familyName: null }],
    ]);
    // No directory row and no wallet-directory user: the name is still read (it is the API's).
    await seedName('email', 'e1.home-only', null, 'Solo');
    const lone = await json<Record<string, any>>(await adminRequest('/api/users/get', { body: { provider: 'email', sub: 'e1.home-only', ticket: 'T-N2' } }));
    expect([lone.user, lone.walletUsers, lone.name]).toEqual([null, [], { givenName: null, familyName: 'Solo' }]);
    const none = await json<Record<string, any>>(await adminRequest('/api/users/get', { body: { provider: 'google', sub: '7699', ticket: 'T-N3' } }));
    expect(none.name).toBeNull();
    // A failed read: the page stands, without `name`, marked.
    const down = await requestWith(envWith({ API: overrideBinding(env.API, { profileNames: async () => Promise.reject(new Error('down')) }) }), '/api/users/get', { provider: 'google', sub: '7601', ticket: 'T-N4' });
    expect(down.status).toBe(200);
    const dd = await json<Record<string, any>>(down);
    expect(['name' in dd, dd.nameError, dd.user.email]).toEqual([false, 'upstream_unavailable', 'named@example.com']);
  });

  it('a rate-limited view emails the alias and answers 429', async () => {
    const fake = useFakeEmail();
    const e = envWith({ ISSUER: overrideBinding(env.ISSUER!, { get: async () => ({ ok: false, code: 'rate_limited', budget: { window: '1d', limit: 2000, retryAfterMs: 3_600_000 } }) }) });
    const res = await requestWith(e, '/api/users/get', { provider: 'email', sub: 'e1.x', ticket: 'T-6' });
    expect(res.status).toBe(429);
    expect(fake.sent[0]!.text).toMatch(/2000 identities a UTC day/u);
  });
});

const findAudit = () =>
  env.CONSOLE_TEST_DB.prepare("SELECT org_id, actor_email, target, details_json FROM audit_log WHERE action = 'users.find' ORDER BY seq").all<Record<string, unknown>>().then((r) => r.results);

describe('POST /api/users/find (the wallet directory)', () => {
  it('by Support ID, User ID or internal id: the users with their identities, no address; each find audited first, org-less, with the ticket (D410)', async () => {
    const app = await seedHotApp();
    const w = await seedWalletUser(app.scope, [{ provider: 'google', sub: '7300' }]);
    const before = (await findAudit()).length;
    // (A wallet address search is the API's, tested there with real StrKey and EIP-55 addresses.)
    for (const query of [w.supportId, w.supportId.toLowerCase(), w.userId, w.internalId]) {
      const r = await json<{ users: { userId: string; identities: { sub: string; directoryKey: unknown }[] }[] }>(await adminRequest('/api/users/find', { body: { query, ticket: 'ZD-73' } }));
      expect(r.users.map((u) => u.userId), query).toEqual([w.userId]);
      expect(r.users[0]!.identities[0]).toMatchObject({ sub: '7300', directoryKey: { provider: 'google', sub: '7300' } });
      expect(JSON.stringify(r)).not.toMatch(/email/u);
    }
    expect(await issuerAudit()).toEqual([]);
    const rows = (await findAudit()).slice(before);
    expect(rows.map((r) => [r.org_id, r.actor_email, r.target, JSON.parse(String(r.details_json))])).toEqual([
      [null, STAFF_EMAIL, w.supportId, { by: 'supportId', ticket: 'ZD-73' }],
      [null, STAFF_EMAIL, w.supportId, { by: 'supportId', ticket: 'ZD-73' }],
      [null, STAFF_EMAIL, w.userId, { by: 'userId', ticket: 'ZD-73' }],
      [null, STAFF_EMAIL, w.internalId, { by: 'internalId', ticket: 'ZD-73' }],
    ]);
    // No row names the identity's sub.
    expect(JSON.stringify(rows)).not.toContain('7300');
  });

  it('refuses without a ticket, and a sub (the directory search’s, ticketed there), before any audit or read', async () => {
    const app = await seedHotApp();
    const w = await seedWalletUser(app.scope, [{ provider: 'google', sub: '7400' }]);
    const before = (await findAudit()).length;
    for (const body of [{ query: w.userId }, { query: w.userId, ticket: '' }, { query: w.userId, ticket: 'a@b.example' }, { query: '7400', ticket: 'T-1' }, { query: 'two words', ticket: 'T-1' }, { ticket: 'T-1' }]) {
      const r = await adminRequest('/api/users/find', { body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(await json(r))).not.toContain(w.internalId);
    }
    expect((await findAudit()).length).toBe(before);
  });

  it('reads nothing when the audit row can’t be written', async () => {
    const app = await seedHotApp();
    const w = await seedWalletUser(app.scope, [{ provider: 'google', sub: '7500' }]);
    let apiCalls = 0;
    const api = overrideBinding(env.API, { findUsers: async () => (apiCalls++, { ok: true, users: [] }) });
    const down = await requestWith(envWith({ API: api, CONSOLE: downBinding() }), '/api/users/find', { query: w.userId, ticket: 'T-1' });
    expect(down.status).toBe(503);
    const refusing = await requestWith(envWith({ API: api, CONSOLE: overrideBinding(env.CONSOLE, { recordStaffAction: async () => ({ ok: false, code: 'internal' }) }) }), '/api/users/find', { query: w.userId, ticket: 'T-1' });
    expect(refusing.status).toBe(500);
    expect(apiCalls).toBe(0);
  });
});

describe('GET /api/audit: the issuer’s rows as a third source', () => {
  it('lists the directory reads newest first, by staff and action; a failure there leaves the page up', async () => {
    await seedDirectory({ provider: 'email', sub: 'e1.a1', email: 'a1@example.com' });
    await adminRequest('/api/users/search', { body: { q: 'a1@example.com', ticket: 'T-6' } });
    await adminRequest('/api/users/get', { body: { provider: 'email', sub: 'e1.a1', ticket: 'T-7' } });
    const r = await json<{ directory: { rows: { action: string; staff: string; ticket: string | null }[] } }>(await adminRequest('/api/audit'));
    expect(r.directory.rows.map((x) => x.action)).toEqual(['user_view', 'user_search']);
    expect(r.directory.rows[0]).toMatchObject({ staff: STAFF_EMAIL, ticket: 'T-7' });
    const views = await json<{ directory: { rows: unknown[] } }>(await adminRequest('/api/audit?dirAction=user_view'));
    expect(views.directory.rows).toHaveLength(1);
    const nobody = await json<{ directory: { rows: unknown[] } }>(await adminRequest('/api/audit?dirStaff=nobody@hana.example'));
    expect(nobody.directory.rows).toEqual([]);
    const headers = new Headers({ 'cf-access-jwt-assertion': await staffJwt() });
    const down = await worker.fetch(new Request(`${ADMIN}/api/audit`, { headers }), envWith({ ISSUER: downBinding() }));
    expect(down.status).toBe(200);
    expect((await json<{ directory: unknown }>(down)).directory).toEqual({ error: 'directory_unavailable' });
    const none = await worker.fetch(new Request(`${ADMIN}/api/audit`, { headers }), envWith({ ISSUER: undefined }));
    expect((await json<{ directory: unknown }>(none)).directory).toBeNull();
  });
});
