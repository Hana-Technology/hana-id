// Test harness for @hana-id/react: the real createHana and HanaClient from @hana-id/web on happy-dom, with the partner
// client's scripted vault (packages/web/test/client/harness.ts) attached to each vault iframe the provider mounts, and
// window.open replaced by fake popups. Each test file mocks '@hana-id/web' so createHana calls are counted while the
// real function still runs:
//
//   vi.mock('@hana-id/web', async (importOriginal) => {
//     const real = await importOriginal<typeof import('@hana-id/web')>();
//     return { ...real, createHana: vi.fn(real.createHana) };
//   });
import type { HanaClient } from '@hana-id/web';
import { act } from '@testing-library/react';
import { vi } from 'vitest';
import { FakeMessageChannel, FakePopup, FakeVault, PK, flush, quietIframeLoads } from '../../web/test/client/harness.ts';
import { type EvmWallet, type StellarWallet, type UseHanaResult, useHana, useWallet } from '../src/index.ts';

export { EVM, EVM_2, LOGGED_IN, LOGGED_OUT, PK, STELLAR, STELLAR_2 } from '../../web/test/client/harness.ts';
export type { FakeVault } from '../../web/test/client/harness.ts';

/** An env that envs.generated.ts always has (envs/sandbox-dev.json sets both Hana origins). */
export const ENV = 'sandbox-dev';
export const CONFIG = Object.freeze({ publishableKey: PK, environment: ENV });

export interface Env {
  popups: FakePopup[];
  open: ReturnType<typeof vi.fn>;
}

/** Stubs MessageChannel and window.open (call in beforeEach). */
export function stubBrowser(): Env {
  quietIframeLoads();
  vi.stubGlobal('MessageChannel', FakeMessageChannel);
  const popups: FakePopup[] = [];
  const open = vi.fn((..._args: unknown[]) => {
    const p = new FakePopup();
    popups.push(p);
    return p;
  });
  window.open = open as unknown as typeof window.open;
  return { popups, open };
}

/** The scripted vault on the most recently mounted vault iframe. */
export function attachVault(): FakeVault {
  const frames = document.querySelectorAll<HTMLIFrameElement>('iframe[name^="hana-vault-"]');
  const frame = frames[frames.length - 1];
  if (!frame) throw new Error('No vault iframe mounted');
  return new FakeVault(frame);
}

export const vaultFrames = (): number => document.querySelectorAll('iframe[name^="hana-vault-"]').length;

/** Each render's hook values, in order. */
export interface Renders {
  hana: UseHanaResult[];
  stellar: StellarWallet[];
  evm: EvmWallet[];
  readonly last: { hana: UseHanaResult; stellar: StellarWallet; evm: EvmWallet };
}

export function newRenders(): Renders {
  const r = {
    hana: [] as UseHanaResult[],
    stellar: [] as StellarWallet[],
    evm: [] as EvmWallet[],
    get last() {
      const hana = r.hana.at(-1);
      const stellar = r.stellar.at(-1);
      const evm = r.evm.at(-1);
      if (!hana || !stellar || !evm) throw new Error('Not rendered yet');
      return { hana, stellar, evm };
    },
  };
  return r;
}

/** A partner component: records every render's hook values and offers `onClick={login}` as its sign-in button. */
export function Probe({ renders }: { renders: Renders }) {
  const hana = useHana();
  const stellar = useWallet('stellar');
  const evm = useWallet('evm');
  renders.hana.push(hana);
  renders.stellar.push(stellar);
  renders.evm.push(evm);
  return (
    <button type="button" onClick={hana.login}>
      Sign in
    </button>
  );
}

/** The client the provider created (the n-th createHana call's result). */
export function createdClient(createHana: ReturnType<typeof vi.fn>, n = 0): HanaClient {
  const r = createHana.mock.results[n];
  if (!r || r.type !== 'return') throw new Error(`createHana call ${n} did not return a client`);
  return r.value as HanaClient;
}

/** Lets port deliveries, promise chains and the provider's deferred destroy run, inside act(). */
export async function settle(): Promise<void> {
  await act(async () => {
    await flush();
  });
}
