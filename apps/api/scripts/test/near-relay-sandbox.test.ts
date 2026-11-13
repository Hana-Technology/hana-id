// sandbox-dev's NEAR relay as configured for the hackathon's judging week (D793): the manifest's values parse, and the
// funding and budget lines keep the relationships D793 sized them by. Reverting D793 means changing the pinned values
// here on purpose.
import { loadEnv } from '@hana-id/env';
import { describe, expect, it } from 'vitest';
import { nearRelayVar, nearToYocto, parseNearRelayConfig } from '../../src/near/relay-config.ts';

/** Measured on testnet 2026-11-13 (docs/operations.md "NEAR relay"): one activation, one guestbook relay, in yocto. */
const ACTIVATION_YOCTO = 7_115n * 10n ** 18n;
const GUESTBOOK_RELAY_YOCTO = 239n * 10n ** 18n;

describe("sandbox-dev's NEAR relay (D793)", () => {
  const relay = loadEnv('sandbox-dev').near?.relay;
  const config = relay ? parseNearRelayConfig(nearRelayVar(relay)) : null;

  it('parses, with the judging-week values', () => {
    expect(config).not.toBeNull();
    expect(relay).toMatchObject({ appDailyBudgetNear: 3, dailyBudgetNear: 6, activationsPerAppPerDay: 300, lowBalanceNear: 9, inFlightNear: 3, perSenderPerDay: 50 });
  });

  it("alerts on the balance while the in-flight hold and a whole day's budget are still covered", () => {
    expect(config!.lowBalanceYocto).toBeGreaterThanOrEqual(config!.inFlightYocto + config!.dailyBudgetYocto);
  });

  it("the app's day covers its activations at the measured cost, and 200 new users writing five messages each", () => {
    expect(BigInt(config!.activationsPerAppPerDay) * ACTIVATION_YOCTO).toBeLessThanOrEqual(config!.appDailyBudgetYocto);
    expect(200n * (ACTIVATION_YOCTO + 5n * GUESTBOOK_RELAY_YOCTO)).toBeLessThanOrEqual(config!.appDailyBudgetYocto);
    // One account's day (its per-sender cap) is a small part of the app's day.
    expect(BigInt(config!.perSenderPerDay) * GUESTBOOK_RELAY_YOCTO * 100n).toBeLessThanOrEqual(config!.appDailyBudgetYocto);
  });

  it("leaves partners' apps room in the env's day", () => {
    expect(config!.dailyBudgetYocto - config!.appDailyBudgetYocto).toBeGreaterThanOrEqual(nearToYocto(3));
  });
});
