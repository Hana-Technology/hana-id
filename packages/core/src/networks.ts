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
 * EVM mainnets Hana can name, by chain ID. For display only: it allows nothing (a test app signs for none of them
 * outside the mainnet demo's own list).
 */
export const KNOWN_EVM_MAINNETS: Readonly<Record<number, string>> = Object.freeze({
  1: 'Ethereum',
  10: 'OP Mainnet',
  56: 'BNB Smart Chain',
  137: 'Polygon',
  146: 'Sonic',
  8453: 'Base',
  42161: 'Arbitrum One',
  43114: 'Avalanche C-Chain',
});

/** The native coin's symbol on the chains Hana can name; every other named chain's is ETH. */
const EVM_NATIVE_SYMBOLS: Readonly<Record<number, string>> = Object.freeze({
  56: 'BNB',
  97: 'tBNB',
  137: 'POL',
  80002: 'POL',
  146: 'S',
  57054: 'S',
  14601: 'S',
  43114: 'AVAX',
  43113: 'AVAX',
});

export interface EvmChainInfo {
  /** Hana's own name for the chain, with "(testnet)" unless the name already says so: "Sepolia (testnet)", "Base". */
  readonly label: string;
  readonly testnet: boolean;
  /** The native coin's symbol: "ETH". */
  readonly nativeSymbol: string;
}

/**
 * Hana's name and native coin for an EVM chain ID, from its own tables only (a name an app supplies is never shown
 * as the chain's), or null for a chain Hana doesn't know: show its number.
 */
export function evmChainInfo(chainId: number): EvmChainInfo | null {
  if (!Number.isSafeInteger(chainId)) return null;
  const testnet = Object.hasOwn(TEST_EVM_CHAINS, chainId);
  const name = testnet ? TEST_EVM_CHAINS[chainId] : Object.hasOwn(KNOWN_EVM_MAINNETS, chainId) ? KNOWN_EVM_MAINNETS[chainId] : undefined;
  if (name === undefined) return null;
  const label = testnet && !/testnet|^Local/iu.test(name) ? `${name} (testnet)` : name;
  return { label, testnet, nativeSymbol: Object.hasOwn(EVM_NATIVE_SYMBOLS, chainId) ? (EVM_NATIVE_SYMBOLS[chainId] as string) : 'ETH' };
}

// The mainnet demo (D428): the mainnets a `pk_test_` app with Hana's demo on may sign for are Base (8453) and Stellar's
// public network. The vault decides with the app's setting and the per-transaction cap (`@hana-id/core/mainnet-demo`);
// the partner client lets Base through its own early check only while its vault says the demo is on (the
// `mainnetDemo` port event), and the vault's answer is the one that counts. The constants live in demo-config.ts (no imports) for the API Worker.
export { MAINNET_DEMO_BALANCE_ENDPOINTS, MAINNET_DEMO_BALANCE_ORIGINS, MAINNET_DEMO_EVM_CHAINS, MAINNET_DEMO_TX_CAP_USD_MICROS } from './demo-config.ts';

export const isTestPublishableKey = (pk: string): boolean => pk.startsWith('pk_test_');

/** Whether a test app may use this EVM chain (it is on the testnet allowlist). */
export const isTestEvmChain = (chainId: number): boolean => Number.isSafeInteger(chainId) && Object.hasOwn(TEST_EVM_CHAINS, chainId);

/** Whether a test app may sign for this Stellar network. */
export const isTestStellarNetwork = (passphrase: string): boolean => passphrase !== STELLAR_MAINNET_PASSPHRASE;

/** Whether a test app may sign a NEAR transaction or delegate action for this network (testnet only). */
export const isTestNearNetwork = (network: string): boolean => network === 'testnet';

/** The user-facing explanation (vault errors, the partner client's errors, the approval popup). */
export const TEST_APP_NETWORK_RULE = 'Test apps (pk_test_ keys) can sign only for test networks: Hana ID refuses Stellar mainnet, NEAR mainnet and EVM chains outside its testnet list';

/** Why a test app's raw request is refused (a raw digest names no network, so it could be a mainnet transaction). */
export const TEST_APP_RAW_RULE = 'Test apps (pk_test_ keys) can’t use raw signing: a raw digest can be a mainnet transaction';

/** A mainnet a test app may not sign for, as the request names it. */
export type MainnetRefusal = { chain: 'stellar'; networkPassphrase: string } | { chain: 'evm'; chainId: number } | { chain: 'near'; network: string };

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
    case 'near_signTransaction':
    case 'near_signDelegateAction':
      // The request names its network; NEAR's bytes don't (a testnet transaction is tied to testnet by its block hash,
      // which the vault checks for a test app: D726).
      return isTestNearNetwork(request.params.network) ? null : { chain: 'near', network: request.params.network };
    case 'stellar_signMessage':
    case 'personal_sign':
    case 'hana_signRaw':
    case 'near_signMessage':
      return null;
  }
}
