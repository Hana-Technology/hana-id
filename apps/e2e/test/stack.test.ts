// The e2e stack's own behaviour: the test MPC, the Google stub, the D1 shim with apps/api's code on it, and the
// mocked API's origin rule, relay and shares. If these drift from the real services, the Playwright suite proves
// nothing, so each is checked against @hana-id/core (the same code the vault runs) or apps/api.
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { base58 } from '@scure/base';
import {
  ckdAppId,
  ckdKeyProblem,
  decryptCkd,
  decryptRelayPayload,
  encryptRelayPayload,
  newAppKey,
  newSessionKey,
  randomBytes,
  relayIdFor,
  base64UrlEncode,
  sessionNonce,
  signDerive,
  signVaultMessage,
  vaultPayload,
  verifyGoogleIdToken,
} from '@hana-id/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { CALLBACK_URL, GOOGLE_AUTH_URL, GoogleStub, checkAuthRequest } from '../src/google-stub.ts';
import { MockApi } from '../src/server/api.ts';
import { type ApiModules, loadApiModules } from '../src/server/api-modules.ts';
import { Chain, mpcAnswer } from '../src/server/chain.ts';
import { D1Shim } from '../src/server/d1.ts';
import { AUTH_ORIGIN, E2E_ENV, PARTNER_ORIGIN, SITE_B_ORIGIN, TEST_CKD_NETWORK_KEY, VAULT_ORIGIN } from '../src/stack.ts';

let modules: ApiModules;
beforeAll(async () => {
  modules = await loadApiModules();
});

describe('the e2e env', () => {
  it('pins a usable CKD key and loopback Hana origins on different ports', () => {
    expect(ckdKeyProblem(E2E_ENV)).toBeNull();
    expect(E2E_ENV.devEnv).toBe(true);
    expect(new Set([E2E_ENV.vaultOrigin, E2E_ENV.authOrigin, E2E_ENV.apiUrl, E2E_ENV.rpc]).size).toBe(4);
    expect(new URL(PARTNER_ORIGIN).hostname).not.toBe(new URL(VAULT_ORIGIN).hostname);
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
    expect(checkAuthRequest(authUrl())).toMatchObject({ ok: true, request: { clientId: 'c', nonce: 'n', state: 's', maxAge: null } });
    expect(checkAuthRequest(authUrl({ max_age: '0' }))).toMatchObject({ ok: true, request: { maxAge: '0' } });
    const bads: Record<string, string | null>[] = [{ scope: 'openid email' }, { response_type: 'code' }, { response_mode: 'query' }, { prompt: null }, { redirect_uri: `${AUTH_ORIGIN}/cb` }, { nonce: null }, { state: null }, { max_age: '60' }, { login_hint: 'x' }];
    for (const bad of bads) {
      expect(checkAuthRequest(authUrl(bad)).ok).toBe(false);
    }
  });

  it('signs tokens the vault’s verifier accepts, with only allow-listed claims', async () => {
    const g = new GoogleStub();
    const token = await g.idToken({ clientId: 'c', nonce: 'n', state: 's', maxAge: null }, { sub: '42', label: 'x' });
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
    g.coop = 'same-origin';
    expect((await g.authorize(authUrl())).headers['cross-origin-opener-policy']).toBe('same-origin');
    expect((await g.authorize(authUrl({ scope: 'openid profile' }))).status).toBe(400);
  });
});

describe('mocked API on apps/api code', () => {
  const setup = () => {
    const d1 = new D1Shim();
    const chain = new Chain();
    const api = new MockApi(d1, chain, modules);
    return { d1, chain, api };
  };
  const call = (api: MockApi, path: string, init: { method?: string; origin?: string; parent?: string; pk?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.origin) headers.origin = init.origin;
    if (init.parent) headers['x-hana-parent-origin'] = init.parent;
    if (init.pk) headers['x-hana-key'] = init.pk;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const req = new Request(`http://127.0.0.1/${path.replace(/^\//u, '')}`, { method: init.method ?? 'GET', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    return api.handle(req, new AbortController().signal);
  };

  it('stores apps that apps/api’s getAppByKey reads back, origins included', async () => {
    const { d1, api } = setup();
    const { appId, pk } = api.createApp({ origins: [PARTNER_ORIGIN, 'http://localhost:*'] });
    const app = await modules.getAppByKey(d1, pk);
    expect(app).toMatchObject({ id: appId, scope_id: 'e2e', status: 'active', scope_conflict: false });
    expect(app?.origins.sort()).toEqual([PARTNER_ORIGIN, 'http://localhost:*'].sort());
  });

  it('applies the Hana-origin rule: an allowed parent from vaultOrigin, never an unlisted one or another origin', async () => {
    const { api } = setup();
    const { pk } = api.createApp({ origins: [PARTNER_ORIGIN] });
    expect((await call(api, '/v1/app', { origin: VAULT_ORIGIN, parent: PARTNER_ORIGIN, pk })).status).toBe(200);
    expect((await call(api, '/v1/app', { origin: VAULT_ORIGIN, parent: SITE_B_ORIGIN, pk })).status).toBe(403);
    expect((await call(api, '/v1/app', { origin: PARTNER_ORIGIN, pk })).status).toBe(200);
    expect((await call(api, '/v1/app', { origin: SITE_B_ORIGIN, pk })).status).toBe(403);
    expect((await call(api, '/v1/vault/unlock', { method: 'POST', origin: AUTH_ORIGIN, parent: PARTNER_ORIGIN, pk, body: {} })).status).toBe(403);
    expect((await call(api, '/v1/app', { origin: VAULT_ORIGIN, parent: PARTNER_ORIGIN, pk: 'pk_test_1111111111111111111111' })).status).toBe(401);
    const { pk: suspended } = api.createApp({ origins: [PARTNER_ORIGIN], status: 'suspended' });
    expect(await (await call(api, '/v1/app', { origin: VAULT_ORIGIN, parent: PARTNER_ORIGIN, pk: suspended })).json()).toMatchObject({ code: 'app_suspended' });
  });

  it('relays once: authOrigin writes, the read key reads and consumes, a wrong key reads nothing', async () => {
    const { api } = setup();
    const readKey = randomBytes(32);
    const relayKey = randomBytes(32);
    const relayId = relayIdFor(readKey);
    const value = await encryptRelayPayload(relayKey, relayId, { idToken: 'a.b.c' });
    const read = (key: Uint8Array, wait = 1) => call(api, `/v1/login-relay/${relayId}?wait=${wait}`, { origin: VAULT_ORIGIN, headers: { 'x-hana-relay-key': base64UrlEncode(key) } });

    expect((await call(api, `/v1/login-relay/${relayId}`, { method: 'POST', origin: VAULT_ORIGIN, body: value })).status).toBe(403);
    const pending = read(readKey, 5);
    expect((await call(api, `/v1/login-relay/${relayId}`, { method: 'POST', origin: AUTH_ORIGIN, body: value })).status).toBe(204);
    expect((await call(api, `/v1/login-relay/${relayId}`, { method: 'POST', origin: AUTH_ORIGIN, body: value })).status).toBe(409);
    const got = await pending;
    expect(got.status).toBe(200);
    expect(await decryptRelayPayload(relayKey, relayId, (await got.json()) as never)).toEqual({ idToken: 'a.b.c' });
    expect((await read(readKey)).status).toBe(410);
    expect((await read(randomBytes(32))).status).toBe(403);
    expect((await call(api, '/v1/login-relay/short', { origin: VAULT_ORIGIN })).status).toBe(400);
  });

  it('logs in, makes a share only for a spent session, unlocks with the next counter and refuses after revoke', async () => {
    const { chain, api } = setup();
    const { appId, pk } = api.createApp({ origins: [PARTNER_ORIGIN] });
    const vault = { origin: VAULT_ORIGIN, parent: PARTNER_ORIGIN, pk };
    const session = await newSessionKey();
    const salt = randomBytes(32);
    const expiresAtMs = Date.now() + 3_600_000;
    const nonce = sessionNonce({ signer: E2E_ENV.signer, scopeId: 'e2e', sessionPublicKey: session.publicKey, expiresAtMs, keyIndex: 0, maxUses: 1, salt });
    const jwt = `x.${base64UrlEncode(new TextEncoder().encode(JSON.stringify({ sub: '42', nonce })))}.y`;
    const key = newAppKey();
    const { pk1, pk2 } = key.publicKey.AppPublicKeyPV;
    const body = { jwt, sessionPublicKey: Array.from(session.publicKey), expiresAtMs, salt: Array.from(salt), keyIndex: 0, maxUses: 1, signature: Array.from(await signDerive(session.keyPair.privateKey, 1, pk1, pk2)), pk1, pk2 };
    const res = await call(api, '/v1/login', { method: 'POST', ...vault, body });
    expect(res.status).toBe(200);
    const login = (await res.json()) as { result: { big_y: string; big_c: string }; nearTx: string };
    expect(decryptCkd(login.result, key.a, ckdAppId(E2E_ENV.signer, 'e2e#google#42#0'), TEST_CKD_NETWORK_KEY)).toHaveLength(48);
    expect(chain.txs.get(login.nearTx)).toEqual(login.result);
    expect((await call(api, '/v1/login', { method: 'POST', ...vault, body })).status).toBe(409);
    // A nonce that doesn't commit to the session is refused.
    expect((await call(api, '/v1/login', { method: 'POST', ...vault, body: { ...body, maxUses: 2 } })).status).toBe(401);

    const share = async (shareId: Uint8Array, counter: number, payload: Uint8Array) =>
      Array.from(await signVaultMessage(session.keyPair.privateKey, { signer: E2E_ENV.signer, appId, shareId, counter, payload }));
    const created = await call(api, '/v1/vault/shares', { method: 'POST', ...vault, body: { sessionPublicKey: Array.from(session.publicKey), signature: await share(new Uint8Array(16), 0, vaultPayload.createShare(PARTNER_ORIGIN)) } });
    expect(created.status).toBe(201);
    const { shareId, ks } = (await created.json()) as { shareId: number[]; ks: number[] };
    const unlock = async (counter: number) => call(api, '/v1/vault/unlock', { method: 'POST', ...vault, body: { shareId, counter, signature: await share(Uint8Array.from(shareId), counter, vaultPayload.unlock()) } });
    const u1 = await unlock(1);
    expect(u1.status).toBe(200);
    expect(((await u1.json()) as { ks: number[] }).ks).toEqual(ks);
    expect(await (await unlock(1)).json()).toMatchObject({ code: 'bad_counter', expected: 2 });
    expect(api.revokeApp(pk)).toBe(1);
    expect(await (await unlock(2)).json()).toMatchObject({ code: 'share_revoked' });
  });
});
