// @vitest-environment happy-dom
// Switching app or environment by remounting HanaProvider with a new `key` (D936): the old client is destroyed before
// the new one is created, so the new client takes over the page's one EIP-6963 entry (same uuid), and real wagmi's
// one Journear Passport connector works with each client in turn; also under StrictMode.
import { connect, createConfig, disconnect, getAccount, getConnectors, http } from '@wagmi/core';
import { act, cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { sepolia } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HanaProvider } from '../src/index.ts';
import { CONFIG, EVM, LOGGED_IN, Probe, attachVault, newRenders, settle, stubBrowser, vaultFrames } from './harness.tsx';

const EVM_CONFIG = { chains: [{ id: sepolia.id, rpcUrl: 'https://sepolia.rpc.test' }], defaultChainId: sepolia.id };
const WITH_EVM = { ...CONFIG, evm: EVM_CONFIG };

let announcedUuids: string[];
const onAnnounce = (e: Event) => announcedUuids.push((e as CustomEvent<{ info: { uuid: string } }>).detail.info.uuid);
beforeEach(() => {
  stubBrowser();
  announcedUuids = [];
  window.addEventListener('eip6963:announceProvider', onAnnounce);
});
afterEach(async () => {
  window.removeEventListener('eip6963:announceProvider', onAnnounce);
  cleanup();
  await settle();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** Connects the newest vault frame as the signed-in user, answering eth_accounts. */
async function signedIn(): Promise<void> {
  const vault = attachVault();
  vault.handle('eth_accounts', () => ({ result: [EVM] }));
  await act(() => vault.connect(LOGGED_IN));
  await settle();
}

function tree(key: string, renders: ReturnType<typeof newRenders>, strict: boolean) {
  const provider = (
    <HanaProvider key={key} config={WITH_EVM}>
      <Probe renders={renders} />
    </HanaProvider>
  );
  return strict ? <StrictMode>{provider}</StrictMode> : provider;
}

describe.each([false, true])('a key remount a → b → c (StrictMode: %s)', (strict) => {
  it("keeps one uuid, one live client, and wagmi's one connector works with each client", async () => {
    const config = createConfig({ chains: [sepolia], transports: { [sepolia.id]: http('https://sepolia.rpc.test') }, storage: null });
    const ours = () => getConnectors(config).filter((c) => c.name === 'Journear Passport');
    const renders = newRenders();
    const view = render(tree('a', renders, strict));
    await settle();
    let first: unknown;
    let uuid: string | undefined;
    for (const key of ['a', 'b', 'c']) {
      if (key !== 'a') view.rerender(tree(key, renders, strict));
      await settle();
      expect(vaultFrames()).toBe(1);
      const client = renders.last.hana.client!;
      expect(client.destroyed).toBe(false);
      await signedIn();
      const detail = client.eip6963!;
      uuid ??= detail.info.uuid;
      expect(detail.info.uuid).toBe(uuid);
      expect(ours()).toHaveLength(1);
      const connector = ours()[0]!;
      first ??= connector;
      expect(connector).toBe(first);
      expect(await connector.getProvider()).toBe(detail.provider);
      expect(getAccount(config)).toMatchObject({ status: 'connected', address: EVM });
      await disconnect(config);
      await expect(connect(config, { connector })).resolves.toMatchObject({ accounts: [EVM] });
    }
    expect(new Set(announcedUuids)).toEqual(new Set([uuid]));
    view.unmount();
    await settle();
    expect(vaultFrames()).toBe(0);
    expect(getAccount(config).status).toBe('disconnected');
  });
});

describe('StrictMode with the real provider component', () => {
  it('one client and one announcement through the simulated unmount and remount', async () => {
    const renders = newRenders();
    render(tree('a', renders, true));
    await settle();
    expect(vaultFrames()).toBe(1);
    expect(new Set(announcedUuids).size).toBe(1);
    const client = renders.last.hana.client!;
    expect(client.destroyed).toBe(false);
    await signedIn();
    expect(await client.eip6963!.provider.request({ method: 'eth_accounts' })).toEqual([EVM]);
  });
});
