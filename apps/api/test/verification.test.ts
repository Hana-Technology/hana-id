// Batch A.2 checks made before relaying: ID-token verification (RS256 against Google's JWKS) and the session nonce,
// Ed25519 session signatures, shared vs own client scope checks, and GET /v1/app.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64UrlDecode, base64UrlEncode, hex } from '../src/bytes.ts';
import { clearViewCaches } from '../src/views.ts';
import { ckdPayload, revokePayload, sessionMessage, sessionNonce } from '../src/session-crypto.ts';
import { makeJwt, rsaSigner } from './near-mock.ts';
import { DERIVE_KEY, ORIGIN, appHeaders, bytes, call, chain, deriveBody, google, newSessionKey, revokeBody, seedApp, seedPlan, sessionBody, sessionKeyPair, uid } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const newAud = (): string => `${uid()}.apps.googleusercontent.com`;
const at = (ms: number): void => {
  vi.spyOn(Date, 'now').mockReturnValue(ms);
};

describe('byte layouts (vectors from an independent Node implementation)', () => {
  it('session nonce = b64url(sha256("hana-id/session/v1" ‖ borsh(signer) ‖ borsh(scope) ‖ spk ‖ exp ‖ key_index ‖ max_uses ‖ salt))', async () => {
    const nonce = await sessionNonce({
      signer: 'signer.test.near',
      scopeId: 's1',
      sessionPublicKey: Array.from({ length: 32 }, (_, i) => i),
      expiresAtMs: 1800003600000,
      keyIndex: 3,
      maxUses: 10,
      salt: Array(16).fill(9),
    });
    expect(nonce).toBe('w5v4OJIpEsPF4BxywjxEHRrQVQ4KPBckUllPsljZXBU');
  });

  it('session message = "hana-id-session-v1:" ‖ counter u64 LE ‖ sha256(payload), for revoke and CKD payloads', async () => {
    expect(hex(await sessionMessage(2, revokePayload()))).toBe(
      '68616e612d69642d73657373696f6e2d76313a0200000000000000777ac4ea0a6e6f4d1301fd1cf8aa9183f44f435be43c75a6615ba307c266e5a7',
    );
    expect(hex(await sessionMessage(1, ckdPayload('bls12381g1:abc', 'bls12381g2:def')))).toBe(
      '68616e612d69642d73657373696f6e2d76313a0100000000000000d31965637cb24bdcac493acee556c9d4350b00564d7a078bfa1d587c1d93cef9',
    );
  });
});

describe('base64url decoding matches the contract (canonical, no padding)', () => {
  it('round-trips and rejects non-canonical encodings atob would accept', () => {
    for (let n = 0; n < 40; n++) {
      const b = new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37 + n) % 256));
      expect([...base64UrlDecode(base64UrlEncode(b))]).toEqual([...b]);
    }
    expect([...base64UrlDecode('QQ')]).toEqual([65]);
    expect([...base64UrlDecode('QUI')]).toEqual([65, 66]);
    // Same bytes as above with non-zero unused bits: atob('QR==') is 'A', the contract panics "Malformed base64url".
    for (const bad of ['QR', 'QX', 'QUJ', 'QUL', 'Q', 'QUJDR', 'QQ==', 'Q+Q', 'Q/Q']) expect(() => base64UrlDecode(bad), bad).toThrow();
  });
});

describe('POST /v1/sessions: ID token verification', () => {
  async function setup() {
    const app = await seedApp();
    const aud = newAud();
    const near = chain({ [aud]: app.scope });
    const post = (b: Record<string, unknown>): Promise<Response> => call('/v1/sessions', { headers: appHeaders(app), body: b });
    return { app, aud, near, post };
  }

  async function expectRejected(res: Response, status: number, code: string): Promise<void> {
    const b = await body(res);
    expect([res.status, b.code], JSON.stringify(b)).toEqual([status, code]);
  }

  it('rejects a bad signature, an unsigned token and alg none', async () => {
    const { app, aud, near, post } = await setup();
    const impostor = await rsaSigner(google.jwk.kid);
    await expectRejected(await post(await sessionBody(app.scope, aud, {}, {}, impostor)), 401, 'invalid_token');
    const valid = await sessionBody(app.scope, aud);
    const [h, p] = (valid.jwt as string).split('.');
    await expectRejected(await post({ ...valid, jwt: `${h}.${p}.${btoa('nope').replace(/=+$/u, '')}` }), 401, 'invalid_token');
    // Payload swapped under a genuine signature.
    const other = await sessionBody(app.scope, aud, {}, { sub: 'mallory' });
    await expectRejected(await post({ ...valid, jwt: `${h}.${(other.jwt as string).split('.')[1]}.${(valid.jwt as string).split('.')[2]}` }), 401, 'invalid_token');
    await expectRejected(await post({ ...valid, jwt: makeJwt({ iss: 'https://accounts.google.com', aud, sub: '1', nonce: 'n', exp: 9999999999 }) }), 401, 'invalid_token');
    const none = `${btoa(JSON.stringify({ alg: 'none', kid: google.jwk.kid })).replace(/=+$/u, '')}.${p}.${btoa('x').replace(/=+$/u, '')}`;
    await expectRejected(await post({ ...valid, jwt: none }), 401, 'invalid_token');
    expect(near.sent).toHaveLength(0);
    expect(near.viewCalls).toHaveLength(0);
  });

  it('refetches the JWKS once for an unknown kid (at most once a minute)', async () => {
    const { app, aud, near, post } = await setup();
    const t0 = Date.now();
    at(t0);
    expect((await post(await sessionBody(app.scope, aud))).status).toBe(200);
    expect(near.jwksFetches).toBe(1);
    // Google rotates in a new key.
    const rotated = await rsaSigner('rotated-kid');
    near.jwks = { keys: [google.jwk, rotated.jwk] };
    near.activeKids.add(rotated.jwk.kid);
    // Just after a fetch: no refetch, the unknown kid is rejected.
    at(t0 + 30_000);
    await expectRejected(await post(await sessionBody(app.scope, aud, {}, {}, rotated)), 401, 'invalid_token');
    expect(near.jwksFetches).toBe(1);
    // Later: one refetch finds it.
    at(t0 + 61_000);
    expect((await post(await sessionBody(app.scope, aud, {}, {}, rotated))).status).toBe(200);
    expect(near.jwksFetches).toBe(2);
    // A kid Google doesn't publish: one refetch at most, then rejected.
    const stranger = await rsaSigner('stranger-kid');
    at(t0 + 200_000);
    await expectRejected(await post(await sessionBody(app.scope, aud, {}, {}, stranger)), 401, 'invalid_token');
    await expectRejected(await post(await sessionBody(app.scope, aud, {}, {}, stranger)), 401, 'invalid_token');
    expect(near.jwksFetches).toBe(3);
  });

  it('caches the JWKS per its Cache-Control max-age', async () => {
    const { app, aud, near, post } = await setup();
    near.jwksCacheControl = 'public, max-age=600, must-revalidate, no-transform';
    const t0 = Date.now();
    at(t0);
    expect((await post(await sessionBody(app.scope, aud))).status).toBe(200);
    at(t0 + 540_000);
    expect((await post(await sessionBody(app.scope, aud))).status).toBe(200);
    expect(near.jwksFetches).toBe(1);
    at(t0 + 660_000);
    expect((await post(await sessionBody(app.scope, aud))).status).toBe(200);
    expect(near.jwksFetches).toBe(2);
  });

  it('rejects a signature with non-canonical base64url (the contract would panic on it)', async () => {
    const { app, aud, near, post } = await setup();
    const valid = await sessionBody(app.scope, aud);
    const [h, p, sig] = (valid.jwt as string).split('.') as [string, string, string];
    // A 256-byte RS256 signature is 342 chars: its last char carries 4 unused bits, which atob ignores.
    expect(sig.length % 4).toBe(2);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(sig.at(-1)!);
    for (const bits of [1, 2, 4, 8, 15]) {
      const variant = `${h}.${p}.${sig.slice(0, -1)}${alphabet[last | bits]}`;
      await expectRejected(await post({ ...valid, jwt: variant }), 401, 'invalid_token');
    }
    expect(near.sent).toHaveLength(0);
    expect((await post(valid)).status).toBe(200);
  });

  it('keeps serving cached keys while the JWKS refetch fails (bounded grace), throttling failed fetches', async () => {
    const { app, aud, near, post } = await setup();
    near.jwksCacheControl = 'public, max-age=600';
    const t0 = Date.now();
    at(t0);
    expect((await post(await sessionBody(app.scope, aud))).status).toBe(200);
    expect(near.jwksFetches).toBe(1);
    // The set expired and Google's endpoint fails: the cached kid still verifies (the contract has it on chain too),
    // and the stale serve is logged.
    near.jwksStatus = 500;
    at(t0 + 700_000);
    const warn = vi.spyOn(console, 'warn');
    expect((await post(await sessionBody(app.scope, aud))).status).toBe(200);
    expect(near.jwksFetches).toBe(2);
    expect(warn.mock.calls.filter(([line]) => String(line).includes('"event":"jwks_stale"'))).toHaveLength(1);
    // Forged tokens with unknown kids can't make every request fetch again: the failed attempt counts.
    const stranger = await rsaSigner('stranger-kid');
    for (let i = 0; i < 3; i++) await expectRejected(await post(await sessionBody(app.scope, aud, {}, {}, stranger)), 401, 'invalid_token');
    expect(near.jwksFetches).toBe(2);
    // The stale set is retried at most every 10 s...
    at(t0 + 705_000);
    expect((await post(await sessionBody(app.scope, aud))).status).toBe(200);
    expect(near.jwksFetches).toBe(2);
    at(t0 + 711_000);
    expect((await post(await sessionBody(app.scope, aud))).status).toBe(200);
    expect(near.jwksFetches).toBe(3);
    // ...and used for at most 6 h past its max-age: then fail closed.
    at(t0 + 600_000 + 6 * 3_600_000 + 1_000);
    await expectRejected(await post(await sessionBody(app.scope, aud)), 503, 'issuer_keys_unavailable');
    // Once Google answers again, logins resume.
    near.jwksStatus = 200;
    at(t0 + 600_000 + 6 * 3_600_000 + 12_000);
    expect((await post(await sessionBody(app.scope, aud))).status).toBe(200);
  });

  it('a cold isolate whose JWKS fetch fails retries at most every 10 s', async () => {
    const { app, aud, near, post } = await setup();
    near.jwksStatus = 500;
    const t0 = Date.now();
    at(t0);
    await expectRejected(await post(await sessionBody(app.scope, aud)), 503, 'issuer_keys_unavailable');
    await expectRejected(await post(await sessionBody(app.scope, aud)), 503, 'issuer_keys_unavailable');
    expect(near.jwksFetches).toBe(1);
    near.jwksStatus = 200;
    at(t0 + 11_000);
    expect((await post(await sessionBody(app.scope, aud))).status).toBe(200);
    expect(near.jwksFetches).toBe(2);
    expect(near.sent).toHaveLength(1);
  });

  it('rejects a replayed request whose session key is already in use (409, not relayed)', async () => {
    const { app, aud, near, post } = await setup();
    const b = await sessionBody(app.scope, aud);
    expect((await post(b)).status).toBe(200);
    await expectRejected(await post(b), 409, 'session_exists');
    // Also when this isolate didn't create it: read from chain.
    clearViewCaches();
    await expectRejected(await post(b), 409, 'session_exists');
    expect(near.sent).toHaveLength(1);
    // An expired session no longer holds its key (the contract allows reuse).
    const spk = newSessionKey();
    near.sessions.set(JSON.stringify(spk), { path: `${app.scope}#google#1#0`, scope_id: app.scope, expires_at_ms: Date.now() - 1, max_uses: 10, used: 0 });
    expect((await post(await sessionBody(app.scope, aud, { sessionPublicKey: spk }))).status).toBe(200);
    expect(near.sent).toHaveLength(2);
  });

  it('rejects a replay after the session was revoked, until it expires (409, not relayed)', async () => {
    const { app, aud, near, post } = await setup();
    const b = await sessionBody(app.scope, aud);
    expect((await post(b)).status).toBe(200);
    const spk = b.sessionPublicKey as number[];
    expect((await call('/v1/sessions/revoke', { headers: appHeaders(app), body: await revokeBody(spk, { counter: 1 }) })).status).toBe(200);
    // get_session now hides the session, but the key still blocks create_session on chain.
    clearViewCaches();
    await expectRejected(await post(b), 409, 'session_exists');
    expect(near.sent.map((t) => t.method)).toEqual(['create_session', 'revoke_session']);
  });

  it('fails closed (503) when the JWKS cannot be fetched', async () => {
    const { app, aud, near, post } = await setup();
    near.jwksStatus = 500;
    await expectRejected(await post(await sessionBody(app.scope, aud)), 503, 'issuer_keys_unavailable');
    expect(near.sent).toHaveLength(0);
  });

  it('rejects expired tokens, with 60 s of clock skew', async () => {
    const { app, aud, near, post } = await setup();
    const now = Math.floor(Date.now() / 1000);
    expect((await post(await sessionBody(app.scope, aud, {}, { exp: now - 30 }))).status).toBe(200);
    await expectRejected(await post(await sessionBody(app.scope, aud, {}, { exp: now - 90 })), 400, 'token_expired');
    expect(near.sent).toHaveLength(1);
  });

  it('rejects unknown issuers and audiences that are neither the app’s client nor shared', async () => {
    const { app, aud, near, post } = await setup();
    await expectRejected(await post(await sessionBody(app.scope, aud, {}, { iss: 'https://evil.example' })), 400, 'unsupported_issuer');
    await expectRejected(await post(await sessionBody(app.scope, newAud())), 403, 'unregistered_client');
    near.clients['other-app.apps.googleusercontent.com'] = 'sother';
    await expectRejected(await post(await sessionBody(app.scope, 'other-app.apps.googleusercontent.com')), 403, 'scope_mismatch');
    expect(near.sent).toHaveLength(0);
  });

  it('rejects a token whose nonce does not commit to this session, app scope and signer', async () => {
    const { app, aud, near, post } = await setup();
    await expectRejected(await post(await sessionBody(app.scope, aud, {}, { nonce: 'abc' })), 400, 'nonce_mismatch');
    await expectRejected(await post(await sessionBody(app.scope, aud, {}, { nonce: undefined })), 400, 'nonce_mismatch');
    // Each committed field changed after the token was issued.
    for (const change of [{ maxUses: 11 }, { keyIndex: 1 }, { expiresAtMs: Date.now() + 2 * 3600_000 }, { salt: bytes(16, 4) }, { sessionPublicKey: newSessionKey() }]) {
      const b = await sessionBody(app.scope, aud);
      await expectRejected(await post({ ...b, ...change }), 400, 'nonce_mismatch');
    }
    // A nonce for another scope (e.g. computed by another app's page) or another deployment.
    const b = await sessionBody(app.scope, aud);
    const fields = { sessionPublicKey: b.sessionPublicKey as number[], expiresAtMs: b.expiresAtMs as number, keyIndex: 0, maxUses: 10, salt: b.salt as number[] };
    for (const [signer, scopeId] of [[env.SIGNER_ACCOUNT, 'sother'], ['other-signer.test.near', app.scope]] as const) {
      const nonce = await sessionNonce({ signer, scopeId, ...fields });
      const forged = await sessionBody(app.scope, aud, fields, { nonce });
      await expectRejected(await post(forged), 400, 'nonce_mismatch');
    }
    expect(near.sent).toHaveLength(0);
  });
});

describe('POST /v1/sessions: shared vs own client', () => {
  const SHARED = 'hana-shared.apps.googleusercontent.com';

  it('a shared client logs in to a scope that allows shared login, with the app’s scope_id', async () => {
    const app = await seedApp();
    const near = chain({}, { shared: [SHARED], allowShared: [app.scope] });
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, SHARED, { keyIndex: 2 }) });
    expect(res.status).toBe(200);
    expect((await body(res)).result).toMatchObject({ scope_id: app.scope, path: `${app.scope}#google#1234567890#2` });
    expect(near.sent).toHaveLength(1);
    expect(near.sent[0]!.args.scope_id).toBe(app.scope);
    // session_key_in_use and the governance reads (get_config, shared with the scope check, and get_issuer) run
    // alongside the scope checks; get_config and get_scope follow scope_for_client's miss.
    const views = near.viewCalls.map((v) => v.method);
    expect([...views].sort()).toEqual(['get_config', 'get_issuer', 'get_scope', 'scope_for_client', 'session_key_in_use']);
    expect(views.indexOf('get_config')).toBeGreaterThan(views.indexOf('scope_for_client'));
    expect(views.indexOf('get_scope')).toBeGreaterThan(views.indexOf('get_config'));
    // Concurrent: the session-key read does not wait for the scope reads.
    expect(views.indexOf('session_key_in_use')).toBeLessThan(views.indexOf('get_config'));
  });

  it('rejects a shared client for a scope without allow_shared, or a scope that is not on chain', async () => {
    const app = await seedApp();
    const near = chain({}, { shared: [SHARED] });
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, SHARED) });
    expect([res.status, (await body(res)).code]).toEqual([403, 'shared_login_disabled']);
    const ghost = await seedApp();
    near.missingScopes.add(ghost.scope);
    const res2 = await call('/v1/sessions', { headers: appHeaders(ghost), body: await sessionBody(ghost.scope, SHARED) });
    expect([res2.status, (await body(res2)).code]).toEqual([403, 'unknown_scope']);
    expect(near.sent).toHaveLength(0);
  });

  it('an own client must map to the app’s scope even when the scope also allows shared login', async () => {
    const app = await seedApp();
    const aud = newAud();
    const near = chain({ [aud]: 'sother' }, { shared: [SHARED], allowShared: [app.scope] });
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) });
    expect([res.status, (await body(res)).code]).toEqual([403, 'scope_mismatch']);
    expect(near.sent).toHaveLength(0);
  });

  it('a pending shared client counts only once its timelock has passed', async () => {
    const app = await seedApp();
    const near = chain({}, { allowShared: [app.scope] });
    near.pendingShared = [{ provider: 'google', aud: SHARED, effective_at_ms: Date.now() + 3_600_000 }];
    const locked = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, SHARED) });
    expect([locked.status, (await body(locked)).code]).toEqual([403, 'unregistered_client']);
    // Unlocked but not yet applied (get_config may still list it as pending): it is in force.
    near.pendingShared = [{ provider: 'google', aud: SHARED, effective_at_ms: Date.now() - 1 }];
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000); // past the get_config cache
    near.contract.create_session = (a) => ({ path: `${a.scope_id as string}#google#1#0`, scope_id: a.scope_id, expires_at_ms: a.expires_at_ms, max_uses: a.max_uses, used: 0 });
    const unlocked = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, SHARED) });
    expect(unlocked.status).toBe(200);
  });
});

describe('POST /v1/derive and /v1/sessions/revoke: Ed25519 session signature pre-check', () => {
  async function setup() {
    const app = await seedApp();
    const near = chain({});
    const spk = newSessionKey();
    near.sessions.set(JSON.stringify(spk), { path: `${app.scope}#google#1#0`, scope_id: app.scope, expires_at_ms: Date.now() + 3_600_000, max_uses: 10, used: 0 });
    return { app, near, spk };
  }

  it('relays correctly signed requests', async () => {
    const { app, near, spk } = await setup();
    expect((await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk) })).status).toBe(200);
    expect((await call('/v1/sessions/revoke', { headers: appHeaders(app), body: await revokeBody(spk) })).status).toBe(200);
    expect(near.sent.map((t) => t.method)).toEqual(['derive_key', 'revoke_session']);
  });

  it('rejects bad signatures before reading the session or relaying', async () => {
    const { app, near, spk } = await setup();
    const otherKey = newSessionKey();
    const legacy = async (counter: number, payload: Uint8Array): Promise<number[]> => {
      // The batch A domain string ("hana-embed-session-v1:") is no longer accepted.
      const m = new Uint8Array([...new TextEncoder().encode('hana-embed-session-v1:'), ...(await sessionMessage(counter, payload)).slice(19)]);
      return [...sessionKeyPair(spk).sign(m).signature];
    };
    const derives = [
      await deriveBody(spk, { signature: (await deriveBody(otherKey)).signature }), // another key
      { ...(await deriveBody(spk)), counter: 2 }, // signed for counter 1
      { ...(await deriveBody(spk)), pk1: 'bls12381g1:other' }, // signed for other BLS keys
      await deriveBody(spk, { signature: bytes(64, 9) }),
      await deriveBody(spk, { signature: await legacy(1, ckdPayload(DERIVE_KEY.pk1, DERIVE_KEY.pk2)) }),
    ];
    for (const b of derives) {
      const res = await call('/v1/derive', { headers: appHeaders(app), body: b });
      expect([res.status, (await body(res)).code]).toEqual([401, 'invalid_signature']);
    }
    const revokes = [
      await revokeBody(spk, { signature: (await deriveBody(spk, { counter: 2 })).signature }), // CKD payload, not "revoke"
      { ...(await revokeBody(spk)), counter: 3 },
      await revokeBody(spk, { signature: (await revokeBody(otherKey)).signature }),
      await revokeBody(spk, { signature: await legacy(2, revokePayload()) }),
    ];
    for (const b of revokes) {
      const res = await call('/v1/sessions/revoke', { headers: appHeaders(app), body: b });
      expect([res.status, (await body(res)).code]).toEqual([401, 'invalid_signature']);
    }
    expect(near.viewCalls).toHaveLength(0);
    expect(near.sent).toHaveLength(0);
  });
});

describe('GET /v1/app', () => {
  const SHARED = ['hana-shared-1.apps.googleusercontent.com', 'hana-shared-2.apps.googleusercontent.com'];
  const get = (app: { key: string }, origin = ORIGIN, ip?: string): Promise<Response> =>
    call('/v1/app', { method: 'GET', headers: { ...appHeaders(app, origin), ...(ip ? { 'cf-connecting-ip': ip } : {}) } });

  it('own mode: the scope’s first Google client', async () => {
    const app = await seedApp();
    const aud = newAud();
    const near = chain({ [aud]: app.scope, [newAud()]: app.scope }, { shared: SHARED, allowShared: [app.scope] });
    near.views.get_scope = (a) => ({ id: a.scope_id, owners: [], clients: [['other', 'x'], ['google', aud], ['google', 'second']], pending: [], action_nonce: 0, allow_shared: true });
    const res = await get(app);
    const b = await body(res);
    expect(res.status).toBe(200);
    expect(b).toMatchObject({ scopeId: app.scope, signer: env.SIGNER_ACCOUNT, google: { clientId: aud, mode: 'own' } });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    expect(near.sent).toHaveLength(0);
  });

  it('shared mode: the first shared client in force when the scope allows shared login', async () => {
    const app = await seedApp();
    const near = chain({}, { shared: SHARED, allowShared: [app.scope] });
    expect(await body(await get(app))).toMatchObject({ scopeId: app.scope, google: { clientId: SHARED[0], mode: 'shared' } });
    // Only a pending addition whose timelock has passed counts.
    const app2 = await seedApp();
    near.allowShared.add(app2.scope);
    near.shared.length = 0;
    near.pendingShared = [
      { provider: 'google', aud: 'later', effective_at_ms: Date.now() + 3_600_000 },
      { provider: 'google', aud: 'ready', effective_at_ms: Date.now() - 1 },
    ];
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    expect(await body(await get(app2))).toMatchObject({ google: { clientId: 'ready', mode: 'shared' } });
  });

  it('409 when the scope has no Google client and no usable shared login, or is not on chain', async () => {
    const app = await seedApp();
    const near = chain({}, { shared: SHARED });
    const noShared = await get(app);
    expect([noShared.status, (await body(noShared)).code]).toEqual([409, 'no_google_client']);
    const app2 = await seedApp();
    near.allowShared.add(app2.scope);
    near.shared.length = 0;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    const none = await get(app2);
    expect([none.status, (await body(none)).code]).toEqual([409, 'no_google_client']);
    const ghost = await seedApp();
    near.missingScopes.add(ghost.scope);
    const missing = await get(ghost);
    expect([missing.status, (await body(missing)).code]).toEqual([409, 'scope_not_registered']);
  });

  it('requires a known, active app and an allowed Origin', async () => {
    chain({});
    const res = await call('/v1/app', { method: 'GET', headers: { origin: ORIGIN } });
    expect([res.status, (await body(res)).code]).toEqual([401, 'missing_key']);
    const app = await seedApp();
    const bad = await get(app, 'https://evil.example');
    expect([bad.status, (await body(bad)).code]).toEqual([403, 'origin_not_allowed']);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    const suspended = await seedApp({ status: 'suspended' });
    expect((await body(await get(suspended))).code).toBe('app_suspended');
  });

  it('is limited per IP but never uses the app’s relay quota', async () => {
    const plan = `p${uid()}`;
    await seedPlan(plan, 1, 1000, 2);
    const app = await seedApp({ plan });
    const aud = newAud();
    chain({ [aud]: app.scope });
    const ip = `192.0.2.${Math.floor(Math.random() * 250)}`;
    expect([(await get(app, ORIGIN, ip)).status, (await get(app, ORIGIN, ip)).status, (await get(app, ORIGIN, ip)).status]).toEqual([200, 200, 429]);
    // The app's per-minute relay quota (1) is untouched.
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) })).status).toBe(200);
  });

  it('routing: preflight, 405, 502 when the registry cannot be read', async () => {
    const origin = `https://${uid()}.example.com`;
    const app = await seedApp({ origins: [origin] });
    const pre = await call('/v1/app', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-hana-key' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toContain('GET');
    expect((await call('/v1/app', { headers: appHeaders(app, origin), body: {} })).status).toBe(405);
    const near = chain({});
    delete near.views.get_scope;
    const res = await get(app, origin);
    expect([res.status, (await body(res)).code]).toEqual([502, 'near_unavailable']);
  });
});

describe('scope_for_client cache and owner actions', () => {
  it('an executed AddClient makes the new client usable right away in this isolate (cached miss dropped)', async () => {
    const app = await seedApp();
    const aud = newAud();
    const near = chain({});
    const login = async (): Promise<Response> => call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) });
    const early = await login();
    expect([early.status, (await body(early)).code]).toEqual([403, 'unregistered_client']);
    near.views.get_scope = (a) => ({
      id: a.scope_id,
      owners: [],
      clients: Object.entries(near.clients).filter(([, sc]) => sc === a.scope_id).map(([x]) => ['google', x]),
      pending: [{ id: 1, change: { AddClient: { provider: 'google', aud } }, unlock_at_ms: 0 }],
      action_nonce: 0,
      allow_shared: false,
    });
    near.contract.execute_change = () => {
      near.clients[aud] = app.scope;
      return null;
    };
    const exec = await call('/v1/owner-actions', { body: { method: 'execute_change', args: { scope_id: app.scope, change_id: 1 } } });
    expect(exec.status).toBe(200);
    expect(await body(await call('/v1/app', { method: 'GET', headers: appHeaders(app) }))).toMatchObject({ google: { clientId: aud, mode: 'own' } });
    expect((await login()).status).toBe(200);
  });
});
