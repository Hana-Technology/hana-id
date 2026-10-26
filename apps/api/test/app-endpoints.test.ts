import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usageDay } from '../src/apps.ts';
import { clearViewCaches } from '../src/views.ts';
import { makeJwt, panic } from './near-mock.ts';
import { GOOGLE_ISS, ORIGIN, appHeaders, call, chain, deriveBody, newKey, newSessionKey, revokeBody, seedApp, seedPlan, sessionBody, uid } from './helpers.ts';

beforeEach(() => clearViewCaches());
afterEach(() => vi.restoreAllMocks());

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function usage(appId: string): Promise<{ sessions: number; derives: number } | null> {
  return env.DB.prepare('SELECT sessions, derives FROM usage WHERE app_id = ?1 AND day = ?2').bind(appId, usageDay(Date.now())).first();
}

describe('POST /v1/sessions', () => {
  it('relays create_session for a token whose client is registered to the app scope, and counts usage', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    const near = chain({ [aud]: app.scope });
    const req = sessionBody(aud, { keyIndex: 3 });
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: req });
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.result).toMatchObject({ scope_id: app.scope, path: `${app.scope}#google#1234567890#3`, used: 0 });
    expect(typeof json.nearTx).toBe('string');
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('vary')).toBe('Origin');
    expect(res.headers.get('x-request-id')).toBeTruthy();

    expect(near.sent).toHaveLength(1);
    const tx = near.sent[0]!;
    expect(tx.receiverId).toBe(env.SIGNER_ACCOUNT);
    expect(tx.signerId).toBe(env.RELAYER_ACCOUNT);
    expect(tx.method).toBe('create_session');
    expect(tx.gas).toBe(300_000_000_000_000n);
    expect(tx.args).toEqual({
      jwt: req.jwt,
      session_public_key: req.sessionPublicKey,
      expires_at_ms: req.expiresAtMs,
      salt: req.salt,
      key_index: 3,
      max_uses: 10,
    });
    expect(near.viewCalls).toEqual([{ method: 'scope_for_client', args: { provider: 'google', aud } }]);
    expect(await usage(app.id)).toEqual({ sessions: 1, derives: 0 });
  });

  it('maps both Google iss forms to provider google', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    chain({ [aud]: app.scope });
    const jwt = makeJwt({ iss: 'accounts.google.com', aud, sub: '1', exp: Math.floor(Date.now() / 1000) + 600 });
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: sessionBody(aud, { jwt }) });
    expect(res.status).toBe(200);
  });

  it('caches scope_for_client (≤ 60 s)', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    const near = chain({ [aud]: app.scope });
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: sessionBody(aud) })).status).toBe(200);
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: sessionBody(aud) })).status).toBe(200);
    expect(near.viewCalls.filter((v) => v.method === 'scope_for_client')).toHaveLength(1);
    expect(await usage(app.id)).toEqual({ sessions: 2, derives: 0 });
  });

  it('rejects a token for an unregistered client before relaying', async () => {
    const app = await seedApp();
    const near = chain({});
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: sessionBody('nobody.apps.googleusercontent.com') });
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ code: 'unregistered_client' });
    expect(near.sent).toHaveLength(0);
    expect(await usage(app.id)).toBeNull();
  });

  it('rejects a token for a client registered to a different scope', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    const near = chain({ [aud]: 'sother' });
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: sessionBody(aud) });
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ code: 'scope_mismatch' });
    expect(near.sent).toHaveLength(0);
  });

  it('rejects unknown issuers, unreadable and expired tokens', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    const near = chain({ [aud]: app.scope });
    const exp = Math.floor(Date.now() / 1000) + 600;
    const cases: [string, number, string][] = [
      [makeJwt({ iss: 'https://evil.example', aud, sub: '1', exp }), 400, 'unsupported_issuer'],
      [makeJwt({ iss: GOOGLE_ISS, aud: [aud], sub: '1', exp }), 400, 'bad_request'],
      [makeJwt({ iss: GOOGLE_ISS, aud, sub: '1', exp: Math.floor(Date.now() / 1000) - 10 }), 400, 'token_expired'],
      ['aaaa.!!!!.bbbb', 400, 'bad_request'],
      ['aaaa.bbbb.cccc', 400, 'bad_request'],
    ];
    for (const [jwt, status, code] of cases) {
      const res = await call('/v1/sessions', { headers: appHeaders(app), body: sessionBody(aud, { jwt }) });
      expect(res.status, code).toBe(status);
      expect((await body(res)).code).toBe(code);
    }
    expect(near.sent).toHaveLength(0);
  });

  it('validates argument shapes', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    const near = chain({ [aud]: app.scope });
    const bad: Record<string, unknown>[] = [
      { sessionPublicKey: [1, 2, 3] },
      { sessionPublicKey: Array(32).fill(256) },
      { salt: Array(15).fill(1) },
      { salt: Array(65).fill(1) },
      { expiresAtMs: Date.now() - 1 },
      { expiresAtMs: Date.now() + 2 * 24 * 3600 * 1000 },
      { expiresAtMs: 'soon' },
      { keyIndex: -1 },
      { keyIndex: 2 ** 32 },
      { keyIndex: 1.5 },
      { maxUses: 0 },
      { maxUses: 501 },
      { jwt: 'x'.repeat(8000) },
      { jwt: 42 },
    ];
    for (const override of bad) {
      const res = await call('/v1/sessions', { headers: appHeaders(app), body: sessionBody(aud, override) });
      expect(res.status, JSON.stringify(override).slice(0, 80)).toBe(400);
      expect((await body(res)).code).toBe('bad_request');
    }
    for (const rawBody of ['not json', '[1,2]', 'null']) {
      const res = await call('/v1/sessions', { method: 'POST', headers: { ...appHeaders(app), 'content-type': 'application/json' }, rawBody });
      expect(res.status).toBe(400);
    }
    const big = await call('/v1/sessions', { method: 'POST', headers: appHeaders(app), rawBody: JSON.stringify({ pad: 'x'.repeat(20_000) }) });
    expect(big.status).toBe(413);
    expect(near.sent).toHaveLength(0);
  });

  it('returns the contract panic as 422 and does not count usage', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    const near = chain({ [aud]: app.scope });
    near.contract.create_session = () => panic('Nonce mismatch');
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: sessionBody(aud) });
    expect(res.status).toBe(422);
    const json = await body(res);
    expect(json).toMatchObject({ code: 'contract_rejected' });
    expect(json.error).toContain('Nonce mismatch');
    expect(typeof json.nearTx).toBe('string');
    expect(await usage(app.id)).toBeNull();
  });

  it('reports an unreachable RPC as 502', async () => {
    const app = await seedApp();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: sessionBody(`${uid()}.apps.googleusercontent.com`) });
    expect(res.status).toBe(502);
    expect((await body(res)).code).toBe('near_unavailable');
  });
});

describe('app checks (in order)', () => {
  it('requires a publishable key', async () => {
    const res = await call('/v1/sessions', { headers: { origin: ORIGIN }, body: {} });
    expect(res.status).toBe(401);
    expect((await body(res)).code).toBe('missing_key');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects malformed and unknown keys', async () => {
    for (const key of ['sk_test_abc', 'pk_test_short', newKey()]) {
      const res = await call('/v1/sessions', { headers: { 'x-hana-key': key, origin: ORIGIN }, body: {} });
      expect(res.status).toBe(401);
      expect((await body(res)).code).toBe('unknown_app');
    }
  });

  it('rejects suspended apps (before the origin check)', async () => {
    const app = await seedApp({ status: 'suspended' });
    const res = await call('/v1/sessions', { headers: appHeaders(app, 'https://other.example'), body: {} });
    expect(res.status).toBe(403);
    expect((await body(res)).code).toBe('app_suspended');
  });

  it('rejects a missing or unlisted Origin', async () => {
    const app = await seedApp();
    const noOrigin = await call('/v1/sessions', { headers: { 'x-hana-key': app.key }, body: {} });
    expect(noOrigin.status).toBe(403);
    expect((await body(noOrigin)).code).toBe('origin_not_allowed');
    for (const origin of ['https://evil.example', `${ORIGIN}/`, 'https://WALLET.example.com', 'http://wallet.example.com', 'http://localhost:3000']) {
      const res = await call('/v1/sessions', { headers: appHeaders(app, origin), body: {} });
      expect(res.status, origin).toBe(403);
      expect((await body(res)).code).toBe('origin_not_allowed');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('allows http://localhost:* only for pk_test_ keys', async () => {
    const testApp = await seedApp({ origins: ['http://localhost:*'] });
    const liveApp = await seedApp({ key: newKey('pk_live_'), origins: ['http://localhost:*', 'http://localhost:5173'] });
    const ok = await call('/v1/sessions', { headers: appHeaders(testApp, 'http://localhost:5173'), body: {} });
    expect(ok.status).toBe(400); // past the origin check, stopped at argument validation
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const notLocal = await call('/v1/sessions', { headers: appHeaders(testApp, 'http://localhost.evil.com'), body: {} });
    expect(notLocal.status).toBe(403);
    const live = await call('/v1/sessions', { headers: appHeaders(liveApp, 'http://localhost:5173'), body: {} });
    expect(live.status).toBe(403);
    expect((await body(live)).code).toBe('origin_not_allowed');
  });

  it('rate limits per app per minute', async () => {
    const plan = `p${uid()}`;
    await seedPlan(plan, 2, 1000, 1000);
    const app = await seedApp({ plan });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await call('/v1/sessions', { headers: appHeaders(app), body: {} })).status);
    expect(statuses).toEqual([400, 400, 429]);
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: {} });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(await body(res)).toMatchObject({ code: 'rate_limited' });
  });

  it('rate limits per app per day', async () => {
    const plan = `p${uid()}`;
    await seedPlan(plan, 1000, 2, 1000);
    const app = await seedApp({ plan });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await call('/v1/sessions', { headers: appHeaders(app), body: {} })).status);
    expect(statuses).toEqual([400, 400, 429]);
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: {} });
    expect((await body(res)).error).toContain('day');
  });

  it('rate limits per IP per minute (other IPs unaffected)', async () => {
    const plan = `p${uid()}`;
    await seedPlan(plan, 1000, 1000, 2);
    const app = await seedApp({ plan });
    const ip = `192.0.2.${Math.floor(Math.random() * 250)}`;
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await call('/v1/sessions', { headers: { ...appHeaders(app), 'cf-connecting-ip': ip }, body: {} })).status);
    expect(statuses).toEqual([400, 400, 429]);
    const other = await call('/v1/sessions', { headers: { ...appHeaders(app), 'cf-connecting-ip': '198.51.100.7' }, body: {} });
    expect(other.status).toBe(400);
  });
});

describe('rate limit order', () => {
  it('a request rejected by the per-IP limit does not use up the app’s shared quota', async () => {
    const plan = `p${uid()}`;
    await seedPlan(plan, 5, 1000, 2);
    const app = await seedApp({ plan });
    const noisy = `192.0.2.${Math.floor(Math.random() * 250)}`;
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await call('/v1/sessions', { headers: { ...appHeaders(app), 'cf-connecting-ip': noisy }, body: {} })).status);
    expect(statuses).toEqual([400, 400, ...Array(8).fill(429)]);
    // The app's per-minute quota (5) has 3 left for everyone else.
    const others: number[] = [];
    for (let i = 0; i < 4; i++) others.push((await call('/v1/sessions', { headers: { ...appHeaders(app), 'cf-connecting-ip': `198.51.100.${i + 20}` }, body: {} })).status);
    expect(others).toEqual([400, 400, 400, 429]);
  });

  it('keys IPv6 clients on their /64', async () => {
    const plan = `p${uid()}`;
    await seedPlan(plan, 1000, 1000, 2);
    const app = await seedApp({ plan });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await call('/v1/sessions', { headers: { ...appHeaders(app), 'cf-connecting-ip': `2001:db8:1:2::${i + 1}` }, body: {} })).status);
    expect(statuses).toEqual([400, 400, 429]);
    expect((await call('/v1/sessions', { headers: { ...appHeaders(app), 'cf-connecting-ip': '2001:db8:1:3::1' }, body: {} })).status).toBe(400);
  });
});

describe('view cache lifetimes', () => {
  const at = (ms: number): void => {
    vi.spyOn(Date, 'now').mockReturnValue(ms);
  };

  it('scope_for_client is cached for at most 60 s, a cached miss included', async () => {
    const plan = `p${uid()}`;
    await seedPlan(plan, 1000, 1000, 1000);
    const app = await seedApp({ plan });
    const aud = `${uid()}.apps.googleusercontent.com`;
    const near = chain({});
    const t0 = Date.now();
    const scopeViews = (): number => near.viewCalls.filter((v) => v.method === 'scope_for_client').length;
    at(t0);
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: sessionBody(aud) })).status).toBe(403);
    // Registered meanwhile: the cached null still answers within 60 s...
    near.clients[aud] = app.scope;
    at(t0 + 59_000);
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: sessionBody(aud) })).status).toBe(403);
    expect(scopeViews()).toBe(1);
    // ...and expires after it.
    at(t0 + 61_000);
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: sessionBody(aud) })).status).toBe(200);
    expect(scopeViews()).toBe(2);
    // A client removed on chain stops passing the API check once the entry expires.
    delete near.clients[aud];
    at(t0 + 123_000);
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: sessionBody(aud) })).status).toBe(403);
    expect(scopeViews()).toBe(3);
  });

  it('get_session is cached for at most 10 s', async () => {
    const plan = `p${uid()}`;
    await seedPlan(plan, 1000, 1000, 1000);
    const app = await seedApp({ plan });
    const near = chain({});
    const spk = newSessionKey();
    const t0 = Date.now();
    near.sessions.set(JSON.stringify(spk), { path: `${app.scope}#google#1#0`, scope_id: app.scope, expires_at_ms: t0 + 3_600_000, max_uses: 10, used: 0 });
    const sessionViews = (): number => near.viewCalls.filter((v) => v.method === 'get_session').length;
    at(t0);
    expect((await call('/v1/derive', { headers: appHeaders(app), body: deriveBody(spk) })).status).toBe(200);
    at(t0 + 9_000);
    expect((await call('/v1/derive', { headers: appHeaders(app), body: deriveBody(spk, { counter: 2 }) })).status).toBe(200);
    expect(sessionViews()).toBe(1);
    // Revoked outside the API: seen once the 10 s entry expires.
    near.sessions.delete(JSON.stringify(spk));
    at(t0 + 11_000);
    expect((await call('/v1/derive', { headers: appHeaders(app), body: deriveBody(spk, { counter: 3 }) })).status).toBe(404);
    expect(sessionViews()).toBe(2);
  });
});

describe('POST /v1/derive and /v1/sessions/revoke', () => {
  async function withSession() {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    const near = chain({ [aud]: app.scope });
    const spk = newSessionKey();
    near.sessions.set(JSON.stringify(spk), { path: `${app.scope}#google#1#0`, scope_id: app.scope, expires_at_ms: Date.now() + 3_600_000, max_uses: 10, used: 0 });
    return { app, near, spk, aud };
  }

  it('relays derive_key for the app’s own session and returns {big_y, big_c}', async () => {
    const { app, near, spk } = await withSession();
    const res = await call('/v1/derive', { headers: appHeaders(app), body: deriveBody(spk) });
    expect(res.status).toBe(200);
    const json = await body(res);
    expect(json.result).toEqual({ big_y: 'bls12381g1:Y', big_c: 'bls12381g1:C' });
    expect(near.sent.map((t) => t.method)).toEqual(['derive_key']);
    expect(near.sent[0]!.args).toEqual({ session_public_key: spk, counter: 1, signature: deriveBody(spk).signature, pk1: 'bls12381g1:abc', pk2: 'bls12381g2:def' });
    expect(await usage(app.id)).toEqual({ sessions: 0, derives: 1 });
  });

  it('counts sessions and derives separately over a full login', async () => {
    const { app, near, aud } = await withSession();
    const req = sessionBody(aud);
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: req })).status).toBe(200);
    const spk = req.sessionPublicKey as number[];
    expect((await call('/v1/derive', { headers: appHeaders(app), body: deriveBody(spk) })).status).toBe(200);
    expect((await call('/v1/derive', { headers: appHeaders(app), body: deriveBody(spk, { counter: 2 }) })).status).toBe(200);
    // The session came from our own create_session: no get_session view needed.
    expect(near.viewCalls.filter((v) => v.method === 'get_session')).toHaveLength(0);
    expect(await usage(app.id)).toEqual({ sessions: 1, derives: 2 });
    expect((await call('/v1/sessions/revoke', { headers: appHeaders(app), body: revokeBody(spk) })).status).toBe(200);
    expect(await usage(app.id)).toEqual({ sessions: 1, derives: 2 });
  });

  it('caches get_session (≤ 10 s)', async () => {
    const { app, near, spk } = await withSession();
    await call('/v1/derive', { headers: appHeaders(app), body: deriveBody(spk) });
    await call('/v1/derive', { headers: appHeaders(app), body: deriveBody(spk, { counter: 2 }) });
    expect(near.viewCalls.filter((v) => v.method === 'get_session')).toHaveLength(1);
  });

  it('rejects unknown sessions, sessions of other scopes and expired sessions', async () => {
    const { app, near } = await withSession();
    const unknown = await call('/v1/derive', { headers: appHeaders(app), body: deriveBody(newSessionKey()) });
    expect(unknown.status).toBe(404);
    expect((await body(unknown)).code).toBe('unknown_session');

    const foreign = newSessionKey();
    near.sessions.set(JSON.stringify(foreign), { path: 'sother#google#1#0', scope_id: 'sother', expires_at_ms: Date.now() + 3_600_000, max_uses: 10, used: 0 });
    for (const path of ['/v1/derive', '/v1/sessions/revoke']) {
      const res = await call(path, { headers: appHeaders(app), body: path === '/v1/derive' ? deriveBody(foreign) : revokeBody(foreign) });
      expect(res.status).toBe(403);
      expect((await body(res)).code).toBe('scope_mismatch');
    }

    const expired = newSessionKey();
    near.sessions.set(JSON.stringify(expired), { path: `${app.scope}#google#1#0`, scope_id: app.scope, expires_at_ms: Date.now() - 1, max_uses: 10, used: 0 });
    const res = await call('/v1/derive', { headers: appHeaders(app), body: deriveBody(expired) });
    expect(res.status).toBe(404);
    expect(near.sent).toHaveLength(0);
  });

  it('validates derive and revoke shapes', async () => {
    const { app, near, spk } = await withSession();
    const bad = [
      deriveBody(spk, { counter: 0 }),
      deriveBody(spk, { signature: [1, 2] }),
      deriveBody(spk, { pk1: 'bls12381g2:x' }),
      deriveBody(spk, { pk2: 'x'.repeat(400) }),
      deriveBody([1]),
    ];
    for (const b of bad) expect((await call('/v1/derive', { headers: appHeaders(app), body: b })).status).toBe(400);
    expect((await call('/v1/sessions/revoke', { headers: appHeaders(app), body: { sessionPublicKey: spk, counter: 1 } })).status).toBe(400);
    expect(near.sent).toHaveLength(0);
  });

  it('relays revoke_session and forgets the cached session', async () => {
    const { app, near, spk } = await withSession();
    expect((await call('/v1/derive', { headers: appHeaders(app), body: deriveBody(spk) })).status).toBe(200);
    const res = await call('/v1/sessions/revoke', { headers: appHeaders(app), body: revokeBody(spk) });
    expect(res.status).toBe(200);
    expect((await body(res)).result).toBeNull();
    const after = await call('/v1/derive', { headers: appHeaders(app), body: deriveBody(spk, { counter: 3 }) });
    expect(after.status).toBe(404);
    expect(near.sent.map((t) => t.method)).toEqual(['derive_key', 'revoke_session']);
  });

  it('rejects a derive_key result without the key', async () => {
    const { app, near, spk } = await withSession();
    near.contract.derive_key = () => null;
    const res = await call('/v1/derive', { headers: appHeaders(app), body: deriveBody(spk) });
    expect(res.status).toBe(502);
    expect(await usage(app.id)).toBeNull();
  });
});
