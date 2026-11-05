// @hana-id/react: `HanaProvider`, `useHana` and `useWallet` over @hana-id/web (docs/batch-b-spec.md, React).
//
//   <HanaProvider config={{ publishableKey: 'pk_test_…', environment: 'sandbox-dev', evm, stellar }}>…</HanaProvider>
//   const { status, addresses, persistence, error, login, logout, exportKey } = useHana();
//   const { address, signer } = useWallet('stellar');   // signer = hana.stellar
//   const { address, provider } = useWallet('evm');     // provider = hana.ethereum (EIP-1193)
//   <button onClick={login}>Sign in</button>             // login only from an onClick, with no await before it
//   const { identityToken, refresh, error } = useIdentityToken();   // the partner identity token, kept fresh

/** Package version, kept equal to package.json (test/index.test.ts). */
export const VERSION = '0.2.0';

export { HanaContext, HanaProvider, type HanaContextValue, type HanaProviderProps } from './provider.tsx';
export { useHana, useWallet, type EvmWallet, type HanaChain, type StellarWallet, type UseHanaResult } from './hooks.ts';
export { INITIAL_STATE, type HanaPersistence, type HanaState } from './store.ts';
export { IDENTITY_REFRESH_BEFORE_MS, IDENTITY_RETRY_MS, useIdentityToken, type UseIdentityTokenResult } from './identity.ts';
