// @vitest-environment happy-dom
// HanaClient.supportId (batch C15): the logged-in user's Support ID from the vault's `ready`, the login result and, after
// another tab's session took over, hana_status; null logged out, after a logout, an expiry or a lost vault; announced by
// `supportIdChanged`. The hello names this SDK's version, so the vault knows it takes the field.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPPORT_ID_SDK_MIN, sdkAtLeast } from '@hana-id/core';
import { VERSION } from '../../src/version.ts';
import { EVM, EVM_2, LOGGED_IN, LOGGED_OUT, STELLAR, STELLAR_2, type Setup, flush, setup } from './harness.ts';

const CODE = 'HANA-2750-G5HM';
const CODE_2 = 'HANA-0000-ZZZZ';
const LOGIN_RESULT = { addresses: { stellar: STELLAR, evm: EVM }, expiresAtMs: 1_900_000_000_000, persistence: 'session' as const };

let s: Setup;
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  s?.client.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function loginWith(result: Record<string, unknown>): Promise<void> {
  s.vault.handle('hana_login', () => 'manual');
  const p = s.client.login();
  await flush();
  s.vault.emit('loginProgress', { stage: 'popup_connected' });
  s.vault.reply(s.vault.last('hana_login').id, result);
  await p;
}

describe('HanaClient.supportId', () => {
  it('the hello names a version the vault gives the field to', () => {
    expect(sdkAtLeast(VERSION, SUPPORT_ID_SDK_MIN)).toBe(true);
  });

  it('null before ready and when logged out', async () => {
    s = setup();
    expect(s.client.supportId).toBeNull();
    await s.vault.connect(LOGGED_OUT);
    expect(s.client.supportId).toBeNull();
  });

  it('from `ready` with a restored session; null when the vault sent none', async () => {
    s = setup();
    const seen: (string | null)[] = [];
    s.client.on('supportIdChanged', (v) => seen.push(v));
    await s.vault.connect({ ...LOGGED_IN, supportId: CODE });
    expect(s.client.supportId).toBe(CODE);
    expect(seen).toEqual([CODE]);
    s.client.destroy();
    document.body.replaceChildren();
    s = setup();
    await s.vault.connect(LOGGED_IN);
    expect(s.client.status).toBe('logged_in');
    expect(s.client.supportId).toBeNull();
  });

  it('from the login result, and cleared by logout', async () => {
    s = setup();
    await s.vault.connect(LOGGED_OUT);
    await loginWith({ ...LOGIN_RESULT, supportId: CODE });
    expect(s.client.supportId).toBe(CODE);
    expect(s.client.lastLogin?.supportId).toBe(CODE);
    s.vault.handle('hana_logout', () => ({ result: null }));
    await s.client.logout();
    expect(s.client.supportId).toBeNull();
  });

  it('a login result without one leaves it null', async () => {
    s = setup();
    await s.vault.connect(LOGGED_OUT);
    await loginWith(LOGIN_RESULT);
    expect(s.client.status).toBe('logged_in');
    expect(s.client.supportId).toBeNull();
  });

  it('cleared by sessionExpired and by a lost vault', async () => {
    s = setup();
    await s.vault.connect({ ...LOGGED_IN, supportId: CODE });
    s.vault.emit('sessionExpired', null);
    await flush();
    expect(s.client.supportId).toBeNull();
    s.client.destroy();
    document.body.replaceChildren();
    s = setup();
    await s.vault.connect({ ...LOGGED_IN, supportId: CODE });
    s.vault.emit('disconnect', { code: 4900 });
    await flush();
    expect(s.client.supportId).toBeNull();
  });

  it('another session’s addresses (accountsChanged): cleared, then read again with hana_status', async () => {
    s = setup();
    await s.vault.connect({ ...LOGGED_IN, supportId: CODE });
    const other = { stellar: STELLAR_2, evm: EVM_2 };
    s.vault.handle('hana_status', () => ({ result: { status: 'logged_in', addresses: other, expiresAtMs: 1_900_000_000_000, persistence: 'session', supportId: CODE_2 } }));
    const seen: (string | null)[] = [];
    s.client.on('supportIdChanged', (v) => seen.push(v));
    s.vault.emit('accountsChanged', { addresses: other });
    await flush();
    await flush();
    expect(s.vault.seen('hana_status')).toHaveLength(1);
    expect(s.client.supportId).toBe(CODE_2);
    expect(seen).toEqual([null, CODE_2]);
    // Logged out by another tab: null, and nothing to read.
    s.vault.emit('accountsChanged', { addresses: null });
    await flush();
    expect(s.client.supportId).toBeNull();
    expect(s.vault.seen('hana_status')).toHaveLength(1);
  });

  it('a hana_status answer for other addresses than the page’s now is not taken', async () => {
    s = setup();
    await s.vault.connect({ ...LOGGED_IN, supportId: CODE });
    s.vault.handle('hana_status', () => ({ result: { ...LOGGED_IN, supportId: CODE_2 } }));
    s.vault.emit('accountsChanged', { addresses: { stellar: STELLAR_2, evm: EVM_2 } });
    await flush();
    await flush();
    expect(s.client.supportId).toBeNull();
  });
});
