// @vitest-environment happy-dom
// HanaProvider and the page's one EIP-6963 entry (D936), with real React (19, and 18 through the react18 suite) and
// real wagmi: a `key` remount (switching app or environment) creates the new client a microtask before the old one is
// destroyed, as always; the entry follows the newest client, so there is one uuid and wagmi's one connector works with
// each client in turn, plain and under StrictMode; two providers at once; `<Activity>` hide and show (React 19) never
// destroys a client early; mount and unmount ×3.
import { connect, createConfig, disconnect, getAccount, getConnectors, http } from '@wagmi/core';
import { act, cleanup, render } from '@testing-library/react';
import * as React from 'react';
import { StrictMode, useState } from 'react';
import { flushSync } from 'react-dom';
import { sepolia } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HanaClient } from '@hana-id/web';
import { HanaProvider, useHana } from '../src/index.ts';
import { CONFIG, EVM, LOGGED_IN, attachVault, settle, stubBrowser, vaultFrames } from './harness.tsx';

const EVM_CONFIG = { chains: [{ id: sepolia.id, rpcUrl: 'https://sepolia.rpc.test' }], defaultChainId: sepolia.id };
const WITH_EVM = { ...CONFIG, evm: EVM_CONFIG };

let announced: { info: { uuid: string }; provider: { removeAllListeners(): void } }[];
const onAnnounce = (e: Event) => announced.push((e as CustomEvent<(typeof announced)[number]>).detail);
/** The clients each named spot in the tree saw, in order. */
const seen: Record<string, HanaClient[]> = {};
beforeEach(() => {
  stubBrowser();
  announced = [];
  for (const k of Object.keys(seen)) delete seen[k];
  window.addEventListener('eip6963:announceProvider', onAnnounce);
});
afterEach(async () => {
  window.removeEventListener('eip6963:announceProvider', onAnnounce);
  cleanup();
  await settle();
  // The page's entry outlives a test: a test's wagmi must not hear the next test's clients.
  for (const d of announced) d.provider.removeAllListeners();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function Grab({ name }: { name: string }) {
  const { client } = useHana();
  if (client && !(seen[name] ??= []).includes(client)) seen[name]!.push(client);
  return null;
}
const latest = (name: string) => seen[name]!.at(-1)!;

/** Connects the newest vault frame as the signed-in user, answering eth_accounts. */
async function signedIn(): Promise<void> {
  const vault = attachVault();
  vault.handle('eth_accounts', () => ({ result: [EVM] }));
  await act(() => vault.connect(LOGGED_IN));
  await settle();
}

const wagmi = () => createConfig({ chains: [sepolia], transports: { [sepolia.id]: http('https://sepolia.rpc.test') }, storage: null });
const oursIn = (config: ReturnType<typeof wagmi>) => getConnectors(config).filter((c) => c.name === 'Journear Passport');

describe.each([false, true])('a key remount a → b → c (StrictMode: %s)', (strict) => {
  it("keeps one uuid, one live client, and wagmi's one connector works with each client", async () => {
    const config = wagmi();
    const tree = (key: string) => {
      const p = (
        <HanaProvider key={key} config={WITH_EVM}>
          <Grab name={key} />
        </HanaProvider>
      );
      return strict ? <StrictMode>{p}</StrictMode> : p;
    };
    const view = render(tree('a'));
    await settle();
    let first: unknown;
    let uuid: string | undefined;
    for (const key of ['a', 'b', 'c']) {
      if (key !== 'a') view.rerender(tree(key));
      await settle();
      expect(vaultFrames()).toBe(1);
      expect(seen[key]).toHaveLength(1);
      const client = latest(key);
      expect(client.destroyed).toBe(false);
      await signedIn();
      const detail = client.eip6963!;
      uuid ??= detail.info.uuid;
      expect(detail.info.uuid).toBe(uuid);
      expect(oursIn(config)).toHaveLength(1);
      const connector = oursIn(config)[0]!;
      first ??= connector;
      expect(connector).toBe(first);
      expect(await connector.getProvider()).toBe(detail.provider);
      expect(getAccount(config)).toMatchObject({ status: 'connected', address: EVM });
      await disconnect(config);
      await expect(connect(config, { connector })).resolves.toMatchObject({ accounts: [EVM] });
    }
    expect(new Set(announced.map((d) => d.info.uuid))).toEqual(new Set([uuid]));
    view.unmount();
    await settle();
    expect(vaultFrames()).toBe(0);
    expect(getAccount(config).status).toBe('disconnected');
  });
});

describe.each([false, true])('two providers at once (StrictMode: %s)', (strict) => {
  it('remounting one with a new key never destroys the other; one frame each; one entry', async () => {
    const tree = (k: string) => {
      const both = (
        <>
          <HanaProvider config={WITH_EVM}>
            <Grab name="stay" />
          </HanaProvider>
          <HanaProvider key={k} config={WITH_EVM}>
            <Grab name={`k${k}`} />
          </HanaProvider>
        </>
      );
      return strict ? <StrictMode>{both}</StrictMode> : both;
    };
    const view = render(tree('a'));
    await settle();
    expect(vaultFrames()).toBe(2);
    const stay = latest('stay');
    for (const k of ['b', 'c', 'd']) {
      view.rerender(tree(k));
      await settle();
      expect(stay.destroyed).toBe(false);
      expect(seen.stay).toHaveLength(1);
      expect(vaultFrames()).toBe(2);
      expect(latest(`k${k}`).destroyed).toBe(false);
      expect(latest(`k${k}`).eip6963).toBe(stay.eip6963);
    }
    expect(new Set(announced.map((d) => d.info.uuid)).size).toBe(1);
  });
});

describe('Activity (React 19)', () => {
  const Activity = (React as unknown as { Activity?: React.ComponentType<{ mode: 'visible' | 'hidden'; children: React.ReactNode }> }).Activity;
  it.skipIf(!Activity)('hide one provider, then in the same task show it and key-remount the other: no client is destroyed early', async () => {
    let set!: (s: { mode: 'visible' | 'hidden'; k: string }) => void;
    function App() {
      const [s, setS] = useState<{ mode: 'visible' | 'hidden'; k: string }>({ mode: 'visible', k: 'a' });
      set = setS;
      return (
        <>
          <HanaProvider key={s.k} config={WITH_EVM}>
            <Grab name="p2" />
          </HanaProvider>
          {Activity && (
            <Activity mode={s.mode}>
              <HanaProvider config={WITH_EVM}>
                <Grab name="p1" />
              </HanaProvider>
            </Activity>
          )}
        </>
      );
    }
    render(<App />);
    await settle();
    expect(vaultFrames()).toBe(2);
    const p1 = latest('p1');
    act(() => {
      flushSync(() => set({ mode: 'hidden', k: 'a' }));
      flushSync(() => set({ mode: 'visible', k: 'b' }));
    });
    await settle();
    expect(p1.destroyed).toBe(false);
    expect(latest('p1')).toBe(p1);
    expect(vaultFrames()).toBe(2);
  });
});

describe.each([false, true])('wagmi: mount and unmount the provider ×3 (StrictMode: %s)', (strict) => {
  it('one connector, connected each time, refused with 4900 while off', async () => {
    const config = wagmi();
    let setOn!: (b: boolean) => void;
    function App() {
      const [on, s] = useState(true);
      setOn = s;
      const p = on ? (
        <HanaProvider config={WITH_EVM}>
          <Grab name="x" />
        </HanaProvider>
      ) : null;
      return strict ? <StrictMode>{p}</StrictMode> : p;
    }
    render(<App />);
    await settle();
    let first: unknown;
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        act(() => setOn(true));
        await settle();
      }
      expect(vaultFrames()).toBe(1);
      await signedIn();
      expect(oursIn(config)).toHaveLength(1);
      first ??= oursIn(config)[0];
      expect(oursIn(config)[0]).toBe(first);
      expect(getAccount(config)).toMatchObject({ status: 'connected', address: EVM });
      await disconnect(config);
      await expect(connect(config, { connector: oursIn(config)[0]! })).resolves.toMatchObject({ accounts: [EVM] });
      act(() => setOn(false));
      await settle();
      expect(vaultFrames()).toBe(0);
      expect(getAccount(config).status).toBe('disconnected');
      await expect(connect(config, { connector: oursIn(config)[0]! })).rejects.toMatchObject({ code: 4900 });
    }
  });
});
