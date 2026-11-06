// Hana's verified contract list and block explorers (docs/decisions.md D44). The auto-approve consent screen shows a
// policy contract on this list as "✓ {verified name}"; any other contract as "{partner name} · named by {app}", flagged
// when the partner's name imitates a verified one. This module is pinned data built into the vault and popup bundles:
// a code release changes it, never D1 or the API.
//
// Adding an entry: only after Hana confirms the address from the protocol's own official sources, and `sources` lists
// every one of them (a version-pinned package file, a docs page). Entries here are confirmed by two Sodax sources that
// agree on both the address and the contract's role on that chain:
//   - the published @sodax/types@2.1.0 package, the version this repo pins (packages/sodax; lockfile integrity
//     sha512-5fK0RTcRGzc/iK1ZeqIEE9n/CkB2Q8ecRYgY7aeBICe30X+GApkviSjsEtMETLW3Lx9EUSFJChCsVLjB2d5dWQ==): the SDK's
//     default config, the addresses @sodax/sdk sends transactions to. 2.2.0, the latest release on 2026-10-28, has
//     the same addresses for every entry here;
//   - Sodax's mainnet deployments page, https://docs.sodax.com/developers/deployments/mainnet (read 2026-10-28).
// An address only one of them lists, or that they disagree on, is left out. Sodax is mainnet-only, so every Sodax
// entry is a mainnet entry. test/verified-contracts.test.ts checks every entry's shape, sources and uniqueness;
// packages/sodax/test/verified-contracts.test.ts checks every Sodax entry against the installed @sodax/types config.
//
// Keys: EVM entries by chainId and address, compared lowercase (stored EIP-55); Stellar entries by network passphrase
// and contract StrKey, compared exactly.
import { STELLAR_MAINNET_PASSPHRASE } from './networks.ts';

/** A chain a policy contract lives on: an EVM chain ID, or a Stellar network passphrase. */
export type ContractChain = { readonly kind: 'evm'; readonly chainId: number } | { readonly kind: 'stellar'; readonly networkPassphrase: string };

export interface VerifiedContract {
  readonly chain: ContractChain;
  /** EVM: EIP-55. Stellar: contract StrKey (C…). */
  readonly address: string;
  /** Shown as "✓ {name}". Self-describing: it names the protocol. */
  readonly name: string;
  /** The protocol that deployed it (a partner name mentioning it on another contract is flagged). */
  readonly protocol: string;
  /** Where Hana confirmed the address: https URLs, packages pinned to an exact version. At least one. */
  readonly sources: readonly string[];
  /** ISO date the entry was added. */
  readonly added: string;
}

export const STELLAR_TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

const SODAX_DOCS = 'https://docs.sodax.com/developers/deployments/mainnet';
const SODAX_TYPES = 'https://unpkg.com/@sodax/types@2.2.0/dist';
/** chains.js: spokeChainConfig (per spoke chain) and hubConfig (Sonic). */
const SODAX_CHAINS = `${SODAX_TYPES}/chains/chains.js`;
const SODAX_SOLVER = `${SODAX_TYPES}/common/constants.js`;
const SODAX_MONEY_MARKET = `${SODAX_TYPES}/moneyMarket/moneyMarket.js`;
const SODAX_DEX = `${SODAX_TYPES}/dex/dex.js`;
const SODAX_ADDED = '2026-10-28';

const evm = (chainId: number): ContractChain => ({ kind: 'evm', chainId });
const sodax = (chain: ContractChain, address: string, name: string, packageFile: string): VerifiedContract => ({
  chain,
  address,
  name,
  protocol: 'Sodax',
  sources: [packageFile, SODAX_DOCS],
  added: SODAX_ADDED,
});

const SONIC = evm(146);
const STELLAR = { kind: 'stellar', networkPassphrase: STELLAR_MAINNET_PASSPHRASE } as const;

/** Spoke chains: `spokeChainConfig[chain].addresses.assetManager` and `.bnUSD`, the docs' AssetManager and bnUSD rows. */
const SPOKES: readonly (readonly [chainId: number, assetManager: string, bnUSD: string])[] = [
  [1, '0x39E77f86C1B1f3fbAb362A82b49D2E86C09659B4', '0x1f22279C89B213944b7Ea41daCB0a868DdCDFd13'], // Ethereum
  [10, '0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3', '0xF4f7dC27c17470a26d0de9039Cf0EA5045F100E8'], // Optimism
  [56, '0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3', '0x8428FedC020737a5A2291F46cB1B80613eD71638'], // BNB Chain
  [137, '0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3', '0x39E77f86C1B1f3fbAb362A82b49D2E86C09659B4'], // Polygon
  [151, '0x39E77f86C1B1f3fbAb362A82b49D2E86C09659B4', '0xF4f7dC27c17470a26d0de9039Cf0EA5045F100E8'], // Redbelly
  [295, '0x0df73542cC68bDC01b361d231c60F726B0e0bC05', '0x0000000000000000000000000000000000A0286A'], // Hedera
  [999, '0xAfd6A6e4287A511D3BAAd013093815268846FBb7', '0x506Ba7C8d91dAdf7a91eE677a205D9687b751579'], // HyperEVM
  [1890, '0x4A1C82744cDDeE675A255fB289Cb0917A482e7C7', '0x36134A03dcD03Bbe858B8F7ED28a71AAC608F9E7'], // LightLink
  [4663, '0x0df73542cC68bDC01b361d231c60F726B0e0bC05', '0x3cd95C469be0EDFD12Bd4F3a4436B132B7908DF4'], // Robinhood Chain
  [8217, '0x6D2126DB97dd88AfA85127253807D04A066b6746', '0xF8D13cAcb8E2B6BA8396DbA35a7365EF6b603cd6'], // Kaia
  [8453, '0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3', '0xAcfab3F31C0a18559D78556BBf297EC29c6cf8aa'], // Base
  [42161, '0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3', '0xA256dd181C3f6E5eC68C6869f5D50a712d47212e'], // Arbitrum
  [43114, '0x5bDD1E1C5173F4c912cC919742FB94A55ECfaf86', '0x6958a4CBFe11406E2a1c1d3a71A1971aD8B3b92F'], // Avalanche
];

/** Spoke chains where the docs also list the Connection contract (`spokeChainConfig[chain].addresses.connection`). */
const SPOKE_CONNECTIONS: readonly (readonly [chainId: number, connection: string])[] = [
  [295, '0x4555aC13D7338D9E671584C1D118c06B2a3C88eD'], // Hedera
  [4663, '0x4555aC13D7338D9E671584C1D118c06B2a3C88eD'], // Robinhood Chain
  [8217, '0x4555aC13D7338D9E671584C1D118c06B2a3C88eD'], // Kaia
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export const VERIFIED_CONTRACTS: readonly VerifiedContract[] = deepFreeze([
  // Sonic, the hub: hubConfig.addresses (docs "Infrastructure HUB"), solverConfig (docs Intents, ProtocolIntents),
  // moneyMarketConfig (docs "Money Market", "Balanced Dollar minting", "SodaTokens"), concentratedLiquidityConfig
  // (docs "DEX").
  sodax(SONIC, '0x60c5681bD1DB4e50735c4cA3386005A4BA4937C0', 'Sodax Hub Asset Manager', SODAX_CHAINS),
  sodax(SONIC, '0xA0ed3047D358648F2C0583B415CffCA571FDB544', 'Sodax Hub Wallet Factory', SODAX_CHAINS),
  sodax(SONIC, '0xC67C3e55c665E78b25dc9829B3Aa5af47d914733', 'Sodax Sonic Router', SODAX_CHAINS),
  sodax(SONIC, '0x8294DE9fc60F5ABCc19245E5857071d7C42B9875', 'Sodax ICX Migration', SODAX_CHAINS),
  sodax(SONIC, '0x610a90B61b89a98b954d5750E94834Aa45d08d10', 'Sodax BALN Migration', SODAX_CHAINS),
  sodax(SONIC, '0x7c7d53EEcda37a87ce0D5bf8E0b24512A48dC963', 'Sodax SODA token', SODAX_CHAINS),
  sodax(SONIC, '0x21685E341DE7844135329914Be6Bd8D16982d834', 'Sodax SODA Vault', SODAX_CHAINS),
  sodax(SONIC, '0x4333B324102d00392038ca92537DfbB8CB0DAc68', 'Sodax Staked SODA', SODAX_CHAINS),
  sodax(SONIC, '0xADC6561Cc8FC31767B4917CCc97F510D411378d9', 'Sodax xSODA', SODAX_CHAINS),
  sodax(SONIC, '0xE287Cd568543d880e0F0DfaDCE18B44930759367', 'Sodax Staking Router', SODAX_CHAINS),
  sodax(SONIC, '0x6382D6ccD780758C5e8A6123c33ee8F4472F96ef', 'Sodax Intents', SODAX_SOLVER),
  sodax(SONIC, '0xaFf2EDb3057ed6f9C1dA6c930b8ddDf2beE573A5', 'Sodax Protocol Intents', SODAX_SOLVER),
  sodax(SONIC, '0x553434896D39F867761859D0FE7189d2Af70514E', 'Sodax Money Market Pool', SODAX_MONEY_MARKET),
  sodax(SONIC, '0x94dC79ce9C515ba4AE4D195da8E6AB86c69BFc38', 'Sodax bnUSD', SODAX_MONEY_MARKET),
  sodax(SONIC, '0xa2cDA49735e42f0905496E40a66B3C5475Ed69dF', 'Sodax bnUSD aToken', SODAX_MONEY_MARKET),
  sodax(SONIC, '0xE801CA34E19aBCbFeA12025378D19c4FBE250131', 'Sodax bnUSD Vault', SODAX_MONEY_MARKET),
  sodax(SONIC, '0x5bFB058c65E4c1DEC1cFF0Ff2cBd8522b4c3feBB', 'Sodax DEX Router', SODAX_DEX),
  sodax(SONIC, '0xcc08a04d9E5766c7A20FE6bb32cAa40EA0e7e9e1', 'Sodax DEX Position Manager', SODAX_DEX),
  sodax(SONIC, '0xA3256ab552A271A16AcDfdB521B32ef82d481F43', 'Sodax DEX Pool Manager', SODAX_DEX),
  // EVM spoke chains.
  ...SPOKES.flatMap(([chainId, assetManager, bnUSD]) => [
    sodax(evm(chainId), assetManager, 'Sodax Asset Manager', SODAX_CHAINS),
    sodax(evm(chainId), bnUSD, 'Sodax bnUSD', SODAX_CHAINS),
  ]),
  ...SPOKE_CONNECTIONS.map(([chainId, connection]) => sodax(evm(chainId), connection, 'Sodax Connection', SODAX_CHAINS)),
  // Stellar: spokeChainConfig.stellar.addresses.assetManager and .bnUSD (docs "Stellar" AssetManager, bnUSD).
  sodax(STELLAR, 'CCGF33A4CO6D3BXFEKPXVCFCZBK76I3AQOZK6KIKRPAWAZR3632WHCJ3', 'Sodax Asset Manager', SODAX_CHAINS),
  sodax(STELLAR, 'CD6YBFFWMU2UJHX2NGRJ7RN76IJVTCC7MRA46DUBXNB7E6W7H7JRJ2CX', 'Sodax bnUSD', SODAX_CHAINS),
] satisfies VerifiedContract[]);

const chainKey = (chain: ContractChain): string => (chain.kind === 'evm' ? `evm:${chain.chainId}` : `stellar:${chain.networkPassphrase}`);
/** The lookup key: EVM addresses lowercase, Stellar contract IDs exact. */
export const verifiedContractKey = (chain: ContractChain, address: string): string =>
  `${chainKey(chain)}|${chain.kind === 'evm' ? address.toLowerCase() : address}`;

const BY_KEY: ReadonlyMap<string, VerifiedContract> = new Map(VERIFIED_CONTRACTS.map((e) => [verifiedContractKey(e.chain, e.address), e]));

/** The verified entry for this contract on this chain, or null. */
export function verifiedContract(chain: ContractChain, address: string): VerifiedContract | null {
  return BY_KEY.get(verifiedContractKey(chain, address)) ?? null;
}

/**
 * The verified entry when the contract is verified on every one of `chains` under one name (a Stellar policy lists
 * several networks for each contract), or null.
 */
export function verifiedContractOnAll(chains: readonly ContractChain[], address: string): VerifiedContract | null {
  if (chains.length === 0) return null;
  const found = chains.map((c) => verifiedContract(c, address));
  const first = found[0];
  return first && found.every((e) => e?.name === first.name) ? first : null;
}

// ---- partner names that imitate a verified one ----

/** Latin look-alikes (Cyrillic, Greek, digits) folded to the letter they imitate, after NFKC and lowercasing. */
const CONFUSABLES: Readonly<Record<string, string>> = Object.freeze({
  а: 'a', в: 'b', е: 'e', ё: 'e', һ: 'h', н: 'h', і: 'l', ї: 'l', ј: 'j', к: 'k', м: 'm', о: 'o', р: 'p', с: 'c', ѕ: 's',
  т: 't', у: 'y', х: 'x', ԁ: 'd', ԛ: 'q', ԝ: 'w', ӏ: 'l', ɡ: 'g', ı: 'l',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'l', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
  '0': 'o', '1': 'l', i: 'l', '|': 'l',
});

/**
 * A name's comparison form: NFKC, accents dropped, lowercased, look-alike letters folded, `rn`→`m` and `vv`→`w`,
 * and everything but a–z and 0–9 removed. Two names with the same skeleton read the same to a user.
 */
export function nameSkeleton(name: string): string {
  const folded = Array.from(name.normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(), (ch) => CONFUSABLES[ch] ?? ch).join('');
  return folded.replace(/[^a-z0-9]/gu, '').replace(/rn/gu, 'm').replace(/vv/gu, 'w');
}

/** Why a partner's name for an unverified contract is flagged, or null. */
export type NameCollision =
  /** The name reads as a verified contract's name (on any chain). */
  | { readonly kind: 'verified-name'; readonly entry: VerifiedContract }
  /** The name mentions a protocol on the verified list. */
  | { readonly kind: 'protocol'; readonly protocol: string };

const PROTOCOLS: readonly string[] = [...new Set(VERIFIED_CONTRACTS.map((e) => e.protocol))];

/**
 * Whether `partnerName`, given to `address` on `chains`, imitates a verified name. The contract's own entries (on one
 * of `chains`, when it isn't verified on all of them) don't count: their name and protocol are no imitation.
 */
export function nameCollision(partnerName: string, chains: readonly ContractChain[], address: string, list: readonly VerifiedContract[] = VERIFIED_CONTRACTS): NameCollision | null {
  const skeleton = nameSkeleton(partnerName);
  if (skeleton.length === 0) return null;
  const self = new Set(chains.map((c) => verifiedContractKey(c, address)));
  const own = list.filter((e) => self.has(verifiedContractKey(e.chain, e.address)));
  if (own.some((e) => nameSkeleton(e.name) === skeleton)) return null;
  const entry = list.find((e) => nameSkeleton(e.name) === skeleton);
  if (entry) return { kind: 'verified-name', entry };
  const ownProtocols = new Set(own.map((e) => e.protocol));
  const protocols = list === VERIFIED_CONTRACTS ? PROTOCOLS : [...new Set(list.map((e) => e.protocol))];
  const protocol = protocols.find((p) => !ownProtocols.has(p) && skeleton.includes(nameSkeleton(p)));
  return protocol === undefined ? null : { kind: 'protocol', protocol };
}

/** Check marks a partner name may not show: only Hana's verified badge carries one (removed when rendering). */
export const CHECK_MARKS = /[\u2611\u2705\u2713\u2714\u221a\u{10102}\u{1F5F8}\u{1F5F9}\u{1FBB1}\ufe0e\ufe0f]/gu;

/** A partner name as the consent screen shows it: check marks removed, trimmed. */
export const displayPartnerName = (name: string): string => name.replace(CHECK_MARKS, '').trim();

// ---- block explorers ----

export interface Explorer {
  /** Link text: "View on {name}". */
  readonly name: string;
  /** https URL prefix; the contract address is appended. */
  readonly contractUrl: string;
}

/**
 * EVM explorers by chain ID: viem@2.57.7's `blockExplorers.default` for each chain plus `/address/`, except Hedera,
 * whose contract pages are `/contract/` (@sodax/types@2.1.0 `baseChainInfo` hedera `contractUrl`). Chains without a
 * known explorer (Sonic testnet 14601, local chains) are left out: their addresses show without a link.
 */
export const EVM_EXPLORERS: Readonly<Record<number, Explorer>> = deepFreeze({
  1: { name: 'Etherscan', contractUrl: 'https://etherscan.io/address/' },
  10: { name: 'Optimism Explorer', contractUrl: 'https://optimistic.etherscan.io/address/' },
  56: { name: 'BscScan', contractUrl: 'https://bscscan.com/address/' },
  137: { name: 'PolygonScan', contractUrl: 'https://polygonscan.com/address/' },
  146: { name: 'SonicScan', contractUrl: 'https://sonicscan.org/address/' },
  151: { name: 'Routescan', contractUrl: 'https://redbelly.routescan.io/address/' },
  295: { name: 'HashScan', contractUrl: 'https://hashscan.io/mainnet/contract/' },
  999: { name: 'HyperEVMScan', contractUrl: 'https://hyperevmscan.io/address/' },
  1890: { name: 'LightLink Phoenix Explorer', contractUrl: 'https://phoenix.lightlink.io/address/' },
  4663: { name: 'Robinhood Chain Blockscout', contractUrl: 'https://robinhoodchain.blockscout.com/address/' },
  8217: { name: 'KaiaScan', contractUrl: 'https://kaiascan.io/address/' },
  8453: { name: 'Basescan', contractUrl: 'https://basescan.org/address/' },
  42161: { name: 'Arbiscan', contractUrl: 'https://arbiscan.io/address/' },
  43114: { name: 'SnowTrace', contractUrl: 'https://snowtrace.io/address/' },
  // Test networks (networks.ts TEST_EVM_CHAINS).
  11155111: { name: 'Sepolia Etherscan', contractUrl: 'https://sepolia.etherscan.io/address/' },
  17000: { name: 'Holesky Etherscan', contractUrl: 'https://holesky.etherscan.io/address/' },
  560048: { name: 'Hoodi Etherscan', contractUrl: 'https://hoodi.etherscan.io/address/' },
  84532: { name: 'Base Sepolia Basescan', contractUrl: 'https://sepolia.basescan.org/address/' },
  421614: { name: 'Arbitrum Sepolia Arbiscan', contractUrl: 'https://sepolia.arbiscan.io/address/' },
  11155420: { name: 'OP Sepolia Blockscout', contractUrl: 'https://optimism-sepolia.blockscout.com/address/' },
  57054: { name: 'Sonic Blaze testnet explorer', contractUrl: 'https://testnet.sonicscan.org/address/' },
  97: { name: 'BscScan testnet', contractUrl: 'https://testnet.bscscan.com/address/' },
  80002: { name: 'Amoy PolygonScan', contractUrl: 'https://amoy.polygonscan.com/address/' },
  43113: { name: 'SnowTrace Fuji', contractUrl: 'https://testnet.snowtrace.io/address/' },
});

/** Stellar explorers by network passphrase (StellarExpert; the public URL as in @sodax/types@2.1.0 `contractUrl`). */
export const STELLAR_EXPLORERS: Readonly<Record<string, Explorer>> = deepFreeze({
  [STELLAR_MAINNET_PASSPHRASE]: { name: 'StellarExpert', contractUrl: 'https://stellar.expert/explorer/public/contract/' },
  [STELLAR_TESTNET_PASSPHRASE]: { name: 'StellarExpert (testnet)', contractUrl: 'https://stellar.expert/explorer/testnet/contract/' },
});

export function explorerFor(chain: ContractChain): Explorer | null {
  const table: Readonly<Record<string | number, Explorer>> = chain.kind === 'evm' ? EVM_EXPLORERS : STELLAR_EXPLORERS;
  const key = chain.kind === 'evm' ? chain.chainId : chain.networkPassphrase;
  return Object.hasOwn(table, key) ? (table[key] ?? null) : null;
}

/** The explorer page of this contract, or null when no explorer is known for the chain. */
export function explorerContractUrl(chain: ContractChain, address: string): string | null {
  const e = explorerFor(chain);
  return e ? `${e.contractUrl}${encodeURIComponent(address)}` : null;
}

/** "0x348B…7Bc3", "CCGF…HCJ3": the first and last four characters (after `0x`). */
export function shortAddress(address: string): string {
  const prefix = address.startsWith('0x') ? '0x' : '';
  const body = address.slice(prefix.length);
  return body.length <= 10 ? address : `${prefix}${body.slice(0, 4)}…${body.slice(-4)}`;
}
