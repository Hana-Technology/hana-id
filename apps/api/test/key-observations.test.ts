// Issuer key lead-time measurement (D33 "Open"): JWKS observations from the cron and the verification path, and the
// once-per-kid first-token write from /v1/sessions and /v1/login.
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { isHourlyRun } from '../src/index.ts';
import { GOOGLE_JWKS_URL, JWKS_FETCHES_PER_RUN, type Jwk, syncIssuerKeys } from '../src/issuer-keys.ts';
import { TOKEN_SIGHTING_EVERY_MS, cacheMaxAgeS, clearNotedTokenKids, keyObserver, recordJwksObservation, recordTokenKid } from '../src/key-observations.ts';
import { appHeaders, call, chain, google, seedApp, sessionBody, uid } from './helpers.ts';
import { appKey, hanaHeaders, loginBody, withCombinedCall } from './login-helpers.ts';
import { NearMock, rsaSigner } from './near-mock.ts';

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM issuer_key_observations').run();
  await env.DB.prepare('DELETE FROM issuer_key_missing').run();
});

interface Row {
  kid: string;
  first_seen_jwks_ms: number | null;
  last_seen_jwks_ms: number | null;
  removed_jwks_ms: number | null;
  first_token_ms: number | null;
  max_age_s_last: number | null;
}

async function rows(provider = 'google'): Promise<Record<string, Omit<Row, 'kid'>>> {
  const { results } = await env.DB.prepare(
    'SELECT kid, first_seen_jwks_ms, last_seen_jwks_ms, removed_jwks_ms, first_token_ms, max_age_s_last FROM issuer_key_observations WHERE provider = ?1',
  )
    .bind(provider)
    .all<Row>();
  return Object.fromEntries(results.map(({ kid, ...rest }) => [kid, rest]));
}

const seen = (first: number, last: number, maxAge: number | null, more: Partial<Row> = {}): Omit<Row, 'kid'> => ({
  first_seen_jwks_ms: first,
  last_seen_jwks_ms: last,
  removed_jwks_ms: null,
  first_token_ms: null,
  max_age_s_last: maxAge,
  ...more,
});

const N = 'x'.repeat(342);
const jwk = (kid: string): Jwk => ({ kid, n: N, e: 'AQAB', kty: 'RSA', alg: 'RS256', use: 'sig' });
const T = Date.UTC(2026, 9, 29, 12, 0);

describe('Cache-Control max-age', () => {
  it('reads max-age in seconds, not s-maxage; null without one', () => {
    expect(cacheMaxAgeS('public, max-age=20604, must-revalidate, no-transform')).toBe(20604);
    expect(cacheMaxAgeS('MAX-AGE=60')).toBe(60);
    expect(cacheMaxAgeS('public, s-maxage=300')).toBeNull();
    expect(cacheMaxAgeS('no-cache')).toBeNull();
    expect(cacheMaxAgeS(null)).toBeNull();
    expect(cacheMaxAgeS('max-age=99999999999999999999')).toBe(2 ** 31 - 1);
  });
});

describe('JWKS observations', () => {
  it('records first and last sighting, marks a kid removed once a fetch omits it, and clears the mark if it returns', async () => {
    expect(await recordJwksObservation(env.DB, 'google', ['a', 'b', 'a'], 21600, T)).toBe(true);
    expect(await rows()).toEqual({ a: seen(T, T, 21600), b: seen(T, T, 21600) });

    // Later: c is pre-published, a is gone.
    await recordJwksObservation(env.DB, 'google', ['b', 'c'], 18000, T + 900_000);
    expect(await rows()).toEqual({
      a: seen(T, T, 21600, { removed_jwks_ms: T + 900_000 }),
      b: seen(T, T + 900_000, 18000),
      c: seen(T + 900_000, T + 900_000, 18000),
    });

    // A stale response lists a again: not removed after all (removal counts from the next fetch without it).
    await recordJwksObservation(env.DB, 'google', ['a', 'b', 'c'], null, T + 1_800_000);
    expect((await rows()).a).toEqual(seen(T, T + 1_800_000, null));
    await recordJwksObservation(env.DB, 'google', ['b', 'c'], 18000, T + 2_700_000);
    // Already marked: a later fetch without it keeps the first time it was seen missing.
    await recordJwksObservation(env.DB, 'google', ['b', 'c'], 18000, T + 3_600_000);
    expect((await rows()).a).toEqual(seen(T, T + 1_800_000, null, { removed_jwks_ms: T + 2_700_000 }));
  });

  it('keeps the earliest first sighting and the latest last sighting when writes arrive out of order', async () => {
    await recordJwksObservation(env.DB, 'google', ['a', 'b'], 100, T + 60_000);
    // An older fetch (another isolate) lands late: it lowers first_seen, doesn't touch last_seen or max-age, and its
    // missing b is older than b's last sighting, so b is not marked removed.
    await recordJwksObservation(env.DB, 'google', ['a'], 200, T);
    expect(await rows()).toEqual({ a: seen(T, T + 60_000, 100), b: seen(T + 60_000, T + 60_000, 100) });
  });

  it('records nothing for an empty list, and keeps providers apart', async () => {
    await recordJwksObservation(env.DB, 'google', ['a'], 60, T);
    expect(await recordJwksObservation(env.DB, 'google', [], 60, T + 1)).toBe(false);
    await recordJwksObservation(env.DB, 'other', ['z'], 60, T + 2);
    expect(await rows()).toEqual({ a: seen(T, T, 60) });
    expect(Object.keys(await rows('other'))).toEqual(['z']);
  });

  it('never throws when D1 fails', async () => {
    const broken = { prepare: () => ({ bind: () => ({}) }), batch: () => Promise.reject(new Error('D1 down')) } as unknown as D1Database;
    expect(await recordJwksObservation(broken, 'google', ['a'], 60, T)).toBe(false);
    const brokenRun = { prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error('D1 down')) }) }) } as unknown as D1Database;
    expect(await recordTokenKid(brokenRun, 'google', 'a', T)).toBe(false);
  });
});

describe('first token per kid', () => {
  it('keeps the earliest token time and leaves the JWKS columns alone', async () => {
    await recordJwksObservation(env.DB, 'google', ['a'], 60, T);
    await recordTokenKid(env.DB, 'google', 'a', T + 5000);
    await recordTokenKid(env.DB, 'google', 'a', T + 9000);
    await recordTokenKid(env.DB, 'google', 'a', T + 3000);
    // A token before any JWKS fetch listed the kid: a row with only first_token_ms.
    await recordTokenKid(env.DB, 'google', 'early', T);
    expect(await rows()).toEqual({
      a: seen(T, T, 60, { first_token_ms: T + 3000 }),
      early: { first_seen_jwks_ms: null, last_seen_jwks_ms: null, removed_jwks_ms: null, first_token_ms: T, max_age_s_last: null },
    });
    // A later JWKS fetch fills the sighting in.
    await recordJwksObservation(env.DB, 'google', ['a', 'early'], 60, T + 900_000);
    expect((await rows()).early).toEqual(seen(T + 900_000, T + 900_000, 60, { first_token_ms: T }));
  });

  it('keeps the latest token time in last_token_ms, whatever order the writes arrive in (D422)', async () => {
    await recordTokenKid(env.DB, 'google', 'a', T + 5000);
    await recordTokenKid(env.DB, 'google', 'a', T + 9000);
    await recordTokenKid(env.DB, 'google', 'a', T + 3000);
    expect(await env.DB.prepare("SELECT first_token_ms, last_token_ms FROM issuer_key_observations WHERE kid = 'a'").first()).toEqual({ first_token_ms: T + 3000, last_token_ms: T + 9000 });
  });

  it('writes a kid again once TOKEN_SIGHTING_EVERY_MS has passed in the same isolate (last_token_ms stays current)', async () => {
    let writes = 0;
    const counted = { ...env, DB: { prepare: (sql: string) => (writes++, env.DB.prepare(sql)) } as unknown as D1Database };
    const ctx = createExecutionContext();
    const observer = keyObserver(counted, ctx)!;
    observer.token('google', 'k1', T);
    observer.token('google', 'k1', T + TOKEN_SIGHTING_EVERY_MS - 1);
    observer.token('google', 'k1', T + TOKEN_SIGHTING_EVERY_MS);
    await waitOnExecutionContext(ctx);
    expect(writes).toBe(2);
    expect(await env.DB.prepare("SELECT first_token_ms, last_token_ms FROM issuer_key_observations WHERE kid = 'k1'").first()).toEqual({ first_token_ms: T, last_token_ms: T + TOKEN_SIGHTING_EVERY_MS });
    clearNotedTokenKids();
  });

  it('writes a kid at most once per isolate, after the response (waitUntil), and nothing without an execution context', async () => {
    let writes = 0;
    const counted = { ...env, DB: { prepare: (sql: string) => (writes++, env.DB.prepare(sql)) } as unknown as D1Database };
    expect(keyObserver(counted)).toBeUndefined();
    const ctx = createExecutionContext();
    const observer = keyObserver(counted, ctx)!;
    observer.token('google', 'k1', T);
    observer.token('google', 'k1', T + 1);
    observer.token('google', 'k2', T + 2);
    observer.token('other', 'k1', T + 3);
    await waitOnExecutionContext(ctx);
    expect(writes).toBe(3);
    expect(Object.fromEntries(Object.entries(await rows()).map(([k, r]) => [k, r.first_token_ms]))).toEqual({ k1: T, k2: T + 2 });
    clearNotedTokenKids();
  });
});

describe('cron', () => {
  it('runs hourly work only in the first quarter of a UTC hour', () => {
    expect(isHourlyRun(T)).toBe(true);
    expect(isHourlyRun(T + 14 * 60_000 + 59_999)).toBe(true);
    expect(isHourlyRun(T + 15 * 60_000)).toBe(false);
    expect(isHourlyRun(T + 45 * 60_000)).toBe(false);
  });

  it('a quarter-hour run records the JWKS; without the keys-updater key it makes no chain call', async () => {
    const near = new NearMock();
    near.jwks = { keys: [jwk('q1'), jwk('q2')] };
    near.jwksCacheControl = 'public, max-age=19000, must-revalidate, no-transform';
    near.install();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '*/15 * * * *', scheduledTime: T + 15 * 60_000 }), { ...env, KEYS_UPDATER_KEY: undefined }, ctx);
    await waitOnExecutionContext(ctx);
    // JWKS_FETCHES_PER_RUN fetches a run (D422).
    expect(near.jwksFetches).toBe(JWKS_FETCHES_PER_RUN);
    expect(near.rpcMethods).toEqual([]);
    const r = await rows();
    expect(Object.keys(r).sort()).toEqual(['q1', 'q2']);
    expect(r.q1!.max_age_s_last).toBe(19000);
  });

  it('a failed or empty JWKS fetch records nothing', async () => {
    const near = new NearMock();
    near.install();
    near.jwksStatus = 503;
    expect((await syncIssuerKeys(env)).skipped).toBe('jwks_fetch_failed');
    near.jwksStatus = 200;
    near.jwks = { keys: [] };
    expect((await syncIssuerKeys(env)).skipped).toBe('jwks_empty');
    expect(await rows()).toEqual({});
  });

  it('the sync records the JWKS from its own fetch, with or without the keys-updater key', async () => {
    const near = new NearMock();
    near.views.get_issuer = () => ({ provider: 'google', iss_values: [], kids: ['h1'] });
    near.views.get_key_changes = () => [];
    near.views.get_config = () => ({ paused: false });
    near.jwks = { keys: [jwk('h1')] };
    near.jwksCacheControl = 'public, max-age=21000';
    near.install();
    expect(await syncIssuerKeys(env, 'google', GOOGLE_JWKS_URL, T)).toEqual({ proposed: [], removalsProposed: [], executed: [], failed: [], cancelled: [], notes: [] });
    expect(await syncIssuerKeys({ ...env, KEYS_UPDATER_KEY: undefined }, 'google', GOOGLE_JWKS_URL, T + 60_000)).toMatchObject({ skipped: 'no_keys_updater_key' });
    expect(near.jwksFetches).toBe(2 * JWKS_FETCHES_PER_RUN);
    expect(await rows()).toEqual({ h1: seen(T, T + 60_000, 21000) });
  });
});

describe('token verification records the signing kid', () => {
  async function sessionsSetup() {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    const near = chain({ [aud]: app.scope });
    const signer = await rsaSigner(`kid-${uid()}`);
    near.jwks = { keys: [google.jwk, signer.jwk] };
    near.activeKids.add(signer.jwk.kid);
    near.jwksCacheControl = 'public, max-age=20000';
    const post = async (b: Record<string, unknown>): Promise<Response> => call('/v1/sessions', { headers: appHeaders(app), body: b });
    return { app, aud, near, signer, post };
  }

  it('/v1/sessions: the first verified token per kid is written once per isolate, plus the verification fetch', async () => {
    const { app, aud, signer, post } = await sessionsSetup();
    const kid = signer.jwk.kid;
    const before = Date.now();
    const res = await post(await sessionBody(app.scope, aud, {}, {}, signer));
    expect(res.status).toBe(200);
    let r = (await rows())[kid]!;
    expect(r.first_token_ms).toBeGreaterThanOrEqual(before);
    // The API's own JWKS fetch (to verify the token) is an observation too.
    expect(r.first_seen_jwks_ms).toBeGreaterThanOrEqual(before);
    expect(r.max_age_s_last).toBe(20000);
    expect(Object.keys(await rows()).sort()).toEqual([google.jwk.kid, kid].sort());

    // Same isolate, same kid: no second write (shown by clearing the column: it stays empty).
    await env.DB.prepare('UPDATE issuer_key_observations SET first_token_ms = NULL WHERE kid = ?1').bind(kid).run();
    expect((await post(await sessionBody(app.scope, aud, {}, {}, signer))).status).toBe(200);
    expect((await rows())[kid]!.first_token_ms).toBeNull();
    // A new isolate (cleared set) writes it again.
    clearNotedTokenKids();
    expect((await post(await sessionBody(app.scope, aud, {}, {}, signer))).status).toBe(200);
    r = (await rows())[kid]!;
    expect(r.first_token_ms).not.toBeNull();
  });

  it('records no token for a bad signature, and a token whose nonce is wrong still counts (Google signed it)', async () => {
    const { app, aud, signer, post } = await sessionsSetup();
    const impostor = await rsaSigner(signer.jwk.kid);
    expect((await post(await sessionBody(app.scope, aud, {}, {}, impostor))).status).toBe(401);
    expect((await rows())[signer.jwk.kid]?.first_token_ms ?? null).toBeNull();
    const res = await post(await sessionBody(app.scope, aud, {}, { nonce: 'wrong' }, signer));
    expect(((await res.json()) as { code: string }).code).toBe('nonce_mismatch');
    expect((await rows())[signer.jwk.kid]!.first_token_ms).not.toBeNull();
  });

  it('/v1/login records the kid too', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    const near = withCombinedCall(chain({ [aud]: app.scope }));
    const signer = await rsaSigner(`kid-${uid()}`);
    near.jwks = { keys: [signer.jwk] };
    near.activeKids.add(signer.jwk.kid);
    const res = await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud, {}, {}, appKey(), signer) });
    expect(res.status).toBe(200);
    expect((await rows())[signer.jwk.kid]).toEqual(expect.objectContaining({ first_token_ms: expect.any(Number), first_seen_jwks_ms: expect.any(Number), max_age_s_last: null }));
  });
});
