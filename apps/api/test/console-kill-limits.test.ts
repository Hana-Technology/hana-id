// D937: the partner console's kill switches, isolated from every other organisation. Two budget classes that never
// charge each other on the `console-rpc` object's own clock: ordinary calls take the org's bucket and the console's
// global bucket (no reserve); kill switches take the org's kill bucket and the global kill bucket only, each org's first
// 5 of a rolling minute past the global kill bucket. Suspensions out of the breaker, on the org's own 20 a clock hour
// (as publishable key revocations, D935); the breaker's removals and rotations with each org's first 3 of its hour past
// the global 20. No token is ever given back. Against the real Durable Object and the real ConsoleRpc handlers; its own
// file: its own database and objects.
import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONSOLE_KEY_REVOKES, CONSOLE_LIMITS, CONSOLE_LIMITER, CONSOLE_SUSPENSIONS } from '../src/changes/guard.ts';
import { placedStub } from '../src/placement.ts';
import type { ConsoleAdmission } from '../src/rate-limiter.ts';
import { CONSOLE_COSTS, ConsoleRpc } from '../src/rpc/console.ts';
import { ORIGIN } from './helpers.ts';
import { autoApprovePolicy } from './vault-helpers.ts';
import { adminRpc, appRow, consoleRpc, hana, member, newOrg, orgApp, ownClock, rows } from './rpc-helpers.ts';

afterEach(() => vi.restoreAllMocks());

const MIN = 60_000;
const HOUR = 60 * MIN;
const L = CONSOLE_LIMITS;
const SECOND = 'https://second.example.com';

let n = 0;
/** A limiter object of its own (its own clock and buckets). */
const fresh = () => env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`d937-limits-${Date.now()}-${++n}`));
type Stub = ReturnType<typeof fresh>;
/** A start ahead of real time, a second into a fresh hour. */
const start = () => Math.ceil(Date.now() / HOUR) * HOUR + (++n % 1000) * 4 * HOUR + 1000;
const ordinary = (stub: Stub, org: string, cost: number, at: number) => stub.consoleAdmit({ org, cost, limits: L }, at);
const kill = (stub: Stub, org: string, cost: number, at: number) => stub.consoleAdmit({ org, cost, killSwitch: true, limits: L }, at);
const removal = (stub: Stub, org: string, at: number) => stub.consoleAdmit({ org, cost: CONSOLE_COSTS.removeOrigins, killSwitch: true, breaker: true, limits: L }, at);
const orgsOf = (k: number, tag = 'org') => Array.from({ length: k }, (_, i) => `${tag}_${n}_${i}`);
/** A seeded pseudo-random stream. */
const rng = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
type Bk = { tokens: number; at: number } | null;
/** Buckets' stored states and the object's clock. */
const stored = (stub: Stub, keys: string[]) => runInDurableObject(stub, (_i, st) => ({ clock: st.storage.kv.get<number>('clock') ?? 0, all: keys.map((k) => st.storage.kv.get<{ tokens: number; at: number }>(k) ?? null) as Bk[] }));
const held = (b: Bk, def: { ratePerS: number; burst: number }, at: number) => (b ? Math.min(def.burst, b.tokens + (Math.max(0, at - b.at) / 1000) * def.ratePerS) : def.burst);

/** The console's kill switches and their costs (rpc/console.ts: `killSwitch`). */
const KILL_SWITCHES = ['removeOrigins', 'frameOnlyOrigins', 'turnOff', 'removeLabels', 'setSuspended', 'revokeKey', 'cancelPlatformKey', 'ownerAction'] as const;
const MAX_KILL_COST = Math.max(...KILL_SWITCHES.map((m) => CONSOLE_COSTS[m]));

/** RATE_LIMITER's stubs with some methods replaced (the rest bound to the real stub). */
function wrapStubs(over: (real: Stub) => Partial<Record<string, (...a: never[]) => unknown>>) {
  const get = env.RATE_LIMITER.get.bind(env.RATE_LIMITER);
  vi.spyOn(env.RATE_LIMITER, 'get').mockImplementation((id, o) => {
    const stub = get(id, o);
    const repl = over(stub);
    return new Proxy(stub, {
      get(t, p) {
        if (typeof p === 'string' && repl[p]) return repl[p];
        return typeof p === 'string' && p !== 'then' ? (...a: unknown[]) => (t as unknown as Record<string, (...x: unknown[]) => unknown>)[p]!(...a) : Reflect.get(t, p);
      },
    });
  });
}
/** A breaker slot and nothing else (cost 0): fills the breaker's lists without touching a bucket. */
const slot = (stub: Stub, org: string, at: number) => stub.consoleAdmit({ org, cost: 0, breaker: true, limits: L }, at);
const stops = (org: string) => placedStub(env, env.RATE_LIMITER, `console-stops:${org}`);
const consoleObject = () => placedStub(env, env.RATE_LIMITER, CONSOLE_LIMITER);
const liveKey = async (appId: string) => (await rows<{ id: string }>('SELECT id FROM app_keys WHERE app_id = ?1 AND revoked_at IS NULL ORDER BY id', appId))[0]!.id;

describe('the numbers and the two budget classes', () => {
  it('the limits as built', () => {
    expect(L).toEqual({
      perOrg: { ratePerS: 10, burst: 40 },
      global: { ratePerS: 30, burst: 60 },
      linkRead: { ratePerS: 50, burst: 100 },
      breaker: { windowMs: HOUR, perOrg: 5, global: 20, floor: 3, overflow: 60 },
      kill: { perOrg: { ratePerS: 1, burst: 60 }, global: { ratePerS: 10, burst: 300 }, floor: { windowMs: MIN, calls: 5 } },
    });
    expect(CONSOLE_SUSPENSIONS).toEqual([{ name: 'suspensions:hour', windowMs: HOUR, max: 20 }]);
    expect(CONSOLE_KEY_REVOKES).toEqual([{ name: 'key-revokes:hour', windowMs: HOUR, max: 20 }]);
    // Every kill switch: 10 at once from a full kill bucket, 10 a minute after; the floor's 5 at most 30 statements.
    expect(MAX_KILL_COST).toBe(6);
    for (const m of KILL_SWITCHES) {
      expect(10 * CONSOLE_COSTS[m], m).toBeLessThanOrEqual(L.kill.perOrg.burst);
      expect(Math.floor((60 * L.kill.perOrg.ratePerS) / CONSOLE_COSTS[m]), m).toBeGreaterThanOrEqual(10);
    }
    expect(L.kill.floor.calls * MAX_KILL_COST).toBe(30);
    // The global kill bucket bites only past ten orgs at their full rate.
    expect(L.kill.global.ratePerS).toBe(10 * L.kill.perOrg.ratePerS);
  });

  it('a kill switch takes only its org’s kill bucket and the global kill bucket; an ordinary call never touches a kill bucket', async () => {
    const stub = fresh();
    const t = start();
    const [a, b] = orgsOf(2);
    for (let i = 0; i < 10; i++) expect(await kill(stub, a!, 6, t)).toMatchObject({ ok: true, at: t });
    expect(await kill(stub, a!, 6, t)).toMatchObject({ ok: false, limit: 'budget_kill' });
    const keys = [`console:bucket:org:${a!}`, 'console:bucket', `console:kill:org:${a!}`, 'console:kill'];
    let s = await stored(stub, keys);
    expect(s.all[0]).toBeNull();
    expect(s.all[1]).toBeNull();
    expect(s.all[2]).toMatchObject({ tokens: 0, at: t });
    expect(s.all[3]).toMatchObject({ tokens: 240, at: t });
    // The org's ordinary calls are untouched by its empty kill bucket, and another org's kill switch by anything.
    for (let i = 0; i < 4; i++) expect(await ordinary(stub, a!, 10, t)).toMatchObject({ ok: true });
    expect(await ordinary(stub, a!, 10, t)).toMatchObject({ ok: false, limit: 'budget_org' });
    expect(await kill(stub, b!, 6, t)).toMatchObject({ ok: true });
    s = await stored(stub, keys);
    expect(s.all[2]).toMatchObject({ tokens: 0, at: t });
    expect(s.all[3]).toMatchObject({ tokens: 234, at: t });
    // And an empty ordinary budget leaves every kill switch alone.
    for (let i = 0; i < 2; i++) await ordinary(stub, `${b!}_x${i}`, 10, t);
    expect(await ordinary(stub, b!, 1, t)).toMatchObject({ ok: false, limit: 'budget' });
    expect(await kill(stub, b!, 6, t)).toMatchObject({ ok: true });
  });

  it('a settlement gives back a breaker slot only, never a token', async () => {
    const stub = fresh();
    const t = start();
    const [a] = orgsOf(1);
    const r = await removal(stub, a!, t);
    expect(r).toMatchObject({ ok: true, at: t });
    const keys = [`console:kill:org:${a!}`, 'console:kill'];
    const before = await stored(stub, keys);
    await stub.consoleSettle({ org: a!, at: t, breaker: true });
    await stub.consoleSettle({ org: a!, at: t, breaker: true }); // once only
    const after = await stored(stub, keys);
    expect(after.all).toEqual(before.all);
    const lists = await runInDurableObject(stub, (_i, st) => [st.storage.kv.get<number[]>(`console:breaker:org:${a!}`), st.storage.kv.get<number[]>('console:breaker:global'), st.storage.kv.get<number[]>(`console:kill:floor:org:${a!}`)]);
    // The breaker's two lists empty again; the kill floor keeps the call (no refunds of a kill switch).
    expect(lists).toEqual([[], [], [t]]);
  });
});

describe('the bucket-level starvation found before D937 (D935 residual risk (g)) is gone', () => {
  it('two orgs’ revocations refused by their quota (changing nothing) no longer empty a third org’s kill-switch budget: its suspend and removal pass', async () => {
    // Before D937: ordinary reads took the global bucket down to its reserve (20); two orgs' revocations refused by their
    // full quota kept the reserve tokens they took (20 in all); the victim's suspend was refused `budget` (proved on the
    // old code: {"ok":false,"code":"rate_limited"}, the app not suspended).
    ownClock({ freeze: true });
    const rpc = consoleRpc();
    for (const k of [40, 20]) {
      const o = await orgApp();
      for (let i = 0; i < k; i++) expect(await rpc.listApps({ ...member(), orgId: o.org })).toMatchObject({ ok: true });
    }
    for (let a = 0; a < 2; a++) {
      const o = await orgApp();
      expect(await stops(o.org).hit(CONSOLE_KEY_REVOKES, Date.now(), 20)).toMatchObject({ ok: true });
      const keyId = await liveKey(o.id);
      for (let i = 0; i < 12; i++) expect(await rpc.revokeKey({ ...member(), orgId: o.org, appId: o.id, keyId })).toMatchObject({ ok: false, code: 'rate_limited' });
      expect((await rows<{ revoked_at: number | null }>('SELECT revoked_at FROM app_keys WHERE id = ?1', keyId))[0]!.revoked_at).toBeNull();
    }
    const victim = await orgApp({ origins: [ORIGIN, SECOND] });
    expect(await rpc.setSuspended({ ...member(), orgId: victim.org, appId: victim.id, suspended: true })).toMatchObject({ ok: true, suspendedBy: 4 });
    expect(await rpc.removeOrigins({ ...member(), orgId: victim.org, appId: victim.id, remove: [SECOND], expectedVersion: 0 })).toMatchObject({ ok: true });
    expect((await appRow(victim.id)).suspended_by).toBe(4);
  });

  it('sustained: four orgs reading at full rate leave a victim’s kill switches at its own rate (before D937: 4 of 60 a minute)', async () => {
    // Before D937, 4 orgs reading every 100 ms held the global bucket at its reserve, and the victim's kill switches to its
    // 12-token share of the reserve a minute: 4 of 60 tries (one a second) admitted, 56 refused `budget_reserve`; with 40
    // or 160 more orgs spending their shares, 3 of 60. Now: the victim at its own rate (one of cost 5 every 5 s) is never
    // refused, with or without 4 more orgs flooding kill switches at their full rate (below the global kill bucket's bite).
    for (const kills of [0, 4]) {
      const stub = fresh();
      const t0 = start();
      const flooders = orgsOf(4, 'reader');
      const killers = orgsOf(kills, 'killer');
      let victimOk = 0;
      let victimNo = 0;
      for (let tick = 0; tick < 600; tick++) {
        const t = t0 + tick * 100;
        for (const f of flooders) await ordinary(stub, f, 1, t);
        for (const k of killers) if (tick % 10 === 0) await kill(stub, k, 6, t);
        if (tick % 50 === 25) {
          if ((await kill(stub, 'victim', 5, t)).ok) victimOk++;
          else victimNo++;
        }
      }
      expect([victimOk, victimNo], `${kills} orgs flooding kill switches`).toEqual([12, 0]);
    }
  }, 180_000);
});

describe('a victim beside 4, 20, then 40 organisations exhausting their breaker and limits (the real handlers)', () => {
  async function scenario(others: number) {
    const clock = ownClock({ freeze: true });
    const rpc = consoleRpc();
    // The others: one app each, every key revocation and suspension of the hour already used; each rotates its key until
    // refused (the breaker: 5 an org, 20 across orgs; past the 20, each org's first 3 while the overflow's 60 has room),
    // then fires stops that change nothing until its own kill bucket refuses them.
    const crowd = await Promise.all(Array.from({ length: others }, () => orgApp()));
    for (const o of crowd) {
      expect(await stops(o.org).hit(CONSOLE_SUSPENSIONS, Date.now(), 20)).toMatchObject({ ok: true });
      expect(await stops(o.org).hit(CONSOLE_KEY_REVOKES, Date.now(), 20)).toMatchObject({ ok: true });
    }
    let rotated = 0;
    for (const o of crowd) {
      clock.advance(1000); // the ordinary budget's second (30 statements: five rotations)
      for (let i = 0; i < 6; i++) if ((await rpc.rotateKey({ ...member(), orgId: o.org, appId: o.id, keyId: await liveKey(o.id) })).ok) rotated++;
    }
    expect(rotated).toBe(Math.min(20 + Math.max(0, others - 4) * 3, 80));
    const noOp = async (o: { org: string; id: string }, i: number) =>
      i % 2 === 0 ? rpc.setSuspended({ ...member(), orgId: o.org, appId: o.id, suspended: true }) : rpc.revokeKey({ ...member(), orgId: o.org, appId: o.id, keyId: await liveKey(o.id) });
    for (const o of crowd) for (let i = 0; i < 13; i++) expect(await noOp(o, i)).toMatchObject({ ok: false, code: 'rate_limited' });
    // The victim: 3 removals (its floor through the full breaker) and 20 suspensions (its own limit), one stop every 12 s
    // (its kill floor, 5 a rolling minute), the others firing a stop that changes nothing between each.
    const victim = newOrg();
    const victimApps = await Promise.all(Array.from({ length: 21 }, () => orgApp({ org: victim, origins: [ORIGIN, SECOND] })));
    const removals: string[] = [];
    const suspensions: string[] = [];
    const step = async (into: string[], call: () => Promise<{ ok: boolean; code?: string }>) => {
      clock.advance(12_000);
      for (const [i, o] of crowd.entries()) await noOp(o, i);
      const r = await call();
      into.push(r.ok ? 'ok' : r.code!);
    };
    for (const a of victimApps.slice(0, 3)) await step(removals, () => rpc.removeOrigins({ ...member(), orgId: victim, appId: a.id, remove: [SECOND], expectedVersion: 0 }));
    for (const a of victimApps.slice(0, 20)) await step(suspensions, () => rpc.setSuspended({ ...member(), orgId: victim, appId: a.id, suspended: true }));
    expect(suspensions).toEqual(Array(20).fill('ok'));
    for (const a of victimApps.slice(0, 20)) expect((await appRow(a.id)).suspended_by).toBe(4);
    // What the global kill bucket holds after the victim's last stop: with 40 others it was kept empty (the victim passed
    // on its floor).
    const k = await runInDurableObject(consoleObject(), (_i, st) => st.storage.kv.get<{ tokens: number; at: number }>('console:kill') ?? null);
    const globalLeft = held(k, L.kill.global, Date.now());
    // Past its floor the breaker's global count applies (removals), past its 20 its own limit (suspensions).
    clock.advance(12_000);
    expect(await rpc.removeOrigins({ ...member(), orgId: victim, appId: victimApps[3]!.id, remove: [SECOND], expectedVersion: 0 })).toMatchObject({ ok: false, code: 'rate_limited' });
    clock.advance(12_000);
    expect(await rpc.setSuspended({ ...member(), orgId: victim, appId: victimApps[20]!.id, suspended: true })).toMatchObject({ ok: false, code: 'rate_limited' });
    expect((await appRow(victimApps[20]!.id)).suspended_by).toBe(0);
    // Staff's removal is never limited.
    expect(await adminRpc().removeOrigins({ ...hana(), orgId: victim, appId: victimApps[3]!.id, remove: [SECOND], expectedVersion: 0 })).toMatchObject({ ok: true });
    return { removals, globalLeft };
  }

  it('4 others: every stop of the victim passes, up to its floor of removals and its own 20 suspensions', async () => {
    const r = await scenario(4);
    expect(r.removals).toEqual(['ok', 'ok', 'ok']);
    expect(r.globalLeft).toBeGreaterThan(MAX_KILL_COST);
  }, 120_000);

  it('20 others (48 of the overflow’s 60 used): the same, the victim’s removals on its floor', async () => {
    const r = await scenario(20);
    expect(r.removals).toEqual(['ok', 'ok', 'ok']);
  }, 240_000);

  it('40 others (the overflow full: 80 breaker calls in the hour, the hard ceiling): the victim’s removals are refused, its 20 suspensions all pass, staff’s removal passes', async () => {
    const r = await scenario(40);
    expect(r.removals).toEqual(['rate_limited', 'rate_limited', 'rate_limited']);
    expect(r.globalLeft).toBeLessThan(MAX_KILL_COST);
  }, 300_000);
});

describe('the console breaker’s hard ceiling: the global 20 and the overflow’s 60', () => {
  it('100 orgs each trying 5 at once: exactly 80 pass (20, then 60 on floors), the rest refused `breaker_global`', async () => {
    const stub = fresh();
    const t = start();
    let ok = 0;
    for (const [i, o] of orgsOf(100, 'many').entries()) for (let k = 0; k < 5; k++) if ((await slot(stub, o, t + i)).ok) ok++;
    expect(ok).toBe(80);
  });

  it('100 orgs trying their floor at random times over three hours: no rolling hour ever holds more than 80', async () => {
    const stub = fresh();
    const r = rng(937);
    const t0 = start();
    const orgs = orgsOf(100, 'spread');
    const admitted: number[] = [];
    let t = t0;
    for (let step = 0; step < 3000; step++) {
      t += Math.floor(r() * 7000);
      const a = await slot(stub, orgs[Math.floor(r() * orgs.length)]!, t);
      if (a.ok) admitted.push(a.at);
    }
    expect(t - t0).toBeGreaterThan(2 * HOUR);
    for (const at of admitted) expect(admitted.filter((x) => x > at - HOUR && x <= at).length).toBeLessThanOrEqual(80);
    // And it is reached: some hour holds all 80.
    expect(Math.max(...admitted.map((at) => admitted.filter((x) => x > at - HOUR && x <= at).length))).toBe(80);
  });

  it('the overflow full: a victim under its floor is refused with the sooner of the global count’s and the overflow’s slide; at that time it passes, a second earlier it doesn’t', async () => {
    const stub = fresh();
    const t = start();
    // The global 20 at t, the overflow's 60 from 20 orgs' floors at t + 10 min … t + 29 min.
    for (const o of orgsOf(4, 'g')) for (let k = 0; k < 5; k++) expect((await slot(stub, o, t)).ok).toBe(true);
    for (const [i, o] of orgsOf(20, 'f').entries()) for (let k = 0; k < 3; k++) expect((await slot(stub, o, t + (10 + i) * MIN)).ok).toBe(true);
    const [v] = orgsOf(1, 'victim');
    const now = t + 40 * MIN;
    const refused = await slot(stub, v!, now);
    expect(refused).toMatchObject({ ok: false, limit: 'breaker_global' });
    // The overflow's oldest (t + 10 min) leaves at t + 70 min, before the global count can fall under 20 (61 of 80
    // must leave: t + 79 min).
    const wait = (refused as { retryAfterS: number }).retryAfterS;
    expect(wait).toBe(30 * 60);
    expect((await slot(stub, v!, now + (wait - 1) * 1000)).ok).toBe(false);
    expect(await slot(stub, v!, now + wait * 1000)).toMatchObject({ ok: true, overflow: true });
    // The victim's suspensions never touch the breaker.
    expect(await kill(stub, v!, 5, now)).toMatchObject({ ok: true });
  });

  it('a settlement gives back exactly one slot from the lists the call was on: the overflow only for an overflow admission, even beside one of the same millisecond', async () => {
    const stub = fresh();
    const t = start();
    for (const o of orgsOf(4, 'g')) for (let k = 0; k < (o.endsWith('_3') ? 4 : 5); k++) expect((await slot(stub, o, t)).ok).toBe(true);
    const [a, b] = orgsOf(2, 'ab');
    // A takes the 20th global slot, B (same millisecond) the first overflow slot.
    const ra = await slot(stub, a!, t + 1000);
    const rb = await slot(stub, b!, t + 1000);
    expect(ra).toEqual({ ok: true, at: t + 1000 });
    expect(rb).toEqual({ ok: true, at: t + 1000, overflow: true });
    const lists = () =>
      runInDurableObject(stub, (_i, st) => ({
        a: (st.storage.kv.get<number[]>(`console:breaker:org:${a!}`) ?? []).length,
        b: (st.storage.kv.get<number[]>(`console:breaker:org:${b!}`) ?? []).length,
        global: (st.storage.kv.get<number[]>('console:breaker:global') ?? []).length,
        overflow: (st.storage.kv.get<number[]>('console:breaker:overflow') ?? []).length,
      }));
    expect(await lists()).toEqual({ a: 1, b: 1, global: 21, overflow: 1 });
    await stub.consoleSettle({ org: a!, at: t + 1000, breaker: true });
    expect(await lists()).toEqual({ a: 0, b: 1, global: 20, overflow: 1 });
    await stub.consoleSettle({ org: b!, at: t + 1000, breaker: true, overflow: true });
    expect(await lists()).toEqual({ a: 0, b: 0, global: 19, overflow: 0 });
  });

  it('through the handler: a removal on the overflow that changed nothing gives its slot back to all three lists', async () => {
    ownClock({ freeze: true });
    const t = Date.now();
    for (const o of orgsOf(4, 'g')) for (let k = 0; k < 5; k++) expect((await slot(consoleObject(), o, t)).ok).toBe(true);
    const app = await orgApp({ origins: [ORIGIN, SECOND] });
    const lengths = () =>
      runInDurableObject(consoleObject(), (_i, st) =>
        [`console:breaker:org:${app.org}`, 'console:breaker:global', 'console:breaker:overflow'].map((k) => (st.storage.kv.get<number[]>(k) ?? []).filter((x) => x > Date.now() - HOUR).length),
      );
    const before = await lengths();
    expect(await consoleRpc().removeOrigins({ ...member(), orgId: app.org, appId: 'app_none', remove: [SECOND], expectedVersion: 0 })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await consoleRpc().removeOrigins({ ...member(), orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 9 })).toMatchObject({ ok: false, code: 'version_conflict' });
    expect(await lengths()).toEqual(before);
    expect(await consoleRpc().removeOrigins({ ...member(), orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 0 })).toMatchObject({ ok: true });
    expect(await lengths()).toEqual([before[0]! + 1, before[1]! + 1, before[2]! + 1]);
  });
});

describe('parallel calls at each edge (the real handlers)', () => {
  it('suspensions: 18 of the hour’s 20 used, five at once, exactly two pass; a resume is never counted', async () => {
    ownClock({ freeze: true });
    const org = newOrg();
    const apps = await Promise.all([1, 2, 3, 4, 5].map(() => orgApp({ org })));
    expect(await stops(org).hit(CONSOLE_SUSPENSIONS, Date.now(), 18)).toMatchObject({ ok: true });
    const out = await Promise.all(apps.map((a) => consoleRpc().setSuspended({ ...member(), orgId: org, appId: a.id, suspended: true })));
    expect(out.filter((r) => r.ok)).toHaveLength(2);
    expect(out.filter((r) => !r.ok).map((r) => (r as { code: string }).code)).toEqual(['rate_limited', 'rate_limited', 'rate_limited']);
    const suspended = (await Promise.all(apps.map((a) => appRow(a.id)))).filter((r) => r.suspended_by === 4);
    expect(suspended).toHaveLength(2);
    // Resumes are ordinary calls: never counted, never refused by the full window.
    for (const a of apps) expect(await consoleRpc().setSuspended({ ...member(), orgId: org, appId: a.id, suspended: false })).toMatchObject({ ok: true });
    expect(await stops(org).hit(CONSOLE_SUSPENSIONS, Date.now())).toMatchObject({ ok: false });
  });

  it('the breaker’s floor: the global 20 full, an org with 2 of its 3, three removals at once, exactly one passes', async () => {
    ownClock({ freeze: true });
    const t = Date.now();
    for (const o of orgsOf(4, 'fill')) for (let i = 0; i < 5; i++) expect((await slot(consoleObject(), o, t)).ok).toBe(true);
    const org = newOrg();
    const apps = await Promise.all([1, 2, 3, 4, 5].map(() => orgApp({ org, origins: [ORIGIN, SECOND] })));
    for (const a of apps.slice(0, 2)) expect(await consoleRpc().removeOrigins({ ...member(), orgId: org, appId: a.id, remove: [SECOND], expectedVersion: 0 })).toMatchObject({ ok: true });
    const out = await Promise.all(apps.slice(2).map((a) => consoleRpc().removeOrigins({ ...member(), orgId: org, appId: a.id, remove: [SECOND], expectedVersion: 0 })));
    expect(out.filter((r) => r.ok)).toHaveLength(1);
    expect(out.filter((r) => !r.ok).map((r) => (r as { code: string }).code)).toEqual(['rate_limited', 'rate_limited']);
  });

  it('the overflow’s edge: the global 20 full and 58 of the overflow’s 60 used, four orgs’ removals at once, exactly two pass', async () => {
    ownClock({ freeze: true });
    const t = Date.now();
    for (const o of orgsOf(4, 'g')) for (let k = 0; k < 5; k++) expect((await slot(consoleObject(), o, t)).ok).toBe(true);
    for (const [i, o] of orgsOf(20, 'f').entries()) for (let k = 0; k < (i === 19 ? 1 : 3); k++) expect((await slot(consoleObject(), o, t)).ok).toBe(true);
    const apps = await Promise.all([1, 2, 3, 4].map(() => orgApp({ origins: [ORIGIN, SECOND] })));
    const out = await Promise.all(apps.map((a) => consoleRpc().removeOrigins({ ...member(), orgId: a.org, appId: a.id, remove: [SECOND], expectedVersion: 0 })));
    expect(out.filter((r) => r.ok)).toHaveLength(2);
    expect(out.filter((r) => !r.ok).map((r) => (r as { code: string }).code)).toEqual(['rate_limited', 'rate_limited']);
    // Their suspensions all pass.
    for (const a of apps) expect(await consoleRpc().setSuspended({ ...member(), orgId: a.org, appId: a.id, suspended: true })).toMatchObject({ ok: true, suspendedBy: 4 });
  });

  it('the org’s breaker edge: 4 of its 5 used, the global count low, three rotations at once, exactly one passes', async () => {
    const clock = ownClock({ freeze: true });
    const org = newOrg();
    const apps = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(() => orgApp({ org })));
    for (const a of apps.slice(0, 4)) expect(await consoleRpc().rotateKey({ ...member(), orgId: org, appId: a.id, keyId: await liveKey(a.id) })).toMatchObject({ ok: true });
    const keys = await Promise.all(apps.slice(4).map((a) => liveKey(a.id)));
    clock.advance(5000); // the org's ordinary bucket full again
    const out = await Promise.all(apps.slice(4).map((a, i) => consoleRpc().rotateKey({ ...member(), orgId: org, appId: a.id, keyId: keys[i]! })));
    expect(out.filter((r) => r.ok)).toHaveLength(1);
    expect(out.filter((r) => !r.ok).map((r) => (r as { code: string }).code)).toEqual(['rate_limited', 'rate_limited']);
  });

  it('the kill floor: the global kill bucket empty, an org with 3 of its 5 a minute, four suspensions at once, exactly two pass', async () => {
    ownClock({ freeze: true });
    const t = Date.now();
    const org = newOrg();
    const apps = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(() => orgApp({ org })));
    for (const a of apps.slice(0, 3)) expect(await consoleRpc().setSuspended({ ...member(), orgId: org, appId: a.id, suspended: true })).toMatchObject({ ok: true });
    // 50 other orgs' kill switches of 6 empty the global kill bucket (300 − 15).
    for (const o of orgsOf(50, 'drain')) await kill(consoleObject(), o, 6, t);
    const out = await Promise.all(apps.slice(3).map((a) => consoleRpc().setSuspended({ ...member(), orgId: org, appId: a.id, suspended: true })));
    expect(out.filter((r) => r.ok)).toHaveLength(2);
    expect((await Promise.all(apps.map((a) => appRow(a.id)))).filter((r) => r.suspended_by === 4)).toHaveLength(5);
  });
});

describe('no-ops are uncounted and drain nothing another organisation relies on', () => {
  it('a suspension that changes nothing (already suspended, not found) never counts on the org’s 20; a take-over of the platform’s suspension counts', async () => {
    const clock = ownClock({ freeze: true });
    const rpc = consoleRpc();
    const app = await orgApp();
    expect(await rpc.setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: true })).toMatchObject({ ok: true, suspendedBy: 4 });
    for (let i = 0; i < 30; i++) {
      clock.advance(6000); // its own kill bucket's pace
      expect(await rpc.setSuspended({ ...member(), orgId: app.org, appId: i % 2 ? app.id : 'app_none', suspended: true })).toMatchObject(i % 2 ? { ok: true, suspendedBy: 4 } : { ok: false, code: 'not_found' });
    }
    // One counted: 19 left.
    expect(await stops(app.org).hit(CONSOLE_SUSPENSIONS, Date.now(), 19)).toMatchObject({ ok: true });
    expect(await stops(app.org).hit(CONSOLE_SUSPENSIONS, Date.now())).toMatchObject({ ok: false });
    // A take-over writes (the platform's suspension becomes the member's): counted.
    const p = await orgApp();
    await env.DB.prepare("UPDATE apps SET suspended_by = 4, partner_bit_by = 'platform' WHERE id = ?1").bind(p.id).run();
    expect(await stops(p.org).hit(CONSOLE_SUSPENSIONS, Date.now(), 19)).toMatchObject({ ok: true });
    expect(await rpc.setSuspended({ ...member(), orgId: p.org, appId: p.id, suspended: true })).toMatchObject({ ok: true, suspendedBy: 4, takenOver: true });
    expect(await rpc.setSuspended({ ...member(), orgId: p.org, appId: (await orgApp({ org: p.org })).id, suspended: true })).toMatchObject({ ok: false, code: 'rate_limited' });
  });

  it('forty orgs flooding stops that change nothing leave another org’s kill bucket, floor, quotas and breaker exactly as they were', async () => {
    ownClock({ freeze: true });
    const rpc = consoleRpc();
    const victim = await orgApp({ origins: [ORIGIN, SECOND] });
    const read = () =>
      runInDurableObject(consoleObject(), (_i, st) =>
        [`console:kill:org:${victim.org}`, `console:kill:floor:org:${victim.org}`, `console:breaker:org:${victim.org}`, `console:bucket:org:${victim.org}`].map((k) => JSON.stringify(st.storage.kv.get(k) ?? null)),
      );
    const before = await read();
    const crowd = await Promise.all(Array.from({ length: 40 }, () => orgApp()));
    for (const o of crowd) {
      await rpc.setSuspended({ ...member(), orgId: o.org, appId: o.id, suspended: true });
      for (let i = 0; i < 12; i++) await rpc.setSuspended({ ...member(), orgId: o.org, appId: i % 3 ? o.id : 'app_none', suspended: true });
    }
    expect(await read()).toEqual(before);
    // Its own 20 suspensions and 20 revocations untouched: each still has the whole hour.
    expect(await stops(victim.org).hit(CONSOLE_SUSPENSIONS, Date.now(), 20)).toMatchObject({ ok: true });
    expect(await stops(victim.org).hit(CONSOLE_KEY_REVOKES, Date.now(), 20)).toMatchObject({ ok: true });
    // And its first 5 stops of the minute pass with the global kill bucket emptied by the crowd.
    expect(held(await runInDurableObject(consoleObject(), (_i, st) => st.storage.kv.get<{ tokens: number; at: number }>('console:kill') ?? null), L.kill.global, Date.now())).toBeLessThan(MAX_KILL_COST);
    expect(await rpc.removeOrigins({ ...member(), orgId: victim.org, appId: victim.id, remove: [SECOND], expectedVersion: 0 })).toMatchObject({ ok: true });
    expect(await rpc.turnOff({ ...member(), orgId: victim.org, appId: victim.id, what: 'policy', expectedVersion: 0 })).toMatchObject({ ok: true });
  }, 120_000);
});

describe('fail closed, staff uncounted, resume ordinary', () => {
  it('a limiter error refuses a suspension and a removal (internal), writing nothing; so does an error of the org’s stops object alone', async () => {
    ownClock({ freeze: true });
    const app = await orgApp({ origins: [ORIGIN, SECOND] });
    vi.spyOn(env.RATE_LIMITER, 'get').mockImplementation(() => {
      throw new Error('limiter down');
    });
    expect(await consoleRpc().setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: true })).toMatchObject({ ok: false, code: 'internal' });
    expect(await consoleRpc().removeOrigins({ ...member(), orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 0 })).toMatchObject({ ok: false, code: 'internal' });
    vi.restoreAllMocks();
    ownClock({ freeze: true });
    expect((await appRow(app.id)).suspended_by).toBe(0);
    expect(await rows('SELECT origin FROM app_origins WHERE app_id = ?1', app.id)).toHaveLength(2);
    // The admission answers; the org's suspension window doesn't.
    wrapStubs(() => ({ hit: () => Promise.reject(new Error('stops object down')) }));
    expect(await consoleRpc().setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: true })).toMatchObject({ ok: false, code: 'internal' });
    vi.restoreAllMocks();
    expect((await appRow(app.id)).suspended_by).toBe(0);
  });

  it('staff’s suspensions and removals (AdminRpc) are neither counted nor limited, with the org’s console limits used up', async () => {
    ownClock({ freeze: true });
    const app = await orgApp({ origins: [ORIGIN, SECOND, 'https://third.example.com'] });
    expect(await stops(app.org).hit(CONSOLE_SUSPENSIONS, Date.now(), 20)).toMatchObject({ ok: true });
    // The org's kill bucket empty.
    for (let i = 0; i < 10; i++) await kill(consoleObject(), app.org, 6, Date.now());
    expect(await consoleRpc().setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: true })).toMatchObject({ ok: false, code: 'rate_limited' });
    for (let k = 0; k < 30; k++) expect(await adminRpc().setSuspended({ ...hana(), appId: app.id, bit: 4, suspended: k % 2 === 0 })).toMatchObject({ ok: true });
    expect(await adminRpc().removeOrigins({ ...hana(), orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 0 })).toMatchObject({ ok: true });
    const audit = await rows<{ actor_kind: string }>("SELECT actor_kind FROM app_changes WHERE app_id = ?1 AND kind LIKE 'suspension.%'", app.id);
    expect(audit).toHaveLength(30);
    expect(audit.every((r) => r.actor_kind === 'hana')).toBe(true);
  });

  it('a resume is an ordinary call: it passes with the org’s kill bucket empty and waits with its ordinary bucket empty', async () => {
    ownClock({ freeze: true });
    const rpc = consoleRpc();
    const org = newOrg();
    const a = await orgApp({ org });
    const b = await orgApp({ org });
    expect(await rpc.setSuspended({ ...member(), orgId: org, appId: a.id, suspended: true })).toMatchObject({ ok: true });
    for (let i = 0; i < 10; i++) await kill(consoleObject(), org, 6, Date.now());
    expect(await rpc.setSuspended({ ...member(), orgId: org, appId: b.id, suspended: true })).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(await rpc.setSuspended({ ...member(), orgId: org, appId: a.id, suspended: false })).toMatchObject({ ok: true, suspendedBy: 0 });
    // The org's ordinary bucket empty (40): the resume waits; a suspension needs no ordinary token.
    for (let i = 0; i < 40; i++) await ordinary(consoleObject(), org, 1, Date.now());
    expect(await rpc.setSuspended({ ...member(), orgId: org, appId: a.id, suspended: false })).toMatchObject({ ok: false, code: 'rate_limited' });
  });
});

describe('honest retry-afters, per stage', () => {
  it('ordinary (org, global), kill (org, global past the floor) and breaker (org, global past the floor): a retry at exactly the stated time, nothing else changed, is admitted', async () => {
    const seen = new Set<string>();
    for (const seed of [3, 937, 5151]) {
      const stub = fresh();
      const r = rng(seed);
      const orgs = orgsOf(30);
      let t = start();
      for (let step = 0; step < 500; step++) {
        t += Math.floor(r() * 200);
        // First five orgs, mostly breaker calls and large costs; then 30 orgs, mostly kill switches (the global kill bucket).
        const early = step < 250;
        const org = orgs[Math.floor(r() * (early ? 5 : 30))]!;
        const kind = r();
        const call: Omit<ConsoleAdmission, 'limits'> = early
          ? kind < 0.35
            ? { org, cost: 6, killSwitch: true, breaker: true }
            : kind < 0.6
              ? { org, cost: 6, breaker: true }
              : kind < 0.8
                ? { org, cost: [5, 30, 60][Math.floor(r() * 3)]!, killSwitch: true }
                : { org, cost: [1, 8, 40][Math.floor(r() * 3)]! }
          : kind < 0.8
            ? { org, cost: [2, 5, 6][Math.floor(r() * 3)]!, killSwitch: true }
            : { org, cost: [1, 8, 30][Math.floor(r() * 3)]! };
        const a = await stub.consoleAdmit({ ...call, limits: L }, t);
        if (a.ok) continue;
        seen.add(a.limit);
        t += a.retryAfterS * 1000;
        const again = await stub.consoleAdmit({ ...call, limits: L }, t);
        expect(again, `seed ${seed} step ${step}: ${a.limit} after ${a.retryAfterS} s`).toMatchObject({ ok: true });
      }
    }
    for (const l of ['budget_org', 'budget', 'budget_kill', 'budget_kill_global', 'breaker_org', 'breaker_global']) expect(seen.has(l), l).toBe(true);
  }, 120_000);

  it('the breaker past the floor: the sooner of the two expiries, whichever it is; one second earlier still refused', async () => {
    for (const orgFirst of [true, false]) {
      const stub = fresh();
      const t = start();
      const [x, y] = orgsOf(2, 'xy');
      const fill = async (counts: number[], at: number) => {
        for (const [j, o] of orgsOf(counts.length, 'fill').entries()) for (let i = 0; i < counts[j]!; i++) expect((await slot(stub, o, at)).ok).toBe(true);
      };
      if (orgFirst) {
        // X's three (its floor) the oldest; 17 more fill the global 20 at t + 10 min; Y's three pass on its floor (23).
        for (let i = 0; i < 3; i++) expect((await slot(stub, x!, t + i * MIN)).ok).toBe(true);
        await fill([5, 5, 5, 2], t + 10 * MIN);
        for (let i = 0; i < 3; i++) expect((await slot(stub, y!, t + 11 * MIN)).ok).toBe(true);
      } else {
        // 20 fill the global at t + 10 min; X's three pass on its floor later (23).
        await fill([5, 5, 5, 5], t + 10 * MIN);
        for (let i = 0; i < 3; i++) expect((await slot(stub, x!, t + 20 * MIN + i * MIN)).ok).toBe(true);
      }
      const now = t + 30 * MIN;
      const refused = await slot(stub, x!, now);
      expect(refused).toMatchObject({ ok: false, limit: 'breaker_global' });
      const wait = (refused as { retryAfterS: number }).retryAfterS;
      // X's oldest first: it leaves the floor's count at t + 60 min, before the global's 4th oldest of 23 (t + 10 min,
      // gone at t + 70 min). Otherwise that 4th oldest at t + 70 min, before X's oldest (t + 80 min).
      expect(wait).toBe(orgFirst ? 30 * 60 : 40 * 60);
      expect((await slot(stub, x!, now + (wait - 1) * 1000)).ok).toBe(false);
      expect((await slot(stub, x!, now + wait * 1000)).ok).toBe(true);
    }
  });

  it('a kill switch past its floor with the global kill bucket empty: the sooner of the bucket’s refill and the floor’s slide; with its own bucket short too, the later', async () => {
    const stub = fresh();
    const t = start();
    const [v] = orgsOf(1, 'v');
    for (let i = 0; i < 5; i++) expect((await kill(stub, v!, 1, t + i * 10_000)).ok).toBe(true);
    // The global kill bucket emptied at t + 50 s by 50 others.
    for (const o of orgsOf(50, 'drain')) await kill(stub, o, 6, t + 50_000);
    const r1 = await kill(stub, v!, 6, t + 50_000);
    expect(r1).toMatchObject({ ok: false, limit: 'budget_kill_global' });
    // Refill to 6 at 10 a second: 0.6 s, sooner than the floor's slide (10 s): 1 s.
    expect((r1 as { retryAfterS: number }).retryAfterS).toBe(1);
    expect((await kill(stub, v!, 6, t + 51_000)).ok).toBe(true);
    // Its own bucket short (60 taken at once) as well: the later of the two.
    const s2 = fresh();
    const [w] = orgsOf(1, 'w');
    expect((await kill(s2, w!, 60, t)).ok).toBe(true);
    for (let i = 0; i < 4; i++) expect((await kill(s2, w!, 0, t + i)).ok).toBe(true);
    for (const o of orgsOf(50, 'drain2')) await kill(s2, o, 6, t + 10);
    const r2 = await kill(s2, w!, 6, t + 10);
    expect(r2).toMatchObject({ ok: false, limit: 'budget_kill', retryAfterS: 6 });
    expect((await kill(s2, w!, 6, t + 10 + 5000)).ok).toBe(false);
    expect((await kill(s2, w!, 6, t + 10 + 6000)).ok).toBe(true);
  });
});

describe('token conservation on the object’s clock', () => {
  it('random admits and settles, stale and future caller times, clock jumps, costs 0 to 1 000, 24 orgs: no bucket ever holds more than its start plus its refill less what it gave', async () => {
    for (const seed of [11, 937, 2026]) {
      const stub = fresh();
      const r = rng(seed);
      const orgs = orgsOf(24);
      let t = start();
      const t0 = t;
      // The object's clock starts at t0 (a call of no cost by an org not watched), so no bucket is born before it.
      expect((await stub.consoleAdmit({ org: 'clock', cost: 0, limits: L }, t0)).ok).toBe(true);
      const keys = [...orgs.flatMap((o) => [`console:bucket:org:${o}`, `console:kill:org:${o}`]), 'console:bucket', 'console:kill'];
      const defOf = (key: string) => (key === 'console:bucket' ? L.global : key === 'console:kill' ? L.kill.global : key.startsWith('console:kill:') ? L.kill.perOrg : L.perOrg);
      const given = new Map<string, number>();
      const breakers: { org: string; at: number }[] = [];
      let clock = t0;
      for (let step = 0; step < 500; step++) {
        const jump = r();
        t += jump < 0.05 ? Math.floor(r() * 10 * MIN) : Math.floor(r() * 400);
        const caller = r() < 0.3 ? t - Math.floor(r() * 20_000) : r() < 0.1 ? t + Math.floor(r() * 5000) : t;
        const org = orgs[Math.floor(r() * orgs.length)]!;
        const cost = [0, 1, 5, 6, 60, 61, 300, 301, 1000][Math.floor(r() * 9)]!;
        const op = r();
        if (op < 0.1 && breakers.length > 0) {
          const s = breakers[Math.floor(r() * breakers.length)]!;
          await stub.consoleSettle({ org: s.org, at: s.at, breaker: true });
          continue;
        }
        const killSwitch = op < 0.6;
        const breaker = op < 0.35 || (op > 0.85 && op < 0.95);
        const touched = killSwitch ? [`console:kill:org:${org}`, 'console:kill'] : [`console:bucket:org:${org}`, 'console:bucket'];
        const before = await stored(stub, touched);
        const a = await stub.consoleAdmit({ org, cost, ...(killSwitch ? { killSwitch: true } : {}), ...(breaker ? { breaker: true } : {}), limits: L }, caller);
        clock = Math.max(clock, caller);
        if (a.ok) {
          clock = a.at;
          // What each bucket gave: the cost, or what it held when a kill switch passed on its org's floor.
          for (const [i, key] of touched.entries()) given.set(key, (given.get(key) ?? 0) + Math.min(cost, held(before.all[i]!, defOf(key), a.at)));
          if (breaker) breakers.push({ org, at: a.at });
        }
        const state = await stored(stub, keys);
        expect(state.clock).toBeGreaterThanOrEqual(clock);
        for (const [i, key] of keys.entries()) {
          const b = state.all[i];
          if (!b) continue;
          const def = defOf(key);
          const now = held(b, def, state.clock);
          const bound = def.burst + ((state.clock - t0) / 1000) * def.ratePerS - (given.get(key) ?? 0);
          expect(now, `seed ${seed} step ${step} ${key}`).toBeLessThanOrEqual(bound + 1e-3);
          expect(b.tokens, key).toBeGreaterThanOrEqual(0);
          expect(b.at, key).toBeLessThanOrEqual(state.clock);
        }
      }
    }
  }, 180_000);
});

describe('the hard ceiling on console kill switches', () => {
  // Every org bursting kill switches of the largest cost (6) after ten idle minutes: in the first minute at most the
  // global kill bucket's 300 + 600 plus each org's floor (5 × 6) beyond it, and each org's own 60 + 60; a minute later
  // 600 + 30 a minute an org (and each org's own 60); each org's floor reached.
  for (const orgCount of [20, 100]) {
    it(`${orgCount} orgs: ≤ min(120 N, 900 + 30 N) in a first minute, ≤ min(60 N, 600 + 30 N) a minute after`, async () => {
      const stub = fresh();
      const t0 = start() + 10 * MIN;
      const orgs = orgsOf(orgCount, 'burst');
      const cost = [0, 0];
      for (let tick = 0; tick < 2 * 120; tick++) {
        const t = t0 + tick * 500;
        const m = Math.floor(tick / 120);
        for (const org of orgs) if ((await kill(stub, org, 6, t)).ok) cost[m]! += 6;
      }
      const N = orgCount;
      expect(cost[0]).toBeLessThanOrEqual(Math.min(120 * N, 900 + 30 * N));
      expect(cost[1]).toBeLessThanOrEqual(Math.min(60 * N, 600 + 30 * N) + 6);
      // Each org's floor is reached whatever the others do: at least its 5 a rolling minute (less one call at the edges).
      expect(cost[1]).toBeGreaterThanOrEqual((L.kill.floor.calls - 1) * 6 * N);
    }, 240_000);
  }
});

describe('the ConsoleRpc setup', () => {
  it('suspending is a kill switch outside the breaker; rotating is an ordinary breaker call; resuming is ordinary', async () => {
    const seen: Record<string, unknown>[] = [];
    wrapStubs((real) => ({
      consoleAdmit: (r: ConsoleAdmission, at?: number) => {
        seen.push({ cost: r.cost, killSwitch: !!r.killSwitch, breaker: !!r.breaker });
        return real.consoleAdmit(r, at);
      },
    }));
    ownClock({ freeze: true });
    const app = await orgApp();
    const rpc = new ConsoleRpc(createExecutionContext(), env);
    await rpc.setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: true });
    await rpc.setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: false });
    await rpc.rotateKey({ ...member(), orgId: app.org, appId: app.id, keyId: await liveKey(app.id) });
    expect(seen).toEqual([
      { cost: 5, killSwitch: true, breaker: false },
      { cost: 5, killSwitch: false, breaker: false },
      { cost: 6, killSwitch: false, breaker: true },
    ]);
  });
});

describe('after PR 164’s review', () => {
  const breakerLists = (org: string) =>
    runInDurableObject(consoleObject(), (_i, st) =>
      [`console:breaker:org:${org}`, 'console:breaker:global', 'console:breaker:overflow'].map((k) => (st.storage.kv.get<number[]>(k) ?? []).filter((x) => x > Date.now() - HOUR).length),
    );

  it('a breaker call refused before any batch (a web-client change with a session TTL under a proposed policy: `policy_invalid`) gives its slot back to all three lists; the app row is unchanged', async () => {
    ownClock({ freeze: true });
    const t = Date.now();
    // The reviewer's sequence: the global 20 full, an org with a pending policy proposal, four such calls.
    for (const o of orgsOf(4, 'g')) for (let k = 0; k < 5; k++) expect((await slot(consoleObject(), o, t)).ok).toBe(true);
    const app = await orgApp({ live: true });
    expect(await adminRpc().proposeChange({ ...hana(), orgId: app.org, appId: app.id, kind: 'policy_set', policy: autoApprovePolicy('12h'), expectedVersion: 0 })).toMatchObject({ ok: true });
    const before = await breakerLists(app.org);
    const row = await appRow(app.id);
    for (let i = 0; i < 4; i++) {
      expect(await consoleRpc().updateSettings({ ...member(), orgId: app.org, appId: app.id, expectedVersion: 1, sessionTtlMs: 2 * HOUR, idleTtlMs: HOUR, googleWebClientId: null }), `call ${i + 1}`).toMatchObject({ ok: false, code: 'policy_invalid' });
    }
    // Before the fix: org 0 → 3, global 20 → 23, overflow 0 → 3 (the fourth refused `rate_limited`), nothing written.
    expect(await breakerLists(app.org)).toEqual(before);
    expect(await appRow(app.id)).toEqual(row);
    // The org's floor is whole: three removals pass on the overflow.
    for (let i = 0; i < 3; i++) {
      const a = await orgApp({ org: app.org, origins: [ORIGIN, SECOND] });
      expect(await consoleRpc().removeOrigins({ ...member(), orgId: app.org, appId: a.id, remove: [SECOND], expectedVersion: 0 })).toMatchObject({ ok: true });
    }
  });

  it('a breaker call that answers ok and changes nothing (a web-client change to the client already set) gives its slot back', async () => {
    ownClock({ freeze: true });
    const app = await orgApp();
    const current = (await appRow(app.id)).google_web_client_id as string | null;
    const before = await breakerLists(app.org);
    for (let i = 0; i < 6; i++) expect(await consoleRpc().updateSettings({ ...member(), orgId: app.org, appId: app.id, expectedVersion: 0, googleWebClientId: current })).toEqual({ ok: true, version: 0 });
    expect(await breakerLists(app.org)).toEqual(before);
  });

  it('a breaker call whose batch was sent and failed with an unknown outcome (`internal`) keeps its slot', async () => {
    ownClock({ freeze: true });
    const app = await orgApp({ origins: [ORIGIN, SECOND] });
    const before = await breakerLists(app.org);
    const db = env.DB;
    const spy = vi.spyOn(db, 'batch').mockRejectedValueOnce(new Error('D1 lost the answer'));
    expect(await consoleRpc().removeOrigins({ ...member(), orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 0 })).toMatchObject({ ok: false, code: 'internal' });
    spy.mockRestore();
    expect(await breakerLists(app.org)).toEqual([before[0]! + 1, before[1]! + 1, before[2]!]);
  });
});
