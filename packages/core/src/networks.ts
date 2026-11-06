// Test apps and mainnet chains (docs/decisions.md D39). A `pk_test_` app's keys come from the testnet MPC, whose keys
// can be stolen (weaker operator and node standards) or lost (a network reset changes every address), so the vault
// never signs anything for such an app that a mainnet would accept:
// - Stellar: a transaction or auth entry for the public network's passphrase is refused (it is the only mainnet; a
//   signature for any other passphrase is invalid there).
// - EVM: an explicit allowlist of known testnet chain IDs. Anything else is treated as a mainnet and refused, which is
//   safer than a denylist of mainnets (a new or unknown chain is refused, not allowed).
// - Typed data is refused when its domain names a chain outside the allowlist. Messages and typed data without a
//   chainId name no network (D35) and are not refused.
// - Raw signing is refused outright for test apps: a raw digest can be a mainnet transaction's hash, and nothing in
//   the request says which network it is for.
// The partner client applies the same rules to eth_sendTransaction and wallet_switchEthereumChain/addEthereumChain,
// for a clear error before anything is filled or switched; the vault's check is the one that counts.
import { type PortRequest, type SignMethod, approvalContent } from './protocol.ts';
import { normalizeTypedData, typedDataChainId } from './typed-data.ts';

export const STELLAR_MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

/** EVM chains a test app may use, by chain ID. Everything else counts as a mainnet for a test app. */
export const TEST_EVM_CHAINS: Readonly<Record<number, string>> = Object.freeze({
  11155111: 'Sepolia',
  17000: 'Holesky',
  84532: 'Base Sepolia',
  421614: 'Arbitrum Sepolia',
  11155420: 'OP Sepolia',
  57054: 'Sonic Blaze testnet',
  14601: 'Sonic testnet',
  560048: 'Hoodi',
  97: 'BNB Smart Chain testnet',
  80002: 'Polygon Amoy',
  43113: 'Avalanche Fuji',
  31337: 'Local (Hardhat, Anvil)',
  1337: 'Local (Ganache, Geth dev)',
});

/**
 * The mainnets a `pk_test_` app with Hana's mainnet demo on may sign for (D426: the user, 2026-11-06, "Base and Stellar
 * only"): Base by chain ID here, and Stellar's public network. The vault decides with the app's setting and the
 * per-transaction cap (`@hana-id/core/mainnet-demo`); the partner client only lets these chains through its own
 * early check, so the vault's answer (4100 `mainnet_not_allowed` when the demo is off) is the one that counts.
 */
export const MAINNET_DEMO_EVM_CHAINS: readonly number[] = Object.freeze([8453]);

export const isTestPublishableKey = (pk: string): boolean => pk.startsWith('pk_test_');

/** Whether a test app may use this EVM chain (it is on the testnet allowlist). */
export const isTestEvmChain = (chainId: number): boolean => Number.isSafeInteger(chainId) && Object.hasOwn(TEST_EVM_CHAINS, chainId);

/** Whether the partner client's early D39 check lets a test app use this EVM chain (a testnet, or a demo mainnet). */
export const isTestOrDemoEvmChain = (chainId: number): boolean => isTestEvmChain(chainId) || MAINNET_DEMO_EVM_CHAINS.includes(chainId);

/** Whether a test app may sign for this Stellar network. */
export const isTestStellarNetwork = (passphrase: string): boolean => passphrase !== STELLAR_MAINNET_PASSPHRASE;

/** The user-facing explanation (vault errors, the partner client's errors, the approval popup). */
export const TEST_APP_NETWORK_RULE = 'Test apps (pk_test_ keys) can sign only for test networks: Hana ID refuses Stellar mainnet and EVM chains outside its testnet list';

/** Why a test app's raw request is refused (a raw digest names no network, so it could be a mainnet transaction). */
export const TEST_APP_RAW_RULE = 'Test apps (pk_test_ keys) can’t use raw signing: a raw digest can be a mainnet transaction';

/** A mainnet a test app may not sign for, as the request names it. */
export type MainnetRefusal = { chain: 'stellar'; networkPassphrase: string } | { chain: 'evm'; chainId: number };

/**
 * The mainnet this sign request is for, or null when a test app may sign it (a test network, or a request that names
 * no network). Throws on a request that doesn't parse (the caller refuses those first).
 */
export function mainnetOfRequest(request: Extract<PortRequest, { method: SignMethod }>): MainnetRefusal | null {
  switch (request.method) {
    case 'stellar_signTransaction':
    case 'stellar_signAuthEntry': {
      const passphrase = request.params.networkPassphrase;
      return isTestStellarNetwork(passphrase) ? null : { chain: 'stellar', networkPassphrase: passphrase };
    }
    case 'eth_signTransaction': {
      const context = approvalContent(request).context;
      const chainId = 'chainId' in context ? context.chainId : 0;
      return isTestEvmChain(chainId) ? null : { chain: 'evm', chainId };
    }
    case 'eth_signTypedData_v4': {
      const chainId = typedDataChainId(normalizeTypedData(request.params[1]));
      return chainId === null || isTestEvmChain(chainId) ? null : { chain: 'evm', chainId };
    }
    case 'stellar_signMessage':
    case 'personal_sign':
    case 'hana_signRaw':
      return null;
  }
}
