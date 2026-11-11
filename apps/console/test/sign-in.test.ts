// Partner sign-in end to end (docs/batch-c-spec.md "Tests: Code flow and sessions"): the real routes in a browser's
// order (`POST /api/auth/start`, AuthHandler's `/start` and `/callback`, `/api/auth/complete`) against a mocked Google
// that checks the code, the client secret, the redirect URI and the PKCE verifier. Single use of the start handle, the
// state, the code and the handoff; every refusal the callback owes (bad iss, aud, expiry, nonce, iat, the email claims,
// the claim allow-list); the implicit-flow guard; cookie binding across the flow; the session cookie; that no token is
// ever echoed, logged or stored; CSRF and the per-IP limit on the auth routes.
import { b64url, nonceOf, originChangeDigest, ownerActionDigest, randomBytes, stepUpDigest } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_ORIGIN_CSP } from '../src/auth-flow.ts';
import { AUTH, CLIENT_ID, MockGoogle, account, authOrigin, getWith, landing, setCookie, setCookieLine, signIn } from './google.ts';
import { CSRF, ORIGIN, auditRows, db, minuteHeadroom, post, request, seedOrg, shiftClock } from './helpers.ts';

let google: MockGoogle;
beforeEach(async () => {
  google = new MockGoogle();
  await google.init();
});
afterEach(() => vi.restoreAllMocks());

/** An existing member of a fresh active org (optionally with a required Workspace domain). */
async function existingMember(o: { role?: 'owner' | 'viewer'; requiredHd?: string; hd?: string } = {}) {
  const org = await seedOrg({ ...(o.requiredHd ? { requiredHd: o.requiredHd } : {}) });
  const acct = account(o.hd ? { hd: o.hd } : {});
  const userId = `usr_${b64url(randomBytes(12)).replace(/[^A-Za-z0-9]/gu, 'x')}`;
  await db.prepare("INSERT INTO console_users (id, provider, sub, email, created_at) VALUES (?, 'google', ?, ?, ?)").bind(userId, acct.sub, acct.email, Date.now()).run();
  await db.prepare('INSERT INTO members (org_id, user_id, role, role_since, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)').bind(org, userId, o.role ?? 'owner', Date.now(), 'test', Date.now()).run();
  return { org, acct, userId };
}

function expectStatic400(res: Response) {
  expect(res.status).toBe(400);
  expect(res.headers.get('location')).toBeNull();
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('content-security-policy')).toBe(AUTH_ORIGIN_CSP);
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('content-type')).toMatch(/^text\/html/u);
}

describe('a sign-in, step by step', () => {
  it('signs an existing member in: Google gets a code-flow request with PKCE; a session cookie; /api/me works', async () => {
    const { org, acct, userId } = await existingMember();
    const s = await signIn(google, acct);
    // 1. create
    expect(s.start.status).toBe(200);
    expect(setCookieLine(s.start, '__Host-hana_pre')).toMatch(/^__Host-hana_pre=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/u);
    expect(s.startUrl).toMatch(new RegExp(`^${AUTH}/start\\?f=[A-Za-z0-9_-]{43}$`, 'u'));
    // 2. start: 303 to Google, the flow cookie on the auth origin
    expect(s.toGoogle!.status).toBe(303);
    expect(setCookieLine(s.toGoogle!, '__Host-hana_af')).toMatch(/^__Host-hana_af=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/u);
    const p = s.auth!.params;
    expect(Object.fromEntries([...p.entries()].filter(([k]) => !['state', 'nonce', 'code_challenge'].includes(k)))).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: `${AUTH}/callback`,
      response_type: 'code',
      scope: 'openid email',
      prompt: 'select_account',
      code_challenge_method: 'S256',
    });
    expect(s.auth!.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(s.auth!.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    // The exchange sent the client secret and a verifier matching the challenge (the mock refuses otherwise).
    expect(google.exchanges).toHaveLength(1);
    expect(google.exchanges[0]!.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    // 3. callback: to complete, with an empty fragment, the flow cookie cleared
    expect(s.callback!.status).toBe(303);
    expect(s.callback!.headers.get('location')).toMatch(new RegExp(`^${ORIGIN}/api/auth/complete\\?h=[A-Za-z0-9_-]{43}#$`, 'u'));
    expect(setCookieLine(s.callback!, '__Host-hana_af')).toMatch(/Max-Age=0$/u);
    // 4. complete: the session, the pre-flow cookie cleared, home
    expect(s.complete!.status).toBe(303);
    expect(landing(s)).toBe('/');
    expect(setCookieLine(s.complete!, '__Host-hana_cs')).toMatch(/^__Host-hana_cs=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict$/u);
    expect(setCookieLine(s.complete!, '__Host-hana_pre')).toMatch(/Max-Age=0$/u);
    expect(s.complete!.headers.get('cache-control')).toBe('no-store');
    const me = await getWith(s.browser.cs, '/api/me');
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ user: { id: userId, email: acct.email }, memberships: [{ orgId: org, orgName: `Org ${org}`, status: 'active', role: 'owner' }], features: { users: false }, sessionExpiresAt: expect.any(Number), envName: 'sandbox-test' });
    const audit = await auditRows("action = 'session.signed_in' AND target = ?", userId);
    expect(audit).toMatchObject([{ actor_kind: 'member', actor_id: userId, details_json: '{"invite":false}', outcome: 'ok' }]);
    const u = await db.prepare('SELECT last_sign_in_at FROM console_users WHERE id = ?').bind(userId).first<number>('last_sign_in_at');
    expect(u).toBeGreaterThan(0);
  });

  it('a new session id at every sign-in; the old one stays its own', async () => {
    const { acct } = await existingMember();
    const a = await signIn(google, acct);
    const b = await signIn(google, acct);
    expect(a.browser.cs).toBeTruthy();
    expect(b.browser.cs).toBeTruthy();
    expect(a.browser.cs).not.toBe(b.browser.cs);
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM console_sessions s JOIN console_users u ON u.id = s.user_id WHERE u.sub = ?').bind(acct.sub).first<number>('n');
    expect(rows).toBe(2);
  });

  it('updates the stored address to the one Google verified this time (display and notices only)', async () => {
    const { acct, userId } = await existingMember();
    const s = await signIn(google, { ...acct, email: 'Renamed@Partner.Example' });
    expect(landing(s)).toBe('/');
    expect(await db.prepare('SELECT email FROM console_users WHERE id = ?').bind(userId).first('email')).toBe('renamed@partner.example');
  });
});

describe('single use', () => {
  it('the start handle: a second /start with it is the static page', async () => {
    const { acct } = await existingMember();
    const s = await signIn(google, acct);
    const u = new URL(s.startUrl!);
    expectStatic400(await authOrigin(`${u.pathname}${u.search}`));
  });

  it('the state: a replayed callback (even with the right flow cookie and a fresh code) is the static page', async () => {
    const { acct } = await existingMember();
    const s = await signIn(google, acct);
    const fresh = google.authorize(s.toGoogle!.headers.get('location')!, acct).code;
    expectStatic400(await authOrigin(`/callback?code=${encodeURIComponent(fresh)}&state=${s.auth!.state}`, { cookie: `__Host-hana_af=${s.browser.af}` }));
  });

  it('the handoff code: a second complete is refused (expired), and makes no session', async () => {
    const { acct } = await existingMember();
    const s = await signIn(google, acct);
    const next = new URL(s.callback!.headers.get('location')!);
    const again = await request(`${next.pathname}${next.search}`, { headers: { cookie: `__Host-hana_pre=${s.browser.pre}` } });
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toBe(`${ORIGIN}/signin#error=expired`);
    expect(setCookie(again, '__Host-hana_cs')).toBeNull();
  });

  it('the code at Google: the mock refuses a second exchange, so a replayed code gets the static page', async () => {
    const { acct } = await existingMember();
    const first = await signIn(google, acct);
    // A new flow presenting the first flow's (used) code.
    const s2 = await post('/api/auth/start', { purpose: 'login' });
    const u = new URL(((await s2.json()) as { startUrl: string }).startUrl);
    const go = await authOrigin(`${u.pathname}${u.search}`);
    const state = new URL(go.headers.get('location')!).searchParams.get('state')!;
    const res = await authOrigin(`/callback?code=${encodeURIComponent(first.code!)}&state=${state}`, { cookie: `__Host-hana_af=${setCookie(go, '__Host-hana_af')}` });
    expectStatic400(res);
  });

  it('the nonce and PKCE verifier are fresh per flow', async () => {
    const { acct } = await existingMember();
    const a = await signIn(google, acct);
    const b = await signIn(google, acct);
    expect(a.auth!.nonce).not.toBe(b.auth!.nonce);
    expect(a.auth!.challenge).not.toBe(b.auth!.challenge);
    expect(a.auth!.state).not.toBe(b.auth!.state);
  });
});

describe('the ID token: refusals', () => {
  const now = () => Math.floor(Date.now() / 1000);
  const cases: [string, Record<string, unknown>][] = [
    ['bad iss', { iss: 'https://evil.example' }],
    ['bad aud', { aud: 'other-client.apps.googleusercontent.com' }],
    ['bad azp', { azp: 'other-client.apps.googleusercontent.com' }],
    ['expired', { exp: now() - 10, iat: now() - 100 }],
    ['wrong nonce', { nonce: 'n'.repeat(43) }],
    ['no nonce', { nonce: undefined }],
    ['iat over 120 s', { iat: now() - 121 }],
    ['iat in the future', { iat: now() + 120 }],
    ['no iat', { iat: undefined }],
    ['missing email', { email: undefined }],
    ['email_verified false', { email_verified: false }],
    ['email_verified missing', { email_verified: undefined }],
    ['a name claim (profile scope)', { name: 'A Person' }],
    ['a picture claim', { picture: 'https://lh3.googleusercontent.com/x' }],
    ['a locale claim', { locale: 'en' }],
    ['at_hash of another access token', { at_hash: 'A'.repeat(22) }],
    ['a mistyped optional claim (strict)', { email_verified: 'yes' }],
  ];
  for (const [name, edits] of cases) {
    it(`${name}: the static page, no handoff, no session`, async () => {
      const { acct } = await existingMember();
      const s = await signIn(google, acct, { edits });
      expectStatic400(s.callback!);
      expect(s.complete).toBeUndefined();
    });
  }

  it('a token whose nonce commits to another purpose (a step-up, an origin change, an owner action) is refused for login', async () => {
    const { acct } = await existingMember();
    const others = [
      nonceOf(await stepUpDigest({ sessionHash: randomBytes(32), action: { v: 1, env: env.ENV_NAME, org_id: 'org_x', kind: 'origin.add' } })),
      nonceOf(await originChangeDigest({ signer: 'signer.test.near', appId: 'app_x', add: ['https://a.example'], remove: [], originsVersion: 1 })),
      nonceOf(await ownerActionDigest({ signer: 'signer.test.near', scopeId: 's1', method: 'cancel_change', argsBorsh: new Uint8Array(8), actionNonce: 1 })),
    ];
    for (const nonce of others) {
      const s = await signIn(google, acct, { edits: { nonce } });
      expectStatic400(s.callback!);
    }
  });

  it('accepts a Workspace token with hd, and keeps hd on the session', async () => {
    const { acct, userId } = await existingMember({ requiredHd: 'partner.example', hd: 'partner.example' });
    const s = await signIn(google, acct);
    expect(landing(s)).toBe('/');
    expect(await db.prepare('SELECT hd FROM console_sessions WHERE user_id = ?').bind(userId).first('hd')).toBe('partner.example');
  });

  it("Google's JWKS unavailable: 503, the same static page, no session (fail closed)", async () => {
    const { acct } = await existingMember();
    google.jwks.status = 503;
    const { clearJwksCache } = await import('@hana-id/oidc');
    clearJwksCache();
    const s = await signIn(google, acct);
    expect(s.callback!.status).toBe(503);
    expect(s.callback!.headers.get('location')).toBeNull();
  });

  it("Google's token endpoint failing: 503; refusing (a 4xx): 400", async () => {
    const { acct } = await existingMember();
    google.nextStatus = 500;
    expect((await signIn(google, acct)).callback!.status).toBe(503);
    google.nextStatus = 401;
    expectStatic400((await signIn(google, acct)).callback!);
  });
});

describe('the callback and the implicit-flow guard', () => {
  it('no query, code without state, state without code, a malformed state, an unknown state: the static page, no Location', async () => {
    const { acct } = await existingMember();
    const s = await signIn(google, acct);
    for (const q of ['', '?code=x', `?state=${s.auth!.state}`, '?code=x&state=short', `?code=x&state=${b64url(randomBytes(32))}`, `?code=x&code=y&state=${s.auth!.state}`]) {
      expectStatic400(await authOrigin(`/callback${q}`, { cookie: `__Host-hana_af=${s.browser.af}` }));
    }
  });

  it("Google's error=access_denied gets the static page, and leaves the flow unused", async () => {
    const { acct } = await existingMember();
    const start = await post('/api/auth/start', { purpose: 'login' });
    const u = new URL(((await start.json()) as { startUrl: string }).startUrl);
    const go = await authOrigin(`${u.pathname}${u.search}`);
    const af = setCookie(go, '__Host-hana_af')!;
    const state = new URL(go.headers.get('location')!).searchParams.get('state')!;
    expectStatic400(await authOrigin(`/callback?error=access_denied&state=${state}`, { cookie: `__Host-hana_af=${af}` }));
    // The same flow still completes (the error touched nothing).
    const { code } = google.authorize(go.headers.get('location')!, acct);
    expect((await authOrigin(`/callback?code=${encodeURIComponent(code)}&state=${state}`, { cookie: `__Host-hana_af=${af}` })).status).toBe(303);
  });

  it('an implicit-flow answer (an id_token, no code) never gets a Location', async () => {
    const { acct } = await existingMember();
    const s = await signIn(google, acct);
    const forged = await google.idToken({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: acct.sub, nonce: s.auth!.nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 });
    expectStatic400(await authOrigin(`/callback?id_token=${forged}&state=${s.auth!.state}`, { cookie: `__Host-hana_af=${s.browser.af}` }));
  });

  it('no __Host-hana_af, or another browser’s: the static page, and the flow is not consumed', async () => {
    const { acct } = await existingMember();
    const start = await post('/api/auth/start', { purpose: 'login' });
    const u = new URL(((await start.json()) as { startUrl: string }).startUrl);
    const go = await authOrigin(`${u.pathname}${u.search}`);
    const af = setCookie(go, '__Host-hana_af')!;
    const { code, auth } = google.authorize(go.headers.get('location')!, acct);
    expectStatic400(await authOrigin(`/callback?code=${encodeURIComponent(code)}&state=${auth.state}`));
    expectStatic400(await authOrigin(`/callback?code=${encodeURIComponent(code)}&state=${auth.state}`, { cookie: `__Host-hana_af=${b64url(randomBytes(32))}` }));
    expectStatic400(await authOrigin(`/callback?code=${encodeURIComponent(code)}&state=${auth.state}`, { cookie: `__Host-hana_af=${af}; __Host-hana_af=${af}` }));
    expect(google.exchanges).toHaveLength(0);
    const ok = await authOrigin(`/callback?code=${encodeURIComponent(code)}&state=${auth.state}`, { cookie: `__Host-hana_af=${af}` });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toMatch(/#$/u);
  });

  it('an expired flow (over 5 min) gets the static page at /start and at /callback', async () => {
    const { acct } = await existingMember();
    const start = await post('/api/auth/start', { purpose: 'login' });
    const u = new URL(((await start.json()) as { startUrl: string }).startUrl);
    const go = await authOrigin(`${u.pathname}${u.search}`);
    const { code, auth } = google.authorize(go.headers.get('location')!, acct);
    shiftClock(5 * 60_000 + 1000);
    expectStatic400(await authOrigin(`/callback?code=${encodeURIComponent(code)}&state=${auth.state}`, { cookie: `__Host-hana_af=${setCookie(go, '__Host-hana_af')}` }));
    vi.restoreAllMocks();
    await google.init();
    const start2 = await post('/api/auth/start', { purpose: 'login' });
    const u2 = new URL(((await start2.json()) as { startUrl: string }).startUrl);
    shiftClock(5 * 60_000 + 1000);
    expectStatic400(await authOrigin(`${u2.pathname}${u2.search}`));
  });

  it('/start refuses a malformed or extra query', async () => {
    for (const q of ['', '?f=short', `?f=${b64url(randomBytes(32))}&x=1`, `?f=${b64url(randomBytes(32))}&f=${b64url(randomBytes(32))}`]) expectStatic400(await authOrigin(`/start${q}`));
  });

  it('the auth origin answers only GET /start and /callback on its own host', async () => {
    const { handleAuthOrigin } = await import('../src/auth-handler.ts');
    for (const [url, method] of [[`${AUTH}/`, 'GET'], [`${AUTH}/start`, 'POST'], [`${ORIGIN}/start`, 'GET'], [`${AUTH}/api/me`, 'GET']] as const) {
      const res = await handleAuthOrigin(new Request(url, { method, ...(method === 'POST' ? { body: '{}' } : {}) }), env);
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(res.headers.get('content-security-policy')).toBe(AUTH_ORIGIN_CSP);
    }
  });
});

describe('the handoff', () => {
  it('needs the pre-flow cookie of the browser that started: another browser (or none) is refused and consumes nothing', async () => {
    const { acct } = await existingMember();
    const s = await signIn(google, acct, { browser: {} });
    // s completed already; run a flow and stop before complete.
    const start = await post('/api/auth/start', { purpose: 'login' });
    const pre = setCookie(start, '__Host-hana_pre')!;
    const u = new URL(((await start.json()) as { startUrl: string }).startUrl);
    const go = await authOrigin(`${u.pathname}${u.search}`);
    const { code, auth } = google.authorize(go.headers.get('location')!, acct);
    const cb = await authOrigin(`/callback?code=${encodeURIComponent(code)}&state=${auth.state}`, { cookie: `__Host-hana_af=${setCookie(go, '__Host-hana_af')}` });
    const next = new URL(cb.headers.get('location')!);
    const path = `${next.pathname}${next.search}`;
    for (const cookie of [undefined, `__Host-hana_pre=${s.browser.pre}`, `__Host-hana_pre=${b64url(randomBytes(32))}`]) {
      const res = await request(path, { headers: cookie ? { cookie } : {} });
      expect(res.headers.get('location'), String(cookie)).toBe(`${ORIGIN}/signin#error=expired`);
      expect(setCookie(res, '__Host-hana_cs')).toBeNull();
    }
    const ok = await request(path, { headers: { cookie: `__Host-hana_pre=${pre}` } });
    expect(ok.headers.get('location')).toBe(`${ORIGIN}/`);
  });

  it('expires after 60 s', async () => {
    const { acct } = await existingMember();
    const start = await post('/api/auth/start', { purpose: 'login' });
    const pre = setCookie(start, '__Host-hana_pre')!;
    const u = new URL(((await start.json()) as { startUrl: string }).startUrl);
    const go = await authOrigin(`${u.pathname}${u.search}`);
    const { code, auth } = google.authorize(go.headers.get('location')!, acct);
    const cb = await authOrigin(`/callback?code=${encodeURIComponent(code)}&state=${auth.state}`, { cookie: `__Host-hana_af=${setCookie(go, '__Host-hana_af')}` });
    const next = new URL(cb.headers.get('location')!);
    shiftClock(61_000);
    const res = await request(`${next.pathname}${next.search}`, { headers: { cookie: `__Host-hana_pre=${pre}` } });
    expect(res.headers.get('location')).toBe(`${ORIGIN}/signin#error=expired`);
  });

  it('is scrubbed once used: the row keeps no identity', async () => {
    const { acct } = await existingMember();
    await signIn(google, acct);
    const rows = (await db.prepare('SELECT result_json FROM handoff_codes WHERE used_at IS NOT NULL').all<{ result_json: string }>()).results;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.result_json).toBe('{}');
  });
});

describe('no token anywhere', () => {
  it('the ID token, the access token, the code, the verifier and the cookies are never in a body, a log line or D1', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const { acct } = await existingMember();
    const ok = await signIn(google, acct);
    const refused = await signIn(google, acct, { edits: { name: 'Person' } });
    // (The start answers' bodies, `{startUrl}`, were read by signIn.)
    const bodies = [ok.toGoogle!, ok.callback!, ok.complete!, refused.callback!].map((r) => r.text());
    const dump: string[] = [];
    for (const t of ['auth_flows', 'handoff_codes', 'console_sessions', 'console_users', 'audit_log']) {
      dump.push(JSON.stringify((await db.prepare(`SELECT * FROM ${t}`).all()).results));
    }
    const secrets = [...google.issued, ok.code!, refused.code!, ...google.exchanges.map((e) => e.get('code_verifier')!), ok.browser.af!, ok.browser.pre!, ok.browser.cs!, 'test-console-client-secret'];
    const haystack = [...(await Promise.all(bodies)), ...lines, ...dump].join('\n');
    for (const s of secrets) expect(haystack.includes(s), `found a secret of length ${s.length}`).toBe(false);
    // Nor the address or sub in a log line.
    expect(lines.join('\n')).not.toContain(acct.email);
    expect(lines.join('\n')).not.toContain(acct.sub);
    expect(lines.some((l) => l.includes('"claim":"name"'))).toBe(true);
  });
});

describe('CSRF and rate limits on the auth routes', () => {
  it('POST /api/auth/start needs each of the four CSRF pieces', async () => {
    for (const drop of Object.keys(CSRF)) {
      const headers = { ...CSRF } as Record<string, string>;
      delete headers[drop];
      const res = await request('/api/auth/start', { method: 'POST', headers, body: { purpose: 'login' } });
      expect(res.status, drop).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: 'csrf' } });
    }
  });

  it('refuses another purpose and unknown fields', async () => {
    for (const body of [{}, { purpose: 'step_up' }, { purpose: 'login', extra: 1 }, { purpose: 'login', invite: 'short' }]) expect((await post('/api/auth/start', body)).status, JSON.stringify(body)).toBe(400);
  });

  it('10 a minute per IP across /api/auth/* and the auth origin: the 11th is 429, another IP is not', async () => {
    // The binding's windows are real-clock minutes: the whole run in one (helpers.ts minuteHeadroom).
    await minuteHeadroom();
    const ip = '192.0.2.188';
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await post('/api/auth/start', { purpose: 'login' }, { ip })).status);
    expect(statuses.every((s) => s === 200)).toBe(true);
    const over = await post('/api/auth/start', { purpose: 'login' }, { ip });
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBe('60');
    const page = await authOrigin(`/start?f=${b64url(randomBytes(32))}`, { ip });
    expect(page.status).toBe(429);
    expect(page.headers.get('location')).toBeNull();
    const complete = await request(`/api/auth/complete?h=${b64url(randomBytes(32))}`, { ip });
    expect(complete.headers.get('location')).toBe(`${ORIGIN}/signin#error=rate_limited`);
    expect((await post('/api/auth/start', { purpose: 'login' }, { ip: '192.0.2.189' })).status).toBe(200);
  });
});

describe('logout', () => {
  it('revokes the session, clears the cookie, audits; the cookie no longer works', async () => {
    const { acct, userId } = await existingMember();
    const s = await signIn(google, acct);
    const out = await request('/api/auth/logout', { method: 'POST', headers: { ...CSRF, cookie: `__Host-hana_cs=${s.browser.cs}` }, body: {} });
    expect(out.status).toBe(200);
    expect(setCookieLine(out, '__Host-hana_cs')).toBe('__Host-hana_cs=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
    expect((await getWith(s.browser.cs, '/api/me')).status).toBe(401);
    expect(await auditRows("action = 'session.signed_out' AND target = ?", userId)).toHaveLength(1);
    expect((await request('/api/auth/logout', { method: 'POST', headers: { ...CSRF }, body: {} })).status).toBe(401);
  });

  it('needs the CSRF checks', async () => {
    const { acct } = await existingMember();
    const s = await signIn(google, acct);
    const res = await request('/api/auth/logout', { method: 'POST', headers: { cookie: `__Host-hana_cs=${s.browser.cs}`, 'content-type': 'application/json' }, body: {} });
    expect(res.status).toBe(403);
    expect((await getWith(s.browser.cs, '/api/me')).status).toBe(200);
  });
});
