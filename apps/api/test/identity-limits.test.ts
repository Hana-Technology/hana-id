// Regression tests for the identity token's second review (D176–D178): per-app, per-scope and per-account limits ahead
// of the global breaker (M1), the global alert line, sliding windows, the app's own identity windows (L3), revocation
// across apps of a scope (L1), single-use markers only for live sessions and swept by an alarm (L2), and a marker keyed
// on (key, time, nonce) rather than the signature (L5).
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetCachedApps } from '../src/app-cache.ts';
import { hex } from '../src/bytes.ts';
import { limiter } from '../src/handlers.ts';
import {
  IDENTITY_APP_HOUR_MAX,
  IDENTITY_GLOBAL_LIMITER,
  IDENTITY_GLOBAL_PER_HOUR,
  IDENTITY_PER_ROOT_MINUTE,
  IDENTITY_PER_SESSION_MINUTE,
  identityAppHourMax,
  identityProofLimiter,
  identityScopeLimiter,
} from '../src/identity/limits.ts';
import { clearIdentitySignerCache } from '../src/identity/signer.ts';
import { proofMarker } from '../src/identity/token.ts';
import { clearViewCaches } from '../src/views.ts';
import { minuteHeadroom, seedApp, seedPlan, uid } from './helpers.ts';
import { limiterKeys, mint, randomPrk, setSlidingBucket } from './identity-helpers.ts';
import { HOUR, act, createShare, setSettings, spentSession, vaultSetup } from './vault-helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
  clearIdentitySignerCache();
});

const MIN = 60_000;

async function codeOf(res: Response): Promise<[number, unknown, string | undefined]> {
  const b = (await res.json()) as { code?: unknown; error?: string; reason?: unknown };
  return [res.status, b.code, typeof b.reason === 'string' ? b.reason : typeof b.error === 'string' ? b.error : undefined];
}

async function slidingCount(subject: string, name: string, windowMs: number, now = Date.now()): Promise<number> {
  const start = Math.floor(now / windowMs) * windowMs;
  return runInDurableObject(limiter(env, subject), (_i, state) => state.storage.kv.get<number>(`slide:${name}@${start}`) ?? 0);
}

describe('M1: no tenant can use up what others share', () => {
  it('global ceiling ≥ 10 × the largest per-app ceiling', () => {
    expect(IDENTITY_GLOBAL_PER_HOUR).toBeGreaterThanOrEqual(10 * IDENTITY_APP_HOUR_MAX);
    expect(identityAppHourMax({ per_day: 5000 })).toBe(5000);
    expect(identityAppHourMax({ per_day: 10_000_000 })).toBe(IDENTITY_APP_HOUR_MAX);
  });

  it('an app at its plan-sized hourly ceiling gets 429; another app keeps minting', async () => {
    const plan = `tiny${uid()}`;
    await seedPlan(plan, 60, 3, 20);
    const { app, near } = await vaultSetup({ plan });
    const share = await createShare(app, near);
    for (let i = 0; i < 3; i++) expect((await mint(app, share.spk)).status).toBe(200);
    const [status, code, error] = await codeOf(await mint(app, share.spk));
    expect([status, code]).toEqual([429, 'rate_limited']);
    expect(error).toMatch(/per app per hour/u);
    const other = await vaultSetup();
    const otherShare = await createShare(other.app, other.near);
    expect((await mint(other.app, otherShare.spk)).status).toBe(200);
  });

  it('the scope’s hourly ceiling refuses (429), and the app window takes the hit back', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const now = Date.now();
    await setSlidingBucket(identityScopeLimiter(app.scope), 'identity:hour', HOUR, 2 * identityAppHourMax({ per_day: 5000 }), now);
    const before = await slidingCount(`app:${app.id}`, 'identity:hour', HOUR);
    const [status, code, error] = await codeOf(await mint(app, share.spk));
    expect([status, code]).toEqual([429, 'rate_limited']);
    expect(error).toMatch(/per scope per hour/u);
    expect(await slidingCount(`app:${app.id}`, 'identity:hour', HOUR)).toBe(before);
    await setSlidingBucket(identityScopeLimiter(app.scope), 'identity:hour', HOUR, null, now);
    expect((await mint(app, share.spk)).status).toBe(200);
  });

  it('one account root at most IDENTITY_PER_ROOT_MINUTE mints a minute, over all its sessions', async () => {
    const { app, near } = await vaultSetup();
    await minuteHeadroom(12_000);
    const sessions = [];
    for (let i = 0; i < Math.ceil((IDENTITY_PER_ROOT_MINUTE + 1) / IDENTITY_PER_SESSION_MINUTE); i++) sessions.push(await createShare(app, near, { sub: 'same-user' }));
    const statuses: number[] = [];
    for (let i = 0; i <= IDENTITY_PER_ROOT_MINUTE; i++) statuses.push((await mint(app, sessions[Math.floor(i / IDENTITY_PER_SESSION_MINUTE)]!.spk)).status);
    expect(statuses.slice(0, IDENTITY_PER_ROOT_MINUTE).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Another user of the same app is not affected.
    const other = await createShare(app, near, { sub: 'other-user' });
    expect((await mint(app, other.spk)).status).toBe(200);
  }, 30_000);

  it('past the global alert line: a critical log, and the mint still succeeds', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((l: unknown) => void errors.push(String(l)));
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    await setSlidingBucket(IDENTITY_GLOBAL_LIMITER, 'alert:hour', HOUR, 100_000);
    try {
      expect((await mint(app, share.spk)).status).toBe(200);
      expect(errors.some((l) => l.includes('"identity_volume_alert"'))).toBe(true);
    } finally {
      await setSlidingBucket(IDENTITY_GLOBAL_LIMITER, 'alert:hour', HOUR, null);
    }
  });
});

describe('sliding windows (RateLimiter.hitSliding)', () => {
  it('counts the previous bucket by its overlap, so a refusal clears gradually; soft limits only report', async () => {
    const stub = limiter(env, `test:slide:${uid()}`);
    const l = [{ name: 'w', windowMs: 1000, max: 2 }];
    const t0 = 1_000_000_000_000;
    expect((await stub.hitSliding(l, t0)).ok).toBe(true);
    expect((await stub.hitSliding(l, t0 + 1)).ok).toBe(true);
    const refused = await stub.hitSliding(l, t0 + 2);
    expect(refused).toMatchObject({ ok: false, limit: 'w' });
    // Half-way through the next bucket: 2 × 0.5 = 1 in the window, room for one.
    expect((await stub.hitSliding(l, t0 + 1500)).ok).toBe(true);
    // 1 + 2 × 0.499 < 2: one more; then 2 + … ≥ 2.
    expect((await stub.hitSliding(l, t0 + 1501)).ok).toBe(true);
    expect((await stub.hitSliding(l, t0 + 1502)).ok).toBe(false);
    expect((await stub.hitSliding([{ name: 's', windowMs: 1000, max: 1, soft: true }], t0))).toEqual({ ok: true });
    expect((await stub.hitSliding([{ name: 's', windowMs: 1000, max: 1, soft: true }], t0 + 1))).toEqual({ ok: true, soft: ['s'] });
    // Take-back.
    await stub.unhitSliding(l, t0 + 1502);
    expect((await stub.hitSliding(l, t0 + 1503)).ok).toBe(true);
  });
});

describe('L3: identity tokens have their own app windows', () => {
  it('mints at their per-minute limit get 429 while unlocks go on; a full vault window doesn’t stop mints', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const now = Date.now();
    await setSlidingBucket(`app:${app.id}`, 'identity:minute', MIN, 10 * 60, now);
    const [status, , error] = await codeOf(await mint(app, share.spk));
    expect(status).toBe(429);
    expect(error).toMatch(/per app per minute/u);
    expect((await act(app, share, 'unlock', 1)).status).toBe(200);
    await setSlidingBucket(`app:${app.id}`, 'identity:minute', MIN, null, now);
    // The vault endpoints' own window full: mints are not counted there.
    const start = Math.floor(Date.now() / MIN) * MIN;
    await runInDurableObject(limiter(env, `app:${app.id}`), (_i, state) => state.storage.kv.put(`vault:minute@${start}`, 10 * 60));
    expect((await mint(app, share.spk)).status).toBe(200);
  });
});

describe('L1: a session revoked in one app of a scope mints in no other app', () => {
  it("a 'none' app refuses a session key whose share is another app's, live or revoked", async () => {
    const { app: keeper, near } = await vaultSetup();
    const share = await createShare(keeper, near);
    const noneApp = await seedApp({ scope: keeper.scope });
    await setSettings(noneApp.id, { persistence: 'none' });
    forgetCachedApps();
    expect(await codeOf(await mint(noneApp, share.spk))).toEqual([410, 'session_ended', 'unknown_share']);
    expect((await act(keeper, share, 'revoke', 1)).status).toBe(200);
    expect(await codeOf(await mint(noneApp, share.spk))).toEqual([410, 'session_ended', 'unknown_share']);
    // And a 'none' app's own session (no share anywhere) still mints.
    expect((await mint(noneApp, spentSession(near, keeper.scope))).status).toBe(200);
  });
});

describe('L2: single-use markers only for live sessions, swept by an alarm', () => {
  it('a refused proof (no session, paused) leaves no marker', async () => {
    const { app, near } = await vaultSetup();
    await setSettings(app.id, { persistence: 'none' });
    forgetCachedApps();
    const ghost = spentSession(near, app.scope);
    near.sessions.delete(JSON.stringify(ghost));
    expect((await mint(app, ghost)).status).toBe(410);
    expect((await limiterKeys(identityProofLimiter(hex(Uint8Array.from(ghost))))).filter((k) => k.startsWith('mark:'))).toEqual([]);
    const live = spentSession(near, app.scope);
    near.paused = true;
    clearViewCaches();
    expect((await mint(app, live)).status).toBe(503);
    expect((await limiterKeys(identityProofLimiter(hex(Uint8Array.from(live))))).filter((k) => k.startsWith('mark:'))).toEqual([]);
    near.paused = false;
    clearViewCaches();
    expect((await mint(app, live)).status).toBe(200);
    expect((await limiterKeys(identityProofLimiter(hex(Uint8Array.from(live))))).filter((k) => k.startsWith('mark:'))).toHaveLength(1);
  });

  it('the object’s alarm deletes expired markers', async () => {
    const stub = limiter(env, `identity-proof:test${uid()}`);
    expect(await stub.reserve('a', Date.now() + 50)).toBe(true);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).not.toBeNull();
    await new Promise((r) => setTimeout(r, 80));
    // The alarm may already have fired by itself; run it if it hasn't.
    await runDurableObjectAlarm(stub);
    expect(await runInDurableObject(stub, (_i, state) => [...state.storage.kv.list({ prefix: 'mark:' })].length)).toBe(0);
  });
});

describe('L5: the marker is (key, time, nonce), not the signature', () => {
  it('another valid signature over the same key, time and nonce is a replay', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const issuedAtMs = Date.now();
    expect((await mint(app, share.spk, { nonce, issuedAtMs, prk: randomPrk() })).status).toBe(200);
    // Other wallet proofs: another payload, so another signature.
    expect(await codeOf(await mint(app, share.spk, { nonce, issuedAtMs, prk: randomPrk() }))).toEqual([409, 'proof_replayed', 'This session proof was already used']);
    expect(await proofMarker({ sessionPk: Uint8Array.from(share.spk), issuedAtMs, nonce })).toMatch(/^[0-9a-f]{64}$/u);
  });
});
