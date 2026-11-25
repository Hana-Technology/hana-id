// sandbox-dev's NEAR relay after the hackathon's judging week (D793's put-back, D924): the manifest's values parse, are
// the four D793 recorded as the return values (1, 5, 200 and 2), and keep the relationships those values were chosen
// by. The judging-week values (3, 6, 300 and 9) are gone; raising them again means changing the pinned values here on
// purpose.
import { loadEnv } from '@hana-id/env';
import { describe, expect, it } from 'vitest';
import { nearRelayVar, nearToYocto, parseNearRelayConfig } from '../../src/near/relay-config.ts';

/** Measured on testnet 2026-11-13 (docs/operations.md "NEAR relay"): one activation, one guestbook relay, in yocto. */
const ACTIVATION_YOCTO = 7_115n * 10n ** 18n;
const GUESTBOOK_RELAY_YOCTO = 239n * 10n ** 18n;

describe("sandbox-dev's NEAR relay (D793 put back, D924)", () => {
  const relay = loadEnv('sandbox-dev').near?.relay;
  const config = relay ? parseNearRelayConfig(nearRelayVar(relay)) : null;

  it('parses, with the values D793 put back after judging; the others as D793 left them', () => {
    expect(config).not.toBeNull();
    expect(relay).toMatchObject({ appDailyBudgetNear: 1, dailyBudgetNear: 5, activationsPerAppPerDay: 200, lowBalanceNear: 2 });
    expect(relay).toMatchObject({ inFlightNear: 3, perSenderPerDay: 50, perAppPerDay: 2000, relaysPerDay: 10000, relaysPerMinute: 200, activationsPerDay: 1000, maxGasTgas: 10 });
  });

  it('the relay account needs inFlightNear + lowBalanceNear + dailyBudgetNear = 10 NEAR (docs/operations.md "NEAR relay")', () => {
    expect(config!.inFlightYocto + config!.lowBalanceYocto + config!.dailyBudgetYocto).toBe(nearToYocto(10));
  });

  it("one app's day: about 120 new users writing five messages each (D793: \"1 would stop at about 120\"), so a busy stamps day ends with relays refused until 00:00 UTC", () => {
    expect(120n * (ACTIVATION_YOCTO + 5n * GUESTBOOK_RELAY_YOCTO)).toBeLessThanOrEqual(config!.appDailyBudgetYocto);
    expect(130n * (ACTIVATION_YOCTO + 5n * GUESTBOOK_RELAY_YOCTO)).toBeGreaterThan(config!.appDailyBudgetYocto);
    // The budget, not the activation count, is what stops a busy app first.
    expect(BigInt(config!.activationsPerAppPerDay) * ACTIVATION_YOCTO).toBeGreaterThan(config!.appDailyBudgetYocto);
    // One account's day (its per-sender cap) stays a small part of the app's day.
    expect(BigInt(config!.perSenderPerDay) * GUESTBOOK_RELAY_YOCTO * 50n).toBeLessThanOrEqual(config!.appDailyBudgetYocto);
  });

  it("leaves partners' apps room in the env's day", () => {
    expect(config!.dailyBudgetYocto - config!.appDailyBudgetYocto).toBeGreaterThanOrEqual(nearToYocto(3));
  });
});
