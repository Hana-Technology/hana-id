// The e2e stack's batch 8b pieces (unit): the Google stub's request kinds (login, proof, second_request's request for
// the email scope) and its refusals, Google's server-side answers for the Workers (google-backend.ts), and the mocked
// chain's accounts and links behind the mocked /v1/login (the path through the account root, a linked login over the
// linked CKD payload, a pending member refused) and the link relays.
import {
  ckdAppId,
  decryptCkd,
  identityKeyHex,
  linkedCkdPayload,
  newAppKey,
  newSessionKey,
  randomBytes,
  sessionMessage,
  sessionNonce,
  base64UrlEncode,
} from '@hana-id/core';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALLBACK_URL, GOOGLE_AUTH_URL, GoogleStub, checkAuthRequest } from '../src/google-stub.ts';
import { MockApi } from '../src/server/api.ts';
import { type ApiModules, loadApiModules } from '../src/server/api-modules.ts';
import { Chain } from '../src/server/chain.ts';
import { D1Shim } from '../src/server/d1.ts';
import { GOOGLE_TOKENINFO_URL, GOOGLE_USERINFO_URL, GoogleBackend, accessTokenFor } from '../src/server/google-backend.ts';
import { serve } from '../src/server/http.ts';
import { E2E_ENV, PARTNER_ORIGIN, TEST_CKD_NETWORK_KEY, VAULT_ORIGIN } from '../src/stack.ts';

let modules: ApiModules;
beforeAll(async () => {
  modules = await loadApiModules();
});

const url = (p: Record<string, string>) => new URL(`${GOOGLE_AUTH_URL}?${new URLSearchParams(p).toString()}`);
const base = { client_id: 'c', redirect_uri: CALLBACK_URL, response_mode: 'fragment', state: 's' };

describe('Google stub: batch 8b’s requests (proof, second_request’s access request)', () => {
  it('a proof names its account and shows no chooser; the access request asks for email only, silently or not', () => {
    expect(checkAuthRequest(url({ ...base, response_type: 'id_token', scope: 'openid', nonce: 'n', login_hint: '42' }))).toMatchObject({ ok: true, request: { kind: 'proof', loginHint: '42' } });
    expect(checkAuthRequest(url({ ...base, response_type: 'token', scope: 'email', login_hint: '42', prompt: 'none' }))).toMatchObject({ ok: true, request: { kind: 'access', silent: true } });
    expect(checkAuthRequest(url({ ...base, response_type: 'token', scope: 'email', login_hint: '42' }))).toMatchObject({ ok: true, request: { kind: 'access', silent: false } });
    for (const bad of [
      // The email scope next to an ID token: the address could land in the on-chain token (D25).
      { ...base, response_type: 'id_token token', scope: 'openid email', nonce: 'n', prompt: 'select_account' },
      { ...base, response_type: 'id_token', scope: 'openid email', nonce: 'n', prompt: 'select_account' },
      { ...base, response_type: 'token', scope: 'openid email', login_hint: '42' },
      { ...base, response_type: 'token', scope: 'email' },
      { ...base, response_type: 'token', scope: 'email', login_hint: '42', nonce: 'n' },
      { ...base, response_type: 'id_token', scope: 'openid', nonce: 'n', login_hint: '42', prompt: 'select_account' },
    ]) {
      expect(checkAuthRequest(url(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('answers a named account at once: an ID token for a proof, an access token for the email scope', async () => {
    const g = new GoogleStub();
    g.accounts = [{ sub: '42', label: 'x', email: 'ada@gmail.com', emailVerified: true }];
    const proof = await g.authorize(url({ ...base, response_type: 'id_token', scope: 'openid', nonce: 'n', login_hint: '42' }));
    expect(proof.body).toContain(`${CALLBACK_URL}#state=s&id_token=`);
    const access = await g.authorize(url({ ...base, response_type: 'token', scope: 'email', login_hint: '42', prompt: 'none' }));
    expect(access.body).toMatch(/#access_token=ya29\.e2e\.[^&]+&token_type=Bearer&expires_in=3599&scope=email&state=s/u);
    const unknown = await g.authorize(url({ ...base, response_type: 'token', scope: 'email', login_hint: '7', prompt: 'none' }));
    expect(unknown.body).toContain('error=login_required');
  });
});

describe('Google stub: token_first’s requests (D270, D273) and tokeninfo from the browser', () => {
  const tokenFirst = { ...base, response_type: 'token', scope: 'openid email', prompt: 'select_account' };
  const silentId = { ...base, response_type: 'id_token', scope: 'openid', nonce: 'n', login_hint: '42', prompt: 'none' };

  it('accepts the access token request with the chooser and the silent hinted ID request; refuses their near misses', () => {
    expect(checkAuthRequest(url(tokenFirst))).toMatchObject({ ok: true, request: { kind: 'token_first', scope: 'openid email', nonce: '' } });
    expect(checkAuthRequest(url(silentId))).toMatchObject({ ok: true, request: { kind: 'id', loginHint: '42', silent: true, nonce: 'n', scope: 'openid' } });
    // D273's interactive retry is an ID request with the hint and no prompt (a proof's shape).
    const { prompt: _p, ...retry } = silentId;
    expect(checkAuthRequest(url(retry))).toMatchObject({ ok: true, request: { kind: 'proof', loginHint: '42' } });
    for (const bad of [
      { ...tokenFirst, prompt: 'none' },
      { ...tokenFirst, login_hint: '42' },
      { ...tokenFirst, nonce: 'n' },
      { ...tokenFirst, max_age: '0' },
      { ...tokenFirst, scope: 'openid email profile' },
      { ...silentId, max_age: '0' },
      { ...silentId, scope: 'openid email' },
      { ...silentId, response_type: 'id_token token' },
    ]) {
      expect(checkAuthRequest(url(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('the chooser’s links carry access tokens (no ID token is signed); the silent ID request answers at once, or the account’s silentIdError', async () => {
    const g = new GoogleStub();
    g.accounts = [{ sub: '42', label: 'x', email: 'ada@gmail.com', emailVerified: true }];
    const chooser = await g.authorize(url(tokenFirst));
    expect(chooser.body).toMatch(/#access_token=ya29\.e2e\.[^&]+&amp;token_type=Bearer&amp;expires_in=3599&amp;scope=openid\+email&amp;state=s/u);
    expect(chooser.body).not.toContain('id_token=');
    expect(g.issued).toEqual([]);
    expect((await g.authorize(url(silentId))).body).toContain(`${CALLBACK_URL}#state=s&id_token=`);
    expect(g.issued.map((t) => t.sub)).toEqual(['42']);
    g.accounts = [{ sub: '42', label: 'x', silentIdError: 'interaction_required' }];
    expect((await g.authorize(url(silentId))).body).toContain('error=interaction_required');
    const { prompt: _p, ...retry } = silentId;
    expect((await g.authorize(url(retry))).body).toContain('id_token=');
    expect((await g.authorize(url({ ...silentId, login_hint: '7' }))).body).toContain('error=login_required');
    expect(g.kinds).toEqual(['token_first', 'id', 'id', 'proof', 'id']);
    expect(g.logins).toHaveLength(1);
  });

  it('tokeninfo answers the page’s CORS POST as the stack’s Google does, and allows another origin when tokeninfoCors is off', () => {
    const g = new GoogleStub();
    const token = accessTokenFor({ aud: 'c', sub: '42', email: 'a@gmail.com', emailVerified: true, hd: null, expMs: Date.now() + 60_000 });
    const ok = g.tokeninfo('POST', 'http://127.0.0.1:4430', new URLSearchParams({ access_token: token }).toString());
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe('http://127.0.0.1:4430');
    expect(JSON.parse(ok.body)).toMatchObject({ aud: 'c', azp: 'c', sub: '42' });
    expect(Number(JSON.parse(ok.body).expires_in)).toBeGreaterThan(0);
    expect(g.tokeninfo('POST', 'http://127.0.0.1:4430', 'access_token=nope').status).toBe(400);
    expect(g.tokeninfo('OPTIONS', 'http://127.0.0.1:4430', null).headers['access-control-allow-origin']).toBe('http://127.0.0.1:4430');
    g.tokeninfoCors = false;
    const off = g.tokeninfo('POST', 'http://127.0.0.1:4430', new URLSearchParams({ access_token: token }).toString());
    expect(off.headers['access-control-allow-origin']).not.toBe('http://127.0.0.1:4430');
    expect(off.headers['access-control-allow-origin']).toBeDefined();
    // Never the token: the account and the page's origin only.
    expect(g.tokeninfoCalls).toEqual([
      { sub: '42', origin: 'http://127.0.0.1:4430' },
      { sub: null, origin: 'http://127.0.0.1:4430' },
      { sub: '42', origin: 'http://127.0.0.1:4430' },
    ]);
    expect(JSON.stringify(g.tokeninfoCalls)).not.toContain(token);
  });
});

describe('Google’s server side for the stack’s Workers', () => {
  it('tokeninfo and userinfo read the stub’s access token back; revoke ends it; the JWKS lists the stack key', async () => {
    const b = await GoogleBackend.create();
    const token = accessTokenFor({ aud: 'c', sub: '42', email: 'a@x.example', emailVerified: true, hd: 'x.example', expMs: Date.now() + 60_000 });
    const info = await b.answer(GOOGLE_TOKENINFO_URL, { method: 'POST', body: new URLSearchParams({ access_token: token }).toString() });
    expect(await info!.json()).toMatchObject({ aud: 'c', azp: 'c', sub: '42' });
    const user = await b.answer(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${token}` } });
    expect(await user!.json()).toEqual({ sub: '42', email: 'a@x.example', email_verified: true, hd: 'x.example' });
    await b.answer('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token }).toString() });
    expect((await b.answer(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${token}` } }))!.status).toBe(401);
    expect((await b.jwks()).keys[0]?.kid).toBe(b.kid);
    expect(await b.answer('https://example.com/', undefined)).toBeNull();
  });
});

describe('the mocked chain’s accounts and links behind /v1/login', () => {
  const chain = new Chain();
  let nearRpc = '';
  let close: () => Promise<void> = async () => undefined;
  beforeAll(async () => {
    const [server] = await serve(0, ['127.0.0.1'], chain.handler());
    nearRpc = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    close = () => new Promise((resolve) => server!.close(() => resolve()));
  });
  afterAll(() => close());

  const b64 = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
  const googleJwt = (sub: string, nonce: string) => `x.${b64({ sub, nonce })}.y`;
  const emailJwt = (sub: string, nonce: string) => JSON.stringify({ payload: b64({ sub, nonce }), signatures: [] });

  async function login(api: MockApi, pk: string, jwt: (nonce: string) => string, link?: { jwt: string; immediate: boolean }) {
    const session = await newSessionKey();
    const salt = randomBytes(32);
    const expiresAtMs = Date.now() + 3_600_000;
    const nonce = sessionNonce({ signer: E2E_ENV.signer, scopeId: 'e2e', sessionPublicKey: session.publicKey, expiresAtMs, keyIndex: 0, maxUses: 1, salt });
    const key = newAppKey();
    const { pk1, pk2 } = key.publicKey.AppPublicKeyPV;
    const payload = link ? linkedCkdPayload(pk1, pk2, link.jwt, link.immediate) : new TextEncoder().encode(`hana-id-ckd-v1:${pk1}:${pk2}`);
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, session.keyPair.privateKey, sessionMessage(1, payload)));
    const body = { jwt: jwt(nonce), sessionPublicKey: Array.from(session.publicKey), expiresAtMs, salt: Array.from(salt), keyIndex: 0, maxUses: 1, signature: Array.from(signature), pk1, pk2, ...(link ? { linkJwt: link.jwt, linkImmediate: link.immediate } : {}) };
    const res = await api.handle(
      new Request('http://127.0.0.1/v1/login', { method: 'POST', headers: { origin: VAULT_ORIGIN, 'x-hana-parent-origin': PARTNER_ORIGIN, 'x-hana-key': pk, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    );
    return { res, key };
  }
  const derivedFor = async (r: { res: Response; key: ReturnType<typeof newAppKey> }, path: string) => {
    expect(r.res.status).toBe(200);
    const { result } = (await r.res.json()) as { result: { big_y: string; big_c: string } };
    return decryptCkd(result, r.key.a, ckdAppId(E2E_ENV.signer, path), TEST_CKD_NETWORK_KEY).length;
  };

  it('case A: an email wallet, then a Google login with its link joins it; the next Google login opens the email path', async () => {
    const api = new MockApi(new D1Shim(), chain, modules, { nearRpc });
    const { pk } = api.createApp({ origins: [PARTNER_ORIGIN] });
    const E = 'e1.caseA';
    expect(await derivedFor(await login(api, pk, (n) => emailJwt(E, n)), `e2e#email#${E}#0`)).toBe(48);
    expect(chain.opened.has(identityKeyHex('e2e', 'email', E))).toBe(true);
    const linkJwt = emailJwt(E, 'auto-link-nonce');
    expect(await derivedFor(await login(api, pk, (n) => googleJwt('g-a', n), { jwt: linkJwt, immediate: true }), `e2e#email#${E}#0`)).toBe(48);
    expect(chain.identityView('e2e', 'google', 'g-a')).toMatchObject({ status: 'member', root: { provider: 'email', sub: E } });
    expect(await derivedFor(await login(api, pk, (n) => googleJwt('g-a', n)), `e2e#email#${E}#0`)).toBe(48);
  });

  it('case B pending: the email identity is a pending member (409 link_pending at its login) until its link is cancelled', async () => {
    const api = new MockApi(new D1Shim(), chain, modules, { nearRpc });
    const { pk } = api.createApp({ origins: [PARTNER_ORIGIN] });
    const E = 'e1.caseB';
    await derivedFor(await login(api, pk, (n) => googleJwt('g-b', n)), 'e2e#google#g-b#0');
    expect(await derivedFor(await login(api, pk, (n) => googleJwt('g-b', n), { jwt: emailJwt(E, 'x'), immediate: false }), 'e2e#google#g-b#0')).toBe(48);
    expect(chain.identityView('e2e', 'email', E)).toMatchObject({ status: 'pending' });
    expect((await login(api, pk, (n) => emailJwt(E, n))).res.status).toBe(409);
    const memberKey = identityKeyHex('e2e', 'email', E);
    const epoch = (chain.accountView('e2e', 'google', 'g-b') as { epoch: number }).epoch;
    const cancel = await api.handle(
      new Request('http://127.0.0.1/v1/link/cancel', {
        method: 'POST',
        headers: { origin: VAULT_ORIGIN, 'x-hana-parent-origin': PARTNER_ORIGIN, 'x-hana-key': pk, 'content-type': 'application/json' },
        body: JSON.stringify({ jwt: googleJwt('g-b', 'n'), memberKey, epoch, salt: Array.from(randomBytes(32)) }),
      }),
    );
    expect(cancel.status).toBe(200);
    expect(chain.identityView('e2e', 'email', E)).toMatchObject({ status: 'own' });
  });

  it('a linked login whose session signature isn’t over the linked payload is refused', async () => {
    const api = new MockApi(new D1Shim(), chain, modules, { nearRpc });
    const { pk } = api.createApp({ origins: [PARTNER_ORIGIN] });
    const session = await newSessionKey();
    const salt = randomBytes(32);
    const expiresAtMs = Date.now() + 3_600_000;
    const nonce = sessionNonce({ signer: E2E_ENV.signer, scopeId: 'e2e', sessionPublicKey: session.publicKey, expiresAtMs, keyIndex: 0, maxUses: 1, salt });
    const key = newAppKey();
    const { pk1, pk2 } = key.publicKey.AppPublicKeyPV;
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, session.keyPair.privateKey, sessionMessage(1, new TextEncoder().encode(`hana-id-ckd-v1:${pk1}:${pk2}`))));
    const body = { jwt: googleJwt('g-c', nonce), sessionPublicKey: Array.from(session.publicKey), expiresAtMs, salt: Array.from(salt), keyIndex: 0, maxUses: 1, signature: Array.from(signature), pk1, pk2, linkJwt: emailJwt('e1.c', 'x'), linkImmediate: true };
    const res = await api.handle(
      new Request('http://127.0.0.1/v1/login', { method: 'POST', headers: { origin: VAULT_ORIGIN, 'x-hana-parent-origin': PARTNER_ORIGIN, 'x-hana-key': pk, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    );
    expect(res.status).toBe(401);
  });
});
