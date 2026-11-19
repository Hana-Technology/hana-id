// An admin lane's own clock (admin-lane-worker.ts): the lane runs in a worker thread, whose `Date` is its own, so the
// tests and the hand test can move the lane's time forward (a waiting transaction past its time limit, the status
// page's 30-second cache) without touching the rest of the stack, whose clock stays the real one. Timers keep real
// time; only what the code reads as "now" moves. Installed once, before any product module reads the time.
const RealDate = Date;
let offsetMs = 0;
let installed = false;

/** The lane's "now" (real time plus the offset). */
export const laneNow = (): number => RealDate.now() + offsetMs;
/** The real time (what the rest of the stack reads), whatever the lane's offset. */
export const realNow = (): number => RealDate.now();

/** Moves the lane's time forward by `ms` (never back: a clock that runs backwards is no real clock). */
export function advanceLaneClock(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 62 * 24 * 3_600_000) throw new Error('advance: 0 to 62 days, in whole ms');
  offsetMs += ms;
  return offsetMs;
}

/** Back to real time (the unit tests; a lane's clock only moves forward). */
export function resetLaneClock(): void {
  offsetMs = 0;
}

export const laneClockOffset = (): number => offsetMs;

/** Replaces this thread's `Date` with one whose "now" is the lane's (`Date.now()`, `new Date()`); idempotent. */
export function installLaneClock(): void {
  if (installed) return;
  installed = true;
  class LaneDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(laneNow());
      else super(...(args as [string | number | Date]));
    }

    static override now(): number {
      return laneNow();
    }
  }
  // `Date()` called as a function returns a string of now.
  const wrapped = new Proxy(LaneDate, { apply: () => new RealDate(laneNow()).toString() });
  globalThis.Date = wrapped as DateConstructor;
}
