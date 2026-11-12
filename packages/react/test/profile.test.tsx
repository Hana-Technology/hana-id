// @vitest-environment happy-dom
// useProfile: the shared name as React state. Re-renders on profileChanged only (not on a new token with the same name),
// gets a token lazily once logged in and keeps it fresh like useIdentityToken, `refresh` passes maxAgeMs to
// hana.getProfile, and a failure lands in `error`. The real HanaClient runs against the scripted vault.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HanaProvider, IDENTITY_REFRESH_BEFORE_MS, IDENTITY_RETRY_MS, type HanaProfile, type UseProfileResult, useProfile } from '../src/index.ts';
import { CONFIG, type FakeVault, LOGGED_IN, LOGGED_OUT, attachVault, settle, stubBrowser } from './harness.tsx';

const NOW = 1_800_000_000_000;
/** JSON → base64url (no padding), as a JWT part (this package doesn't depend on @hana-id/core). */
const b64url = (v: unknown): string => {
  let bin = '';
  for (const b of new TextEncoder().encode(JSON.stringify(v))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};
const HEADER = b64url({ alg: 'ES256', kid: 'k'.repeat(43), typ: 'hana-identity+jwt' });
/** Token n, with the given name claims (an unsigned stand-in: the page never checks the signature). */
const token = (n: number, name: { given_name?: unknown; family_name?: unknown } = {}) =>
  `${HEADER}.${b64url({ iss: 'https://api.hana.test', aud: 'app_test', sub: `u1_${'A'.repeat(22)}`, jti: `jti-${n}`, ...name })}.${'c'.repeat(86)}`;

let visibility: DocumentVisibilityState = 'visible';
beforeEach(() => {
  stubBrowser();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(async () => {
  cleanup();
  await settle();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function Probe({ out }: { out: UseProfileResult[] }) {
  out.push(useProfile());
  return null;
}

/** Mounts the hook; the vault mints token n with `name()`'s claims at the time of each mint. */
async function mount(status = LOGGED_IN, name: () => { given_name?: unknown; family_name?: unknown } = () => ({ given_name: 'Ada' })) {
  const out: UseProfileResult[] = [];
  render(
    <HanaProvider config={CONFIG}>
      <Probe out={out} />
    </HanaProvider>,
  );
  await settle();
  const vault = attachVault();
  let n = 0;
  vault.handle('hana_identityToken', () => {
    n += 1;
    return { result: { identityToken: token(n, name()), expiresAtMs: Date.now() + 3_600_000 } };
  });
  await act(async () => {
    await vault.connect(status);
  });
  await settle();
  return { vault, out, mints: () => n };
}

const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
};

describe('useProfile', () => {
  it('gets a token lazily once logged in and re-renders with its name', async () => {
    const { out, mints } = await mount();
    expect(out.at(-1)!.profile).toBeNull();
    await tick();
    expect(mints()).toBe(1);
    expect(out.at(-1)!.profile).toEqual({ givenName: 'Ada', familyName: null });
    expect(out.at(-1)!.error).toBeNull();
  });

  it('logged in with no name shared: both parts null; a malformed claim reads as absent', async () => {
    const { out } = await mount(LOGGED_IN, () => ({ given_name: 'Ada\u0000', family_name: 'Lovelace' }));
    await tick();
    expect(out.at(-1)!.profile).toEqual({ givenName: null, familyName: 'Lovelace' });
    cleanup();
    await settle();
    document.body.replaceChildren();
    const second = await mount(LOGGED_IN, () => ({}));
    await tick();
    expect(second.out.at(-1)!.profile).toEqual({ givenName: null, familyName: null });
  });

  it('nothing while logged out: no mint, profile null', async () => {
    const { out, mints } = await mount(LOGGED_OUT);
    await tick(10_000);
    expect(mints()).toBe(0);
    expect(out.at(-1)!.profile).toBeNull();
  });

  it('returns the same profile across tokens with the same name, and a new one when the name changes', async () => {
    const { vault, out } = await mount();
    await tick();
    const first = out.at(-1)!;
    // Another tab's token, same name: no new result object.
    await act(async () => {
      vault.emit('identityTokenChanged', { identityToken: token(50, { given_name: 'Ada' }), expiresAtMs: Date.now() + 3_600_000 });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(out.at(-1)).toBe(first);
    expect(out.at(-1)!.profile).toBe(first.profile);
    // The user changed their name in Hana Home; the next token carries it.
    await act(async () => {
      vault.emit('identityTokenChanged', { identityToken: token(51, { given_name: 'Ada', family_name: 'Lovelace' }), expiresAtMs: Date.now() + 3_600_000 });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(out.at(-1)!.profile).toEqual({ givenName: 'Ada', familyName: 'Lovelace' });
    // Logout: null.
    await act(async () => {
      vault.emit('identityTokenChanged', { identityToken: null, expiresAtMs: null });
      vault.emit('accountsChanged', { addresses: null });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(out.at(-1)!.profile).toBeNull();
  });

  it('keeps the token fresh at exp − 5 min while visible, so a changed name arrives with it', async () => {
    let name: { given_name?: string } = { given_name: 'Ada' };
    const { out, mints } = await mount(LOGGED_IN, () => name);
    await tick();
    expect(mints()).toBe(1);
    name = { given_name: 'Augusta' };
    await tick(3_600_000 - IDENTITY_REFRESH_BEFORE_MS - 1000);
    expect(mints()).toBe(1);
    expect(out.at(-1)!.profile?.givenName).toBe('Ada');
    await tick(2000);
    expect(mints()).toBe(2);
    expect(out.at(-1)!.profile?.givenName).toBe('Augusta');
    // Hidden: no refresh.
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await tick(3_600_000);
    expect(mints()).toBe(2);
  });

  it('a failed refresh lands in error and is retried after a minute; refresh() passes maxAgeMs and resolves the profile', async () => {
    const { vault, out } = await mount();
    let fail = true;
    let n = 0;
    vault.handle('hana_identityToken', () => {
      n += 1;
      if (fail) return { error: { code: 'identity_unavailable', message: 'down', data: { requestId: '3f2a9c1e-7b4d-4e8f-9a6b-0c1d2e3f4a5b' } } };
      return { result: { identityToken: token(100 + n, { family_name: 'Lovelace' }), expiresAtMs: Date.now() + 3_600_000 } };
    });
    await tick();
    expect(out.at(-1)!.error?.code).toBe('identity_unavailable');
    expect(out.at(-1)!.error?.requestId).toBe('3f2a9c1e-7b4d-4e8f-9a6b-0c1d2e3f4a5b');
    expect(out.at(-1)!.profile).toBeNull();
    fail = false;
    await tick(IDENTITY_RETRY_MS);
    expect(out.at(-1)!.error).toBeNull();
    expect(out.at(-1)!.profile).toEqual({ givenName: null, familyName: 'Lovelace' });
    let fresh: HanaProfile | null = null;
    await act(async () => {
      fresh = await out.at(-1)!.refresh({ maxAgeMs: 60_000 });
    });
    expect(fresh).toEqual({ givenName: null, familyName: 'Lovelace' });
    expect(vault.last('hana_identityToken').params).toEqual({ maxAgeMs: 60_000 });
    // An explicit refresh's failure rejects with the client's error and lands in `error` too.
    fail = true;
    let caught: unknown = null;
    await act(async () => {
      caught = await out.at(-1)!.refresh({ maxAgeMs: 30_000 }).then(
        () => null,
        (e: unknown) => e,
      );
    });
    expect((caught as { code?: unknown } | null)?.code).toBe('identity_unavailable');
    expect(out.at(-1)!.error).toBe(caught);
  });

  it('throws outside a HanaProvider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe out={[]} />)).toThrow(/inside <HanaProvider>/u);
  });
});
