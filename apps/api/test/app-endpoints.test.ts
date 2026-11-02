import { baseEncode } from '@near-js/utils';
import { env } from 'cloudflare:workers';
import { type Mock, afterEach, describe, expect, it, vi } from 'vitest';
import { usageDay } from '../src/apps.ts';
import { panic, rsaSigner } from './near-mock.ts';
import { DERIVE_KEY, ORIGIN, appHeaders, bytes, call, chain, deriveBody, google, newKey, newSessionKey, revokeBody, seedApp, seedPlan, sessionBody, uid, startOfMinuteClock } from './helpers.ts';
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
    const req = await sessionBody(app.scope, aud, { keyIndex: 3 });
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
    // D155: 100 Tgas covers a 4096-bit issuer key (68.8 burnt in the sandbox).
    expect(tx.gas).toBe(100_000_000_000_000n);
    // The session key's proof of possession (D137) is relayed as create_session's `signature`.
    expect(tx.args).toEqual({
      jwt: req.jwt,
      scope_id: app.scope,
      session_public_key: req.sessionPublicKey,
      expires_at_ms: req.expiresAtMs,
      salt: req.salt,
      key_index: 3,
      max_uses: 10,
      signature: req.signature,
    });
    expect(near.viewCalls).toEqual([
      { method: 'scope_for_client', args: { provider: 'google', aud } },
      // The session key must not be in use already.
      { method: 'session_key_in_use', args: { session_public_key: req.sessionPublicKey } },
      // Governance, alongside: not paused, and the token's kid is active on chain.
      { method: 'get_config', args: {} },
      { method: 'get_issuer', args: { provider: 'google' } },
    ]);
    expect(await usage(app.id)).toEqual({ sessions: 1, derives: 0 });
  });

  it('counts usage after responding (waitUntil), not before', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    chain({ [aud]: app.scope });
    const pending: Promise<unknown>[] = [];
    const exec = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud), exec });
    expect(res.status).toBe(200);
    // The JWKS fetch and the token's kid (key lead time, key-observations.ts), then usage: all after the response.
    expect(pending).toHaveLength(3);
    await Promise.all(pending);
    expect(await usage(app.id)).toEqual({ sessions: 1, derives: 0 });
  });

  it('maps both Google iss forms to provider google', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    chain({ [aud]: app.scope });
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud, {}, { iss: 'accounts.google.com' }) });
    expect(res.status).toBe(200);
  });

  it('caches scope_for_client (≤ 60 s)', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    const near = chain({ [aud]: app.scope });
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) })).status).toBe(200);
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) })).status).toBe(200);
    expect(near.viewCalls.filter((v) => v.method === 'scope_for_client')).toHaveLength(1);
    expect(await usage(app.id)).toEqual({ sessions: 2, derives: 0 });
  });

  it('rejects a token for an unregistered client before relaying', async () => {
    const app = await seedApp();
    const near = chain({});
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, 'nobody.apps.googleusercontent.com') });
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ code: 'unregistered_client' });
    expect(near.sent).toHaveLength(0);
    expect(await usage(app.id)).toBeNull();
  });

  it('rejects a token for a client registered to a different scope', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    const near = chain({ [aud]: 'sother' });
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) });
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ code: 'scope_mismatch' });
    expect(near.sent).toHaveLength(0);
  });

  it('rejects unknown issuers, unreadable and expired tokens', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    const near = chain({ [aud]: app.scope });
    const now = Math.floor(Date.now() / 1000);
    const cases: [Record<string, unknown>, number, string][] = [
      [await sessionBody(app.scope, aud, {}, { iss: 'https://evil.example' }), 400, 'unsupported_issuer'],
      [await sessionBody(app.scope, aud, {}, { aud: [aud] }), 401, 'invalid_token'],
      [await sessionBody(app.scope, aud, {}, { exp: now - 120 }), 400, 'token_expired'],
      [await sessionBody(app.scope, aud, { jwt: 'aaaa.!!!!.bbbb', signature: bytes(64, 1) }), 400, 'bad_request'],
      [await sessionBody(app.scope, aud, { jwt: 'aaaa.bbbb.cccc', signature: bytes(64, 1) }), 401, 'invalid_token'],
    ];
    for (const [req, status, code] of cases) {
      const res = await call('/v1/sessions', { headers: appHeaders(app), body: req });
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
      // The scope is the app's: the client can't name one.
      { scopeId: 'sother' },
      { scope_id: 'sother' },
    ];
    for (const override of bad) {
      const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud, override) });
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
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) });
    expect(res.status).toBe(422);
    const json = await body(res);
    expect(json).toMatchObject({ code: 'contract_rejected' });
    expect(json.error).toContain('Nonce mismatch');
    expect(typeof json.nearTx).toBe('string');
    expect(await usage(app.id)).toBeNull();
  });

  it('reports an unreachable RPC as 502', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    chain({ [aud]: app.scope });
    // Google's JWKS answers, the NEAR RPC is down.
    const jwksOnly = (globalThis.fetch as Mock<typeof fetch>).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation((input, init) =>
      String(input instanceof Request ? input.url : input).startsWith(env.NEAR_RPC) ? Promise.reject(new Error('network down')) : jwksOnly(input, init),
    );
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) });
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

  /** An app on `plan` whose own client is `aud`, and a valid /v1/sessions request for it. */
  async function quotaApp(perMinute: number, perDay: number, perIp = 1000) {
    const plan = `p${uid()}`;
    await seedPlan(plan, perMinute, perDay, perIp);
    const app = await seedApp({ plan });
    const aud = `${uid()}.apps.googleusercontent.com`;
    const near = chain({ [aud]: app.scope });
    const valid = async (): Promise<Response> => call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) });
    return { app, aud, near, valid };
  }

  it('rate limits per app per minute (requests that passed every check)', async () => {
    const { near, valid } = await quotaApp(2, 1000);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await valid()).status);
    expect(statuses).toEqual([200, 200, 429]);
    const res = await valid();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(await body(res)).toMatchObject({ code: 'rate_limited' });
    expect(near.sent).toHaveLength(2);
  });

  it('rate limits per app per day', async () => {
    const { valid } = await quotaApp(1000, 2);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await valid()).status);
    expect(statuses).toEqual([200, 200, 429]);
    expect((await body(await valid())).error).toContain('day');
  });

  it('unauthenticated junk never uses up the app’s quota (APIW-1): every check runs before it is counted', async () => {
    // A day quota of 2: before the fix, two junk requests locked every user of the app out until 00:00 UTC.
    const { app, aud, near, valid } = await quotaApp(2, 2);
    const evil = await rsaSigner('evil-kid');
    near.jwks = { keys: [google.jwk, evil.jwk] }; // a well-formed token signed by a key the chain doesn't trust
    const spk = newSessionKey();
    const junk: [string, () => Promise<Response>][] = [
      ['empty body', () => call('/v1/sessions', { headers: appHeaders(app), body: {} })],
      ['malformed JSON', () => call('/v1/sessions', { headers: { ...appHeaders(app), 'content-type': 'application/json' }, rawBody: '{' })],
      ['forged token', async () => call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud, {}, {}, evil) })],
      ['wrong nonce', async () => call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud, {}, { nonce: 'not-this-session' }) })],
      ['unregistered client', async () => call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, `${uid()}.apps.googleusercontent.com`) })],
      ['bad session signature', async () => call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk, { signature: bytes(64, 9) }) })],
      ['unknown session', async () => call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(newSessionKey()) })],
      ['revoke of an unknown session', async () => call('/v1/sessions/revoke', { headers: appHeaders(app), body: await revokeBody(newSessionKey(), { counter: 1 }) })],
    ];
    for (let round = 0; round < 3; round++) {
      for (const [what, send] of junk) {
        const res = await send();
        expect(res.status, what).toBeGreaterThanOrEqual(400);
        expect(res.status, what).not.toBe(429);
      }
    }
    expect(near.sent).toHaveLength(0);
    // 24 refused requests later, the app's whole quota is still there.
    expect([(await valid()).status, (await valid()).status, (await valid()).status]).toEqual([200, 200, 429]);
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
  it('the per-IP limit comes first and bounds a flood; neither refused nor junk requests use the app’s quota', async () => {
    await startOfMinuteClock();
    const plan = `p${uid()}`;
    await seedPlan(plan, 3, 1000, 2);
    const app = await seedApp({ plan });
    const aud = `${uid()}.apps.googleusercontent.com`;
    chain({ [aud]: app.scope });
    const noisy = `192.0.2.${Math.floor(Math.random() * 250)}`;
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await call('/v1/sessions', { headers: { ...appHeaders(app), 'cf-connecting-ip': noisy }, body: {} })).status);
    expect(statuses).toEqual([400, 400, ...Array(8).fill(429)]);
    // The app's per-minute quota (3) is untouched: three valid requests from other clients pass, the fourth doesn't.
    const others: number[] = [];
    for (let i = 0; i < 4; i++) others.push((await call('/v1/sessions', { headers: { ...appHeaders(app), 'cf-connecting-ip': `198.51.100.${i + 20}` }, body: await sessionBody(app.scope, aud) })).status);
    expect(others).toEqual([200, 200, 200, 429]);
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

  it('scope_for_client is cached for at most 60 s, a cached miss for at most 10 s', async () => {
    const plan = `p${uid()}`;
    await seedPlan(plan, 1000, 1000, 1000);
    const app = await seedApp({ plan });
    const aud = `${uid()}.apps.googleusercontent.com`;
    const near = chain({});
    const t0 = Date.now();
    const scopeViews = (): number => near.viewCalls.filter((v) => v.method === 'scope_for_client').length;
    at(t0);
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) })).status).toBe(403);
    // Registered meanwhile: the cached null still answers within 10 s (as long as /v1/app's scope view)...
    near.clients[aud] = app.scope;
    at(t0 + 9_000);
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) })).status).toBe(403);
    expect(scopeViews()).toBe(1);
    // ...and expires after it.
    at(t0 + 11_000);
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) })).status).toBe(200);
    expect(scopeViews()).toBe(2);
    // A found scope is cached for 60 s: a client removed on chain stops passing the API check once it expires.
    delete near.clients[aud];
    at(t0 + 72_000);
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) })).status).toBe(403);
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
    expect((await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk) })).status).toBe(200);
    at(t0 + 9_000);
    expect((await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk, { counter: 2 }) })).status).toBe(200);
    expect(sessionViews()).toBe(1);
    // Revoked outside the API: seen once the 10 s entry expires.
    near.sessions.delete(JSON.stringify(spk));
    at(t0 + 11_000);
    expect((await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk, { counter: 3 }) })).status).toBe(404);
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
    const res = await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk) });
    expect(res.status).toBe(200);
    const json = await body(res);
    expect(json.result).toEqual({ big_y: 'bls12381g1:Y', big_c: 'bls12381g1:C' });
    expect(near.sent.map((t) => t.method)).toEqual(['derive_key']);
    expect(near.sent[0]!.args).toEqual({ session_public_key: spk, counter: 1, signature: (await deriveBody(spk)).signature, pk1: DERIVE_KEY.pk1, pk2: DERIVE_KEY.pk2 });
    expect(near.sent[0]!.gas).toBe(60_000_000_000_000n);
    expect(await usage(app.id)).toEqual({ sessions: 0, derives: 1 });
  });

  it('counts sessions and derives separately over a full login', async () => {
    const { app, near, aud } = await withSession();
    const req = await sessionBody(app.scope, aud);
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: req })).status).toBe(200);
    const spk = req.sessionPublicKey as number[];
    expect((await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk) })).status).toBe(200);
    expect((await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk, { counter: 2 }) })).status).toBe(200);
    // One session_key_in_use before create_session (the key must be unused); the derives use the session it returned.
    expect(near.viewCalls.filter((v) => v.method === 'session_key_in_use')).toHaveLength(1);
    expect(near.viewCalls.filter((v) => v.method === 'get_session')).toHaveLength(0);
    expect(await usage(app.id)).toEqual({ sessions: 1, derives: 2 });
    expect((await call('/v1/sessions/revoke', { headers: appHeaders(app), body: await revokeBody(spk, { counter: 3 }) })).status).toBe(200);
    expect(await usage(app.id)).toEqual({ sessions: 1, derives: 2 });
  });

  it('caches get_session (≤ 10 s)', async () => {
    const { app, near, spk } = await withSession();
    await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk) });
    await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk, { counter: 2 }) });
    expect(near.viewCalls.filter((v) => v.method === 'get_session')).toHaveLength(1);
  });

  it('rejects unknown sessions, sessions of other scopes and expired sessions', async () => {
    const { app, near } = await withSession();
    const unknown = await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(newSessionKey()) });
    expect(unknown.status).toBe(404);
    expect((await body(unknown)).code).toBe('unknown_session');

    const foreign = newSessionKey();
    near.sessions.set(JSON.stringify(foreign), { path: 'sother#google#1#0', scope_id: 'sother', expires_at_ms: Date.now() + 3_600_000, max_uses: 10, used: 0 });
    for (const path of ['/v1/derive', '/v1/sessions/revoke']) {
      const res = await call(path, { headers: appHeaders(app), body: path === '/v1/derive' ? await deriveBody(foreign) : await revokeBody(foreign) });
      expect(res.status).toBe(403);
      expect((await body(res)).code).toBe('scope_mismatch');
    }

    const expired = newSessionKey();
    near.sessions.set(JSON.stringify(expired), { path: `${app.scope}#google#1#0`, scope_id: app.scope, expires_at_ms: Date.now() - 1, max_uses: 10, used: 0 });
    const res = await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(expired) });
    expect(res.status).toBe(404);
    expect(near.sent).toHaveLength(0);
  });

  it('validates derive and revoke shapes', async () => {
    const { app, near, spk } = await withSession();
    const bad = [
      await deriveBody(spk, { counter: 0 }),
      await deriveBody(spk, { signature: [1, 2] }),
      await deriveBody(spk, { pk1: 'bls12381g2:x' }),
      await deriveBody(spk, { pk2: 'x'.repeat(400) }),
      await deriveBody([1], { signature: bytes(64, 9) }),
    ];
    for (const b of bad) expect((await call('/v1/derive', { headers: appHeaders(app), body: b })).status).toBe(400);
    expect((await call('/v1/sessions/revoke', { headers: appHeaders(app), body: { sessionPublicKey: spk, counter: 1 } })).status).toBe(400);
    expect(near.sent).toHaveLength(0);
  });

  it('refuses app keys that are not one compressed, non-identity point each, signed or not, even with BLS_PRECHECK off (APIW-4)', async () => {
    const { app, near, spk } = await withSession();
    const g1Identity = `bls12381g1:${baseEncode(Uint8Array.from([0xc0, ...Array<number>(47).fill(0)]))}`;
    const g2Identity = `bls12381g2:${baseEncode(Uint8Array.from([0xc0, ...Array<number>(95).fill(0)]))}`;
    for (const keys of [{ pk1: g1Identity }, { pk2: g2Identity }, { pk1: 'bls12381g1:abc' }, { pk2: 'bls12381g2:def' }]) {
      // Signed by the session key over these very keys: only the shape check stops it.
      const res = await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk, keys), env: { BLS_PRECHECK: '0' } });
      expect([res.status, (await body(res)).code], JSON.stringify(keys)).toEqual([400, 'invalid_app_key']);
    }
    expect(near.sent).toHaveLength(0);
    expect((await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk) })).status).toBe(200);
  });

  it('relays revoke_session and forgets the cached session', async () => {
    const { app, near, spk } = await withSession();
    expect((await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk) })).status).toBe(200);
    const res = await call('/v1/sessions/revoke', { headers: appHeaders(app), body: await revokeBody(spk) });
    expect(res.status).toBe(200);
    expect((await body(res)).result).toBeNull();
    const after = await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk, { counter: 3 }) });
    expect(after.status).toBe(404);
    expect(near.sent.map((t) => t.method)).toEqual(['derive_key', 'revoke_session']);
  });

  it('rejects a derive_key result without the key', async () => {
    const { app, near, spk } = await withSession();
    near.contract.derive_key = () => null;
    const res = await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk) });
    expect(res.status).toBe(502);
    expect(await usage(app.id)).toBeNull();
  });
});
