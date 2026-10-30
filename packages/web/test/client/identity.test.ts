// @vitest-environment happy-dom
// hana.getIdentityToken() and identityTokenChanged (docs/identity-token-spec.md "SDK surface"): the port call, null while
// logged out, maxAgeMs clamped, error codes passed through, and the token dropped at logout, expiry and disconnect.
import { ErrorCode } from '@hana-id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HanaError, RpcCode } from '../../src/client/errors.ts';
import { LOGGED_IN, LOGGED_OUT, type Setup, flush, setup } from './harness.ts';

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

const TOKEN = `${'a'.repeat(40)}.${'b'.repeat(300)}.${'c'.repeat(86)}`;
const TOKEN_2 = `${'d'.repeat(40)}.${'e'.repeat(300)}.${'f'.repeat(86)}`;
const EXP = 1_900_000_000_000;

async function rejection(p: Promise<unknown>): Promise<HanaError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(HanaError);
  return e as HanaError;
}

describe('getIdentityToken', () => {
  it('asks the vault (hana_identityToken) and resolves its token; identityTokenChanged fires once per new token', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_identityToken', () => ({ result: { identityToken: TOKEN, expiresAtMs: EXP } }));
    const changed: (string | null)[] = [];
    s.client.on('identityTokenChanged', (t) => changed.push(t));
    expect(await s.client.getIdentityToken()).toBe(TOKEN);
    expect(s.vault.last('hana_identityToken').params).toBeUndefined();
    expect(s.client.identityToken).toBe(TOKEN);
    expect(s.client.identityTokenExpiresAtMs).toBe(EXP);
    expect(await s.client.getIdentityToken()).toBe(TOKEN);
    expect(changed).toEqual([TOKEN]);
    // A token another tab minted, announced by the vault.
    s.vault.emit('identityTokenChanged', { identityToken: TOKEN_2, expiresAtMs: EXP + 1 });
    await flush();
    expect(changed).toEqual([TOKEN, TOKEN_2]);
    expect(s.client.identityToken).toBe(TOKEN_2);
  });

  it('resolves null while logged out (never rejects for that)', async () => {
    s = setup();
    await s.vault.connect(LOGGED_OUT);
    s.vault.handle('hana_identityToken', () => ({ result: { identityToken: null, expiresAtMs: null } }));
    expect(await s.client.getIdentityToken()).toBeNull();
  });

  it('maxAgeMs: passed through, clamped to 30 s .. 1 h, refused when not a positive number', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_identityToken', () => ({ result: { identityToken: TOKEN, expiresAtMs: EXP } }));
    await s.client.getIdentityToken({ maxAgeMs: 120_000 });
    expect(s.vault.last('hana_identityToken').params).toEqual({ maxAgeMs: 120_000 });
    await s.client.getIdentityToken({ maxAgeMs: 1 });
    expect(s.vault.last('hana_identityToken').params).toEqual({ maxAgeMs: 30_000 });
    await s.client.getIdentityToken({ maxAgeMs: 10 * 3_600_000 });
    expect(s.vault.last('hana_identityToken').params).toEqual({ maxAgeMs: 3_600_000 });
    for (const maxAgeMs of [0, -5, Number.NaN, '60000' as unknown as number]) {
      expect((await rejection(s.client.getIdentityToken({ maxAgeMs }))).code).toBe(RpcCode.invalidParams);
    }
    expect(s.vault.invalid).toEqual([]);
  });

  it('passes the vault’s errors through: identity_unavailable, session_ended, rate_limited', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    for (const code of ['identity_unavailable', 'session_ended', 'rate_limited'] as const) {
      s.vault.handle('hana_identityToken', () => ({ error: { code, message: code } }));
      expect((await rejection(s.client.getIdentityToken())).code).toBe(code);
    }
  });

  it('drops the token (identityTokenChanged null) at logout, sessionExpired, the vault’s null and a dead vault', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_identityToken', () => ({ result: { identityToken: TOKEN, expiresAtMs: EXP } }));
    s.vault.handle('hana_logout', () => ({ result: null }));
    const changed: (string | null)[] = [];
    s.client.on('identityTokenChanged', (t) => changed.push(t));

    await s.client.getIdentityToken();
    await s.client.logout();
    expect(changed).toEqual([TOKEN, null]);

    await s.client.getIdentityToken();
    s.vault.emit('sessionExpired', null);
    await flush();
    expect(changed).toEqual([TOKEN, null, TOKEN, null]);

    await s.client.getIdentityToken();
    s.vault.emit('identityTokenChanged', { identityToken: null, expiresAtMs: null });
    await flush();
    expect(changed.at(-1)).toBeNull();
    expect(s.client.identityToken).toBeNull();

    // A second load of the vault frame (its document replaced) kills the port: the token goes with it.
    await s.client.getIdentityToken();
    expect(changed.at(-1)).toBe(TOKEN);
    s.vault.load();
    await flush();
    expect(changed.at(-1)).toBeNull();
    expect(s.client.identityToken).toBeNull();
  });

  it('after destroy(): 4900', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.client.destroy();
    expect((await rejection(s.client.getIdentityToken())).code).toBe(ErrorCode.disconnected);
  });
});
