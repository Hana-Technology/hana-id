// @hana-id/sodax (optional): `IStellarWalletProvider` and `IEvmWalletProvider` adapters over @hana-id/web, typed
// against @sodax/types 2.2.0 (docs/batch-b-spec.md, Sodax adapter):
//
//   const hana = createHana({ publishableKey, environment, stellar: {...}, evm: { chains: [{ id: 8453, rpcUrl }], ... } });
//   const stellar = createSodaxStellarProvider(hana, { networkPassphrase, horizonUrl, sorobanRpcUrl });
//   const base = createSodaxEvmProvider(hana, { chainId: 8453, rpcUrl });
//
// @sodax/types is a type-only peer: nothing of it is imported at runtime.

/** Package version, kept equal to package.json (test/index.test.ts). */
export const VERSION = '0.2.1';

export {
  STELLAR_RECEIPT_POLL_MS,
  STELLAR_RECEIPT_TIMEOUT_MS,
  type SodaxStellarConfig,
  type SodaxStellarHana,
  type SodaxStellarProvider,
  createSodaxStellarProvider,
} from './stellar.ts';
export { EVM_RECEIPT_POLL_MS, EVM_RECEIPT_TIMEOUT_MS, type SodaxEvmConfig, type SodaxEvmHana, createSodaxEvmProvider } from './evm.ts';
