// pk_test_ timings (src/timings.ts): the stage lists, `other`, and the shapes the port, the relay slot and the API carry.
import { describe, expect, it } from 'vitest';
import { parsePortEvent, parsePortReply } from '../src/protocol.ts';
import { RELAY_TIMINGS_MAX_KEYS, decryptRelayPayload, encryptRelayPayload, isRelayPayload } from '../src/relay.ts';
import { relayIdFor } from '../src/layouts.ts';
import {
  LOGIN_TIMING_DETAILS,
  LOGIN_TIMING_STAGES,
  TIMINGS_MAX_KEYS,
  UNLOCK_TIMING_DETAILS,
  UNLOCK_TIMING_STAGES,
  isServerTimings,
  isTimings,
  stageSum,
  withOther,
} from '../src/timings.ts';

describe('stage lists', () => {
  it('are distinct names that fit the port record, with stages and details apart', () => {
    for (const [stages, details] of [
      [LOGIN_TIMING_STAGES, LOGIN_TIMING_DETAILS],
      [UNLOCK_TIMING_STAGES, UNLOCK_TIMING_DETAILS],
    ] as const) {
      const all = [...stages, ...details];
      expect(new Set(all).size).toBe(all.length);
      // `other` and `overrun` are the page's; everything else (plus those two) fits one port record.
      expect(all).not.toContain('other');
      expect(all.length + 2).toBeLessThanOrEqual(TIMINGS_MAX_KEYS);
      expect(isTimings(Object.fromEntries(all.map((k) => [k, 1])))).toBe(true);
    }
  });
});

describe('withOther', () => {
  it('adds the rest of the total as `other`, so the stages and `other` sum to it', () => {
    const t = { app: 10, google: 4000, chain: 6000, scopeCheck: 500 };
    const all = withOther(t, LOGIN_TIMING_STAGES, 12_000);
    expect(all).toEqual({ ...t, other: 1990 });
    // scopeCheck is a detail: not summed.
    expect(stageSum(all, [...LOGIN_TIMING_STAGES, 'other'])).toBe(12_000);
  });

  it('reports stages past the total as `overrun` with `other` 0', () => {
    const all = withOther({ app: 30, chain: 80 }, LOGIN_TIMING_STAGES, 100);
    expect(all).toMatchObject({ other: 0, overrun: 10 });
    expect(stageSum(all, [...LOGIN_TIMING_STAGES, 'other']) - all.overrun!).toBe(100);
  });
});

describe('shapes', () => {
  it('isTimings: letters-only names, finite ms ≥ 0, at most TIMINGS_MAX_KEYS', () => {
    expect(isTimings({ a: 0, bB: 1.5 })).toBe(true);
    for (const bad of [null, [], { a: -1 }, { a: Number.NaN }, { a: Number.POSITIVE_INFINITY }, { a: '1' }, { 'a-b': 1 }, { a1: 1 }, { ['x'.repeat(33)]: 1 }]) expect(isTimings(bad)).toBe(false);
    expect(isTimings(Object.fromEntries(Array.from({ length: TIMINGS_MAX_KEYS + 1 }, (_, i) => [String.fromCharCode(97 + (i % 26)).repeat(1 + Math.floor(i / 26)), 1])))).toBe(false);
  });

  it('isServerTimings: exactly {totalMs, phases}', () => {
    expect(isServerTimings({ totalMs: 5, phases: { app: 1 } })).toBe(true);
    for (const bad of [{ totalMs: 5 }, { totalMs: -1, phases: {} }, { totalMs: 5, phases: { app: -1 } }, { totalMs: 5, phases: {}, extra: 1 }, null]) expect(isServerTimings(bad)).toBe(false);
  });

  it('the port takes timings on hana_login and on ready, and refuses malformed ones', () => {
    const addresses = { stellar: 'GC5LBUI3SHIZ55L7MJW5YPX5NXFV2TUGG4PMU4HJPO5H4C7LFRU6S5KV', evm: '0x52908400098527886E0F7030069857D2E4169EE7' };
    const login = { addresses, expiresAtMs: 5, persistence: 'session', timings: { chain: 1, vault: 2 } };
    expect(parsePortReply({ v: 1, id: '1', result: login }, 'hana_login')).not.toBeNull();
    expect(parsePortReply({ v: 1, id: '1', result: { ...login, timings: { chain: -1 } } }, 'hana_login')).toBeNull();
    expect(parsePortEvent({ v: 1, event: 'ready', data: { status: 'logged_out', persistence: 'session', timings: { store: 1 } } })).not.toBeNull();
    expect(parsePortEvent({ v: 1, event: 'ready', data: { status: 'logged_out', persistence: 'session', timings: { 'st-ore': 1 } } })).toBeNull();
  });

  it('the relay slot takes the popup’s timings beside the token or error, within its own key limit', async () => {
    expect(isRelayPayload({ idToken: 'a.b.c', timings: { authCheck: 1 } })).toBe(true);
    expect(isRelayPayload({ error: 'access_denied', timings: { authCheck: 1 } })).toBe(true);
    expect(isRelayPayload({ timings: { authCheck: 1 } })).toBe(false);
    expect(isRelayPayload({ idToken: 'a.b.c', timings: { authCheck: -1 } })).toBe(false);
    expect(isRelayPayload({ idToken: 'a.b.c', timings: Object.fromEntries(Array.from({ length: RELAY_TIMINGS_MAX_KEYS + 1 }, (_, i) => [`k${'x'.repeat(i)}`.replace(/\d/gu, ''), 1])) })).toBe(false);
    const key = crypto.getRandomValues(new Uint8Array(32));
    const relayId = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
    const payload = { idToken: 'a.b.c', timings: { authCheck: 12, callbackPrep: 1 } };
    expect(await decryptRelayPayload(key, relayId, await encryptRelayPayload(key, relayId, payload))).toEqual(payload);
  });
});
