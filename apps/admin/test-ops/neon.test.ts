// D872 (src/neon.ts): the feed and watcher interval, and the wake-up reports of a staff page's ledger connection.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import { opsDueAt, opsEveryMinutesOf, reportNeonWake, trackedStore, tracksNeon } from '../src/neon.ts';

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
