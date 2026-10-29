// @vitest-environment happy-dom
// pk_test_ timings, partner side (packages/core/src/timings.ts): the client adds its own stages around the vault's so
// that, with `other`, they add up to the page's total; pk_live_ apps never see any.
import { LOGIN_TIMING_STAGES, UNLOCK_TIMING_STAGES, stageSum, withOther } from '@hana-id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVM, LOGGED_IN, LOGGED_OUT, STELLAR, type Setup, flush, setup } from './harness.ts';

let s: Setup;
/** A clock that moves 10 ms every time it is read. */
function ticking(): () => number {
  let t = 1000;
  return () => (t += 10);
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  s?.client.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const LOGIN_RESULT = { addresses: { stellar: STELLAR, evm: EVM }, expiresAtMs: 1_900_000_000_000, persistence: 'session' as const };
/** The vault's stages (they add up to its `vault` total) and a detail that is never added. */
const VAULT_LOGIN = { app: 0.1, keygen: 0.2, popup: 0.3, google: 0.4, verify: 0.5, scopeWait: 0, chain: 0.6, decrypt: 0.7, persist: 0.8, finish: 0.9, vault: 4.5, loginRtt: 0.5 };

describe('login timings', () => {
  it('adds open, wait and port; with other they sum to the page’s total', async () => {
    const now = ticking();
    s = setup({ now });
    await s.vault.connect();
    s.vault.handle('hana_login', () => 'manual');
    const t0 = now();
    const p = s.client.login();
    await flush();
    const req = s.vault.last('hana_login');
    s.vault.emit('loginProgress', { stage: 'popup_connected' });
    s.vault.reply(req.id, { ...LOGIN_RESULT, timings: VAULT_LOGIN });
    await p;
    const totalMs = now() - t0;
    const timings = s.client.lastLogin!.timings!;
    expect(timings).toMatchObject({ ...VAULT_LOGIN, open: expect.any(Number), wait: expect.any(Number), port: expect.any(Number) });
    const all = withOther(timings, LOGIN_TIMING_STAGES, totalMs);
    expect(all).not.toHaveProperty('overrun');
    expect(stageSum(all, [...LOGIN_TIMING_STAGES, 'other'])).toBeCloseTo(totalMs, 9);
    // A detail (loginRtt) is not part of the sum.
    expect(LOGIN_TIMING_STAGES as readonly string[]).not.toContain('loginRtt');
  });

  it('a pk_live_ app gets no timings, even if a vault sent some', async () => {
    s = setup({ config: { publishableKey: 'pk_live_1111111111111111' } });
    await s.vault.connect();
    s.vault.handle('hana_login', () => 'manual');
    const p = s.client.login();
    await flush();
    const req = s.vault.last('hana_login');
    s.vault.emit('loginProgress', { stage: 'popup_connected' });
    s.vault.reply(req.id, { ...LOGIN_RESULT, timings: VAULT_LOGIN });
    await p;
    expect(s.client.lastLogin).not.toHaveProperty('timings');
  });
});

describe('ready (unlock) timings', () => {
  const VAULT_READY = { vaultFetch: 20, vaultScript: 10, vaultConfig: 2, vaultLoad: 3, store: 1, record: 2, unlock: 30, counter: 1, unwrap: 1, addresses: 2, vault: 37, unlockRtt: 29 };

  it('adds mount, frameStart and port; with other they sum to createHana → ready', async () => {
    const now = ticking();
    const t0 = now();
    s = setup({ now });
    await s.vault.connect({ ...LOGGED_IN, timings: VAULT_READY } as never);
    await s.client.ready;
    const totalMs = now() - t0;
    const timings = s.client.readyTimings!;
    expect(timings).toMatchObject({ ...VAULT_READY, mount: expect.any(Number), frameStart: expect.any(Number), port: expect.any(Number) });
    const all = withOther(timings, UNLOCK_TIMING_STAGES, totalMs);
    // The fake vault's load parts are larger than this fake clock's frame load, so frameStart is 0 and the excess
    // shows as `overrun`: the stages, `other` and `overrun` still balance.
    expect(stageSum(all, [...UNLOCK_TIMING_STAGES, 'other'])).toBeCloseTo(totalMs + (all.overrun ?? 0), 9);
  });

  it('is null for pk_live_ apps and when the vault sent none', async () => {
    s = setup({ config: { publishableKey: 'pk_live_1111111111111111' } });
    await s.vault.connect({ ...LOGGED_OUT, timings: VAULT_READY } as never);
    await s.client.ready;
    expect(s.client.readyTimings).toBeNull();
    s.client.destroy();
    s = setup();
    await s.vault.connect(LOGGED_OUT);
    await s.client.ready;
    expect(s.client.readyTimings).toBeNull();
  });
});
