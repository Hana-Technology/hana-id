// The test clock of fixed-window tests (helpers.ts startOfMinuteClock): where it puts a run, for real times next to
// every kind of window boundary, so a window-counting test never straddles one whatever the real time.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { minuteStartFor, startOfMinuteClock } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DAY0 = Date.UTC(2026, 10, 11); // a UTC midnight

describe('minuteStartFor', () => {
  it('a second into the current minute, wherever in it the run starts', () => {
    for (const into of [0, 1, 999, 1000, 30_000, 59_999]) expect(minuteStartFor(DAY0 + 10 * MINUTE + into)).toBe(DAY0 + 10 * MINUTE + 1000);
  });

  it('never in an hour’s last minute (nor so a UTC day’s): the next hour’s first instead', () => {
    for (const into of [0, 30_000, 59_999]) {
      expect(minuteStartFor(DAY0 + 13 * HOUR - MINUTE + into)).toBe(DAY0 + 13 * HOUR + 1000);
      expect(minuteStartFor(DAY0 + DAY - MINUTE + into)).toBe(DAY0 + DAY + 1000);
    }
  });

  it('leaves at least 59 s in the minute, hour and UTC day it lands in', () => {
    for (let t = DAY0 + DAY - 3 * MINUTE; t < DAY0 + DAY + 3 * MINUTE; t += 7_919) {
      const s = minuteStartFor(t);
      for (const w of [MINUTE, HOUR, DAY]) expect(w - (s % w), `${t} ${w}`).toBeGreaterThanOrEqual(59_000);
      // Never more than a minute either side of the real time.
      expect(Math.abs(s - t)).toBeLessThanOrEqual(MINUTE + 1000);
    }
  });
});

describe('startOfMinuteClock', () => {
  it('moves Date.now by minuteStartFor(now) − now, keeping its pace; restoreAllMocks undoes it', async () => {
    // The "real" clock stands still here, so the moved one can be read exactly.
    let real = DAY0 + DAY - 20_000;
    vi.spyOn(Date, 'now').mockImplementation(() => real);
    await startOfMinuteClock();
    expect(Date.now()).toBe(DAY0 + DAY + 1000);
    real += 1234;
    expect(Date.now()).toBe(DAY0 + DAY + 2234);
    // A second call moves the moved clock (no recursion through the reused spy): already a second into its minute.
    real -= 1234;
    await startOfMinuteClock();
    expect(Date.now()).toBe(DAY0 + DAY + 1000);
    vi.restoreAllMocks();
    expect(Date.now()).not.toBe(DAY0 + DAY + 2234);
  });
});
