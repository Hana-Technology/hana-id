// @vitest-environment happy-dom
// HanaProvider (docs/batch-b-spec.md "React"; Tests → React, "HanaProvider creates exactly one client (also under
// React strict mode) and destroys it on unmount").
import { createHana } from '@hana-id/web';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { Component, type ReactNode, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HanaProvider, useHana, useWallet } from '../src/index.ts';
import { CONFIG, LOGGED_OUT, PK, Probe, attachVault, createdClient, newRenders, settle, stubBrowser, vaultFrames } from './harness.tsx';

vi.mock('@hana-id/web', async (importOriginal) => {
  const real = await importOriginal<typeof import('@hana-id/web')>();
  return { ...real, createHana: vi.fn(real.createHana) };
});
const createHanaSpy = vi.mocked(createHana) as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  stubBrowser();
});
afterEach(async () => {
  cleanup();
  await settle();
  createHanaSpy.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

class Boundary extends Component<{ children: ReactNode; caught: unknown[] }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown): void {
    this.props.caught.push(error);
  }
  override render(): ReactNode {
    return this.state.failed ? <p>failed</p> : this.props.children;
  }
}

describe('HanaProvider', () => {
  it('creates one client with the config, mounts one vault iframe, and destroys both on unmount', async () => {
    const renders = newRenders();
    const view = render(
      <HanaProvider config={CONFIG}>
        <Probe renders={renders} />
      </HanaProvider>,
    );
    expect(createHanaSpy).toHaveBeenCalledTimes(1);
    expect(createHanaSpy).toHaveBeenCalledWith(CONFIG);
    expect(vaultFrames()).toBe(1);
    const client = createdClient(createHanaSpy);
    expect(renders.last.hana.client).toBe(client);
    const destroy = vi.spyOn(client, 'destroy');

    view.unmount();
    await settle();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(vaultFrames()).toBe(0);
    expect(createHanaSpy).toHaveBeenCalledTimes(1);
  });

  it('under StrictMode still creates exactly one client, keeps it alive through the simulated remount, and destroys it on unmount', async () => {
    const renders = newRenders();
    const view = render(
      <StrictMode>
        <HanaProvider config={CONFIG}>
          <Probe renders={renders} />
        </HanaProvider>
      </StrictMode>,
    );
    await settle(); // the deferred destroy of the simulated unmount would have run by now
    expect(createHanaSpy).toHaveBeenCalledTimes(1);
    expect(vaultFrames()).toBe(1);
    const client = createdClient(createHanaSpy);
    const destroy = vi.spyOn(client, 'destroy');

    // The client still works: the vault connects and the hooks see it.
    const vault = attachVault();
    await act(() => vault.connect(LOGGED_OUT));
    expect(renders.last.hana.status).toBe('logged_out');
    expect(renders.last.hana.client).toBe(client);

    view.unmount();
    await settle();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(vaultFrames()).toBe(0);
    expect(createHanaSpy).toHaveBeenCalledTimes(1);
  });

  it('renders its children before the client exists, with the initial state and no client', () => {
    const renders = newRenders();
    render(
      <HanaProvider config={CONFIG}>
        <Probe renders={renders} />
      </HanaProvider>,
    );
    const first = renders.hana[0];
    expect(first).toMatchObject({ status: 'unlocking', addresses: null, persistence: null, error: null, client: null });
    expect(renders.stellar[0]).toEqual({ address: null, signer: null });
    expect(renders.evm[0]).toEqual({ address: null, provider: null });
  });

  it('reads config once: a re-render with another config keeps the same client', async () => {
    const renders = newRenders();
    const view = render(
      <HanaProvider config={CONFIG}>
        <Probe renders={renders} />
      </HanaProvider>,
    );
    view.rerender(
      <HanaProvider config={{ publishableKey: PK, environment: 'sandbox-dev', stellar: { networkPassphrase: 'Test SDF Network ; September 2015' } }}>
        <Probe renders={renders} />
      </HanaProvider>,
    );
    await settle();
    expect(createHanaSpy).toHaveBeenCalledTimes(1);
    expect(vaultFrames()).toBe(1);
  });

  it('a remount with a new key destroys the old client and creates a new one', async () => {
    const renders = newRenders();
    const view = render(
      <HanaProvider key="a" config={CONFIG}>
        <Probe renders={renders} />
      </HanaProvider>,
    );
    const first = createdClient(createHanaSpy);
    const destroy = vi.spyOn(first, 'destroy');
    view.rerender(
      <HanaProvider key="b" config={CONFIG}>
        <Probe renders={renders} />
      </HanaProvider>,
    );
    await settle();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(createHanaSpy).toHaveBeenCalledTimes(2);
    expect(renders.last.hana.client).toBe(createdClient(createHanaSpy, 1));
    expect(vaultFrames()).toBe(1);
  });

  it('two providers make two independent clients', async () => {
    render(
      <>
        <HanaProvider config={CONFIG}>
          <span />
        </HanaProvider>
        <HanaProvider config={CONFIG}>
          <span />
        </HanaProvider>
      </>,
    );
    expect(createHanaSpy).toHaveBeenCalledTimes(2);
    expect(createdClient(createHanaSpy, 0)).not.toBe(createdClient(createHanaSpy, 1));
    expect(vaultFrames()).toBe(2);
  });

  it('throws a config createHana refuses to the nearest error boundary, and mounts no vault', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const caught: unknown[] = [];
    const view = render(
      <Boundary caught={caught}>
        <HanaProvider config={{ publishableKey: PK, environment: 'mainnet' }}>
          <span>app</span>
        </HanaProvider>
      </Boundary>,
    );
    expect(caught).toHaveLength(1);
    expect(caught[0]).toBeInstanceOf(TypeError);
    expect(String(caught[0])).toMatch(/Unknown Journear Passport environment/u);
    expect(view.container.textContent).toBe('failed');
    expect(vaultFrames()).toBe(0);
  });

  it('a malformed publishable key is refused the same way', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const caught: unknown[] = [];
    render(
      <Boundary caught={caught}>
        <HanaProvider config={{ publishableKey: 'sk_live_abc', environment: 'sandbox-dev' }}>
          <span>app</span>
        </HanaProvider>
      </Boundary>,
    );
    expect(String(caught[0])).toMatch(/publishableKey/u);
    expect(vaultFrames()).toBe(0);
  });

  it('useHana and useWallet outside a HanaProvider throw', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useHana())).toThrow('useHana must be used inside <HanaProvider>');
    expect(() => renderHook(() => useWallet('evm'))).toThrow('useWallet must be used inside <HanaProvider>');
  });
});
