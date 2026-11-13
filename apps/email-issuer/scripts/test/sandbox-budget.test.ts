// sandbox-dev's daily send budget (D793). The SendGrid account is on Essentials 50K (the user, 2026-11-13): 50,000
// mails a month, billed per mail past that, and shared with the user's other apps (all together they sent 1,342 in the
// 30 days to 2026-11-13 and about 6,300 in the 30 days before: the user's SendGrid screenshot of 2026-11-13). So this
// env's worst-case month (the
// issuer's budget and owner pool every day for 31 days, plus the admin Worker's, the watchdog's and the issuer's alert
// mail) must stay within its share of the plan. The assumption lives in the two constants below; the budget itself in
// envs/sandbox-dev.json `emailIssuer.dailySendBudget`. The numbers docs/operations.md "Judging week on sandbox-dev"
// quotes come from here.
import { loadEnv } from '@hana-id/env';
import { describe, expect, it } from 'vitest';

/** What this test takes from src/limits.ts. */
interface BudgetLimits {
  BUDGET_RESERVE: number;
  HOME_BUDGET_SHARE: number;
  HOME_RESERVE_SHARE: number;
  appBudgetShare(perDay: number, budget: number): number;
  generalPool(budget: number): number;
  ownerPool(budget: number): number;
  staffPool(budget: number): number;
}
// Loaded by a path the typechecker doesn't follow: src/limits.ts names a type of the Worker's rate limiter, whose
// `cloudflare:workers` import this Node-side project can't resolve (the import is a type only, erased at run time).
const LIMITS_MODULE = '../../src/limits.ts';
const { BUDGET_RESERVE, HOME_BUDGET_SHARE, HOME_RESERVE_SHARE, appBudgetShare, generalPool, ownerPool, staffPool } = (await import(/* @vite-ignore */ LIMITS_MODULE)) as BudgetLimits;

/** SendGrid Essentials 50K: mails a month (the user, 2026-11-13). */
const PLAN_PER_MONTH = 50_000;
/** This env's share of it: 30%, the user's choice "to be safe" (2026-11-13), though the other apps send far less (D793). */
const ENV_SHARE = 0.3;
/**
 * The other mail on the same account a day: the issuer's own alerts (at most 20, limits in code), the admin Worker's
 * notices and the watchdog's alerts and digest. An unacknowledged critical watchdog alert re-sends every 15 minutes
 * (96 a day) and is not covered: acknowledge them.
 */
const OTHER_MAIL_PER_DAY = 50;
const DAYS = 31;
/** The `free` plan's `per_day` (apps/api/migrations/0001_init.sql). */
const FREE_PLAN_PER_DAY = 5000;

/** The most this env can send in a month with this budget. */
const worstMonth = (budget: number): number => (budget + ownerPool(budget) + OTHER_MAIL_PER_DAY) * DAYS;

describe("sandbox-dev's daily send budget (D793)", () => {
  const budget = loadEnv('sandbox-dev').emailIssuer?.dailySendBudget;

  it("keeps the worst-case month within the env's share of the plan", () => {
    expect(budget).toBeDefined();
    expect(worstMonth(budget!)).toBeLessThanOrEqual(PLAN_PER_MONTH * ENV_SHARE);
  });

  it('the budgets docs/operations.md lists for a 20%, 30% and 50% share are the largest that fit', () => {
    for (const [share, b] of [
      [0.2, 209],
      [0.3, 333],
      [0.5, 582],
    ] as const) {
      expect(worstMonth(b), String(share)).toBeLessThanOrEqual(PLAN_PER_MONTH * share);
      expect(worstMonth(b + 1), String(share)).toBeGreaterThan(PLAN_PER_MONTH * share);
    }
  });

  it('gives the numbers the runbook quotes', () => {
    const b = budget!;
    expect(b).toBe(333);
    expect(worstMonth(b)).toBe(14_942);
    expect([staffPool(b), generalPool(b), ownerPool(b)]).toEqual([5, 328, 99]);
    // A free-plan app: 2% of 5000, within the pool.
    expect(appBudgetShare(FREE_PLAN_PER_DAY, b)).toBe(100);
    // Past 80% of the general pool an app that used half its share gets no more.
    expect(Math.floor(generalPool(b) * (1 - BUDGET_RESERVE))).toBe(262);
    expect([Math.floor(b * HOME_BUDGET_SHARE), Math.floor(b * HOME_RESERVE_SHARE)]).toEqual([19, 13]);
  });
});
