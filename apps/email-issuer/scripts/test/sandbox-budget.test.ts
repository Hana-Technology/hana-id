// sandbox-dev's daily send budget (D793): every mail the issuer may send in a day stays under the SendGrid free plan's
// 100 a day (the quota docs/operations.md records, D417), with room for the admin Worker's and the watchdog's mail on the
// same account (D414 as amended). The numbers docs/operations.md "Judging week on sandbox-dev" quotes come from here.
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

/** SendGrid's free plan, as docs/operations.md "Never past a free tier" records it. */
const SENDGRID_FREE_PER_DAY = 100;
/** Kept for the two other keys on the account (admin notices, watchdog alerts) and the issuer's own alerts. */
const OTHER_MAIL_ROOM = 9;
/** The `free` plan's `per_day` (apps/api/migrations/0001_init.sql): the demo app's plan. */
const FREE_PLAN_PER_DAY = 5000;

describe("sandbox-dev's daily send budget (D793)", () => {
  const budget = loadEnv('sandbox-dev').emailIssuer?.dailySendBudget;

  it('is set, and all the issuer can send in a day fits under the quota with room for the other mail', () => {
    expect(budget).toBe(70);
    expect(budget! + ownerPool(budget!)).toBeLessThanOrEqual(SENDGRID_FREE_PER_DAY - OTHER_MAIL_ROOM);
  });

  it('gives the numbers the runbook quotes', () => {
    const b = budget!;
    expect([staffPool(b), generalPool(b), ownerPool(b)]).toEqual([5, 65, 21]);
    const share = appBudgetShare(FREE_PLAN_PER_DAY, b);
    expect(share).toBe(65);
    // Past 80% of the general pool an app that used half its share gets no more: the demo app's day is 52.
    expect(Math.floor(generalPool(b) * (1 - BUDGET_RESERVE))).toBe(52);
    expect(Math.floor(share / 2)).toBeLessThanOrEqual(52);
    expect([Math.floor(b * HOME_BUDGET_SHARE), Math.floor(b * HOME_RESERVE_SHARE)]).toEqual([4, 2]);
  });
});
