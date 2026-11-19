// D872 (src/neon.ts): the feed and watcher interval, and the wake-up reports of a staff page's ledger connection.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import { catchUpDue, openTracked, opsDueAt, opsEveryMinutesOf, reportNeonWake, tickOf, trackedStore, tracksNeon } from '../src/neon.ts';

afterEach(() => vi.restoreAllMocks());

const PLAN = '{"computeHoursPerMonth":100,"computeUnits":0.25}';
const DB = { connectionString: 'postgres://unused' } as unknown as Hyperdrive;

describe('the interval (D872)', () => {
  it('15 only when the var says exactly 15; anything else is 5', () => {
    expect(opsEveryMinutesOf({ OPS_EVERY_MINUTES: '15' })).toBe(15);
    for (const v of [undefined, '5', '30', '15 ', 'fifteen', '']) expect(opsEveryMinutesOf({ OPS_EVERY_MINUTES: v }), String(v)).toBe(5);
  });

  it('due at :00, :15, :30, :45 at 15; every run at 5', () => {
    const at = (h: number, m: number) => Date.UTC(2026, 10, 19, h, m);
    expect([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].filter((m) => opsDueAt({ OPS_EVERY_MINUTES: '15' }, at(3, m)))).toEqual([0, 15, 30, 45]);
    expect([0, 5, 10, 15].every((m) => opsDueAt({}, at(3, m)))).toBe(true);
  });
});

describe('the tick and the catch-up (D872 after review)', () => {
  const MIN = 60_000;
  const at = (m: number, s = 0) => Date.UTC(2026, 10, 19, 3, m, s);
  it('a scheduledTime a little off its minute still lands on its tick', () => {
    expect(tickOf(at(14, 59))).toBe(at(15));
    expect(tickOf(at(15, 40))).toBe(at(15));
    expect(opsDueAt({ OPS_EVERY_MINUTES: '15' }, at(14, 58))).toBe(true);
    expect(opsDueAt({ OPS_EVERY_MINUTES: '15' }, at(20, 2))).toBe(false);
    // The hour turns: 23:59:59 on the 30th is the 1st's 00:00 tick.
    expect(opsDueAt({ OPS_EVERY_MINUTES: '15' }, Date.UTC(2026, 10, 30, 23, 59, 59))).toBe(true);
  });

  it('catches up a quarter hour that didn’t report or failed, once; never a healthy one', () => {
    const ok = (m: number) => ({ at: at(m) + 1_000, feed: true, watcher: true });
    const bad = (m: number) => ({ at: at(m) + 1_000, feed: false, watcher: true });
    expect(catchUpDue(null, at(5))).toBe(true);
    expect(catchUpDue(ok(0), at(5))).toBe(false);
    expect(catchUpDue(ok(0), at(10))).toBe(false);
    // :15 didn't report: the record is :00's, before the quarter.
    expect(catchUpDue(ok(0), at(20))).toBe(true);
    // :15 reported a failure: :20 catches up; once :20 has reported (failed again or not), :25 doesn't.
    expect(catchUpDue(bad(15), at(20))).toBe(true);
    expect(catchUpDue(bad(20), at(25))).toBe(false);
    expect(catchUpDue(ok(20), at(25))).toBe(false);
    expect(catchUpDue(ok(15), at(20))).toBe(false);
    expect(catchUpDue({ at: at(15) + 1_000, feed: true, watcher: false }, at(20))).toBe(true);
    expect(MIN).toBe(60_000);
  });
});

describe('wake-up reports (D872)', () => {
  const api = () => {
    const calls: Record<string, unknown>[] = [];
    return { calls, API: { neonWake: async (c: Record<string, unknown>) => (calls.push(c), { ok: true as const, noted: true }) } };
  };

  it('only with NEON_PLAN readable and the ledger bound', () => {
    expect(tracksNeon({ NEON_PLAN: PLAN, USAGE_DB: DB })).toBe(true);
    expect(tracksNeon({ NEON_PLAN: PLAN, USAGE_DB: undefined })).toBe(false);
    expect(tracksNeon({ NEON_PLAN: undefined, USAGE_DB: DB })).toBe(false);
    expect(tracksNeon({ NEON_PLAN: '{bad', USAGE_DB: DB })).toBe(false);
  });

  it('a staff page’s store reports its wake-up when it closes, once; the same store without the plan', async () => {
    const { calls, API } = api();
    const env = { NEON_PLAN: PLAN, USAGE_DB: DB, API } as unknown as Env;
    let closed = 0;
    const store = { read: async () => 7, close: async () => void closed++ };
    const t = trackedStore(env, store, 1_000)!;
    expect(await t.read()).toBe(7);
    expect(calls).toEqual([]);
    await t.close();
    expect(closed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ actor: { kind: 'system', id: 'admin-cron' }, startMs: 1_000 });
    expect(trackedStore({ ...env, NEON_PLAN: undefined }, store, 1_000)).toBe(store);
    expect(trackedStore(env, null, 1_000)).toBeNull();
  });

  it('openTracked reads the clock before the connection opens', async () => {
    const { calls, API } = api();
    const env = { NEON_PLAN: PLAN, USAGE_DB: DB, API } as unknown as Env;
    vi.useFakeTimers({ now: 10_000 });
    try {
      const t = await openTracked(env, async () => {
        vi.setSystemTime(12_500); // the connection took 2.5 s
        return { close: async () => undefined };
      });
      await t!.close();
      expect(calls[0]).toMatchObject({ startMs: 10_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws: an API that refuses or is down is logged; the window is capped at 15 minutes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const down = { NEON_PLAN: PLAN, USAGE_DB: DB, API: { neonWake: () => Promise.reject(new Error('down')) } } as unknown as Env;
    expect(await reportNeonWake(down, 1, 2)).toBe(false);
    const refused = { NEON_PLAN: PLAN, USAGE_DB: DB, API: { neonWake: async () => ({ ok: false, code: 'bad_request' }) } } as unknown as Env;
    expect(await reportNeonWake(refused, 1, 2)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    const { calls, API } = api();
    await reportNeonWake({ NEON_PLAN: PLAN, USAGE_DB: DB, API } as unknown as Env, 0, 60 * 60_000);
    expect(calls[0]).toMatchObject({ startMs: 0, endMs: 15 * 60_000 });
  });
});
