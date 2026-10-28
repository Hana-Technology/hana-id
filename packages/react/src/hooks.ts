'use client';
// useHana and useWallet (docs/batch-b-spec.md, React). Both re-render on the client's statusChanged, accountsChanged,
// sessionExpired and disconnect events, and when `ready` settles.
//
// `login` must be called from an onClick (or another user-gesture handler), synchronously: it calls `hana.login()`
// directly, which opens the Hana popup before anything else, while the browser's user activation still holds. Don't
// put an `await` before it in the handler.
//
// `login` returns a promise that is already marked handled, so `onClick={login}` (where React drops the returned
// promise) never turns a closed popup or a 4001 into an unhandled rejection: the failure is in `useHana().error`. A
// caller that awaits or `.catch`es it still gets the rejection. `logout` and `exportKey` reject as usual: their
// failures are reported nowhere else, so handle them (`onClick={() => logout().catch(report)}`).
import type { HanaAddresses, HanaClient, HanaEthereumProvider, HanaStellarSigner } from '@hana-id/web';
import { HanaError } from '@hana-id/web';
import { useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import { HanaContext, type HanaContextValue } from './provider.tsx';
import { INITIAL_STATE, type HanaState } from './store.ts';

export type HanaChain = 'stellar' | 'evm';

export interface UseHanaResult extends HanaState {
  /**
   * Logs in (popup) and resolves with the addresses. Call it synchronously from an onClick; `onClick={login}` is fine.
   * A failure also lands in `error`, so the returned promise may be ignored (it is marked handled).
   */
  login(): Promise<HanaAddresses>;
  logout(): Promise<void>;
  /** Starts a key export: the key is shown only in a Hana window, never returned to the page. */
  exportKey(chain: HanaChain): Promise<null>;
  /** The underlying client, for the calls this hook doesn't wrap (signRaw, revokeOtherDevices, auto-approve, events). */
  client: HanaClient | null;
}

export interface StellarWallet {
  /** The Stellar address (G…) while logged in, else null. */
  address: string | null;
  /** `hana.stellar`; null until the provider has mounted its client. */
  signer: HanaStellarSigner | null;
}

export interface EvmWallet {
  /** The EIP-55 EVM address while logged in, else null. */
  address: string | null;
  /** `hana.ethereum` (EIP-1193); null until the provider has mounted its client. */
  provider: HanaEthereumProvider | null;
}

function useHanaContext(hook: string): HanaContextValue {
  const ctx = useContext(HanaContext);
  if (ctx === null) throw new Error(`${hook} must be used inside <HanaProvider>`);
  return ctx;
}

const serverSnapshot = (): HanaState => INITIAL_STATE;

function useHanaState(ctx: HanaContextValue): HanaState {
  return useSyncExternalStore(ctx.store.subscribe, ctx.store.getSnapshot, serverSnapshot);
}

/** Before the provider's client exists (a call from the first render, which no click can reach in practice). */
const notMounted = (): Promise<never> => Promise.reject(new HanaError(4900, 'Hana ID is not mounted yet (HanaProvider has not run its effect)'));

const ignore = (): void => {};

/** `p` itself, with a no-op handler attached so dropping it isn't an unhandled rejection (see the header). */
function handled<T>(p: Promise<T>): Promise<T> {
  p.catch(ignore);
  return p;
}

export function useHana(): UseHanaResult {
  const ctx = useHanaContext('useHana');
  const state = useHanaState(ctx);
  const { client } = ctx;
  // Ignore arguments, so `onClick={login}` (which passes the click event) works.
  const login = useCallback(() => handled(client ? client.login() : notMounted()), [client]);
  const logout = useCallback(() => (client ? client.logout() : notMounted()), [client]);
  const exportKey = useCallback((chain: HanaChain) => (client ? client.exportKey(chain) : notMounted()), [client]);
  return useMemo(() => ({ ...state, login, logout, exportKey, client }), [state, login, logout, exportKey, client]);
}

export function useWallet(chain: 'stellar'): StellarWallet;
export function useWallet(chain: 'evm'): EvmWallet;
export function useWallet(chain: HanaChain): StellarWallet | EvmWallet {
  if (chain !== 'stellar' && chain !== 'evm') throw new TypeError(`useWallet takes 'stellar' or 'evm', not ${JSON.stringify(chain)}`);
  const ctx = useHanaContext('useWallet');
  const address = useHanaState(ctx).addresses?.[chain] ?? null;
  const { client } = ctx;
  return useMemo(
    () => (chain === 'stellar' ? { address, signer: client?.stellar ?? null } : { address, provider: client?.ethereum ?? null }),
    [chain, address, client],
  );
}
