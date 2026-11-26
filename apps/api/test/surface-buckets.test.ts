// D938: the signed platform API and the partner console never share a bucket. An ordinary platform call draws only on
// the platform's own buckets (its org's, 8 statements a second, burst 40, and the platform's global one, 10 a second,
// burst 60); an ordinary console call only on the console's (its org's, 10 a second, burst 40, and the console's global
// one, 30 a second, burst 60). Before D938 an ordinary platform call also needed the console's `console:bucket` at its
// cost plus 30 and took its cost from it: the floor protected the console from the platform, but three organisations'
// console members flooding reads held that bucket low and refused every network's ordinary calls (a reviewer measured 0
// of 300). The kill-switch budgets, breakers, stops quotas and per-key windows are unchanged and stay apart. Each "before"
// below was measured by running this file against the code before D938. Against the real `RateLimiter` Durable Object,
// the real admission (`admitMemberCall`) and the real platform handler; its own file: its own database and objects.
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONSOLE_LIMITS, admitMemberCall } from '../src/changes/guard.ts';
import { PLATFORM_LIMITS } from '../src/platform/request.ts';
import { PLATFORM_ROUTES } from '../src/platform/routes.ts';
import type { ConsoleAdmission, PlatformAdmission } from '../src/rate-limiter.ts';
import { CONSOLE_COSTS } from '../src/rpc/console.ts';
import { freshNow, seedKey, send } from './platform-helpers.ts';
import { orgApp } from './rpc-helpers.ts';

afterEach(() => vi.restoreAllMocks());

const MIN = 60_000;
const HOUR = 60 * MIN;
const P = PLATFORM_LIMITS;
const C = CONSOLE_LIMITS;

let n = 0;
/** A limiter object of its own (its own clock and buckets). */
const fresh = () => env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`d938-buckets-${Date.now()}-${++n}`));
type Stub = ReturnType<typeof fresh>;
/** A start ahead of real time, a second into a fresh hour. */
const start = () => Math.ceil(Date.now() / HOUR) * HOUR + (++n % 1000) * 4 * HOUR + 1000;
const orgsOf = (k: number, tag: string) => Array.from({ length: k }, (_, i) => `${tag}_${n}_${i}`);
/** A seeded pseudo-random stream. */
const rng = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pOrdinary = (s: Stub, org: string, cost: number, at: number) => s.platformAdmit({ org, cost, limits: P }, at);
const pKill = (s: Stub, org: string, cost: number, at: number) => s.platformAdmit({ org, cost, killSwitch: true, limits: P }, at);
const cOrdinary = (s: Stub, org: string, cost: number, at: number) => s.consoleAdmit({ org, cost, limits: C }, at);
const cKill = (s: Stub, org: string, cost: number, at: number) => s.consoleAdmit({ org, cost, killSwitch: true, limits: C }, at);
type Bk = { tokens: number; at: number } | null;
/** Every bucket, list and marker the object holds (but its clock), and the clock. */
const snapshot = (s: Stub) =>
  runInDurableObject(s, (_i, st) => {
    const all: Record<string, unknown> = {};
    for (const [k, v] of st.storage.kv.list()) if (k !== 'clock') all[k] = v;
    return { clock: st.storage.kv.get<number>('clock') ?? 0, all };
  });
const held = (b: Bk, def: { ratePerS: number; burst: number }, at: number) => (b ? Math.min(def.burst, b.tokens + (Math.max(0, at - b.at) / 1000) * def.ratePerS) : def.burst);
const onlyPrefix = (all: Record<string, unknown>, prefix: string) => Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith(prefix)));

/** A console read (`getApp`) and a platform read (`GET /v1/platform/credential`): 4 statements each. */
const CONSOLE_READ = CONSOLE_COSTS.getApp;
const PLATFORM_READ = PLATFORM_ROUTES.find((r) => r.method === 'GET' && r.path === '/v1/platform/credential')!.cost;
const PLATFORM_MAX = Math.max(...PLATFORM_ROUTES.map((r) => r.cost));

describe('the numbers: two surfaces, no bucket in common', () => {
  it('the platform’s limits name no console bucket; the combined ordinary ceiling on the hot D1', () => {
    expect([CONSOLE_READ, PLATFORM_READ, PLATFORM_MAX]).toEqual([4, 4, 13]);
    // Before D938: also `shared: { ratePerS: 30, burst: 60, sharedFloor: 30 }` (the console's global bucket and its floor).
    expect(Object.keys(P).sort()).toEqual(['breaker', 'kill', 'maxOrgs', 'perOrg', 'platform']);
    expect([P.perOrg, P.platform]).toEqual([
      { ratePerS: 8, burst: 40 },
      { ratePerS: 10, burst: 60 },
    ]);
    expect([C.perOrg, C.global]).toEqual([
      { ratePerS: 10, burst: 40 },
      { ratePerS: 30, burst: 60 },
    ]);
    // Ordinary calls of both surfaces together: 1 860 + 660 = 2 520 statements in a first minute, 2 400 a minute after
    // (before D938: the platform's inside the console's, 1 860 then 1 800).
    expect(C.global.burst + 60 * C.global.ratePerS + P.platform.burst + 60 * P.platform.ratePerS).toBe(2520);
    expect(60 * (C.global.ratePerS + P.platform.ratePerS)).toBe(2400);
  });

  it('an ordinary platform call reads and writes only `platform:` keys, an ordinary console call only `console:` keys', async () => {
    const stub = fresh();
    const t = start();
    for (let i = 0; i < 5; i++) expect((await pOrdinary(stub, 'net_a', PLATFORM_READ, t)).ok).toBe(true);
    const afterPlatform = await snapshot(stub);
    // Before D938 `console:bucket` was written here too (60 − 20 = 40).
    expect(Object.keys(afterPlatform.all).sort()).toEqual(['platform:bucket', 'platform:bucket:org:net_a']);
    for (let i = 0; i < 5; i++) expect((await cOrdinary(stub, 'org_a', CONSOLE_READ, t)).ok).toBe(true);
    const afterConsole = await snapshot(stub);
    expect(onlyPrefix(afterConsole.all, 'platform:')).toEqual(afterPlatform.all);
    expect(Object.keys(onlyPrefix(afterConsole.all, 'console:')).sort()).toEqual(['console:bucket', 'console:bucket:org:org_a']);
  });
});

describe('a console ordinary flood leaves the platform’s ordinary calls at their own rate (the reviewer’s scenario)', () => {
  // Console members of `readers` orgs try 3 reads (4) every 200 ms each, more than their org's 10 a second (3 orgs at
  // their full rate are the console's whole 30 a second); 3 networks each try a platform read (4) every 200 ms for a
  // minute: 300 tries each.
  async function run(readers: number, networks: number) {
    const stub = fresh();
    const t0 = start();
    const rs = orgsOf(readers, 'reader');
    const nets = orgsOf(networks, 'network');
    const perNetwork = nets.map(() => 0);
    let consoleOk = 0;
    let consoleLow = 0;
    for (let tick = 0; tick < 300; tick++) {
      const t = t0 + tick * 200;
      for (const r of rs) for (let i = 0; i < 3; i++) if ((await cOrdinary(stub, r, CONSOLE_READ, t)).ok) consoleOk++;
      if (readers > 0) {
        const b = (await snapshot(stub)).all['console:bucket'] as Bk;
        // Below what the old gate needed for a platform read (its cost plus the floor of 30).
        if (held(b, C.global, t) < PLATFORM_READ + 30) consoleLow++;
      }
      for (const [j, net] of nets.entries()) if ((await pOrdinary(stub, net, PLATFORM_READ, t)).ok) perNetwork[j]!++;
    }
    return { perNetwork, consoleOk, consoleLow };
  }

  for (const readers of [3, 10]) {
    it(`${readers} organisations’ console members flooding reads: every network’s ordinary calls exactly as with no console traffic (before D938: 0 of 300 each)`, async () => {
      const platformOnly = await run(0, 3);
      const consoleOnly = await run(readers, 0);
      const both = await run(readers, 3);
      // The flood is real: the console's global bucket is below the old gate's 34 at nearly every tick.
      expect(both.consoleLow).toBeGreaterThanOrEqual(295);
      // Before D938 (measured on the old code): [0, 0, 0] of 300 each, refused `budget_shared`. Now as with no console
      // traffic (about [129, 31, 4]): the first network at its org's own 8 a second, the three at the platform's 10.
      expect(both.perNetwork).toEqual(platformOnly.perNetwork);
      expect(both.perNetwork[0]).toBeGreaterThanOrEqual(Math.floor((P.perOrg.burst + 59 * P.perOrg.ratePerS) / PLATFORM_READ));
      for (const k of both.perNetwork) expect(k).toBeGreaterThan(0);
      // The networks together at the platform's own global bucket: 60 + 600 statements in the minute, reached.
      const total = both.perNetwork.reduce((a, b) => a + b, 0) * PLATFORM_READ;
      expect(total).toBeLessThanOrEqual(P.platform.burst + 60 * P.platform.ratePerS);
      expect(total).toBeGreaterThan(P.platform.burst + 60 * P.platform.ratePerS - 3 * PLATFORM_READ);
      // And the console's own reads exactly as without the platform's.
      expect(both.consoleOk).toBe(consoleOnly.consoleOk);
    }, 180_000);
  }
});

describe('a platform ordinary flood from 20 organisations leaves the console’s ordinary calls at their own rate', () => {
  // 20 networks (the cap) each try their costliest call (13) every 200 ms for a minute; 4 console orgs read (4) once a
  // second each; then, after six quiet seconds, both burst at once.
  async function run(networks: number) {
    const stub = fresh();
    const t0 = start();
    const nets = orgsOf(networks, 'network');
    const readers = orgsOf(4, 'reader');
    let platform = 0;
    let consoleOk = 0;
    let consoleNo = 0;
    for (let tick = 0; tick < 300; tick++) {
      const t = t0 + tick * 200;
      for (const net of nets) if ((await pOrdinary(stub, net, PLATFORM_MAX, t)).ok) platform += PLATFORM_MAX;
      if (tick % 5 === 0) for (const r of readers) ((await cOrdinary(stub, r, CONSOLE_READ, t)).ok ? consoleOk++ : consoleNo++);
    }
    // Six quiet seconds (the platform's bucket full again), then the 20 networks' burst and, at the same instant, the
    // console's: as many reads as it admits, across the 4 orgs (their own 40 each).
    const t = t0 + 300 * 200 + 6000;
    for (const net of nets) await pOrdinary(stub, net, PLATFORM_MAX, t);
    let burst = 0;
    for (let i = 0; i < 40; i++) if ((await cOrdinary(stub, readers[i % 4]!, CONSOLE_READ, t)).ok) burst++;
    return { platform, consoleOk, consoleNo, burst };
  }

  it('the console’s reads and its whole burst as with no platform traffic (before D938: its burst cut to the floor’s 30); the platform at its own 10 a second', async () => {
    const consoleOnly = await run(0);
    const both = await run(20);
    expect([consoleOnly.consoleOk, consoleOnly.consoleNo]).toEqual([240, 0]);
    expect([both.consoleOk, both.consoleNo]).toEqual([240, 0]);
    // The console's global bucket whole: 60 / 4 = 15 reads at once. Before D938 (measured): 8, the networks' burst
    // having taken the console's bucket down to 34 (two calls of 13 from 60; the third needed 13 + 30).
    expect(consoleOnly.burst).toBe(15);
    expect(both.burst).toBe(consoleOnly.burst);
    // The platform's own global bucket caps 20 organisations' ordinary calls at 60 + 10 a second (660 in the minute).
    expect(both.platform).toBeLessThanOrEqual(P.platform.burst + 60 * P.platform.ratePerS);
    expect(both.platform).toBeGreaterThan(P.platform.burst + 60 * P.platform.ratePerS - PLATFORM_MAX);
  }, 180_000);

  it('the platform’s ordinary load is the same 10 a second with 5 or 20 organisations', async () => {
    const totals: number[] = [];
    for (const k of [5, 20]) {
      const stub = fresh();
      const t0 = start();
      const nets = orgsOf(k, 'network');
      let s = 0;
      for (let tick = 0; tick < 150; tick++) for (const net of nets) if ((await pOrdinary(stub, net, PLATFORM_MAX, t0 + tick * 200)).ok) s += PLATFORM_MAX;
      totals.push(s);
    }
    // 30 s: 60 + 300 statements whatever the number of organisations (each org's 8 a second is no bound at 5 × 8 = 40).
    for (const s of totals) {
      expect(s).toBeLessThanOrEqual(P.platform.burst + 30 * P.platform.ratePerS);
      expect(s).toBeGreaterThan(P.platform.burst + 30 * P.platform.ratePerS - PLATFORM_MAX);
    }
  }, 120_000);
});

describe('both floods at once: the combined ordinary ceiling, and the kill switches of both sides unchanged', () => {
  // 10 console orgs (8 a call, once every 200 ms each) and 20 networks (13 every 200 ms each) flood ordinary calls for
  // two minutes on a fresh object; a platform victim tries a kill switch (11) and a console victim one (6) every 200 ms.
  async function run(flood: boolean) {
    const stub = fresh();
    const t0 = start();
    const readers = flood ? orgsOf(10, 'reader') : [];
    const nets = flood ? orgsOf(20, 'network') : [];
    const ordinary = [
      { console: 0, platform: 0 },
      { console: 0, platform: 0 },
    ];
    const kills = [
      { platform: 0, console: 0 },
      { platform: 0, console: 0 },
    ];
    for (let tick = 0; tick < 600; tick++) {
      const t = t0 + tick * 200;
      const m = Math.floor(tick / 300);
      for (const r of readers) if ((await cOrdinary(stub, r, 8, t)).ok) ordinary[m]!.console += 8;
      for (const net of nets) if ((await pOrdinary(stub, net, PLATFORM_MAX, t)).ok) ordinary[m]!.platform += PLATFORM_MAX;
      if ((await pKill(stub, 'platform_victim', 11, t)).ok) kills[m]!.platform++;
      if ((await cKill(stub, 'console_victim', 6, t)).ok) kills[m]!.console++;
    }
    return { ordinary, kills };
  }

  it('ordinary: ≤ 1 860 + 660 in a first minute and ≤ 2 400 a minute after, and reached (before D938: 1 860 then 1 800, the platform’s inside the console’s); both victims’ kill switches as with no flood', async () => {
    const quiet = await run(false);
    const loud = await run(true);
    const [first, second] = loud.ordinary;
    // Before D938 (measured): console 1 848 then 1 800, platform 0 and 0 (the console's flood held its bucket under the
    // platform's gate). Now both surfaces at their own rates.
    expect(first!.console).toBeLessThanOrEqual(C.global.burst + 60 * C.global.ratePerS);
    expect(first!.platform).toBeLessThanOrEqual(P.platform.burst + 60 * P.platform.ratePerS);
    expect(first!.console + first!.platform).toBeLessThanOrEqual(2520);
    // A minute later: each at most its rate and a call's worth left over, and each reached within a call.
    expect(second!.console).toBeLessThanOrEqual(1800 + 8);
    expect(second!.platform).toBeLessThanOrEqual(600 + PLATFORM_MAX);
    expect(second!.console).toBeGreaterThanOrEqual(1800 - 8);
    expect(second!.platform).toBeGreaterThanOrEqual(600 - PLATFORM_MAX);
    expect(second!.console + second!.platform).toBeLessThanOrEqual(2400 + 8 + PLATFORM_MAX);
    // Kill switches (tries over 59.8 s a minute): the platform victim's 17 then 14 a minute ((44 + 149.5) / 11, then
    // the leftover and 150), the console victim's 19 then 10 ((60 + 59.8) / 6, 60 / 6), exactly as with no ordinary
    // traffic at all (the same before D938, measured: kill budgets were already apart).
    expect(quiet.kills).toEqual([
      { platform: 17, console: 19 },
      { platform: 14, console: 10 },
    ]);
    expect(loud.kills).toEqual(quiet.kills);
  }, 240_000);
});

describe('token conservation for the buckets of both surfaces', () => {
  it('random admits and settles of both surfaces, stale and future caller times, clock jumps: every bucket within its start plus its refill less what it gave; no call touches the other surface’s keys', async () => {
    for (const seed of [5, 938, 31337]) {
      const stub = fresh();
      const r = rng(seed);
      const orgs = orgsOf(12, 'org');
      let t = start();
      const t0 = t;
      // The object's clock starts at t0, so no bucket is born before it.
      expect((await stub.consoleAdmit({ org: 'clock', cost: 0, limits: C }, t0)).ok).toBe(true);
      const keys = [
        ...orgs.flatMap((o) => [`platform:bucket:org:${o}`, `platform:kill:org:${o}`, `console:bucket:org:${o}`, `console:kill:org:${o}`]),
        'platform:bucket',
        'console:bucket',
        'console:kill',
      ];
      const defOf = (key: string) =>
        key === 'platform:bucket'
          ? P.platform
          : key === 'console:bucket'
            ? C.global
            : key === 'console:kill'
              ? C.kill.global
              : key.startsWith('platform:kill:')
                ? P.kill
                : key.startsWith('platform:')
                  ? P.perOrg
                  : key.startsWith('console:kill:')
                    ? C.kill.perOrg
                    : C.perOrg;
      const given = new Map<string, number>();
      const pBreakers: { org: string; at: number }[] = [];
      const cBreakers: { org: string; at: number }[] = [];
      let clock = t0;
      for (let step = 0; step < 500; step++) {
        t += r() < 0.05 ? Math.floor(r() * 10 * MIN) : Math.floor(r() * 300);
        const caller = r() < 0.3 ? t - Math.floor(r() * 20_000) : r() < 0.1 ? t + Math.floor(r() * 5000) : t;
        const org = orgs[Math.floor(r() * orgs.length)]!;
        const cost = [0, 1, 4, 8, 13, 44, 61, 1000][Math.floor(r() * 8)]!;
        const surface = r() < 0.5 ? 'platform' : 'console';
        const op = r();
        if (op < 0.08) {
          const list = surface === 'platform' ? pBreakers : cBreakers;
          if (list.length > 0) {
            const s = list[Math.floor(r() * list.length)]!;
            if (surface === 'platform') await stub.platformSettle({ org: s.org, at: s.at, breaker: true });
            else await stub.consoleSettle({ org: s.org, at: s.at, breaker: true });
          }
          continue;
        }
        const killSwitch = op < 0.45;
        const breaker = op < 0.2;
        const before = await snapshot(stub);
        const call = { org, cost, ...(killSwitch ? { killSwitch: true } : {}), ...(breaker ? { breaker: true } : {}) };
        const a = surface === 'platform' ? await stub.platformAdmit({ ...call, limits: P } as PlatformAdmission, caller) : await stub.consoleAdmit({ ...call, limits: C } as ConsoleAdmission, caller);
        clock = Math.max(clock, caller);
        const after = await snapshot(stub);
        // Nothing of the other surface changes (before D938 an ordinary platform call wrote `console:bucket`).
        const other = surface === 'platform' ? 'console:' : 'platform:';
        expect(onlyPrefix(after.all, other), `seed ${seed} step ${step}`).toEqual(onlyPrefix(before.all, other));
        if (a.ok) {
          clock = a.at;
          const touched = keys.filter((k) => (after.all[k] ?? null) !== null && JSON.stringify(after.all[k]) !== JSON.stringify(before.all[k] ?? null));
          // What each bucket gave: the cost, or what it held when a console kill switch passed on its org's floor.
          for (const key of touched) given.set(key, (given.get(key) ?? 0) + Math.min(cost, held((before.all[key] as Bk) ?? null, defOf(key), a.at)));
          if (breaker) (surface === 'platform' ? pBreakers : cBreakers).push({ org, at: a.at });
        }
        expect(after.clock).toBeGreaterThanOrEqual(clock);
        for (const key of keys) {
          const b = (after.all[key] as Bk) ?? null;
          if (!b) continue;
          const def = defOf(key);
          const bound = def.burst + ((after.clock - t0) / 1000) * def.ratePerS - (given.get(key) ?? 0);
          expect(held(b, def, after.clock), `seed ${seed} step ${step} ${key}`).toBeLessThanOrEqual(bound + 1e-3);
          expect(b.tokens, key).toBeGreaterThanOrEqual(0);
          expect(b.at, key).toBeLessThanOrEqual(after.clock);
        }
      }
    }
  }, 240_000);
});

describe('honest retry-afters on both surfaces, per stage', () => {
  it('both surfaces interleaved: every refusal retried at exactly its stated time, nothing else changed, is admitted', async () => {
    const seen = new Set<string>();
    for (const seed of [2, 938, 7777]) {
      const stub = fresh();
      const r = rng(seed);
      const nets = orgsOf(8, 'network');
      const orgs = orgsOf(8, 'org');
      let t = start();
      for (let step = 0; step < 500; step++) {
        t += Math.floor(r() * 150);
        const platform = r() < 0.5;
        const few = step % 100 < 50;
        const org = (platform ? nets : orgs)[Math.floor(r() * (few ? 1 : 8))]!;
        const kind = r();
        const cost = platform ? [1, 4, 13][Math.floor(r() * 3)]! : [1, 4, 8, 30][Math.floor(r() * 4)]!;
        const call = kind < 0.15 ? { org, cost: platform ? 11 : 6, killSwitch: true } : { org, cost };
        const admit = (at: number) => (platform ? stub.platformAdmit({ ...call, limits: P }, at) : stub.consoleAdmit({ ...call, limits: C }, at));
        const a = await admit(t);
        if (a.ok) continue;
        seen.add(`${platform ? 'platform' : 'console'}:${a.limit}`);
        t += a.retryAfterS * 1000;
        expect(await admit(t), `seed ${seed} step ${step}: ${a.limit} after ${a.retryAfterS} s`).toMatchObject({ ok: true });
      }
    }
    for (const l of ['platform:budget_org', 'platform:budget_platform', 'console:budget_org', 'console:budget']) expect(seen.has(l), l).toBe(true);
    // No platform refusal names a console bucket (before D938: `budget_shared`).
    expect([...seen].filter((l) => l.startsWith('platform:') && !['platform:budget_org', 'platform:budget_platform', 'platform:budget_kill'].includes(l))).toEqual([]);
  }, 120_000);

  it('the other surface’s empty bucket asks for no wait: a platform read passes at once beside an empty `console:bucket`, a console read beside an empty `platform:bucket`', async () => {
    const stub = fresh();
    const t = start();
    // The console's global bucket emptied (60) by four orgs' reads.
    for (let i = 0; i < 15; i++) expect((await cOrdinary(stub, `reader_${i % 4}`, CONSOLE_READ, t)).ok).toBe(true);
    expect(await cOrdinary(stub, 'reader_x', CONSOLE_READ, t)).toMatchObject({ ok: false, limit: 'budget', retryAfterS: 1 });
    // Before D938: refused `budget_shared`, retry-after 2 s ((4 + 30) / 30 a second).
    // The platform's global bucket emptied (60) by networks' calls; the console's refilled a second later.
    for (let i = 0; i < 15; i++) await pOrdinary(stub, `net_${i % 3}`, PLATFORM_READ, t);
    expect(await pOrdinary(stub, 'net_y', PLATFORM_READ, t)).toMatchObject({ ok: false, limit: 'budget_platform' });
    expect(await cOrdinary(stub, 'reader_y', CONSOLE_READ, t + 1000)).toMatchObject({ ok: true });
    // A stated platform wait is honest: retried then, admitted.
    const w = (await pOrdinary(stub, 'net_y', PLATFORM_READ, t + 1000)) as { ok: false; retryAfterS: number } | { ok: true };
    if (!w.ok) expect((await pOrdinary(stub, 'net_y', PLATFORM_READ, t + 1000 + w.retryAfterS * 1000)).ok).toBe(true);
  });
});

describe('through the real handlers', () => {
  /** RATE_LIMITER's stubs with some methods replaced (the rest bound to the real stub). */
  function wrapStubs(over: Partial<Record<string, (...a: never[]) => unknown>>) {
    const get = env.RATE_LIMITER.get.bind(env.RATE_LIMITER);
    vi.spyOn(env.RATE_LIMITER, 'get').mockImplementation((id, o) => {
      const stub = get(id, o);
      return new Proxy(stub, {
        get(t, p) {
          if (typeof p === 'string' && over[p]) return over[p];
          return typeof p === 'string' && p !== 'then' ? (...a: unknown[]) => (t as unknown as Record<string, (...x: unknown[]) => unknown>)[p]!(...a) : Reflect.get(t, p);
        },
      });
    });
  }

  it('three organisations’ console members reading at their full rate: a network’s signed reads all answered 200 (before D938: 0 of 30, each 429 `platform:budget_shared`)', async () => {
    const k = await seedKey();
    const now = freshNow();
    const readers = await Promise.all(Array.from({ length: 3 }, async () => (await orgApp()).org));
    const answers: (number | string)[] = [];
    for (let s = 0; s < 30; s++) {
      const t = now + s * 1000;
      // Each org's 10 a second and more: the console's 30 a second all used.
      for (const r of readers) for (let i = 0; i < 4; i++) await admitMemberCall(env, { org: r, cost: CONSOLE_READ }, t).catch(() => undefined);
      const res = await send(k, { now: t + 1 });
      answers.push(res.status === 200 ? 200 : String(res.body.limit));
    }
    expect(answers).toEqual(Array(30).fill(200));
  }, 120_000);

  it('fails closed: the platform’s admission erroring answers 503 `rate_limiter_unavailable` and charges nothing; the console’s erroring admits nothing', async () => {
    const k = await seedKey();
    const now = freshNow();
    wrapStubs({ platformAdmit: () => Promise.reject(new Error('limiter down')) });
    const down = await send(k, { now });
    expect([down.status, down.body.code]).toEqual([503, 'rate_limiter_unavailable']);
    vi.restoreAllMocks();
    // The key's windows were given back: its next request is admitted.
    expect((await send(k, { now: now + 1 })).status).toBe(200);
    const org = (await orgApp()).org;
    wrapStubs({ consoleAdmit: () => Promise.reject(new Error('limiter down')) });
    await expect(admitMemberCall(env, { org, cost: CONSOLE_READ }, now)).rejects.toThrow();
    vi.restoreAllMocks();
    expect(await admitMemberCall(env, { org, cost: CONSOLE_READ }, now + 2)).toMatchObject({ at: expect.any(Number) });
  });
});
