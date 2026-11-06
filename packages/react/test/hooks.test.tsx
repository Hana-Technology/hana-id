// @vitest-environment happy-dom
// useHana and useWallet (docs/batch-b-spec.md "React"; Tests → React: "useHana reflects status, addresses, persistence
// and error through login, logout, sessionExpired and disconnect", "useWallet('stellar') and useWallet('evm') return
// the address and hana.stellar / hana.ethereum, and update on accountsChanged", "login called from onClick opens the
// popup synchronously"). The real HanaClient runs against the scripted vault.
import { type HanaClient, HanaError, createHana } from '@hana-id/web';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HanaProvider, useHana, useWallet } from '../src/index.ts';
import {
  CONFIG,
  EVM,
  EVM_2,
  type Env,
  type FakeVault,
  LOGGED_IN,
  LOGGED_OUT,
  Probe,
  type Renders,
  STELLAR,
  STELLAR_2,
  attachVault,
  createdClient,
  newRenders,
  settle,
  stubBrowser,
} from './harness.tsx';

vi.mock('@hana-id/web', async (importOriginal) => {
  const real = await importOriginal<typeof import('@hana-id/web')>();
  return { ...real, createHana: vi.fn(real.createHana) };
});
const createHanaSpy = vi.mocked(createHana) as unknown as ReturnType<typeof vi.fn>;

const LOGIN_RESULT = { addresses: { stellar: STELLAR, evm: EVM }, expiresAtMs: 1_900_000_000_000, persistence: 'session' as const };

let env: Env;
beforeEach(() => {
  env = stubBrowser();
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

interface Mounted {
  renders: Renders;
  client: HanaClient;
  vault: FakeVault;
}

/** Renders a Probe under a HanaProvider and attaches the scripted vault (not yet loaded). */
function mount(): Mounted {
  const renders = newRenders();
  render(
    <HanaProvider config={CONFIG}>
      <Probe renders={renders} />
    </HanaProvider>,
  );
  return { renders, client: createdClient(createHanaSpy), vault: attachVault() };
}

/** Clicks the Probe's `onClick={login}` button and answers the login with `result` once the popup has connected. */
async function loginThroughButton(m: Mounted, result: unknown = LOGIN_RESULT): Promise<void> {
  m.vault.handle('hana_login', () => 'manual');
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await settle();
  const req = m.vault.last('hana_login');
  await act(async () => {
    m.vault.emit('loginProgress', { stage: 'popup_connected' });
    m.vault.reply(req.id, result);
  });
  await settle();
}

describe('useHana', () => {
  it('reports the handshake: unlocking, then logged_out with the persistence mode', async () => {
    const m = mount();
    expect(m.renders.last.hana).toMatchObject({ status: 'unlocking', addresses: null, persistence: null, error: null });
    await act(() => m.vault.connect(LOGGED_OUT));
    expect(m.renders.last.hana).toMatchObject({ status: 'logged_out', addresses: null, persistence: 'session', error: null });
  });

  it('a reload that unlocks reports logged_in with the addresses at once', async () => {
    const m = mount();
    await act(() => m.vault.connect(LOGGED_IN));
    expect(m.renders.last.hana).toMatchObject({ status: 'logged_in', addresses: { stellar: STELLAR, evm: EVM }, persistence: 'session' });
  });

  it("reports persistence 'none' when the vault fell back from storage", async () => {
    const m = mount();
    await act(() => m.vault.connect({ status: 'logged_out', persistence: 'none', warning: 'storage_unavailable' }));
    expect(m.renders.last.hana).toMatchObject({ status: 'logged_out', persistence: 'none' });
  });

  it("re-renders with persistence 'none' when the vault could not save the session after a login (D79)", async () => {
    const m = mount();
    await act(() => m.vault.connect(LOGGED_IN));
    expect(m.renders.last.hana.persistence).toBe('session');
    await act(async () => m.vault.emit('persistenceChanged', { persistence: 'none' }));
    await settle();
    expect(m.renders.last.hana).toMatchObject({ status: 'logged_in', persistence: 'none' });
  });

  it('follows a login: logging_in, then logged_in with the addresses and no error', async () => {
    const m = mount();
    await act(() => m.vault.connect(LOGGED_OUT));
    m.vault.handle('hana_login', () => 'manual');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(m.renders.last.hana.status).toBe('logging_in');
    await settle();
    const req = m.vault.last('hana_login');
    await act(async () => {
      m.vault.emit('loginProgress', { stage: 'popup_connected' });
      m.vault.reply(req.id, { ...LOGIN_RESULT, persistence: 'none' });
    });
    await settle();
    expect(m.renders.last.hana).toMatchObject({ status: 'logged_in', addresses: { stellar: STELLAR, evm: EVM }, persistence: 'none', error: null });
  });

  it("login(options) passes hana.login()'s options (method, emailHint); onClick={login} passes none", async () => {
    const m = mount();
    await act(() => m.vault.connect(LOGGED_OUT));
    m.vault.handle('hana_login', () => 'manual');
    // The click handler's event is not an option.
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await settle();
    const fromClick = m.vault.last('hana_login');
    expect(fromClick.params ?? {}).toEqual({});
    act(() => {
      void m.renders.last.hana.login({ method: 'email', emailHint: 'ada@example.com' });
    });
    await settle();
    const withOptions = m.vault.last('hana_login');
    expect(withOptions.id).not.toBe(fromClick.id);
    expect(withOptions.params).toEqual({ method: 'email', emailHint: 'ada@example.com' });
    await act(async () => {
      m.vault.emit('loginProgress', { stage: 'popup_connected' });
      m.vault.reply(withOptions.id, LOGIN_RESULT);
    });
    await settle();
    expect(m.renders.last.hana).toMatchObject({ status: 'logged_in', addresses: { stellar: STELLAR, evm: EVM }, error: null });
  });

  it('login with bad options rejects with -32602 before any popup (a call error, not a failed login)', async () => {
    const m = mount();
    await act(() => m.vault.connect(LOGGED_OUT));
    const open = vi.spyOn(window, 'open');
    let outcome: unknown;
    act(() => {
      m.renders.last.hana.login({ method: 'phone' } as never).catch((e: unknown) => {
        outcome = e;
      });
    });
    await settle();
    expect(outcome).toBeInstanceOf(HanaError);
    expect((outcome as HanaError).code).toBe(-32602);
    expect(open).not.toHaveBeenCalled();
    expect(m.renders.last.hana.status).toBe('logged_out');
  });

  it('a failed login sets error and returns to logged_out; the next login clears the error', async () => {
    const m = mount();
    await act(() => m.vault.connect(LOGGED_OUT));
    m.vault.handle('hana_login', () => 'manual');
    let outcome: unknown;
    act(() => {
      m.renders.last.hana.login().catch((e: unknown) => {
        outcome = e;
      });
    });
    await settle();
    const req = m.vault.last('hana_login');
    await act(async () => {
      m.vault.emit('loginProgress', { stage: 'popup_connected' });
      m.vault.replyError(req.id, 4001, 'User rejected the request');
    });
    await settle();
    expect(outcome).toBeInstanceOf(HanaError);
    expect(m.renders.last.hana.status).toBe('logged_out');
    expect(m.renders.last.hana.error).toBe(outcome);
    expect(m.renders.last.hana.error?.code).toBe(4001);

    await loginThroughButton(m);
    expect(m.renders.last.hana).toMatchObject({ status: 'logged_in', error: null });
  });

  it('D405: a login the API refused leaves its request ID in error.requestId (only a well-formed one)', async () => {
    const m = mount();
    await act(() => m.vault.connect(LOGGED_OUT));
    m.vault.handle('hana_login', () => 'manual');
    for (const [sent, seen] of [
      ['8d1f2c3a4b5e6f70-SIN', '8d1f2c3a4b5e6f70-SIN'],
      ['not one!', null],
    ] as const) {
      act(() => {
        m.renders.last.hana.login().catch(() => undefined);
      });
      await settle();
      const req = m.vault.last('hana_login');
      await act(async () => {
        m.vault.emit('loginProgress', { stage: 'popup_connected' });
        m.vault.replyError(req.id, 'no_google_client', 'This app has no usable Google client', { requestId: sent });
      });
      await settle();
      expect(m.renders.last.hana.error).toBeInstanceOf(HanaError);
      expect(m.renders.last.hana.error?.code).toBe('no_google_client');
      expect(m.renders.last.hana.error?.requestId).toBe(seen);
    }
  });

  it('logout returns to logged_out with no addresses', async () => {
    const m = mount();
    await act(() => m.vault.connect(LOGGED_IN));
    m.vault.handle('hana_logout', () => ({ result: null }));
    await act(() => m.renders.last.hana.logout());
    expect(m.vault.seen('hana_logout')).toHaveLength(1);
    expect(m.renders.last.hana).toMatchObject({ status: 'logged_out', addresses: null });
  });

  it('sessionExpired returns to logged_out with no addresses', async () => {
    const m = mount();
    await act(() => m.vault.connect(LOGGED_IN));
    await act(async () => {
      m.vault.emit('sessionExpired', null);
    });
    await settle();
    expect(m.renders.last.hana).toMatchObject({ status: 'logged_out', addresses: null });
  });

  it("the vault's disconnect event returns to logged_out with no addresses", async () => {
    const m = mount();
    await act(() => m.vault.connect(LOGGED_IN));
    await act(async () => {
      m.vault.emit('disconnect', { code: 4900 });
    });
    await settle();
    expect(m.renders.last.hana).toMatchObject({ status: 'logged_out', addresses: null });
  });

  it('a lost vault (its document replaced) gives status error with a 4900 error', async () => {
    const m = mount();
    await act(() => m.vault.connect(LOGGED_IN));
    await act(async () => {
      m.vault.load();
    });
    await settle();
    expect(m.renders.last.hana).toMatchObject({ status: 'error', addresses: null });
    expect(m.renders.last.hana.error?.code).toBe(4900);
  });

  it('a vault that never answers gives status error with vault_unavailable (a frame that never loads: 5 s, extended once)', async () => {
    vi.useFakeTimers();
    const m = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    // The frame never loaded: it gets one more deadline, then fails.
    expect(m.renders.last.hana.status).not.toBe('error');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5002);
    });
    expect(m.renders.last.hana.status).toBe('error');
    expect(m.renders.last.hana.error?.code).toBe('vault_unavailable');
  });

  it('exportKey sends hana_export for the chain', async () => {
    const m = mount();
    await act(() => m.vault.connect(LOGGED_IN));
    m.vault.handle('hana_export', () => ({ result: null }));
    await act(async () => {
      await expect(m.renders.last.hana.exportKey('evm')).resolves.toBeNull();
    });
    expect(m.vault.last('hana_export').params).toEqual({ chain: 'evm' });
  });

  it('exposes the client for the calls it does not wrap', async () => {
    const m = mount();
    expect(m.renders.last.hana.client).toBe(m.client);
  });

  it('called before the provider has a client, login, logout and exportKey reject with 4900 and open nothing', async () => {
    const m = mount();
    const first = m.renders.hana[0];
    if (!first) throw new Error('no first render');
    for (const p of [first.login(), first.logout(), first.exportKey('stellar')]) {
      const e = await p.then(
        () => null,
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(HanaError);
      expect((e as HanaError).code).toBe(4900);
    }
    expect(env.open).not.toHaveBeenCalled();
  });

  it('keeps login, logout and exportKey stable across renders, and the result stable while nothing changed', async () => {
    const m = mount();
    await act(() => m.vault.connect(LOGGED_OUT));
    const before = m.renders.last.hana;
    const count = m.renders.hana.length;
    // An event that changes none of the reported fields doesn't re-render.
    await act(async () => {
      m.vault.emit('ui', { launcher: 'show', label: 'Sign in with Hana' });
    });
    await settle();
    expect(m.renders.hana.length).toBe(count);
    await loginThroughButton(m);
    const after = m.renders.last.hana;
    expect(after).not.toBe(before);
    expect(after.login).toBe(before.login);
    expect(after.logout).toBe(before.logout);
    expect(after.exportKey).toBe(before.exportKey);
  });
});

describe('useWallet', () => {
  it("returns the address and hana.stellar / hana.ethereum, and updates on accountsChanged", async () => {
    const m = mount();
    await act(() => m.vault.connect(LOGGED_IN));
    expect(m.renders.last.stellar).toEqual({ address: STELLAR, signer: m.client.stellar });
    expect(m.renders.last.stellar.signer).toBe(m.client.stellar);
    expect(m.renders.last.evm.address).toBe(EVM);
    expect(m.renders.last.evm.provider).toBe(m.client.ethereum);

    await act(async () => {
      m.vault.emit('accountsChanged', { addresses: { stellar: STELLAR_2, evm: EVM_2 } });
    });
    await settle();
    expect(m.renders.last.stellar.address).toBe(STELLAR_2);
    expect(m.renders.last.evm.address).toBe(EVM_2);
    expect(m.renders.last.hana.addresses).toEqual({ stellar: STELLAR_2, evm: EVM_2 });

    await act(async () => {
      m.vault.emit('accountsChanged', { addresses: null });
    });
    await settle();
    expect(m.renders.last.stellar).toEqual({ address: null, signer: m.client.stellar });
    expect(m.renders.last.evm.address).toBeNull();
    expect(m.renders.last.evm.provider).toBe(m.client.ethereum);
  });

  it('gets the addresses from a login', async () => {
    const m = mount();
    await act(() => m.vault.connect(LOGGED_OUT));
    expect(m.renders.last.evm.address).toBeNull();
    await loginThroughButton(m);
    expect(m.renders.last.stellar.address).toBe(STELLAR);
    expect(m.renders.last.evm.address).toBe(EVM);
  });

  it('refuses a chain other than stellar or evm', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Bad() {
      useWallet('solana' as 'evm');
      return null;
    }
    expect(() =>
      render(
        <HanaProvider config={CONFIG}>
          <Bad />
        </HanaProvider>,
      ),
    ).toThrow(/useWallet takes 'stellar' or 'evm'/u);
  });
});

describe('login from onClick', () => {
  it('opens the Hana popup synchronously inside the click handler', async () => {
    let opensDuringClick = -1;
    function Button() {
      const { login } = useHana();
      return (
        <button
          type="button"
          onClick={() => {
            login().catch(() => {});
            opensDuringClick = env.open.mock.calls.length;
          }}
        >
          Go
        </button>
      );
    }
    render(
      <HanaProvider config={CONFIG}>
        <Button />
      </HanaProvider>,
    );
    const client = createdClient(createHanaSpy);
    const vault = attachVault();
    await act(() => vault.connect(LOGGED_OUT));
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(opensDuringClick).toBe(1);
    const [url] = env.open.mock.calls[0] as [string];
    expect(url.startsWith(`${client.authOrigin}/login?v=hana-vault-`)).toBe(true);
    client.cancelLogin();
    await settle();
  });

  it('`onClick={login}` works (the click event is ignored) and resolves the login', async () => {
    const m = mount();
    await act(() => m.vault.connect(LOGGED_OUT));
    await loginThroughButton(m);
    expect(env.open).toHaveBeenCalledTimes(1);
    expect(m.vault.last('hana_login').params).toBeUndefined();
    expect(m.renders.last.hana.status).toBe('logged_in');
  });

  it('`onClick={login}` with a login the user rejects (4001) sets error and leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const m = mount();
      await act(() => m.vault.connect(LOGGED_OUT));
      m.vault.handle('hana_login', () => 'manual');
      // React drops the promise the handler returns.
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      await settle();
      const req = m.vault.last('hana_login');
      await act(async () => {
        m.vault.emit('loginProgress', { stage: 'popup_connected' });
        m.vault.replyError(req.id, 4001, 'User rejected the request');
      });
      await settle();
      // Node reports an unhandled rejection after the microtask queue drains: give it a macrotask.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(m.renders.last.hana.status).toBe('logged_out');
      expect(m.renders.last.hana.error?.code).toBe(4001);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a caller that awaits login still gets the rejection; logout and exportKey reject as usual', async () => {
    const m = mount();
    await act(() => m.vault.connect(LOGGED_IN));
    m.vault.handle('hana_logout', () => ({ error: { code: 4900, message: 'gone' } }));
    m.vault.handle('hana_export', () => ({ error: { code: 4001, message: 'User rejected the request' } }));
    const logout = m.renders.last.hana.logout();
    const exportKey = m.renders.last.hana.exportKey('stellar');
    await act(async () => {
      await expect(logout).rejects.toMatchObject({ code: 4900 });
      await expect(exportKey).rejects.toMatchObject({ code: 4001 });
    });
  });

  it('opens the popup even before the handshake finishes', async () => {
    const m = mount();
    m.vault.handle('hana_login', () => ({ result: LOGIN_RESULT }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(env.open).toHaveBeenCalledTimes(1);
    await act(() => m.vault.connect(LOGGED_OUT));
    await settle();
    expect(m.renders.last.hana.status).toBe('logged_in');
  });
});
