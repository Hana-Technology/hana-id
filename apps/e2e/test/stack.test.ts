// The e2e stack's own behaviour: the test MPC, the Google stub, the D1 shim with apps/api's code on it, and the Hana
// API as the stack serves it (apps/api's Worker on the shims, with /v1/login and /v1/derive mocked). If these drift
// from the real services, the Playwright suite proves nothing, so each is checked against @hana-id/core (the same code
// the vault runs) or against apps/api's own rules.
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { base58 } from '@scure/base';
import {
  ckdAppId,
  ckdKeyProblem,
  decryptCkd,
  decryptRelayPayload,
  isScopeId,
  encryptRelayPayload,
  newAppKey,
  newSessionKey,
  randomBytes,
  relayIdFor,
  base64UrlEncode,
  sessionNonce,
  signDerive,
  signVaultMessage,
  toHex,
  vaultPayload,
  verifyGoogleIdToken,
} from '@hana-id/core';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { stackFingerprint } from '../src/fingerprint.ts';
import { CALLBACK_URL, CALLBACK_URLS, GOOGLE_AUTH_URL, GoogleStub, checkAuthRequest } from '../src/google-stub.ts';
import { MockApi } from '../src/server/api.ts';
import { type ApiModules, loadApiModules } from '../src/server/api-modules.ts';
import { Chain, mpcAnswer } from '../src/server/chain.ts';
import { D1Shim } from '../src/server/d1.ts';
import { serve, servedAt } from '../src/server/http.ts';
import { MemoryNamespace, type MemoryStorage } from '../src/server/workers.ts';
import {
  API_URL,
  AUTH_ORIGIN,
  DEFAULT_PORT_BASE,
  DEMO_ORIGIN,
  E2E_ENV,
  GOOGLE_CLIENT_ID,
  LIVE_API_URL,
  LIVE_AUTH_ORIGIN,
  LIVE_ENV,
  LIVE_ENV_NAME,
  LIVE_EVM_RPC,
  LIVE_NEAR_RPC,
  LIVE_PARTNER_ORIGIN,
  LIVE_SCOPE_ID,
  LIVE_UPSTREAMS,
  LIVE_VAULT_ORIGIN,
  NEAR_RPC,
  EVM_RPC,
  PARTNER_ORIGIN,
  PORTS,
  SITE_B_ORIGIN,
  TEST_CKD_NETWORK_KEY,
  VAULT_ORIGIN,
  portBase,
  portsFrom,
} from '../src/stack.ts';

let modules: ApiModules;
beforeAll(async () => {
  modules = await loadApiModules();
});

describe('the e2e env', () => {
  it('pins a usable CKD key and loopback Hana origins on different ports', () => {
    expect(ckdKeyProblem(E2E_ENV)).toBeNull();
    expect(E2E_ENV.devEnv).toBe(true);
    expect(new Set([E2E_ENV.vaultOrigin, E2E_ENV.authOrigin, E2E_ENV.apiUrl, E2E_ENV.rpc]).size).toBe(4);
  });

  it('puts the two partner sites on different hosts from each other and from the Hana pages (cross-site, as deployed)', () => {
    const host = (o: string) => new URL(o).hostname;
    const hana = [host(VAULT_ORIGIN), host(AUTH_ORIGIN)];
    for (const partner of [PARTNER_ORIGIN, SITE_B_ORIGIN]) expect(hana).not.toContain(host(partner));
    expect(host(SITE_B_ORIGIN)).not.toBe(host(PARTNER_ORIGIN));
    // A *.localhost name: loopback and potentially trustworthy, and expressible in frame-ancestors (an IPv6 literal is not).
    expect(host(SITE_B_ORIGIN)).toMatch(/^[a-z0-9-]+\.localhost$/u);
  });

  it('takes its ports from HANA_E2E_PORT_BASE (4410 by default), so worktrees can run side by side', () => {
    expect(portBase(undefined)).toBe(DEFAULT_PORT_BASE);
    expect(portBase('')).toBe(DEFAULT_PORT_BASE);
    expect(portBase('4510')).toBe(4510);
    expect(portsFrom(4510)).toEqual({ partner: 4510, siteB: 4511, demo: 4512, vault: 4520, liveVault: 4521, auth: 4530, liveAuth: 4531, api: 4540, liveApi: 4541, issuer: 4542, near: 4550, nearFallback: 4551, evm: 4560 });
    for (const bad of ['80', '65500', '45.5', '4510x', '-1', ' 0x1000']) expect(() => portBase(bad)).toThrow(/HANA_E2E_PORT_BASE/u);
    // A base that puts a port on one browsers refuse (5010 + 50 = 5060, SIP) fails at once, not in the tests.
    expect(() => portBase('5010')).toThrow(/port 5060, which browsers refuse/u);
    expect(() => portBase('5059')).toThrow(/port 5060, 5061/u);
    expect(portBase('5110')).toBe(5110);
    // This run's origins follow its base.
    const base = portBase();
    expect([PARTNER_ORIGIN, SITE_B_ORIGIN, VAULT_ORIGIN, AUTH_ORIGIN, API_URL].map((o) => Number(new URL(o).port))).toEqual([base, base + 1, base + 10, base + 20, base + 30]);
    expect(Number(new URL(DEMO_ORIGIN).port)).toBe(base + 2);
    expect(new Set(Object.values(PORTS)).size).toBe(13);
  });

  it('gives live mode an env of its own whose every origin is https, not loopback, and routed to the stack', () => {
    const live = [LIVE_PARTNER_ORIGIN, LIVE_VAULT_ORIGIN, LIVE_AUTH_ORIGIN, LIVE_API_URL, LIVE_NEAR_RPC, LIVE_EVM_RPC];
    for (const o of live) {
      const u = new URL(o);
      expect(u.origin).toBe(o);
      expect(u.protocol).toBe('https:');
      // A reserved `.test` name: no browser treats it as the local machine, and apps/api's loopback rule doesn't match it.
      expect(u.hostname).toMatch(/^[a-z0-9-]+\.[a-z0-9-]+\.test$/u);
      expect(modules.isLoopbackOrigin(o)).toBe(false);
    }
    expect(new Set(live).size).toBe(live.length);
    // The partner is cross-site to both Hana pages (its registrable domain differs), as deployed.
    const site = (o: string) => new URL(o).hostname.split('.').slice(-2).join('.');
    expect([site(LIVE_VAULT_ORIGIN), site(LIVE_AUTH_ORIGIN)]).not.toContain(site(LIVE_PARTNER_ORIGIN));
    expect(Object.keys(LIVE_UPSTREAMS).sort()).toEqual([...live].sort());
    expect(LIVE_UPSTREAMS[LIVE_PARTNER_ORIGIN]).toBe(PARTNER_ORIGIN);
    expect(LIVE_UPSTREAMS[LIVE_NEAR_RPC]).toBe(NEAR_RPC);
    expect(LIVE_UPSTREAMS[LIVE_EVM_RPC]).toBe(EVM_RPC);
    for (const o of [LIVE_VAULT_ORIGIN, LIVE_AUTH_ORIGIN, LIVE_API_URL]) expect(LIVE_UPSTREAMS[o]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    // The same chain, accounts and test MPC as the e2e env; its own name and origins.
    const { emailIssuerUrl: _u, emailIss: _i, rpcFallback: _f, ...noEmail } = E2E_ENV;
    // Live mode runs no email issuer (so no link) and no second RPC.
    expect(LIVE_ENV).toEqual({ ...noEmail, name: LIVE_ENV_NAME, apiUrl: LIVE_API_URL, vaultOrigin: LIVE_VAULT_ORIGIN, authOrigin: LIVE_AUTH_ORIGIN, rpc: LIVE_NEAR_RPC });
    expect(ckdKeyProblem(LIVE_ENV)).toBeNull();
    expect(isScopeId(LIVE_SCOPE_ID)).toBe(true);
    expect(LIVE_SCOPE_ID).not.toBe('e2e');
  });

  it("the stack's fingerprint covers the port base the bundles are built for", () => {
    const now = stackFingerprint();
    vi.stubEnv('HANA_E2E_PORT_BASE', String(portBase() + 100));
    try {
      expect(stackFingerprint()).not.toBe(now);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(stackFingerprint()).toBe(now);
  });
});

describe('test MPC', () => {
  it('answers a CKD that passes the pairing check for the requested path only', () => {
    const key = newAppKey();
    const { pk1 } = key.publicKey.AppPublicKeyPV;
    const path = 'e2e#google#123#0';
    const answer = mpcAnswer(pk1, path);
    const s = decryptCkd(answer, key.a, ckdAppId(E2E_ENV.signer, path), TEST_CKD_NETWORK_KEY);
    expect(s).toHaveLength(48);
    expect(() => decryptCkd(answer, key.a, ckdAppId(E2E_ENV.signer, 'e2e#google#456#0'), TEST_CKD_NETWORK_KEY)).toThrow();
    const other = `bls12381g2:${base58.encode(bls.G2.ProjectivePoint.BASE.multiply(7n).toRawBytes(true))}`;
    expect(() => decryptCkd(answer, key.a, ckdAppId(E2E_ENV.signer, path), other)).toThrow();
  });

  it('derives the same S for the same path with fresh app keys', () => {
    const path = 'e2e#google#123#0';
    const [k1, k2] = [newAppKey(), newAppKey()];
    const s1 = decryptCkd(mpcAnswer(k1.publicKey.AppPublicKeyPV.pk1, path), k1.a, ckdAppId(E2E_ENV.signer, path), TEST_CKD_NETWORK_KEY);
    const s2 = decryptCkd(mpcAnswer(k2.publicKey.AppPublicKeyPV.pk1, path), k2.a, ckdAppId(E2E_ENV.signer, path), TEST_CKD_NETWORK_KEY);
    expect(s1).toEqual(s2);
  });
});

describe('Google stub', () => {
  const authUrl = (over: Record<string, string | null> = {}) => {
    const p: Record<string, string | null> = { client_id: 'c', redirect_uri: CALLBACK_URL, response_type: 'id_token', response_mode: 'fragment', scope: 'openid', nonce: 'n', state: 's', prompt: 'select_account', ...over };
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v !== null) q.set(k, v);
    return new URL(`${GOOGLE_AUTH_URL}?${q.toString()}`);
  };

  it('accepts the spec’s request (and max_age=0) and refuses anything else', () => {
    expect(checkAuthRequest(authUrl())).toMatchObject({ ok: true, request: { clientId: 'c', nonce: 'n', state: 's', maxAge: null, redirectUri: CALLBACK_URL } });
    // Each env's authOrigin callback is a registered redirect URI (live mode's included), nothing else.
    expect(CALLBACK_URLS).toEqual([CALLBACK_URL, `${LIVE_AUTH_ORIGIN}/login/callback`]);
    expect(checkAuthRequest(authUrl({ redirect_uri: `${LIVE_AUTH_ORIGIN}/login/callback` }))).toMatchObject({ ok: true, request: { redirectUri: `${LIVE_AUTH_ORIGIN}/login/callback` } });
    expect(checkAuthRequest(authUrl({ max_age: '0' }))).toMatchObject({ ok: true, request: { maxAge: '0' } });
    const bads: Record<string, string | null>[] = [{ scope: 'openid email' }, { response_type: 'code' }, { response_mode: 'query' }, { prompt: null }, { redirect_uri: `${AUTH_ORIGIN}/cb` }, { redirect_uri: `${LIVE_VAULT_ORIGIN}/login/callback` }, { redirect_uri: null }, { nonce: null }, { state: null }, { max_age: '60' }, { login_hint: 'x' }];
    for (const bad of bads) {
      expect(checkAuthRequest(authUrl(bad)).ok).toBe(false);
    }
  });

  it('signs tokens the vault’s verifier accepts, with only allow-listed claims', async () => {
    const g = new GoogleStub();
    const token = await g.idToken({ clientId: 'c', nonce: 'n', state: 's', maxAge: null, redirectUri: CALLBACK_URL }, { sub: '42', label: 'x' });
    const { keys } = await g.jwks();
    const r = await verifyGoogleIdToken(token, { clientId: 'c', nonce: 'n', nowMs: Date.now(), jwks: keys as never });
    expect(r).toMatchObject({ ok: true, token: { sub: '42' } });
    expect(await verifyGoogleIdToken(token, { clientId: 'other', nonce: 'n', nowMs: Date.now(), jwks: keys as never })).toMatchObject({ ok: false });
  });

  it('serves a chooser whose links carry the state and a token, and a 400 for a bad request', async () => {
    const g = new GoogleStub();
    const ok = await g.authorize(authUrl());
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('id="account-0"');
    expect(ok.body).toContain(`${CALLBACK_URL}#state=s&amp;id_token=`);
    expect(ok.body).toContain('error=access_denied');
    // The links go back to the callback the request named.
    const live = await g.authorize(authUrl({ redirect_uri: `${LIVE_AUTH_ORIGIN}/login/callback` }));
    expect(live.body).toContain(`${LIVE_AUTH_ORIGIN}/login/callback#state=s&amp;id_token=`);
    expect(live.body).not.toContain(CALLBACK_URL);
    g.coop = 'same-origin';
    expect((await g.authorize(authUrl())).headers['cross-origin-opener-policy']).toBe('same-origin');
    expect((await g.authorize(authUrl({ scope: 'openid profile' }))).status).toBe(400);
  });
});

describe('the Hana API: apps/api’s Worker, /v1/login and /v1/derive mocked', () => {
  // The Worker reads the chain over HTTP (share creation, GET /v1/app): the mocked chain's RPC on an ephemeral port.
  const chain = new Chain();
  let nearRpc = '';
  let close: () => Promise<void> = async () => undefined;
  beforeAll(async () => {
    const [server] = await serve(0, ['127.0.0.1'], chain.handler());
    nearRpc = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    close = () => new Promise((resolve) => server!.close(() => resolve()));
  });
  afterAll(() => close());

  const setup = () => {
    const d1 = new D1Shim();
    chain.sessions.clear();
    const api = new MockApi(d1, chain, modules, { nearRpc });
    return { d1, api };
  };
  const call = (api: MockApi, path: string, init: { method?: string; origin?: string; parent?: string; pk?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.origin) headers.origin = init.origin;
    if (init.parent) headers['x-hana-parent-origin'] = init.parent;
    if (init.pk) headers['x-hana-key'] = init.pk;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const req = new Request(`http://127.0.0.1/${path.replace(/^\//u, '')}`, { method: init.method ?? 'GET', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    return api.handle(req);
  };

  /** A spent one-use session via the mocked /v1/login, and the key that signs for it. */
  const loggedIn = async (api: MockApi, pk: string, parent = PARTNER_ORIGIN) => {
    const session = await newSessionKey();
    const salt = randomBytes(32);
    const expiresAtMs = Date.now() + 3_600_000;
    const nonce = sessionNonce({ signer: E2E_ENV.signer, scopeId: 'e2e', sessionPublicKey: session.publicKey, expiresAtMs, keyIndex: 0, maxUses: 1, salt });
    const jwt = `x.${base64UrlEncode(new TextEncoder().encode(JSON.stringify({ sub: '42', nonce })))}.y`;
    const key = newAppKey();
    const { pk1, pk2 } = key.publicKey.AppPublicKeyPV;
    const body = { jwt, sessionPublicKey: Array.from(session.publicKey), expiresAtMs, salt: Array.from(salt), keyIndex: 0, maxUses: 1, signature: Array.from(await signDerive(session.keyPair.privateKey, 1, pk1, pk2)), pk1, pk2 };
    const res = await call(api, '/v1/login', { method: 'POST', origin: VAULT_ORIGIN, parent, pk, body });
    return { session, key, body, expiresAtMs, res };
  };

  it('stores apps that apps/api’s getAppByKey reads back, origins included', async () => {
    const { d1, api } = setup();
    const { appId, pk } = api.createApp({ origins: [PARTNER_ORIGIN, 'http://localhost:*'] });
    const app = await modules.getAppByKey(d1, pk);
    expect(app).toMatchObject({ id: appId, scope_id: 'e2e', status: 'active', scope_conflict: false });
    expect(app?.origins.sort()).toEqual([PARTNER_ORIGIN, 'http://localhost:*'].sort());
  });

  it('applies the Worker’s origin rule: an allowed parent from vaultOrigin, never an unlisted one or another origin', async () => {
    const { api } = setup();
    const { pk } = api.createApp({ origins: [PARTNER_ORIGIN] });
    const ok = await call(api, '/v1/app', { origin: VAULT_ORIGIN, parent: PARTNER_ORIGIN, pk });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(VAULT_ORIGIN);
    // GET /v1/app is the Worker's: the scope's shared Google client from the mocked chain.
    expect(await ok.json()).toMatchObject({ scopeId: 'e2e', signer: E2E_ENV.signer, google: { clientId: GOOGLE_CLIENT_ID, mode: 'shared' }, name: 'E2E Partner' });
    expect((await call(api, '/v1/app', { origin: VAULT_ORIGIN, parent: SITE_B_ORIGIN, pk })).status).toBe(403);
    expect((await call(api, '/v1/app', { origin: PARTNER_ORIGIN, pk })).status).toBe(200);
    expect((await call(api, '/v1/app', { origin: SITE_B_ORIGIN, pk })).status).toBe(403);
    expect((await call(api, '/v1/vault/unlock', { method: 'POST', origin: AUTH_ORIGIN, parent: PARTNER_ORIGIN, pk, body: {} })).status).toBe(403);
    expect((await call(api, '/v1/app', { origin: VAULT_ORIGIN, parent: PARTNER_ORIGIN, pk: 'pk_test_1111111111111111111111' })).status).toBe(401);
    const { pk: suspended } = api.createApp({ origins: [PARTNER_ORIGIN], status: 'suspended' });
    expect(await (await call(api, '/v1/app', { origin: VAULT_ORIGIN, parent: PARTNER_ORIGIN, pk: suspended })).json()).toMatchObject({ code: 'app_suspended' });
  });

  it('gates the mocked /v1/login and /v1/derive with the Worker’s app gate', async () => {
    const { api } = setup();
    const { pk } = api.createApp({ origins: [PARTNER_ORIGIN] });
    // A partner page never calls /v1/login; a Hana page must name an allowed parent.
    const fromPartner = await call(api, '/v1/login', { method: 'POST', origin: PARTNER_ORIGIN, pk, body: {} });
    expect(fromPartner.status).toBe(403);
    expect(fromPartner.headers.get('access-control-allow-origin')).toBeNull();
    const badParent = await call(api, '/v1/login', { method: 'POST', origin: AUTH_ORIGIN, parent: SITE_B_ORIGIN, pk, body: {} });
    expect(await badParent.json()).toMatchObject({ code: 'origin_not_allowed' });
    // The auth origin can read why (its CORS is on the refusal too).
    expect(badParent.headers.get('access-control-allow-origin')).toBe(AUTH_ORIGIN);
    expect((await call(api, '/v1/derive', { method: 'POST', origin: AUTH_ORIGIN, parent: PARTNER_ORIGIN, pk, body: {} })).status).toBe(403);
    expect((await call(api, '/v1/login', { method: 'POST', origin: VAULT_ORIGIN, parent: PARTNER_ORIGIN, body: {} })).status).toBe(401);
    // Past the gate, the mock's own checks, with the Worker's CORS and request id.
    const bad = await call(api, '/v1/login', { method: 'POST', origin: VAULT_ORIGIN, parent: PARTNER_ORIGIN, pk, body: {} });
    expect(bad.status).toBe(400);
    expect(bad.headers.get('access-control-allow-origin')).toBe(VAULT_ORIGIN);
    expect(bad.headers.get('x-request-id')).toBeTruthy();
    // Preflights are the Worker's.
    const pre = await call(api, '/v1/login', { method: 'OPTIONS', origin: VAULT_ORIGIN });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-hana-parent-origin');
  });

  it('relays once through the Worker’s LoginRelay: authOrigin writes, the read key reads and consumes, a wrong key reads nothing', async () => {
    const { api } = setup();
    const readKey = randomBytes(32);
    const relayKey = randomBytes(32);
    const relayId = relayIdFor(readKey);
    const value = await encryptRelayPayload(relayKey, relayId, { idToken: 'a.b.c' });
    const read = (key: Uint8Array, query = '?wait=1') => call(api, `/v1/login-relay/${relayId}${query}`, { origin: VAULT_ORIGIN, headers: { 'x-hana-relay-key': base64UrlEncode(key) } });

    expect((await call(api, `/v1/login-relay/${relayId}`, { method: 'POST', origin: PARTNER_ORIGIN, body: value })).status).toBe(403);
    // The vault writes follow-up slots (batch 8b): another slot, one write.
    const followId = relayIdFor(randomBytes(32));
    const followValue = await encryptRelayPayload(relayKey, followId, { idToken: 'a.b.c' });
    expect((await call(api, `/v1/login-relay/${followId}`, { method: 'POST', origin: VAULT_ORIGIN, body: followValue })).status).toBe(204);
    // No `wait`: an empty slot answers at once.
    const started = Date.now();
    expect((await read(readKey, '')).status).toBe(204);
    expect(Date.now() - started).toBeLessThan(500);
    const pending = read(readKey, '?wait=5');
    expect((await call(api, `/v1/login-relay/${relayId}`, { method: 'POST', origin: AUTH_ORIGIN, body: value })).status).toBe(204);
    expect((await call(api, `/v1/login-relay/${relayId}`, { method: 'POST', origin: AUTH_ORIGIN, body: value })).status).toBe(409);
    const got = await pending;
    expect(got.status).toBe(200);
    expect(got.headers.get('access-control-allow-origin')).toBe(VAULT_ORIGIN);
    expect(await decryptRelayPayload(relayKey, relayId, (await got.json()) as never)).toEqual({ idToken: 'a.b.c' });
    expect((await read(readKey)).status).toBe(410);
    expect((await read(randomBytes(32))).status).toBe(403);
    expect((await call(api, '/v1/login-relay/short', { origin: VAULT_ORIGIN })).status).toBe(400);
    expect((await call(api, `/v1/login-relay/${relayId}`, { method: 'OPTIONS', origin: AUTH_ORIGIN })).status).toBe(204);
    expect((await call(api, `/v1/login-relay/${relayId}`, { method: 'OPTIONS', origin: PARTNER_ORIGIN })).status).toBe(403);
  });

  it('refuses a malformed or out-of-range relay `wait` with 400, as the Worker does', async () => {
    const { api } = setup();
    const readKey = randomBytes(32);
    const relayId = relayIdFor(readKey);
    for (const wait of ['0', 'abc', '26', '1.5', '-1', '']) {
      const res = await call(api, `/v1/login-relay/${relayId}?wait=${wait}`, { origin: VAULT_ORIGIN, headers: { 'x-hana-relay-key': base64UrlEncode(readKey) } });
      expect(res.status, `wait=${wait}`).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'bad_request' });
    }
  });

  it('logs in, makes a KEK-wrapped share only for a spent session, unlocks with the next counter and refuses after revoke', async () => {
    const { d1, api } = setup();
    const { appId, pk } = api.createApp({ origins: [PARTNER_ORIGIN] });
    const vault = { origin: VAULT_ORIGIN, parent: PARTNER_ORIGIN, pk };
    const { session, key, body, expiresAtMs, res } = await loggedIn(api, pk);
    expect(res.status).toBe(200);
    const login = (await res.json()) as { result: { big_y: string; big_c: string }; nearTx: string };
    expect(decryptCkd(login.result, key.a, ckdAppId(E2E_ENV.signer, 'e2e#google#42#0'), TEST_CKD_NETWORK_KEY)).toHaveLength(48);
    expect(chain.txs.get(login.nearTx)).toEqual(login.result);
    expect((await call(api, '/v1/login', { method: 'POST', ...vault, body })).status).toBe(409);
    // A nonce that doesn't commit to the session is refused.
    expect((await call(api, '/v1/login', { method: 'POST', ...vault, body: { ...body, maxUses: 2 } })).status).toBe(401);

    const share = async (shareId: Uint8Array, counter: number, payload: Uint8Array) =>
      Array.from(await signVaultMessage(session.keyPair.privateKey, { signer: E2E_ENV.signer, appId, shareId, counter, payload }));
    const createBody = { sessionPublicKey: Array.from(session.publicKey), signature: await share(new Uint8Array(16), 0, vaultPayload.createShare(PARTNER_ORIGIN)) };
    // Signed for another parent: refused.
    const otherParent = { sessionPublicKey: createBody.sessionPublicKey, signature: await share(new Uint8Array(16), 0, vaultPayload.createShare(SITE_B_ORIGIN)) };
    expect(await (await call(api, '/v1/vault/shares', { method: 'POST', ...vault, body: otherParent })).json()).toMatchObject({ code: 'invalid_signature' });
    const created = await call(api, '/v1/vault/shares', { method: 'POST', ...vault, body: createBody });
    expect(created.status).toBe(201);
    expect(created.headers.get('access-control-allow-origin')).toBe(VAULT_ORIGIN);
    const { shareId, ks, absExpiresAtMs, idleUntilMs } = (await created.json()) as { shareId: number[]; ks: number[]; absExpiresAtMs: number; idleUntilMs: number };
    // The session ends before the app's idle limit (2 h): idleUntil is capped at the share's absolute expiry.
    expect(absExpiresAtMs).toBe(expiresAtMs);
    expect(idleUntilMs).toBe(absExpiresAtMs);
    // D1 holds K_s only wrapped under the stack's KEK.
    const row = d1.db.prepare('SELECT share_enc, kek_id FROM vault_shares').get() as { share_enc: Uint8Array; kek_id: number };
    expect(row.kek_id).toBe(1);
    expect(row.share_enc).toHaveLength(12 + 32 + 16);
    expect(toHex(row.share_enc)).not.toContain(toHex(Uint8Array.from(ks)));
    expect((await call(api, '/v1/vault/shares', { method: 'POST', ...vault, body: createBody })).status).toBe(409);

    const unlock = async (counter: number) => call(api, '/v1/vault/unlock', { method: 'POST', ...vault, body: { shareId, counter, signature: await share(Uint8Array.from(shareId), counter, vaultPayload.unlock()) } });
    const u1 = await unlock(1);
    expect(u1.status).toBe(200);
    expect(((await u1.json()) as { ks: number[] }).ks).toEqual(ks);
    expect(await (await unlock(1)).json()).toMatchObject({ code: 'bad_counter', expected: 2 });
    expect(api.shares(pk)).toEqual([{ counter: 1, revoked: false, partnerOrigin: PARTNER_ORIGIN }]);
    expect(api.revokeApp(pk)).toBe(1);
    expect(api.revokeApp(pk)).toBe(0);
    expect(api.shares(pk)).toEqual([{ counter: 1, revoked: true, partnerOrigin: PARTNER_ORIGIN }]);
    expect(await (await unlock(2)).json()).toMatchObject({ code: 'share_revoked' });
  });

  it('refuses a share for a session that can still derive, and vault preflights from anywhere but vaultOrigin', async () => {
    const { api } = setup();
    const { appId, pk } = api.createApp({ origins: [PARTNER_ORIGIN] });
    const session = await newSessionKey();
    // A live two-use session with one use left, straight on the mocked chain.
    chain.sessions.set(toHex(session.publicKey), { path: 'e2e#google#42#0', scope_id: 'e2e', expires_at_ms: Date.now() + 3_600_000, max_uses: 2, used: 1 });
    const signature = Array.from(await signVaultMessage(session.keyPair.privateKey, { signer: E2E_ENV.signer, appId, shareId: new Uint8Array(16), counter: 0, payload: vaultPayload.createShare(PARTNER_ORIGIN) }));
    const res = await call(api, '/v1/vault/shares', { method: 'POST', origin: VAULT_ORIGIN, parent: PARTNER_ORIGIN, pk, body: { sessionPublicKey: Array.from(session.publicKey), signature } });
    expect(await res.json()).toMatchObject({ code: 'session_not_spent' });
    expect((await call(api, '/v1/vault/unlock', { method: 'OPTIONS', origin: VAULT_ORIGIN })).status).toBe(204);
    expect((await call(api, '/v1/vault/unlock', { method: 'OPTIONS', origin: PARTNER_ORIGIN })).status).toBe(403);
  });

  it('creates an app with a fixed key once and returns the same app after that (the demo bakes its key in)', () => {
    const { api } = setup();
    const first = api.createApp({ origins: [PARTNER_ORIGIN], publishableKey: 'pk_test_DemoE2eDemoE2eDemoE2e' });
    expect(first.pk).toBe('pk_test_DemoE2eDemoE2eDemoE2e');
    expect(api.createApp({ origins: ['http://other.test'], publishableKey: 'pk_test_DemoE2eDemoE2eDemoE2e' })).toEqual(first);
    expect(api.createApp({ origins: [PARTNER_ORIGIN] }).pk).not.toBe(first.pk);
    expect(() => api.createApp({ origins: [PARTNER_ORIGIN], publishableKey: 'pk_live_DemoE2eDemoE2eDemoE2e' })).toThrow(/pk_test_/u);
  });

  it('creates live apps: a pk_live_ key on the live scope, which test apps on the e2e scope never conflict with', async () => {
    const { d1, api } = setup();
    const live = api.createApp({ origins: [LIVE_PARTNER_ORIGIN], live: true, settings: { rawSign: 'approval' } });
    expect(live.pk).toMatch(/^pk_live_[1-9A-HJ-NP-Za-km-z]{16,64}$/u);
    expect(await modules.getAppByKey(d1, live.pk)).toMatchObject({ scope_id: LIVE_SCOPE_ID, scope_conflict: false });
    const test = api.createApp({ origins: [PARTNER_ORIGIN] });
    expect(await modules.getAppByKey(d1, test.pk)).toMatchObject({ scope_id: 'e2e', scope_conflict: false });
    // On a live app's scope, a test app is refused (D51): the hot DB's triggers (migration 0006) refuse the row, which
    // is why live apps get a scope of their own.
    expect(() => api.createApp({ origins: [PARTNER_ORIGIN], scopeId: LIVE_SCOPE_ID })).toThrow(/key prefix does not match the scope environment/u);
    expect(() => api.createApp({ origins: [LIVE_PARTNER_ORIGIN], live: true, publishableKey: 'pk_test_DemoE2eDemoE2eDemoE2e' })).toThrow(/fresh key/u);
    // The control endpoints take live keys too.
    expect(await (await call(api, `/__e2e/apps/${live.pk}/shares`)).json()).toEqual([]);
    expect(await (await call(api, `/__e2e/apps/${live.pk}/revoke`, { method: 'POST' })).json()).toEqual({ revoked: 0 });
  });

  it('serves live mode from a second Worker on the same D1, under the production origin rule for live keys', async () => {
    const { d1, api } = setup();
    const liveApi = new MockApi(d1, chain, modules, { nearRpc, serves: { envName: LIVE_ENV_NAME, vaultOrigin: LIVE_VAULT_ORIGIN, authOrigin: LIVE_AUTH_ORIGIN, apiUrl: LIVE_API_URL } });
    // A live app listing a loopback origin too: the rule (unchanged) still refuses it for a pk_live_ key.
    const { pk } = api.createApp({ origins: [LIVE_PARTNER_ORIGIN, PARTNER_ORIGIN], live: true });
    const ok = await call(liveApi, '/v1/app', { origin: LIVE_VAULT_ORIGIN, parent: LIVE_PARTNER_ORIGIN, pk });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(LIVE_VAULT_ORIGIN);
    expect(await ok.json()).toMatchObject({ scopeId: LIVE_SCOPE_ID, rawSign: 'off' });
    expect((await call(liveApi, '/v1/app', { origin: LIVE_VAULT_ORIGIN, parent: PARTNER_ORIGIN, pk })).status).toBe(403);
    expect((await call(liveApi, '/v1/app', { origin: PARTNER_ORIGIN, pk })).status).toBe(403);
    expect((await call(api, '/v1/app', { origin: VAULT_ORIGIN, parent: PARTNER_ORIGIN, pk })).status).toBe(403);
    // Each Worker answers only its own env's Hana pages.
    expect((await call(liveApi, '/v1/app', { origin: VAULT_ORIGIN, parent: LIVE_PARTNER_ORIGIN, pk })).headers.get('access-control-allow-origin')).toBeNull();
    // The live Worker has no control endpoints: apps are created through the stack's default one.
    expect((await call(liveApi, '/__e2e/health')).status).toBe(404);
    expect((await call(liveApi, '/__e2e/apps', { method: 'POST', body: { origins: [] } })).status).toBe(404);
  });

  it('reports the fingerprint it was given on /__e2e/health, to requests without an Origin only', async () => {
    const api = new MockApi(new D1Shim(), chain, modules, { nearRpc, fingerprint: 'f00d' });
    expect(await (await call(api, '/__e2e/health')).json()).toEqual({ ok: true, fingerprint: 'f00d' });
    expect((await call(api, '/__e2e/health', { origin: PARTNER_ORIGIN })).status).toBe(403);
  });
});

describe('servedAt (live mode’s TLS-terminating front)', () => {
  it('hands the handler the request at the https origin, with its method, headers, query and body', async () => {
    let seen: { url: string; method: string; origin: string | null; body: string } | null = null;
    const handler = servedAt(LIVE_API_URL, async (req) => {
      seen = { url: req.url, method: req.method, origin: req.headers.get('origin'), body: await req.text() };
      return new Response('ok');
    });
    const res = await handler(new Request('http://127.0.0.1:1234/v1/login?x=1', { method: 'POST', headers: { origin: LIVE_VAULT_ORIGIN }, body: '{"a":1}' }), new AbortController().signal);
    expect(await res.text()).toBe('ok');
    expect(seen).toEqual({ url: `${LIVE_API_URL}/v1/login?x=1`, method: 'POST', origin: LIVE_VAULT_ORIGIN, body: '{"a":1}' });
    await handler(new Request('http://127.0.0.1:1234/vault?pk=p'), new AbortController().signal);
    expect(seen).toMatchObject({ url: `${LIVE_API_URL}/vault?pk=p`, method: 'GET', body: '' });
  });
});

describe('in-memory Durable Objects', () => {
  class Counter {
    constructor(readonly state: { storage: MemoryStorage; id: string }) {}
    alarms = 0;
    async alarm(): Promise<void> {
      this.alarms += 1;
    }
  }

  it('gives one instance per name, stores clones and fires the alarm once', async () => {
    const ns = new MemoryNamespace(Counter, () => ({}));
    const a = ns.get(ns.idFromName('a'));
    expect(ns.get('a')).toBe(a);
    expect(ns.get('b')).not.toBe(a);
    const v = { n: 1 };
    a.state.storage.kv.put('k', v);
    v.n = 2;
    expect(a.state.storage.kv.get('k')).toEqual({ n: 1 });
    await a.state.storage.setAlarm(Date.now() + 5);
    await a.state.storage.setAlarm(Date.now() + 10);
    await new Promise((r) => setTimeout(r, 40));
    expect(a.alarms).toBe(1);
    await a.state.storage.deleteAll();
    expect(a.state.storage.kv.get('k')).toBeUndefined();
  });
});
