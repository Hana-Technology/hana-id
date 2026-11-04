// @vitest-environment happy-dom
// useIdentityToken (docs/identity-token-spec.md "SDK surface", Tests → React: re-render on events, refresh timer only
// while visible). The real HanaClient runs against the scripted vault.
import { createHana } from '@hana-id/web';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HanaProvider, IDENTITY_REFRESH_BEFORE_MS, IDENTITY_RETRY_MS, type UseIdentityTokenResult, useIdentityToken } from '../src/index.ts';
import { CONFIG, type FakeVault, LOGGED_IN, LOGGED_OUT, attachVault, settle, stubBrowser } from './harness.tsx';

vi.mock('@hana-id/web', async (importOriginal) => {
  const real = await importOriginal<typeof import('@hana-id/web')>();
  return { ...real, createHana: vi.fn(real.createHana) };
});
const createHanaSpy = vi.mocked(createHana) as unknown as ReturnType<typeof vi.fn>;

const NOW = 1_800_000_000_000;
const token = (n: number) => `${String(n).padStart(20, 'a')}.${'b'.repeat(200)}.${'c'.repeat(86)}`;

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
  createHanaSpy.mockClear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function Probe({ out }: { out: UseIdentityTokenResult[] }) {
  out.push(useIdentityToken());
  return null;
}

async function mount(status = LOGGED_IN): Promise<{ vault: FakeVault; out: UseIdentityTokenResult[]; mints: () => number }> {
  const out: UseIdentityTokenResult[] = [];
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
    return { result: { identityToken: token(n), expiresAtMs: Date.now() + 3_600_000 } };
  });
  await act(async () => {
    await vault.connect(status);
  });
  await settle();
  return { vault, out, mints: () => n };
}

describe('useIdentityToken', () => {
  it('mints lazily once logged in and re-renders with the token', async () => {
    const { out, mints } = await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    expect(mints()).toBe(1);
    expect(out.at(-1)!.identityToken).toBe(token(1));
    expect(out.at(-1)!.error).toBeNull();
  });

  it('nothing while logged out', async () => {
    const { out, mints } = await mount(LOGGED_OUT);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mints()).toBe(0);
    expect(out.at(-1)!.identityToken).toBeNull();
  });

  it('refreshes at exp − 5 min while visible, not while hidden, and catches up when visible again', async () => {
    const { mints } = await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mints()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_600_000 - IDENTITY_REFRESH_BEFORE_MS - 1000);
    });
    expect(mints()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mints()).toBe(2);
    // Hidden: the next refresh doesn't run.
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_600_000);
    });
    expect(mints()).toBe(2);
    visibility = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mints()).toBe(3);
  });

  it('re-renders on identityTokenChanged (another tab’s token, and null at logout)', async () => {
    const { vault, out } = await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      vault.emit('identityTokenChanged', { identityToken: token(99), expiresAtMs: Date.now() + 3_600_000 });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(out.at(-1)!.identityToken).toBe(token(99));
    await act(async () => {
      vault.emit('identityTokenChanged', { identityToken: null, expiresAtMs: null });
      vault.emit('accountsChanged', { addresses: null });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(out.at(-1)!.identityToken).toBeNull();
  });

  it('a failed refresh lands in error and is retried after a minute; refresh() passes maxAgeMs', async () => {
    const { vault, out } = await mount();
    let fail = true;
    let n = 0;
    vault.handle('hana_identityToken', (params) => {
      n += 1;
      if (fail) return { error: { code: 'identity_unavailable', message: 'down' } };
      return { result: { identityToken: token(100 + n), expiresAtMs: Date.now() + 3_600_000, ...(params ? {} : {}) } };
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(out.at(-1)!.error?.code).toBe('identity_unavailable');
    fail = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDENTITY_RETRY_MS);
    });
    expect(out.at(-1)!.error).toBeNull();
    expect(out.at(-1)!.identityToken).toBe(token(102));
    let fresh: string | null = null;
    await act(async () => {
      fresh = await out.at(-1)!.refresh({ maxAgeMs: 60_000 });
    });
    expect(fresh).toBe(token(103));
    expect(vault.last('hana_identityToken').params).toEqual({ maxAgeMs: 60_000 });
  });

  it('throws outside a HanaProvider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe out={[]} />)).toThrow(/inside <HanaProvider>/u);
  });
});
