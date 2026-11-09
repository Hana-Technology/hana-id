// Hana Home's identity verifier and GET /v1/home/config (docs/hana-home-spec.md "Tests", H1 of the build plan): every
// identity refusal in the spec's list, the header vectors from Node, the free-plan bounds, and that nothing of the
// credential reaches a log line or an error body.
import { homeMessage, homeNonce, encodeHomeIdentity, HOME_EMAIL_AUDIENCE } from '@hana-id/core/home';
import { env } from 'cloudflare:workers';
import { KeyPair } from '@near-js/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hex } from '../src/bytes.ts';
import { HOME_CONFIG_ENDPOINT, HOME_CONFIG_PER_IP_MINUTE } from '../src/home/config.ts';
import { homeGate, homeAudienceRoute, type HomeGate } from '../src/home/identity.ts';
import { newCtx } from '../src/handlers.ts';
import { log } from '../src/log.ts';
import { sessionNonce } from '../src/session-crypto.ts';
import { clearViewCaches, type ConfigView } from '../src/views.ts';
import vectors from '../../../packages/core/test/vectors/home-v1.json';
import { emailEnv, emailToken, withEmail } from './email-helpers.ts';
import { GOOGLE_ISS, appHeaders, call, chain, google, newSessionKey, seedApp, sessionBody, uid, type Chain } from './helpers.ts';

const AUTH = env.AUTH_ORIGIN!;
const SHARED = 'shared-client.apps.googleusercontent.com';
const SUB = '110248495921238986420';
const PATH = '/v1/home/apps';

/** A Home key and the header-building for it. */
function homeKey() {
  const kp = KeyPair.fromRandom('ed25519');
  return { kp, pub: Uint8Array.from(kp.getPublicKey().data) };
}

interface IdentityOpts {
  aud?: string;
  sub?: string;
  claims?: Record<string, unknown>;
  expiresAtMs?: number;
  salt?: Uint8Array;
  /** Sign the nonce for this key instead of the one the header carries. */
  nonceKey?: Uint8Array;
  nonce?: string;
  /** The token signer: a different key than the JWKS serves refuses it. */
  signer?: typeof google;
  /** Overrides the token entirely (e.g. an email token, or a session-nonce token). */
  jwt?: string;
  /** The issuer-token's override. */
  key?: ReturnType<typeof homeKey>;
}

/** Everything a page holds for a Home identity: the token, and a signer for individual requests. */
async function newIdentity(o: IdentityOpts = {}) {
  const key = o.key ?? homeKey();
  const expiresAtMs = o.expiresAtMs ?? Date.now() + 15 * 60_000;
  const salt = o.salt ?? crypto.getRandomValues(new Uint8Array(32));
  const nonce = o.nonce ?? homeNonce({ signer: env.SIGNER_ACCOUNT, homePublicKey: o.nonceKey ?? key.pub, expiresAtMs, salt });
  const jwt =
    o.jwt ??
    (await (o.signer ?? google).sign({
      iss: GOOGLE_ISS,
      aud: o.aud ?? SHARED,
      sub: o.sub ?? SUB,
      nonce,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...o.claims,
    }));
  const headerFor = (counter: number, method = 'GET', path = PATH, body: Uint8Array = new Uint8Array(0)): string => {
    const msg = homeMessage({ signer: env.SIGNER_ACCOUNT, counter, method, path, body });
    return encodeHomeIdentity({ jwt, key: key.pub, expiresAtMs, salt, counter, sig: Uint8Array.from(key.kp.sign(msg).signature) });
  };
  return { key, jwt, nonce, expiresAtMs, salt, headerFor };
}

const OPTS = { ipPerMinute: 30, keyPerMinute: 60, window: 'apps' };

function makeRequest(header: string | null, init: { origin?: string | null; method?: string; path?: string; body?: Uint8Array; ip?: string } = {}): Request {
  const headers = new Headers({ 'cf-connecting-ip': init.ip ?? `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  const origin = init.origin === undefined ? AUTH : init.origin;
  if (origin !== null) headers.set('origin', origin);
  if (header !== null) headers.set('x-hana-home', header);
  const method = init.method ?? 'GET';
  return new Request(`https://api.test${init.path ?? PATH}`, { method, headers, ...(init.body ? { body: init.body as unknown as BodyInit } : {}) });
}

async function gate(req: Request, envOverride: Partial<typeof env> = {}, opts = OPTS, now?: number): Promise<HomeGate> {
  const e = { ...env, ...envOverride };
  return homeGate(req, e, newCtx(e, `req-${uid()}`, PATH, req), opts, now);
}

const refusal = async (g: HomeGate): Promise<{ status: number; code: string; body: Record<string, unknown> }> => {
  if (g.ok) throw new Error('expected a refusal');
  const body = (await g.response.clone().json()) as Record<string, unknown>;
  return { status: g.response.status, code: body.code as string, body };
};

let near: Chain;

beforeEach(() => {
  clearViewCaches();
  near = chain({}, { shared: [SHARED] });
  near.install();
});
afterEach(() => vi.restoreAllMocks());

describe('Home identity: what it accepts', () => {
  it('a valid Google token from the shared client, with the Home nonce, key, signature and a fresh counter', async () => {
    const id = await newIdentity();
    const g = await gate(makeRequest(id.headerFor(1)));
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.identity).toMatchObject({ provider: 'google', sub: SUB, route: 'shared', expiresAtMs: id.expiresAtMs });
    expect(g.identity.keyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(g.body).toHaveLength(0);
  });

  it('a valid email token with the issuer’s Home audience (H10’s route; needs the email issuer’s keys)', async () => {
    withEmail(near, []);
    const key = homeKey();
    const expiresAtMs = Date.now() + 15 * 60_000;
    const salt = new Uint8Array(32).fill(5);
    const nonce = homeNonce({ signer: env.SIGNER_ACCOUNT, homePublicKey: key.pub, expiresAtMs, salt });
    const jwt = await emailToken({ aud: HOME_EMAIL_AUDIENCE, sub: 'e1.abc', nonce });
    const id = await newIdentity({ jwt, key, expiresAtMs, salt });
    const g = await gate(makeRequest(id.headerFor(1)), emailEnv());
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.identity).toMatchObject({ provider: 'email', sub: 'e1.abc', route: 'email' });
  });

  it('a pending shared client that has matured since the cached read counts as in force', async () => {
    near.shared = [];
    near.pendingShared = [{ provider: 'google', aud: SHARED, effective_at_ms: Date.now() - 1 }];
    const id = await newIdentity();
    expect((await gate(makeRequest(id.headerFor(1)))).ok).toBe(true);
  });

  it('a POST’s body comes back with the identity, and is signed over', async () => {
    const id = await newIdentity();
    const body = new TextEncoder().encode('{"consentId":"x"}');
    const g = await gate(makeRequest(id.headerFor(1, 'POST', PATH, body), { method: 'POST', body }));
    expect(g.ok).toBe(true);
    if (g.ok) expect([...g.body]).toEqual([...body]);
  });

  it('agrees with the Node vector’s message: same bytes, so a browser and the API can’t disagree', async () => {
    const m = homeMessage({ signer: vectors.signer, counter: 3, method: 'POST', path: '/v1/home/consents/revoke', body: new TextEncoder().encode('{"consentId":"wMHCw8TFxsfIycrLzM3Ozw"}') });
    expect(hex(m)).toBe(vectors.messages.post.preimage_hex);
    const n = homeNonce({
      signer: vectors.nonces.basic.input.signer,
      homePublicKey: Uint8Array.from(Buffer.from(vectors.nonces.basic.input.pk_hex, 'hex')),
      expiresAtMs: vectors.nonces.basic.input.expiresAtMs,
      salt: Uint8Array.from(Buffer.from(vectors.nonces.basic.input.salt_hex, 'hex')),
    });
    expect(n).toBe(vectors.nonces.basic.nonce);
  });
});

describe('Home identity: every refusal in the spec’s list', () => {
  it('a wrong Origin (and a missing one), with no CORS headers', async () => {
    const id = await newIdentity();
    for (const origin of ['https://partner.example', env.VAULT_ORIGIN!, null]) {
      const r = await refusal(await gate(makeRequest(id.headerFor(1), { origin })));
      expect(r.status).toBe(403);
      expect(r.code).toBe('origin_not_allowed');
    }
    const g = await gate(makeRequest(id.headerFor(2), { origin: 'https://partner.example' }));
    expect(g.ok ? null : g.response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('a missing header', async () => {
    const r = await refusal(await gate(makeRequest(null)));
    expect([r.status, r.code]).toEqual([401, 'missing_home_identity']);
  });

  it.each([
    ['garbage', 'a!b'],
    ['valid base64url of nothing useful', btoa('x')],
  ])('a malformed header: %s', async (_name, header) => {
    const r = await refusal(await gate(makeRequest(header)));
    expect([r.status, r.code]).toEqual([401, 'invalid_home_identity']);
  });

  it('a scope client’s token: a partner-held client can’t mint a Home identity', async () => {
    near.clients['partner-client.apps.googleusercontent.com'] = 'scope-partner';
    const id = await newIdentity({ aud: 'partner-client.apps.googleusercontent.com' });
    const r = await refusal(await gate(makeRequest(id.headerFor(1))));
    expect([r.status, r.code]).toEqual([401, 'not_a_home_client']);
  });

  it('a retired shared client', async () => {
    near.shared = [];
    const id = await newIdentity();
    const r = await refusal(await gate(makeRequest(id.headerFor(1))));
    expect(r.code).toBe('not_a_home_client');
  });

  it('a pending shared client not yet in force', async () => {
    near.shared = [];
    near.pendingShared = [{ provider: 'google', aud: SHARED, effective_at_ms: Date.now() + 86_400_000 }];
    const id = await newIdentity();
    const r = await refusal(await gate(makeRequest(id.headerFor(1))));
    expect(r.code).toBe('not_a_home_client');
  });

  it('a session-nonce token (public forever in the transaction args) can never be a Home identity', async () => {
    const key = homeKey();
    const expiresAtMs = Date.now() + 15 * 60_000;
    const salt = new Uint8Array(32).fill(4);
    const nonce = await sessionNonce({ signer: env.SIGNER_ACCOUNT, scopeId: 's1', sessionPublicKey: key.pub, expiresAtMs, keyIndex: 0, maxUses: 1, salt });
    const id = await newIdentity({ key, expiresAtMs, salt, nonce });
    const r = await refusal(await gate(makeRequest(id.headerFor(1))));
    expect([r.status, r.code]).toEqual([401, 'nonce_mismatch']);
  });

  it('a Home token can never open a session: /v1/sessions refuses its nonce and relays nothing', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    near.clients[aud] = app.scope;
    const nonce = homeNonce({ signer: env.SIGNER_ACCOUNT, homePublicKey: Uint8Array.from(newSessionKey()), expiresAtMs: Date.now() + 15 * 60_000, salt: new Uint8Array(32).fill(1) });
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud, {}, { nonce }) });
    expect(((await res.json()) as Record<string, unknown>).code).toBe('nonce_mismatch');
    expect(near.sent).toHaveLength(0);
  });

  it('a wrong key: the token’s nonce commits to another Home key', async () => {
    const other = homeKey();
    const id = await newIdentity({ nonceKey: other.pub });
    const r = await refusal(await gate(makeRequest(id.headerFor(1))));
    expect(r.code).toBe('nonce_mismatch');
  });

  it('a bad signature', async () => {
    const id = await newIdentity();
    const wrong = homeKey();
    const expiresAtMs = id.expiresAtMs;
    const msg = homeMessage({ signer: env.SIGNER_ACCOUNT, counter: 1, method: 'GET', path: PATH, body: new Uint8Array(0) });
    const header = encodeHomeIdentity({ jwt: id.jwt, key: id.key.pub, expiresAtMs, salt: id.salt, counter: 1, sig: Uint8Array.from(wrong.kp.sign(msg).signature) });
    const r = await refusal(await gate(makeRequest(header)));
    expect([r.status, r.code]).toEqual([401, 'invalid_signature']);
  });

  it('a signature for another request: method, path, query or body', async () => {
    const id = await newIdentity();
    // A valid signature, but over a GET of another path.
    const r1 = await refusal(await gate(makeRequest(id.headerFor(1, 'GET', '/v1/home/devices'))));
    expect(r1.code).toBe('invalid_signature');
    const r2 = await refusal(await gate(makeRequest(id.headerFor(2, 'GET', PATH), { path: `${PATH}?scopeId=s9` })));
    expect(r2.code).toBe('invalid_signature');
    const r3 = await refusal(await gate(makeRequest(id.headerFor(3, 'POST', PATH, new TextEncoder().encode('a')), { method: 'POST', body: new TextEncoder().encode('b') })));
    expect(r3.code).toBe('invalid_signature');
  });

  it('a reused counter, and a fresh counter still works', async () => {
    const id = await newIdentity();
    expect((await gate(makeRequest(id.headerFor(7)))).ok).toBe(true);
    const r = await refusal(await gate(makeRequest(id.headerFor(7))));
    expect([r.status, r.code]).toEqual([409, 'counter_reused']);
    expect((await gate(makeRequest(id.headerFor(8)))).ok).toBe(true);
  });

  it('counters are per Home key: another key may use the same value', async () => {
    const a = await newIdentity();
    const b = await newIdentity();
    expect((await gate(makeRequest(a.headerFor(1)))).ok).toBe(true);
    expect((await gate(makeRequest(b.headerFor(1)))).ok).toBe(true);
  });

  it('an expired expiresAtMs, and exactly now is expired (now < expiresAtMs)', async () => {
    const id = await newIdentity({ expiresAtMs: Date.now() - 1000 });
    const r = await refusal(await gate(makeRequest(id.headerFor(1))));
    expect([r.status, r.code]).toEqual([401, 'home_identity_expired']);
    const now = Date.now();
    const onEdge = await newIdentity({ expiresAtMs: now });
    expect((await refusal(await gate(makeRequest(onEdge.headerFor(1)), {}, OPTS, now))).code).toBe('home_identity_expired');
  });

  it('expiresAtMs later than now + 20 min, and exactly now + 20 min is accepted', async () => {
    const now = Date.now();
    const tooLong = await newIdentity({ expiresAtMs: now + 20 * 60_000 + 1 });
    const r = await refusal(await gate(makeRequest(tooLong.headerFor(1)), {}, OPTS, now));
    expect([r.status, r.code]).toEqual([401, 'invalid_home_identity']);
    const atLimit = await newIdentity({ expiresAtMs: now + 20 * 60_000 });
    expect((await gate(makeRequest(atLimit.headerFor(2)), {}, OPTS, now)).ok).toBe(true);
  });

  it('a PII claim (the claim allow-list applies)', async () => {
    const id = await newIdentity({ claims: { email: 'x@y.example' } });
    const r = await refusal(await gate(makeRequest(id.headerFor(1))));
    expect([r.status, r.code]).toEqual([401, 'token_has_pii']);
    expect(r.body).not.toHaveProperty('data');
  });

  it('a forged token (not signed by the JWKS key), and an expired one past the 60 s skew', async () => {
    const { rsaSigner } = await import('./near-mock.ts');
    const forged = await rsaSigner('google-test-kid');
    const id = await newIdentity({ signer: forged });
    const r = await refusal(await gate(makeRequest(id.headerFor(1))));
    expect([r.status, r.code]).toEqual([401, 'invalid_token']);
    const old = await newIdentity({ claims: { exp: Math.floor(Date.now() / 1000) - 120 } });
    const r2 = await refusal(await gate(makeRequest(old.headerFor(1))));
    expect([r2.status, r2.code]).toEqual([401, 'token_expired']);
  });

  it('an unknown issuer and a partner identity token', async () => {
    const bad = await newIdentity({ claims: { iss: 'https://evil.example' } });
    const r = await refusal(await gate(makeRequest(bad.headerFor(1))));
    expect([r.status, r.code]).toEqual([401, 'unsupported_issuer']);
    const partner = await newIdentity({ claims: { iss: env.IDENTITY_ISS } });
    const r2 = await refusal(await gate(makeRequest(partner.headerFor(1))));
    expect([r2.status, r2.code]).toEqual([401, 'bad_token']);
  });

  it('an email token for a scope’s email client: only the Home audience makes a Home identity', async () => {
    withEmail(near, ['s1']);
    const key = homeKey();
    const expiresAtMs = Date.now() + 15 * 60_000;
    const salt = new Uint8Array(32).fill(6);
    const nonce = homeNonce({ signer: env.SIGNER_ACCOUNT, homePublicKey: key.pub, expiresAtMs, salt });
    const jwt = await emailToken({ aud: 'email:s1', sub: 'e1.abc', nonce });
    const id = await newIdentity({ jwt, key, expiresAtMs, salt });
    const r = await refusal(await gate(makeRequest(id.headerFor(1)), emailEnv()));
    expect([r.status, r.code]).toEqual([401, 'not_a_home_client']);
  });

  it('an email token when the env has no email issuer: refused, never a crash', async () => {
    const jwt = await emailToken({ aud: HOME_EMAIL_AUDIENCE, nonce: 'x' });
    const id = await newIdentity({ jwt });
    const r = await refusal(await gate(makeRequest(id.headerFor(1))));
    expect([r.status, r.code]).toEqual([401, 'unsupported_issuer']);
  });

  it('an unreadable JWKS is 503 and a NEAR failure 502: outages stay retryable, not sign-in-again', async () => {
    const id = await newIdentity();
    near.jwksStatus = 503;
    const { clearJwksCache } = await import('@hana-id/oidc');
    clearJwksCache();
    const r = await refusal(await gate(makeRequest(id.headerFor(1))));
    expect([r.status, r.code]).toEqual([503, 'issuer_keys_unavailable']);
    near.jwksStatus = 200;
    clearJwksCache();
    clearViewCaches();
    near.views.get_config = () => {
      throw new Error('rpc down');
    };
    const r2 = await refusal(await gate(makeRequest(id.headerFor(2))));
    expect([r2.status, r2.code]).toEqual([502, 'near_unavailable']);
  });

  it('checks the identity before the signature, the signature before anything is spent', async () => {
    // A wrong nonce with a would-be valid signature is a nonce error, not a signature one; and a refused signature
    // leaves the counter unspent.
    const id = await newIdentity();
    const wrong = homeKey();
    const msg = homeMessage({ signer: env.SIGNER_ACCOUNT, counter: 5, method: 'GET', path: PATH, body: new Uint8Array(0) });
    const bad = encodeHomeIdentity({ jwt: id.jwt, key: id.key.pub, expiresAtMs: id.expiresAtMs, salt: id.salt, counter: 5, sig: Uint8Array.from(wrong.kp.sign(msg).signature) });
    expect((await refusal(await gate(makeRequest(bad)))).code).toBe('invalid_signature');
    expect((await gate(makeRequest(id.headerFor(5)))).ok).toBe(true);
  });

  it('the per-IP limit is checked before the token (an unsigned flood costs one object call)', async () => {
    const ip = '10.200.200.1';
    const opts = { ...OPTS, ipPerMinute: 1, window: `w${uid()}` };
    expect((await refusal(await gate(makeRequest(null, { ip }), {}, opts))).code).toBe('missing_home_identity');
    const r = await refusal(await gate(makeRequest(null, { ip }), {}, opts));
    expect([r.status, r.code]).toEqual([429, 'rate_limited']);
  });

  it('the per-Home-key limit refuses after the signature and doesn’t spend the counter', async () => {
    const id = await newIdentity();
    const opts = { ...OPTS, keyPerMinute: 1, window: `w${uid()}` };
    expect((await gate(makeRequest(id.headerFor(1)), {}, opts)).ok).toBe(true);
    const r = await refusal(await gate(makeRequest(id.headerFor(2)), {}, opts));
    expect([r.status, r.code]).toEqual([429, 'rate_limited']);
    // The counter wasn't marked: it would still work under a roomier window.
    expect((await gate(makeRequest(id.headerFor(2)), {}, { ...OPTS, keyPerMinute: 5, window: `w${uid()}` })).ok).toBe(true);
  });

  it('a body too large is 413, read only after the identity checks', async () => {
    const id = await newIdentity();
    const big = new Uint8Array(17 * 1024);
    const r = await refusal(await gate(makeRequest(id.headerFor(1, 'POST', PATH, big), { method: 'POST', body: big })));
    expect([r.status, r.code]).toEqual([413, 'bad_request']);
  });

  it('a limiter that fails refuses (503), never lets a request through', async () => {
    const id = await newIdentity();
    const failing = { ...env, RATE_LIMITER: { get: () => ({ hit: () => { throw new Error('do down'); } }), idFromName: () => 'x' } } as unknown as typeof env;
    const r = await refusal(await homeGate(makeRequest(id.headerFor(1)), failing, newCtx(failing, 'req', PATH, makeRequest(null)), OPTS));
    expect([r.status, r.code]).toEqual([503, 'rate_limiter_unavailable']);
  });
});

describe('homeAudienceRoute', () => {
  const config: ConfigView = { console_audiences: [], shared_clients: [['google', SHARED]], pending_shared_clients: [], paused: false, links_open: true };
  const now = 1_000;

  it('a shared Google client, the email Home audience, and nothing else', () => {
    expect(homeAudienceRoute(config, 'google', SHARED, now)).toBe('shared');
    expect(homeAudienceRoute(null, 'email', HOME_EMAIL_AUDIENCE, now)).toBe('email');
    expect(homeAudienceRoute(config, 'google', 'other', now)).toBeNull();
    expect(homeAudienceRoute(null, 'google', SHARED, now)).toBeNull();
    expect(homeAudienceRoute(config, 'email', 'email:s1', now)).toBeNull();
    expect(homeAudienceRoute(config, 'email', SHARED, now)).toBeNull();
  });

  it('an email token can’t ride the shared Google list, whatever it says', () => {
    expect(homeAudienceRoute({ ...config, shared_clients: [['email', 'x']] }, 'email', 'x', now)).toBeNull();
  });
});

describe('secrets never reach a log line or an error body', () => {
  it('no token, sub, header or Home key in the logs or a refusal', async () => {
    const spy = { log: vi.spyOn(console, 'log'), warn: vi.spyOn(console, 'warn'), error: vi.spyOn(console, 'error') };
    const id = await newIdentity({ sub: `secret-sub-${uid()}` });
    const header = id.headerFor(1);
    const refusals = await Promise.all([
      gate(makeRequest(header, { origin: 'https://partner.example' })),
      gate(makeRequest(id.headerFor(2, 'GET', '/other'))),
      gate(makeRequest(`${header}x`)),
    ]);
    const ok = await gate(makeRequest(header));
    expect(ok.ok).toBe(true);
    const logged = [...spy.log.mock.calls, ...spy.warn.mock.calls, ...spy.error.mock.calls].flat().join('\n');
    const fragments = [id.jwt, id.jwt.split('.')[1]!, id.jwt.split('.')[2]!, header, 'secret-sub', Buffer.from(id.key.pub).toString('base64url'), id.nonce];
    for (const f of fragments) expect(logged).not.toContain(f);
    for (const g of refusals) {
      expect(g.ok).toBe(false);
      if (g.ok) continue;
      const text = await g.response.clone().text();
      for (const f of fragments) expect(text).not.toContain(f);
    }
  });

  it('log() drops the redacted field names wherever they are nested, and keeps the rest', () => {
    const spy = vi.spyOn(console, 'log');
    log({ event: 'x', code: 'ok', phases: { kept: 1 }, ...({ sub: 'S', 'x-hana-home': 'H', pathHash: 'P', path_hash: 'P2', jwt: 'J', token: 'T', nested: { sub: 'S2' } } as object) } as Parameters<typeof log>[0]);
    const line = spy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.event).toBe('x');
    expect(parsed.phases).toEqual({ kept: 1 });
    for (const banned of ['sub', 'x-hana-home', 'pathHash', 'path_hash', 'jwt', 'token']) expect(parsed).not.toHaveProperty(banned);
    expect(line).not.toContain('S2');
  });
});

describe('GET /v1/home/config', () => {
  const get = (origin: string | null, ip?: string) => call(HOME_CONFIG_ENDPOINT, { method: 'GET', headers: { ...(origin ? { origin } : {}), ...(ip ? { 'cf-connecting-ip': ip } : {}) } });

  it('answers the clock, the signer and the first shared Google client, with CORS for AUTH_ORIGIN only', async () => {
    const before = Date.now();
    const res = await get(AUTH);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(AUTH);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const b = (await res.json()) as Record<string, unknown>;
    expect(b).toMatchObject({ signer: env.SIGNER_ACCOUNT, sharedGoogleClientId: SHARED });
    expect(typeof b.serverTimeMs).toBe('number');
    expect(b.serverTimeMs as number).toBeGreaterThanOrEqual(before);
    expect(typeof b.requestId).toBe('string');
  });

  it('a matured pending client counts, a future one doesn’t, and none is null (an email user can still sign in)', async () => {
    near.shared = [];
    near.pendingShared = [{ provider: 'google', aud: 'pending-client', effective_at_ms: Date.now() - 1 }];
    let b = (await (await get(AUTH)).json()) as Record<string, unknown>;
    expect(b.sharedGoogleClientId).toBe('pending-client');
    clearViewCaches();
    near.pendingShared = [{ provider: 'google', aud: 'pending-client', effective_at_ms: Date.now() + 86_400_000 }];
    b = (await (await get(AUTH)).json()) as Record<string, unknown>;
    expect(b.sharedGoogleClientId).toBeNull();
  });

  it('refuses another origin or none, without CORS', async () => {
    for (const origin of ['https://partner.example', env.VAULT_ORIGIN!, null]) {
      const res = await get(origin);
      expect(res.status).toBe(403);
      expect(((await res.json()) as Record<string, unknown>).code).toBe('origin_not_allowed');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('502 on a failed chain read, with the limiter asked first', async () => {
    near.views.get_config = () => {
      throw new Error('rpc down');
    };
    clearViewCaches();
    const res = await get(AUTH);
    expect(res.status).toBe(502);
    expect(((await res.json()) as Record<string, unknown>).code).toBe('near_unavailable');
  });

  it(`allows ${HOME_CONFIG_PER_IP_MINUTE} a minute per IP`, async () => {
    const ip = '10.77.77.77';
    let last = await get(AUTH, ip);
    for (let i = 1; i < HOME_CONFIG_PER_IP_MINUTE; i++) last = await get(AUTH, ip);
    expect(last.status).toBe(200);
    const res = await get(AUTH, ip);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).not.toBeNull();
  });

  it('preflight: AUTH_ORIGIN only, and it allows x-hana-home', async () => {
    const ok = await call(HOME_CONFIG_ENDPOINT, { method: 'OPTIONS', headers: { origin: AUTH } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(AUTH);
    expect(ok.headers.get('access-control-allow-headers')).toContain('x-hana-home');
    expect((await call(HOME_CONFIG_ENDPOINT, { method: 'OPTIONS', headers: { origin: 'https://partner.example' } })).status).toBe(403);
    expect((await call(HOME_CONFIG_ENDPOINT, { method: 'OPTIONS' })).status).toBe(403);
  });

  it('405 on a wrong method', async () => {
    expect((await call(HOME_CONFIG_ENDPOINT, { method: 'POST', rawBody: '{}', headers: { origin: AUTH } })).status).toBe(405);
  });

  it('no route that could derive a key exists: no other /v1/home path answers', async () => {
    for (const p of ['/v1/home/login', '/v1/home/apps', '/v1/home/devices']) {
      expect((await call(p, { method: 'POST', rawBody: '{}', headers: { origin: AUTH } })).status).toBe(404);
    }
  });
});
