// D935 (after PR 161's second full review): the platform's two budget classes on the rate limiter's own monotone
// clock. Ordinary calls: the org's bucket, the platform's global bucket and the console's shared floor, no reserve.
// Kill switches: each org's kill bucket only. No tokens ever given back; only a removal's breaker slot when it changed
// nothing. At most MAX_PLATFORM_ORGS organisations switched on (staff's switch) and kill buckets in use a minute (the
// limiter's backstop). The reviewer's stale-clock scenarios (H1), the isolation of an org's kill switches from every
// other org, the hard ceilings at N = 20, honest retry-afters (L3), token conservation, a slow upload refused and the
// clock read again after the body. Its own file: its own database and objects.
import { MAX_PLATFORM_ORGS, PLATFORM_REQUEST_LIMITS, b64url } from '@hana-id/console-core';
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { placedStub } from '../src/placement.ts';
import { CONSOLE_LIMITS } from '../src/changes/guard.ts';
import { PLATFORM_ORGS_FULL } from '../src/platform/keys.ts';
import { PLATFORM_LIMITS, PLATFORM_WINDOWS, handlePlatform } from '../src/platform/request.ts';
import { PLATFORM_ROUTES } from '../src/platform/routes.ts';
import { AdminRpc } from '../src/rpc/admin.ts';
import type { PlatformAdmission } from '../src/rate-limiter.ts';
import { read, seedKey, send, switchOn } from './platform-helpers.ts';
import { hana, orgApp, rows } from './rpc-helpers.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const L = PLATFORM_LIMITS;

let n = 0;
/** A limiter object of its own (its own clock and buckets). */
const fresh = () => env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`d935-limits-${Date.now()}-${++n}`));
type Stub = ReturnType<typeof fresh>;
/** A start ahead of real time, a second into a fresh hour. */
const start = () => Math.ceil(Date.now() / HOUR) * HOUR + (++n % 1000) * 4 * HOUR + 1000;
const ordinary = (stub: Stub, org: string, cost: number, at: number) => stub.platformAdmit({ org, cost, limits: L }, at);
const kill = (stub: Stub, org: string, cost: number, at: number) => stub.platformAdmit({ org, cost, killSwitch: true, limits: L }, at);
const removal = (stub: Stub, org: string, at: number) => stub.platformAdmit({ org, cost: 11, killSwitch: true, breaker: true, limits: L }, at);
const orgsOf = (k: number, tag = 'org') => Array.from({ length: k }, (_, i) => `${tag}_${n}_${i}`);
/** A seeded pseudo-random stream. */
const rng = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
/** A bucket's stored state and the object's clock. */
const stored = (stub: Stub, key: string) =>
  runInDurableObject(stub, (_i, state) => ({ bucket: state.storage.kv.get<{ tokens: number; at: number }>(key) ?? null, clock: state.storage.kv.get<number>('clock') ?? 0 }));

describe('the numbers and the two budget classes', () => {
  it('the limits as built', () => {
    expect(L).toEqual({
      perOrg: { ratePerS: 8, burst: 40 },
      platform: { ratePerS: 10, burst: 60 },
      shared: { ratePerS: CONSOLE_LIMITS.global.ratePerS, burst: CONSOLE_LIMITS.global.burst, sharedFloor: 30 },
      breaker: { windowMs: HOUR, perOrg: 10, global: 30, floor: 5 },
      kill: { ratePerS: 2.5, burst: 44 },
      maxOrgs: 20,
    });
    expect(MAX_PLATFORM_ORGS).toBe(20);
    expect(PLATFORM_REQUEST_LIMITS.bodyDeadlineMs).toBe(5000);
    expect(PLATFORM_WINDOWS.killReserve).toEqual([
      { name: 'kill:minute', windowMs: MIN, max: 10 },
      { name: 'kill:day', windowMs: DAY, max: 100 },
    ]);
    // Every kill switch: 4 at once from a full kill bucket, at least 13 a minute.
    for (const r of PLATFORM_ROUTES.filter((x) => x.killSwitch || x.flags)) {
      expect(4 * r.cost, r.path).toBeLessThanOrEqual(L.kill.burst);
      expect(Math.floor((60 * L.kill.ratePerS) / r.cost), r.path).toBeGreaterThanOrEqual(13);
    }
    expect(PLATFORM_ROUTES.filter((r) => r.breaker).map((r) => r.path)).toEqual(['/v1/platform/apps/:appId/origins/remove']);
  });

  it('a kill switch takes only its org’s kill bucket; an ordinary call never touches a kill bucket', async () => {
    const stub = fresh();
    const t = start();
    const [a, b] = orgsOf(2);
    for (let i = 0; i < 4; i++) expect(await kill(stub, a!, 11, t)).toMatchObject({ ok: true, at: t });
    expect(await kill(stub, a!, 11, t)).toMatchObject({ ok: false, limit: 'budget_kill' });
    for (const key of [`platform:bucket:org:${a!}`, 'platform:bucket', 'console:bucket']) expect((await stored(stub, key)).bucket, key).toBeNull();
    // The org's ordinary calls are untouched by its empty kill bucket, and another org's kill switch by anything.
    expect(await ordinary(stub, a!, 13, t)).toMatchObject({ ok: true });
    expect(await ordinary(stub, a!, 13, t)).toMatchObject({ ok: true });
    expect((await stored(stub, `platform:kill:org:${a!}`)).bucket).toMatchObject({ tokens: 0, at: t });
    expect(await kill(stub, b!, 11, t)).toMatchObject({ ok: true });
  });
});

describe('H1: the object’s monotone clock (the reviewer’s three scenarios)', () => {
  it('a stale call never refills a bucket: the platform’s bucket at 25 stays at 25 less the call', async () => {
    const stub = fresh();
    const t = start();
    const orgs = orgsOf(3);
    // 60 → 25 by ordinary calls of three orgs at t (35 statements), each within the console's floor.
    expect(await ordinary(stub, orgs[0]!, 12, t)).toMatchObject({ ok: true });
    expect(await ordinary(stub, orgs[1]!, 12, t)).toMatchObject({ ok: true });
    expect(await ordinary(stub, orgs[2]!, 11, t + 1000)).toMatchObject({ ok: true });
    const before = await stored(stub, 'platform:bucket');
    expect(before.bucket).toMatchObject({ at: t + 1000 });
    expect(before.bucket!.tokens).toBeCloseTo(60 - 35 + 10, 6);
    // A call stamped 10 s earlier: counted at the object's clock, nothing credited, the bucket's time not moved back.
    expect(await ordinary(stub, orgs[0]!, 5, t - 9000)).toMatchObject({ ok: true, at: t + 1000 });
    const after = await stored(stub, 'platform:bucket');
    expect(after.bucket).toMatchObject({ at: t + 1000 });
    expect(after.bucket!.tokens).toBeCloseTo(before.bucket!.tokens - 5, 6);
    // And the next call "now" gets no refill for the stale one either.
    expect(await ordinary(stub, orgs[1]!, Math.floor(after.bucket!.tokens) + 1, t + 1000)).toMatchObject({ ok: false });
  });

  it('one org alternating stale and fresh calls within one second: no more than its buckets hold plus a second’s refill', async () => {
    const stub = fresh();
    const t = start();
    const [org] = orgsOf(1);
    let ordinaryCost = 0;
    let killCost = 0;
    for (let i = 0; i < 200; i++) {
      const at = i % 2 === 0 ? t + i * 5 : t + i * 5 - 10_000;
      if ((await ordinary(stub, org!, 11, at)).ok) ordinaryCost += 11;
      if ((await kill(stub, org!, 11, at)).ok) killCost += 11;
    }
    // Within t … t + 1 s: the org's ordinary bucket 40 + 8, the console's floor 30 above it; the kill bucket 44 + 2.5.
    expect(ordinaryCost).toBeLessThanOrEqual(Math.min(L.perOrg.burst + L.perOrg.ratePerS, L.shared.burst - L.shared.sharedFloor + L.shared.ratePerS));
    expect(killCost).toBeLessThanOrEqual(L.kill.burst + L.kill.ratePerS);
  });

  it('six orgs alternating stale and fresh ordinary calls and kill switches for a minute stay within 660 + 6 × 194', async () => {
    const stub = fresh();
    const t = start();
    const orgs = orgsOf(6);
    let ordinaryCost = 0;
    const killCost = new Map<string, number>();
    for (let tick = 0; tick < 600; tick++) {
      for (const [i, org] of orgs.entries()) {
        const at = (tick + i) % 2 === 0 ? t + tick * 100 : t + tick * 100 - 10_000;
        if ((await ordinary(stub, org, 13, at)).ok) ordinaryCost += 13;
        if ((await kill(stub, org, 11, at)).ok) killCost.set(org, (killCost.get(org) ?? 0) + 11);
      }
    }
    expect(ordinaryCost).toBeLessThanOrEqual(L.platform.burst + 60 * L.platform.ratePerS);
    for (const org of orgs) expect(killCost.get(org) ?? 0).toBeLessThanOrEqual(L.kill.burst + 60 * L.kill.ratePerS);
    expect(ordinaryCost + [...killCost.values()].reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(660 + 6 * 194);
  }, 120_000);

  it('a key’s windows can’t be dodged by a stale time: counted, and undone, only in the window now current', async () => {
    const kobj = fresh();
    const t = start() + 30_000;
    for (let i = 0; i < PLATFORM_REQUEST_LIMITS.perKeyPerMinute; i++) expect((await kobj.hit([...PLATFORM_WINDOWS.key], t)).ok).toBe(true);
    // Stamped in the previous minute (t is 31 s into its minute): still this minute's window, full.
    expect(await kobj.hit([...PLATFORM_WINDOWS.key], t - 45_000)).toMatchObject({ ok: false, limit: 'req:minute' });
    // An undo naming the previous minute frees nothing here.
    await kobj.unhit([...PLATFORM_WINDOWS.key], t - 45_000);
    expect(await kobj.hit([...PLATFORM_WINDOWS.key], t)).toMatchObject({ ok: false, limit: 'req:minute' });
  });
});

describe('isolation: another org’s calls never slow an org’s kill switches, and kill switches never slow anyone’s ordinary calls', () => {
  // The victim tries a kill switch (11) and an ordinary call (5) every 200 ms for 3 minutes; its neighbours, in a seeded
  // random order each tick, flood ordinary calls (13), and in the second scenario also real kill switches and no-ops (11;
  // a no-op costs the same and gets nothing back).
  async function run(neighbours: number, withKills: boolean) {
    const stub = fresh();
    const t0 = start();
    const victim = `victim_${n}`;
    const others = orgsOf(neighbours, 'neighbour');
    const order = rng(935 + neighbours);
    const killPerMinute = [0, 0, 0];
    let victimOrdinary = 0;
    for (let tick = 0; tick < 3 * 300; tick++) {
      const t = t0 + tick * 200;
      const calls: (() => Promise<unknown>)[] = others.map((org) => async () => {
        await ordinary(stub, org, 13, t);
        if (withKills) await kill(stub, org, 11, t);
      });
      calls.push(async () => {
        if ((await kill(stub, victim, 11, t)).ok) killPerMinute[Math.floor(tick / 300)]!++;
        if ((await ordinary(stub, victim, 5, t)).ok) victimOrdinary++;
      });
      for (let i = calls.length - 1; i > 0; i--) {
        const j = Math.floor(order() * (i + 1));
        [calls[i], calls[j]] = [calls[j]!, calls[i]!];
      }
      for (const c of calls) await c();
    }
    return { killPerMinute, victimOrdinary };
  }

  for (const neighbours of [5, 19]) {
    it(`with ${neighbours} other orgs: the victim's kill switches at their full rate (17, then 13 a minute), its ordinary calls exactly as under an ordinary flood alone`, async () => {
      const ordinaryOnly = await run(neighbours, false);
      const everything = await run(neighbours, true);
      for (const r of [ordinaryOnly, everything]) {
        expect(r.killPerMinute[0]).toBeGreaterThanOrEqual(Math.floor((L.kill.burst + 60 * L.kill.ratePerS) / 11));
        for (const m of r.killPerMinute.slice(1)) expect(m).toBeGreaterThanOrEqual(13);
      }
      // Kill switches and no-ops from every neighbour change nothing for the victim's ordinary calls.
      expect(everything.victimOrdinary).toBe(ordinaryOnly.victimOrdinary);
      // Under an ordinary flood its share is about one org's in the shared bucket's 600 a minute: at least a twentieth of it.
      expect(ordinaryOnly.victimOrdinary * 5).toBeGreaterThanOrEqual(Math.floor((3 * 60 * L.platform.ratePerS) / (neighbours + 1) / 4));
    }, 180_000);
  }
});

describe('the hard ceilings with the 20 organisations the cap allows', () => {
  it('idle, then all 20 bursting for two minutes: ordinary ≤ 660 then ≤ 600 a minute; kill ≤ 20 × 194 then ≤ 20 × 150 a minute (each org at most a call’s worth left over)', async () => {
    const stub = fresh();
    const t0 = start() + 10 * MIN; // ten idle minutes: every bucket full
    const orgs = orgsOf(20);
    const ordinaryCost = [0, 0];
    const killCost = [0, 0];
    for (let tick = 0; tick < 2 * 600; tick++) {
      const t = t0 + tick * 100;
      const m = Math.floor(tick / 600);
      for (const org of orgs) {
        if ((await ordinary(stub, org, 13, t)).ok) ordinaryCost[m]! += 13;
        if ((await kill(stub, org, 11, t)).ok) killCost[m]! += 11;
      }
    }
    expect(ordinaryCost[0]).toBeLessThanOrEqual(660);
    expect(ordinaryCost[1]).toBeLessThanOrEqual(600 + 13);
    expect(killCost[0]).toBeLessThanOrEqual(20 * (44 + 150));
    expect(killCost[1]).toBeLessThanOrEqual(20 * (150 + 11));
    // And they are reached, not merely bounded: the shared bucket's minute and every org's kill rate used.
    expect(ordinaryCost[1]).toBeGreaterThanOrEqual(600 - 13);
    expect(killCost[1]).toBeGreaterThanOrEqual(20 * 13 * 11);
  }, 240_000);

  it('a 21st organisation’s kill switches in a minute are refused (failing closed for it alone), until the oldest of the 20 is a minute old; its ordinary calls go on', async () => {
    const stub = fresh();
    const t = start();
    const orgs = orgsOf(21);
    for (const [i, org] of orgs.slice(0, 20).entries()) expect((await kill(stub, org, 1, t + i)).ok).toBe(true);
    const refused = await kill(stub, orgs[20]!, 1, t + 100);
    expect(refused).toMatchObject({ ok: false, limit: 'kill_orgs', retryAfterS: 60 });
    expect((await ordinary(stub, orgs[20]!, 5, t + 100)).ok).toBe(true);
    // One of the 20 again: fine. The 21st at the stated time: the oldest has slid out.
    expect((await kill(stub, orgs[5]!, 1, t + 200)).ok).toBe(true);
    expect((await kill(stub, orgs[20]!, 1, t + 100 + 60_000)).ok).toBe(true);
  });

  it('staff can’t switch the platform on for a 21st organisation: refused in the plan, and in the commit if one was switched on in between', async () => {
    const admin = (e: typeof env = env) => new AdminRpc(createExecutionContext(), e);
    const on = async () => (await rows<{ n: number }>('SELECT COUNT(*) AS n FROM platform_orgs WHERE enabled = 1'))[0]!.n;
    const orgs: string[] = [];
    while ((await on()) < MAX_PLATFORM_ORGS - 1) {
      const o = (await orgApp()).org;
      orgs.push(o);
      await switchOn(o);
    }
    expect(await on()).toBe(MAX_PLATFORM_ORGS - 1);
    // The 20th: allowed. The 21st: refused, nothing written.
    const twentieth = (await orgApp()).org;
    expect(await admin().setPlatformOrg({ ...hana(), orgId: twentieth, enabled: true, reason: 'Onboarding', reviewedKeys: [] })).toMatchObject({ ok: true });
    const extra = (await orgApp()).org;
    const refused = await admin().setPlatformOrg({ ...hana(), orgId: extra, enabled: true, reason: 'Onboarding', reviewedKeys: [] });
    expect(refused).toMatchObject({ ok: false, code: 'conflict', error: PLATFORM_ORGS_FULL });
    expect(await rows('SELECT org_id FROM platform_orgs WHERE org_id = ?1 AND enabled = 1', extra)).toHaveLength(0);
    // Off again for one: the 20th place is free; another switched on between the plan read and the batch takes it.
    expect(await admin().setPlatformOrg({ ...hana(), orgId: twentieth, enabled: false, reason: 'Done' })).toMatchObject({ ok: true });
    const racer = (await orgApp()).org;
    let fired = false;
    const db = new Proxy(env.DB, {
      get(target, p) {
        if (p === 'batch')
          return async (stmts: D1PreparedStatement[]) => {
            if (!fired) {
              fired = true;
              await switchOn(racer);
            }
            return target.batch(stmts);
          };
        const v: unknown = Reflect.get(target, p);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const raced = await admin({ ...env, DB: db }).setPlatformOrg({ ...hana(), orgId: extra, enabled: true, reason: 'Onboarding', reviewedKeys: [] });
    expect(raced).toMatchObject({ ok: false });
    expect(await rows('SELECT org_id FROM platform_orgs WHERE org_id = ?1 AND enabled = 1', extra)).toHaveLength(0);
    expect(await on()).toBe(MAX_PLATFORM_ORGS);
  });
});

describe('L3: every refusal’s retry-after is honest', () => {
  it('ordinary (org, platform, shared), kill bucket, breaker (org and global) and the 21st org: a retry at exactly the stated time, nothing else changed, is admitted', async () => {
    const seen = new Set<string>();
    for (const seed of [1, 935, 4242]) {
      const stub = fresh();
      const r = rng(seed);
      const orgs = orgsOf(22);
      let t = start();
      for (let step = 0; step < 400; step++) {
        t += Math.floor(r() * 300);
        // First four orgs, mostly removals (the breaker's paths); then 22 orgs, mostly kill switches (the 21st org's).
        const early = step < 250;
        const org = orgs[Math.floor(r() * (early ? 4 : 22))]!;
        const kind = r();
        const removalShare = early ? 0.6 : 0.1;
        const call: Omit<PlatformAdmission, 'limits'> =
          kind < removalShare
            ? { org, cost: 11, killSwitch: true, breaker: true }
            : kind < removalShare + (1 - removalShare) / 2
              ? { org, cost: [1, 11][Math.floor(r() * 2)]!, killSwitch: true }
              : { org, cost: [1, 5, 11, 13][Math.floor(r() * 4)]! };
        const a = await stub.platformAdmit({ ...call, limits: L }, t);
        if (a.ok) continue;
        seen.add(a.limit);
        t += a.retryAfterS * 1000;
        const again = await stub.platformAdmit({ ...call, limits: L }, t);
        expect(again, `seed ${seed} step ${step}: ${a.limit} after ${a.retryAfterS} s`).toMatchObject({ ok: true });
      }
    }
    for (const l of ['budget_shared', 'budget_kill', 'breaker_org', 'breaker_global', 'kill_orgs']) expect(seen.has(l), l).toBe(true);
  }, 120_000);

  it('the ordinary paths one at a time: the org’s bucket, the platform’s bucket', async () => {
    // The org's own: one org spaced so the console's floor (30 a second) is never short, its 8 a second is.
    const s1 = fresh();
    const t = start();
    let at = t;
    let refused: Awaited<ReturnType<typeof ordinary>> | null = null;
    for (let i = 0; i < 20 && !refused; i++) {
      const a = await ordinary(s1, 'org_one', 13, (at += 1000));
      if (!a.ok) refused = a;
    }
    expect(refused).toMatchObject({ ok: false, limit: 'budget_org' });
    expect((await ordinary(s1, 'org_one', 13, at + (refused as { retryAfterS: number }).retryAfterS * 1000)).ok).toBe(true);
    // The platform's: the console's floor is short first in a burst, so two fresh orgs a second: the console's 30 a
    // second refills it, the platform's 10 doesn't.
    const s2 = fresh();
    let u = t;
    let short: Awaited<ReturnType<typeof ordinary>> | null = null;
    for (let i = 0; i < 40 && !short; i++) {
      const a = await ordinary(s2, `org_p${i}`, 13, (u += 1000));
      if (!a.ok) short = a;
      const b = await ordinary(s2, `org_q${i}`, 13, u);
      if (!b.ok) short = b;
    }
    expect(short).toMatchObject({ ok: false, limit: 'budget_platform' });
    expect((await ordinary(s2, 'org_retry', 13, u + (short as { retryAfterS: number }).retryAfterS * 1000)).ok).toBe(true);
  });

  it('a key’s kill switch with both its ordinary and its reserve windows full: the wait for whichever opens first', async () => {
    const kobj = fresh();
    const t = start() + 30_000; // 31 s into a minute
    // The day's ordinary window full, the reserve's minute full: the reserve's minute opens first.
    expect((await kobj.hit([{ ...PLATFORM_WINDOWS.key[1]!, max: Number.MAX_SAFE_INTEGER }], t, PLATFORM_REQUEST_LIMITS.perKeyPerDay)).ok).toBe(true);
    for (let i = 0; i < 10; i++) expect((await kobj.hitMark([...PLATFORM_WINDOWS.key], `m${i}`, t + HOUR, t, [...PLATFORM_WINDOWS.killReserve])).ok).toBe(true);
    const r = await kobj.hitMark([...PLATFORM_WINDOWS.key], 'mx', t + HOUR, t, [...PLATFORM_WINDOWS.killReserve]);
    const minuteEnd = Math.ceil(t / MIN) * MIN;
    expect(r).toMatchObject({ ok: false, limit: 'kill:minute', retryAfterS: Math.ceil((minuteEnd - t) / 1000) });
    expect(await kobj.hitMark([...PLATFORM_WINDOWS.key], 'my', t + HOUR, t + (r as { retryAfterS: number }).retryAfterS * 1000, [...PLATFORM_WINDOWS.killReserve])).toMatchObject({ ok: true, reserve: true });
    // Both the reserve's day and the ordinary day full: the sooner day's end.
    const k2 = fresh();
    expect((await k2.hit([{ ...PLATFORM_WINDOWS.key[1]!, max: Number.MAX_SAFE_INTEGER }], t, PLATFORM_REQUEST_LIMITS.perKeyPerDay)).ok).toBe(true);
    expect((await k2.hit([{ ...PLATFORM_WINDOWS.killReserve[1]!, max: Number.MAX_SAFE_INTEGER }], t, PLATFORM_REQUEST_LIMITS.killReservePerKeyPerDay)).ok).toBe(true);
    const both = await k2.hitMark([...PLATFORM_WINDOWS.key], 'z', t + HOUR, t, [...PLATFORM_WINDOWS.killReserve]);
    const dayEnd = Math.ceil(t / DAY) * DAY;
    expect(both).toMatchObject({ ok: false, retryAfterS: Math.ceil((dayEnd - t) / 1000) });
    expect((await k2.hitMark([...PLATFORM_WINDOWS.key], 'z2', t + HOUR, dayEnd, [...PLATFORM_WINDOWS.killReserve])).ok).toBe(true);
  });
});

describe('token conservation on the object’s clock', () => {
  it('random admits and settles, stale and future caller times, clock jumps, costs 0 to 1 000, 24 orgs: no bucket ever holds more than its start plus its refill less what it gave', async () => {
    for (const seed of [7, 99, 935]) {
      const stub = fresh();
      const r = rng(seed);
      const orgs = orgsOf(24);
      let t = start();
      const t0 = t;
      const keys = [...orgs.flatMap((o) => [`platform:bucket:org:${o}`, `platform:kill:org:${o}`]), 'platform:bucket', 'console:bucket'];
      const bucketOf = (key: string) => (key === 'platform:bucket' ? L.platform : key === 'console:bucket' ? L.shared : key.startsWith('platform:kill:') ? L.kill : L.perOrg);
      const spent = new Map<string, number>();
      const removals: { org: string; at: number }[] = [];
      let clock = t0;
      for (let step = 0; step < 500; step++) {
        const jump = r();
        t += jump < 0.05 ? Math.floor(r() * 10 * MIN) : Math.floor(r() * 400);
        const caller = r() < 0.3 ? t - Math.floor(r() * 20_000) : r() < 0.1 ? t + Math.floor(r() * 5000) : t;
        const org = orgs[Math.floor(r() * orgs.length)]!;
        const cost = [0, 1, 11, 44, 45, 1000][Math.floor(r() * 6)]!;
        const op = r();
        if (op < 0.1 && removals.length > 0) {
          const s = removals[Math.floor(r() * removals.length)]!;
          await stub.platformSettle({ org: s.org, at: s.at, breaker: true });
          continue;
        }
        const killSwitch = op < 0.55;
        const breaker = killSwitch && op < 0.25;
        const a = await stub.platformAdmit({ org, cost, ...(killSwitch ? { killSwitch: true } : {}), ...(breaker ? { breaker: true } : {}), limits: L }, caller);
        clock = Math.max(clock, caller);
        if (a.ok) {
          clock = a.at;
          for (const key of killSwitch ? [`platform:kill:org:${org}`] : [`platform:bucket:org:${org}`, 'platform:bucket', 'console:bucket']) spent.set(key, (spent.get(key) ?? 0) + cost);
          if (breaker) removals.push({ org, at: a.at });
        }
        // Every bucket, read now, against its start plus its refill on the object's clock less what was taken.
        const state = await runInDurableObject(stub, (_i, st) => ({ clock: st.storage.kv.get<number>('clock') ?? 0, all: keys.map((k) => st.storage.kv.get<{ tokens: number; at: number }>(k) ?? null) }));
        expect(state.clock).toBeGreaterThanOrEqual(clock);
        for (const [i, key] of keys.entries()) {
          const b = state.all[i];
          if (!b) continue;
          const def = bucketOf(key);
          const now = Math.min(def.burst, b.tokens + (Math.max(0, state.clock - b.at) / 1000) * def.ratePerS);
          const bound = def.burst + ((state.clock - t0) / 1000) * def.ratePerS - (spent.get(key) ?? 0);
          expect(now, `seed ${seed} step ${step} ${key}`).toBeLessThanOrEqual(bound + 1e-3);
          expect(b.tokens, key).toBeGreaterThanOrEqual(0);
          expect(b.at, key).toBeLessThanOrEqual(state.clock);
        }
      }
    }
  }, 120_000);
});

describe('the body: read within 5 s, and the clock read again once it is in', () => {
  const slowBody = (delayMs: number, text = '{}') =>
    new ReadableStream({
      async pull(c) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
  const withBody = (req: Request, body: ReadableStream) => {
    const headers = new Headers(req.headers);
    headers.delete('content-length');
    return new Request(req.url, { method: 'POST', headers, body, duplex: 'half' } as RequestInit);
  };

  it('a body still arriving after 5 s is refused (400), whatever the key', async () => {
    const k = await seedKey();
    const now = Date.now();
    const sent = await send(k, { now, method: 'POST', path: '/v1/platform/credential/revoke', body: '{}', nonce: b64url(crypto.getRandomValues(new Uint8Array(16))) });
    const ctx = createExecutionContext();
    const res = await handlePlatform(withBody(sent.request(), slowBody(6000)), new URL(sent.request().url), env, 'slow-1', ctx, now);
    await waitOnExecutionContext(ctx);
    const r = await read(res);
    expect([r.status, r.body.code]).toEqual([400, 'bad_request']);
    expect(String(r.body.error)).toMatch(/longer than 5 seconds/u);
  }, 20_000);

  it('the timestamp window is checked again after the body: 58 s old at the start and a 3 s upload is stale', async () => {
    const k = await seedKey();
    const signedAt = Date.now() - 58_000;
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
    // Signed 58 s ago (the first delivery, injected at that time, only builds the request).
    const sent = await send(k, { now: signedAt, timestampMs: signedAt, method: 'POST', path: '/v1/platform/apps', body: '{}', idempotencyKey: 'slow-upload-1', nonce });
    const ctx = createExecutionContext();
    const res = await handlePlatform(withBody(sent.request(), slowBody(3000)), new URL(sent.request().url), env, 'slow-2', ctx);
    await waitOnExecutionContext(ctx);
    const r = await read(res);
    expect([r.status, r.body.code]).toEqual([400, 'stale_request']);
  }, 20_000);
});

describe('after PR 161’s third review', () => {
  /** The object with the production clamp on (the tests' env lifts it): its env without LIMITER_TRUST_CALLER_CLOCK. */
  const clamped = async (stub: Stub) => {
    await runInDurableObject(stub, (instance) => {
      const o = instance as unknown as { env: typeof env };
      o.env = { ...o.env, LIMITER_TRUST_CALLER_CLOCK: undefined };
    });
    return stub;
  };

  it('M1: with the clamp, a caller time an hour or ten years ahead moves the clock at most 5 s, logged; nonce replay, the console’s bucket and a key’s window behave normally', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((l: unknown) => void errors.push(String(l)));
    try {
      for (const ahead of [HOUR, 10 * 365 * DAY]) {
        // The nonce object: a nonce reserved with a far-future caller time is still held a moment later.
        const nonce = await clamped(fresh());
        const real = Date.now();
        expect(await nonce.reserveNonce('n1', real + 120_000, [], real + ahead)).toBe('ok');
        expect(await nonce.reserveNonce('n1', real + 120_000, [], real)).toBe('replayed');
        expect(await nonce.reserveNonce('n2', real + 120_000, [], real)).toBe('ok');
        const clock = (await stored(nonce, 'none')).clock;
        expect(clock).toBeLessThanOrEqual(Date.now() + 5000);
        // The console's bucket: drained by calls stamped ahead, it refills as usual and its waits are seconds.
        const cpc = await clamped(fresh());
        let refused: { retryAfterS: number } | null = null;
        for (let i = 0; i < 20 && !refused; i++) {
          const r = await cpc.consoleAdmit({ org: 'org_c', cost: 8, limits: CONSOLE_LIMITS }, Date.now() + ahead);
          if (!r.ok) refused = r;
        }
        expect(refused!.retryAfterS).toBeLessThanOrEqual(10);
        // A key's window: filled with calls stamped ahead, still this minute's (a call now is refused, for under a minute).
        const k = await clamped(fresh());
        for (let i = 0; i < PLATFORM_REQUEST_LIMITS.perKeyPerMinute; i++) await k.hit([...PLATFORM_WINDOWS.key], Date.now() + ahead);
        const r = await k.hit([...PLATFORM_WINDOWS.key], Date.now());
        expect(r).toMatchObject({ ok: false });
        expect((r as { retryAfterS: number }).retryAfterS).toBeLessThanOrEqual(66);
      }
      expect(errors.some((l) => l.includes('"caller_clock_ahead"') && l.includes('"aheadMs"'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('M1: the tests’ lift of the clamp needs both the var and the tests’ env name', () => {
    expect(env.LIMITER_TRUST_CALLER_CLOCK).toBe('1');
    expect(env.ENV_NAME).toBe('sandbox-test');
  });

  it('L1: a marker or a nonce past its not-after on the object’s clock is refused, not reserved anew', async () => {
    const stub = fresh();
    const t = start();
    expect(await stub.reserveFresh('m', t + 120_000, t + 60_000, t)).toBe('ok');
    expect(await stub.reserveFresh('m', t + 120_000, t + 60_000, t + 1000)).toBe('used');
    expect(await stub.reserveFresh('m2', t + 200_000, t + 60_000, t + 90_000)).toBe('stale');
    // The stale one wrote nothing.
    expect(await stub.marked('m2', t + 90_000)).toBe(false);
    expect(await stub.reserveNonce('n', t + 120_000, [...PLATFORM_WINDOWS.nonce], t + 61_000, t + 60_000)).toBe('stale');
    // Within its window: fine; the one refused as stale was never marked.
    const s2 = fresh();
    expect(await s2.reserveNonce('n', t + 120_000, [...PLATFORM_WINDOWS.nonce], t + 30_000, t + 60_000)).toBe('ok');
    expect(await s2.reserveNonce('n', t + 120_000, [...PLATFORM_WINDOWS.nonce], t + 40_000, t + 60_000)).toBe('replayed');
  });

  it('L1 through the handler: a request checked fresh but held up past its window before the nonce is refused as stale', async () => {
    const k = await seedKey();
    const signedAt = Date.now() - 50_000;
    const sent = await send(k, { now: signedAt, timestampMs: signedAt, nonce: b64url(crypto.getRandomValues(new Uint8Array(16))) });
    // A D1 that stalls its first read 11 s: the request is fresh at its checks, 61 s old when its nonce is reserved
    // (without the stall the same request is a replay, 409).
    let stalled = false;
    const wrap = (st: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(st, {
        get(t2, q2) {
          if (q2 === 'bind') return (...args: unknown[]) => wrap(t2.bind(...args));
          if ((q2 === 'first' || q2 === 'all' || q2 === 'raw') && !stalled)
            return async (...args: unknown[]) => {
              stalled = true;
              await new Promise((resolve) => setTimeout(resolve, 11_000));
              return (t2[q2] as (...a: unknown[]) => unknown).apply(t2, args);
            };
          const v: unknown = Reflect.get(t2, q2);
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t2) : v;
        },
      });
    const slowDb = new Proxy(env.DB, {
      get(target, p) {
        if (p === 'prepare') return (sql: string) => wrap(target.prepare(sql));
        const v: unknown = Reflect.get(target, p);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const ctx = createExecutionContext();
    const req = sent.request();
    const res = await handlePlatform(new Request(req.url, { method: req.method, headers: req.headers }), new URL(req.url), { ...env, DB: slowDb }, 'stall-1', ctx);
    await waitOnExecutionContext(ctx);
    const r = await read(res);
    expect([r.status, r.body.code]).toEqual([400, 'stale_request']);
  }, 30_000);

  it('L2: an organisation switched off leaves the count of organisations using kill switches at once', async () => {
    const cpc = placedStub(env, env.RATE_LIMITER, 'console-rpc');
    const t = Date.now();
    const twenty = await Promise.all(Array.from({ length: 20 }, async () => (await orgApp()).org));
    for (const o of twenty) expect((await cpc.platformAdmit({ org: o, cost: 1, killSwitch: true, limits: L }, t)).ok).toBe(true);
    const newcomer = (await orgApp()).org;
    expect(await cpc.platformAdmit({ org: newcomer, cost: 1, killSwitch: true, limits: L }, t + 10)).toMatchObject({ ok: false, limit: 'kill_orgs' });
    // Staff switch one of the twenty off: its place is free at once.
    const gone = twenty[0]!;
    await switchOn(gone);
    expect(await new AdminRpc(createExecutionContext(), env).setPlatformOrg({ ...hana(), orgId: gone, enabled: false, reason: 'Offboarded' })).toMatchObject({ ok: true });
    expect((await cpc.platformAdmit({ org: newcomer, cost: 1, killSwitch: true, limits: L }, t + 20)).ok).toBe(true);
  });
});

describe('after PR 161’s focused review', () => {
  const clampedStub = async () => {
    const stub = fresh();
    await runInDurableObject(stub, (instance) => {
      const o = instance as unknown as { env: typeof env };
      o.env = { ...o.env, LIMITER_TRUST_CALLER_CLOCK: undefined };
    });
    return stub;
  };

  it('a peek writes nothing: with a caller 8 s ahead of the object (clamped), peek then mark succeeds; the old peek by `reserve` blocked the mark', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const stub = await clampedStub();
      const ahead = Date.now() + 8000;
      // As near/relay.ts and evm/sponsor.ts now do: a read, then the real mark.
      expect(await stub.marked('digest', ahead)).toBe(false);
      expect(await stub.reserve('digest', ahead + 60_000, ahead)).toBe(true);
      expect(await stub.marked('digest', ahead)).toBe(true);
      // The old way: a `reserve` ending at the caller's time left a live marker (8 s − 5 s) that refused the real one.
      const old = await clampedStub();
      expect(await old.reserve('digest', ahead, ahead)).toBe(true);
      expect(await old.reserve('digest', ahead + 60_000, ahead)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('`caller_clock_ahead` is logged at most once a minute per object', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((l: unknown) => void lines.push(String(l)));
    try {
      const stub = await clampedStub();
      for (let i = 0; i < 5; i++) await stub.hit([{ name: 'w', windowMs: MIN, max: 100 }], Date.now() + HOUR);
      expect(lines.filter((l) => l.includes('"caller_clock_ahead"'))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
