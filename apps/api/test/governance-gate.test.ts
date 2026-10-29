// Governance prechecks before a relay (handlers.ts chainGate; docs/governance-spec.md "Rotation and logins",
// "Pause"): a token whose kid Google publishes but the contract hasn't activated yet gets 503 issuer_key_pending
// with Retry-After instead of a transaction that would fail with `Unknown signing key`; a paused contract gets 503
// paused on every path it would refuse. Nothing is relayed in either case.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ISSUER_KEY_PENDING_RETRY_S, PAUSED_RETRY_S, chainGate } from '../src/handlers.ts';
import { ISSUER_REFETCH_MIN_MS, clearViewCaches, isIssuerKeyActive } from '../src/views.ts';
import { appHeaders, call, chain, deriveBody, google, revokeBody, seedApp, sessionBody, uid } from './helpers.ts';
import { appKey, hanaHeaders, loginBody, withCombinedCall } from './login-helpers.ts';
import { NearMock, rsaSigner } from './near-mock.ts';

afterEach(() => vi.restoreAllMocks());

const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const at = (ms: number): void => {
  vi.spyOn(Date, 'now').mockReturnValue(ms);
};

async function setup() {
  const app = await seedApp();
  const aud = `${uid()}.apps.googleusercontent.com`;
  const near = withCombinedCall(chain({ [aud]: app.scope }));
  // Google has published a new key; the API's cron proposed it, the contract hasn't activated it yet.
  const rotated = await rsaSigner(`rotated-${uid()}`);
  near.jwks = { keys: [google.jwk, rotated.jwk] };
  const sessions = async (b: Record<string, unknown>): Promise<Response> => call('/v1/sessions', { headers: appHeaders(app), body: b });
  const login = async (b: Record<string, unknown>): Promise<Response> => call('/v1/login', { headers: hanaHeaders(app), body: b });
  return { app, aud, near, rotated, sessions, login };
}

async function expectPending(res: Response): Promise<void> {
  const b = await body(res);
  expect([res.status, b.code, b.retryAfterS]).toEqual([503, 'issuer_key_pending', ISSUER_KEY_PENDING_RETRY_S]);
  expect(res.headers.get('retry-after')).toBe(String(ISSUER_KEY_PENDING_RETRY_S));
  expect(typeof b.requestId).toBe('string');
}

describe('503 issuer_key_pending', () => {
  it('/v1/sessions and /v1/login refuse a token whose kid isn’t active on chain; nothing is relayed', async () => {
    const { app, aud, near, rotated, sessions, login } = await setup();
    await expectPending(await sessions(await sessionBody(app.scope, aud, {}, {}, rotated)));
    await expectPending(await login(await loginBody(app.scope, aud, {}, {}, appKey(), rotated)));
    expect(near.sent).toHaveLength(0);
    // The vault can read Retry-After cross-origin.
    const res = await login(await loginBody(app.scope, aud, {}, {}, appKey(), rotated));
    expect(res.headers.get('access-control-expose-headers')).toContain('retry-after');
    // The active key still logs in.
    expect((await sessions(await sessionBody(app.scope, aud))).status).toBe(200);
    expect((await login(await loginBody(app.scope, aud))).status).toBe(200);
    expect(near.sent.map((t) => t.method)).toEqual(['create_session', 'create_session_and_derive']);
  });

  it('logs in once the key is active, re-reading get_issuer at most every 10 s per isolate', async () => {
    const { app, aud, near, rotated, sessions } = await setup();
    const t0 = Date.now();
    const issuerReads = (): number => near.viewCalls.filter((v) => v.method === 'get_issuer').length;
    const b1 = await sessionBody(app.scope, aud, {}, {}, rotated);
    const b2 = await sessionBody(app.scope, aud, {}, {}, rotated);
    const b3 = await sessionBody(app.scope, aud, {}, {}, rotated);
    at(t0);
    await expectPending(await sessions(b1));
    expect(issuerReads()).toBe(1);
    // A watchdog confirms it (or the delay passes and the cron executes it).
    near.activeKids.add(rotated.jwk.kid);
    at(t0 + ISSUER_REFETCH_MIN_MS - 1);
    await expectPending(await sessions(b2));
    expect(issuerReads()).toBe(1);
    at(t0 + ISSUER_REFETCH_MIN_MS);
    expect((await sessions(b3)).status).toBe(200);
    expect(issuerReads()).toBe(2);
    // A known kid is served from the cache.
    expect((await sessions(await sessionBody(app.scope, aud))).status).toBe(200);
    expect(issuerReads()).toBe(2);
  });

  it('treats an issuer the contract doesn’t know as having no active key', async () => {
    const { app, aud, near, sessions } = await setup();
    near.views.get_issuer = () => null;
    await expectPending(await sessions(await sessionBody(app.scope, aud)));
    expect(near.sent).toHaveLength(0);
  });

  it('fails open when get_issuer can’t be read: the contract decides', async () => {
    const { app, aud, near, sessions } = await setup();
    delete near.views.get_issuer;
    expect((await sessions(await sessionBody(app.scope, aud))).status).toBe(200);
    expect(near.sent).toHaveLength(1);
  });

  it('a scope rejection still answers first', async () => {
    const { app, near, rotated, sessions } = await setup();
    const res = await sessions(await sessionBody(app.scope, `${uid()}.apps.googleusercontent.com`, {}, {}, rotated));
    expect([res.status, (await body(res)).code]).toEqual([403, 'unregistered_client']);
    expect(near.sent).toHaveLength(0);
  });
});

describe('503 paused', () => {
  async function expectPaused(res: Response): Promise<void> {
    const b = await body(res);
    expect([res.status, b.code, b.retryAfterS]).toEqual([503, 'paused', PAUSED_RETRY_S]);
    expect(res.headers.get('retry-after')).toBe(String(PAUSED_RETRY_S));
  }

  it('/v1/sessions, /v1/login and /v1/derive refuse while paused; revoke still relays', async () => {
    const { app, aud, near, sessions, login } = await setup();
    // A session opened before the pause.
    const opened = await sessionBody(app.scope, aud);
    expect((await sessions(opened)).status).toBe(200);
    near.paused = true;
    // The cached config is re-read after at most 60 s; start this test from a cold cache.
    clearViewCaches();
    await expectPaused(await sessions(await sessionBody(app.scope, aud)));
    await expectPaused(await login(await loginBody(app.scope, aud)));
    const spk = opened.sessionPublicKey as number[];
    await expectPaused(await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk) }));
    expect(near.sent.map((t) => t.method)).toEqual(['create_session']);
    const revoke = await call('/v1/sessions/revoke', { headers: appHeaders(app), body: await revokeBody(spk, { counter: 1 }) });
    expect(revoke.status).toBe(200);
    expect(near.sent.map((t) => t.method)).toEqual(['create_session', 'revoke_session']);
  });

  it('sees an unpause within 10 s (a paused config is cached for 10 s, not 60)', async () => {
    const { app, aud, near, sessions } = await setup();
    const t0 = Date.now();
    const b1 = await sessionBody(app.scope, aud);
    const b2 = await sessionBody(app.scope, aud);
    const b3 = await sessionBody(app.scope, aud);
    near.paused = true;
    at(t0);
    await expectPaused(await sessions(b1));
    near.paused = false;
    at(t0 + 9_999);
    await expectPaused(await sessions(b2));
    at(t0 + 10_000);
    expect((await sessions(b3)).status).toBe(200);
  });
});

describe('chainGate', () => {
  it('fails open on unreadable views and never rejects', async () => {
    const near = new NearMock();
    near.install();
    await expect(chainGate(env, { provider: 'google', kid: 'k' })).resolves.toBeNull();
    await expect(chainGate(env, null)).resolves.toBeNull();
  });

  it('pause wins over a pending kid; no token means no issuer read', async () => {
    const near = new NearMock();
    near.views.get_config = () => ({ paused: true });
    near.views.get_issuer = () => ({ provider: 'google', iss_values: [], kids: [] });
    near.install();
    expect(await chainGate(env, { provider: 'google', kid: 'k' })).toMatchObject({ code: 'paused', status: 503 });
    clearViewCaches();
    near.views.get_config = () => ({ paused: false });
    expect(await chainGate(env, { provider: 'google', kid: 'k' })).toMatchObject({ code: 'issuer_key_pending', status: 503 });
    clearViewCaches();
    near.viewCalls.length = 0;
    expect(await chainGate(env, null)).toBeNull();
    expect(near.viewCalls.map((v) => v.method)).toEqual(['get_config']);
  });

  it('concurrent misses share one get_issuer read', async () => {
    const near = new NearMock();
    near.views.get_issuer = () => ({ provider: 'google', iss_values: [], kids: ['a'] });
    near.install();
    const results = await Promise.all([isIssuerKeyActive(env, 'google', 'a'), isIssuerKeyActive(env, 'google', 'b'), isIssuerKeyActive(env, 'google', 'a')]);
    expect(results).toEqual([true, false, true]);
    expect(near.viewCalls.filter((v) => v.method === 'get_issuer')).toHaveLength(1);
  });
});
