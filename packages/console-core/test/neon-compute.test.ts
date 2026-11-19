import { describe, expect, it } from 'vitest';
import { NEON_SUSPEND_MS, addWake, alertLevel, assumedAwakeMs, countedPartly, estimateAwakeMs, allowancePct, awakeMsAt, computeHours, neonMonth, neonPlanOf, neonWakeInput, nextMonthStart } from '../src/neon-compute.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 19, 10, 0);
const sys = { actor: { kind: 'system', id: 'admin-cron' }, requestId: 'cron_12345678', clientIp: '0.0.0.0' };

describe('Neon compute estimate (D872)', () => {
  it('reads NEON_PLAN, refusing anything unusable', () => {
    expect(neonPlanOf('{"computeHoursPerMonth":100,"computeUnits":0.25}')).toEqual({ computeHoursPerMonth: 100, computeUnits: 0.25 });
    for (const bad of [undefined, '', '{', '{}', '{"computeHoursPerMonth":0,"computeUnits":0.25}', '{"computeHoursPerMonth":100,"computeUnits":0.3}', '{"computeHoursPerMonth":"100","computeUnits":0.25}']) expect(neonPlanOf(bad), String(bad)).toBeNull();
  });

  it('a wake-up keeps the compute awake until 5 minutes after the connection closed', () => {
    const r = addWake(null, '2026-11', T0, T0 + 10_000);
    expect(r).toEqual({ month: '2026-11', firstAt: T0, closedMs: 0, winStart: T0, winEnd: T0 + 10_000 + NEON_SUSPEND_MS, windows: 1, alerted: 0 });
    expect(awakeMsAt(r, T0 + 2 * MIN)).toBe(2 * MIN);
    expect(awakeMsAt(r, T0 + 60 * MIN)).toBe(10_000 + 5 * MIN);
  });

  it('overlapping wake-ups count once; a gap opens a new window', () => {
    // A cron run at :00 for 10 s, a login at :02, then the next run at :15.
    let r = addWake(null, '2026-11', T0, T0 + 10_000);
    r = addWake(r, '2026-11', T0 + 2 * MIN, T0 + 2 * MIN + 500);
    expect(r.windows).toBe(1);
    expect(r.winEnd).toBe(T0 + 2 * MIN + 500 + NEON_SUSPEND_MS);
    r = addWake(r, '2026-11', T0 + 15 * MIN, T0 + 15 * MIN + 10_000);
    expect(r.windows).toBe(2);
    expect(r.closedMs).toBe(7 * MIN + 500);
    expect(awakeMsAt(r, T0 + 30 * MIN)).toBe(7 * MIN + 500 + 10_000 + 5 * MIN);
    // A late report (starting before the open window, which began at :15) moves the window's start back: no new window,
    // nothing closed, the gap counted (the estimate errs high).
    const late = addWake(r, '2026-11', T0 + 14 * MIN, T0 + 14 * MIN + 1);
    expect(late.windows).toBe(2);
    expect(late.closedMs).toBe(r.closedMs);
    expect(late.winStart).toBe(T0 + 14 * MIN);
    expect(awakeMsAt(late, T0 + 30 * MIN)).toBe(awakeMsAt(r, T0 + 30 * MIN) + MIN);
    expect(late.firstAt).toBe(T0);
    // One that ended before the open window began (a report an hour late) adds its own length, the window untouched.
    const older = addWake(r, '2026-11', T0 + 3 * MIN, T0 + 3 * MIN + 1000);
    expect(older).toMatchObject({ winStart: r.winStart, winEnd: r.winEnd, windows: r.windows, closedMs: r.closedMs + 1000 + NEON_SUSPEND_MS });
  });

  it('the free plan: 96 runs a day 15 minutes apart, 10 s each, is about 2.1 compute-hours a day (0.25 CU)', () => {
    let r = null;
    for (let i = 0; i < 96; i++) r = addWake(r, '2026-11', T0 + i * 15 * MIN, T0 + i * 15 * MIN + 10_000);
    const hours = computeHours(awakeMsAt(r!, T0 + 24 * 60 * MIN), 0.25);
    expect(hours).toBeCloseTo((96 * (5 * MIN + 10_000)) / 3_600_000 / 4, 6);
    expect(hours).toBeGreaterThan(2.0);
    expect(hours).toBeLessThan(2.1);
    // Every 5 minutes: the windows touch (each ends as the next starts + 10 s), so it never sleeps: 6 a day.
    let five = null;
    for (let i = 0; i < 288; i++) five = addWake(five, '2026-11', T0 + i * 5 * MIN, T0 + i * 5 * MIN + 10_000);
    expect(five!.windows).toBe(1);
    expect(computeHours(awakeMsAt(five!, T0 + 24 * 60 * MIN), 0.25)).toBeCloseTo(6, 2);
  });

  it('months are UTC and roll over on the 1st', () => {
    expect(neonMonth(Date.UTC(2026, 10, 30, 23, 59, 59))).toBe('2026-11');
    expect(neonMonth(Date.UTC(2026, 11, 1, 0, 0))).toBe('2026-12');
    expect(nextMonthStart('2026-11')).toBe(Date.UTC(2026, 11, 1));
    expect(nextMonthStart('2026-12')).toBe(Date.UTC(2027, 0, 1));
  });

  it('a start more than 48 hours into the month is partial; within 48 hours the month counts whole, the hours before assumed awake', () => {
    const H = 60 * MIN;
    const nov1 = Date.UTC(2026, 10, 1);
    expect(countedPartly('2026-11', nov1 + 3_000)).toBe(false);
    expect(countedPartly('2026-11', nov1 + 10 * H)).toBe(false);
    expect(countedPartly('2026-11', nov1 + 48 * H)).toBe(false);
    expect(countedPartly('2026-11', nov1 + 48 * H + 1)).toBe(true);
    expect(countedPartly('2026-11', Date.UTC(2026, 10, 27, 9, 0))).toBe(true);
    // Within 48 h: the lead is added as awake (at most 48 h, 12 compute-hours at 0.25 CU); a partial month adds nothing.
    expect(assumedAwakeMs('2026-11', nov1 + 10 * H)).toBe(10 * H);
    expect(assumedAwakeMs('2026-11', nov1 + 48 * H)).toBe(48 * H);
    expect(computeHours(assumedAwakeMs('2026-11', nov1 + 48 * H), 0.25)).toBe(12);
    expect(assumedAwakeMs('2026-11', nov1 + 48 * H + 1)).toBe(0);
    const row = addWake(null, '2026-11', nov1 + 10 * H, nov1 + 10 * H + 10_000);
    expect(estimateAwakeMs('2026-11', row, nov1 + 11 * H)).toBe(10 * H + 10_000 + NEON_SUSPEND_MS);
    const late = addWake(null, '2026-11', nov1 + 50 * H, nov1 + 50 * H + 10_000);
    expect(estimateAwakeMs('2026-11', late, nov1 + 51 * H)).toBe(10_000 + NEON_SUSPEND_MS);
  });

  it('a window across midnight on the 1st counts in the month it began; the next month starts its own row', () => {
    const nov = addWake(null, neonMonth(Date.UTC(2026, 10, 30, 23, 58)), Date.UTC(2026, 10, 30, 23, 58), Date.UTC(2026, 10, 30, 23, 58, 10));
    expect(nov.month).toBe('2026-11');
    expect(nov.winEnd).toBeGreaterThan(Date.UTC(2026, 11, 1));
    const dec = addWake(null, neonMonth(Date.UTC(2026, 11, 1, 0, 0)), Date.UTC(2026, 11, 1, 0, 0), Date.UTC(2026, 11, 1, 0, 0, 10));
    expect(dec).toMatchObject({ month: '2026-12', closedMs: 0, windows: 1 });
    expect(countedPartly(dec.month, dec.firstAt)).toBe(false);
  });

  it('the alert levels: 70 and 90 of the allowance', () => {
    const plan = { computeHoursPerMonth: 100, computeUnits: 0.25 };
    expect(allowancePct(69.9, plan)).toBeCloseTo(69.9);
    expect([0, 69.99, 70, 89.99, 90, 120].map(alertLevel)).toEqual([0, 0, 70, 70, 90, 90]);
  });

  it('neonWakeInput: a bounded wake-up and at most the three run records', () => {
    expect(neonWakeInput.safeParse({ ...sys, startMs: T0, endMs: T0 + 1000 }).success).toBe(true);
    expect(neonWakeInput.safeParse({ ...sys, startMs: T0, endMs: T0 + 1000, runs: [{ key: 'ledger_cron.last_run', value: '{"at":1}' }] }).success).toBe(true);
    for (const bad of [
      { ...sys, startMs: T0, endMs: T0 - 1 },
      { ...sys, startMs: T0, endMs: T0 + 16 * MIN },
      { ...sys, startMs: T0, endMs: T0, runs: [{ key: 'feed.app_changes.seq', value: '{}' }] },
      { ...sys, startMs: T0, endMs: T0, runs: [{ key: 'cron.last_run', value: 'x'.repeat(4097) }] },
      { ...sys, startMs: T0, endMs: T0, extra: 1 },
    ]) expect(neonWakeInput.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
  });
});
