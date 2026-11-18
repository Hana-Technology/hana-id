// Journear's reviewed list of well-known tokens (D860), so the approval window can say "5 USDC" instead of "5000000 units
// of an unlisted token". Pinned data built into the popup's bundle, reviewed like verified-contracts.ts: a code release
// changes it, never D1 or the API, and never the token itself (a contract's own symbol() or decimals() is its claim, so
// nothing here is ever read from a chain).
//
// Adding an entry: only an address the token's issuer publishes in its own documentation, with that page and the date
// it was read beside the entry. An address a third party lists (an explorer label, an aggregator, a blog) is left out.
// Decimals are the issuer's where it states them; otherwise the token standard's and the source says which.
// test/known-tokens.test.ts checks every entry's shape and source, that the Stellar asset contracts are the ones the
// listed assets derive to, and that every token of the mainnet demo (MAINNET_DEMO, still the source of the demo's
// amounts and caps) is here with the same decimals.
//
// Keys: EVM by chain ID and address, compared without letter case (stored EIP-55); Stellar by network passphrase and
// either a classic asset `CODE:ISSUER` or its asset contract `C…`, compared exactly; NEAR by network and account id,
// compared exactly (account ids are lowercase by the protocol).
import { STELLAR_MAINNET_PASSPHRASE } from './networks.ts';

/** Where a token lives: an EVM chain ID, a Stellar network passphrase, a NEAR network. */
export type TokenNetwork =
  | { readonly kind: 'evm'; readonly chainId: number }
  | { readonly kind: 'stellar'; readonly networkPassphrase: string }
  | { readonly kind: 'near'; readonly network: 'testnet' | 'mainnet' };

export interface KnownTokenEntry {
  /** What the window writes after an amount: "USDC". */
  readonly symbol: string;
  /** The issuer's own name for it. */
  readonly name: string;
  /** The issuer's decimals: an amount is shown as value / 10^decimals. */
  readonly decimals: number;
  /** A collectible's numbers are item ids, never amounts: only `token` entries give an amount a symbol. */
  readonly kind: 'token' | 'collectible';
  /** The issuer's page (https) that lists this exact id, and anything else the entry relies on. At least one. */
  readonly sources: readonly string[];
  /** ISO date the sources were read. */
  readonly read: string;
}

export interface KnownTokenList {
  readonly evm: Readonly<Record<number, Readonly<Record<string, KnownTokenEntry>>>>;
  readonly stellar: Readonly<Record<string, Readonly<Record<string, KnownTokenEntry>>>>;
  readonly near: Readonly<Record<'testnet' | 'mainnet', Readonly<Record<string, KnownTokenEntry>>>>;
}

const READ = '2026-11-18';
/** Circle's USDC contract addresses (sections "Mainnet" and "Testnet"). */
const CIRCLE_USDC = 'https://developers.circle.com/stablecoins/usdc-contract-addresses';
/** Circle's EURC contract addresses. */
const CIRCLE_EURC = 'https://developers.circle.com/stablecoins/eurc-contract-addresses';
/** Circle states USDC and EURC have 6 decimals (outside Stellar). */
const CIRCLE_DECIMALS = 'https://developers.circle.com/gateway/concepts/non-usdc-assets';
/** Circle: on Stellar, USDC is in seven-decimal subunits (every Stellar classic asset is). */
const CIRCLE_STELLAR_DECIMALS = 'https://developers.circle.com/cctp/references/stellar';
/** A Stellar asset contract is derived from the asset and the network (stellar-base Asset.contractId); test/known-tokens.test.ts derives each again. */
const SAC_DERIVED = 'derived: @stellar/stellar-base Asset.contractId(network passphrase) of the listed asset';
/** NEAR's own wrapped-NEAR README: "deployed at wrap.near on mainnet", symbol wNEAR, decimals 24. */
const WNEAR_README = 'https://github.com/near/core-contracts/blob/master/w-near/README.md';
/** NEAR's own JavaScript SDK lists wrap.testnet (wNEAR, 24 decimals) and Circle's NEAR USDC with 6 decimals. */
const NEAR_API_JS_TOKENS = 'https://github.com/near/near-api-js (src/tokens, mainnet and testnet lists)';

const usdc = (sources: readonly string[] = [CIRCLE_USDC, CIRCLE_DECIMALS]): KnownTokenEntry => Object.freeze({ symbol: 'USDC', name: 'USD Coin', decimals: 6, kind: 'token', sources, read: READ });
const eurc = (): KnownTokenEntry => Object.freeze({ symbol: 'EURC', name: 'Euro Coin', decimals: 6, kind: 'token', sources: [CIRCLE_EURC, CIRCLE_DECIMALS], read: READ });
const stellarAsset = (symbol: 'USDC' | 'EURC', source: string): KnownTokenEntry =>
  Object.freeze({ symbol, name: symbol === 'USDC' ? 'USD Coin' : 'Euro Coin', decimals: 7, kind: 'token', sources: [source, CIRCLE_STELLAR_DECIMALS], read: READ });
const stellarContract = (asset: KnownTokenEntry): KnownTokenEntry => Object.freeze({ ...asset, sources: [...asset.sources, SAC_DERIVED] });
const XLM: KnownTokenEntry = Object.freeze({ symbol: 'XLM', name: 'Stellar lumens', decimals: 7, kind: 'token', sources: [SAC_DERIVED, 'the native asset: 7 decimals by the Stellar protocol'], read: READ });

/** Stellar's test network passphrase (the same constant as verified-contracts.ts, kept here to avoid a cycle). */
const STELLAR_TESTNET = 'Test SDF Network ; September 2015';

/** Circle's issuer accounts on Stellar (USDC and EURC), from its address pages. */
export const CIRCLE_STELLAR_ISSUERS = Object.freeze({
  public: Object.freeze({ USDC: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', EURC: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2' }),
  testnet: Object.freeze({ USDC: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', EURC: 'GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO' }),
});

const PUB_USDC = stellarAsset('USDC', CIRCLE_USDC);
const PUB_EURC = stellarAsset('EURC', CIRCLE_EURC);
const TEST_USDC = stellarAsset('USDC', CIRCLE_USDC);
const TEST_EURC = stellarAsset('EURC', CIRCLE_EURC);

/** The reviewed list. Seeded conservatively: only what the issuers' own pages list. */
export const KNOWN_TOKENS: KnownTokenList = Object.freeze({
  evm: Object.freeze({
    // Mainnets.
    1: Object.freeze({ '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': usdc(), '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c': eurc() }), // Ethereum
    10: Object.freeze({ '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85': usdc() }), // OP Mainnet
    137: Object.freeze({ '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359': usdc() }), // Polygon PoS
    8453: Object.freeze({ '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': usdc(), '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42': eurc() }), // Base
    42161: Object.freeze({ '0xaf88d065e77c8cC2239327C5EDb3A432268e5831': usdc() }), // Arbitrum One
    // Test networks.
    11155111: Object.freeze({ '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238': usdc(), '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4': eurc() }), // Ethereum Sepolia
    84532: Object.freeze({ '0x036CbD53842c5426634e7929541eC2318f3dCF7e': usdc(), '0x808456652fdb597867f38412077A9182bf77359F': eurc() }), // Base Sepolia
    421614: Object.freeze({ '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d': usdc() }), // Arbitrum Sepolia
    11155420: Object.freeze({ '0x5fd84259d66Cd46123540766Be93DFE6D43130D7': usdc() }), // OP Sepolia
    80002: Object.freeze({ '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582': usdc() }), // Polygon Amoy
  }),
  stellar: Object.freeze({
    [STELLAR_MAINNET_PASSPHRASE]: Object.freeze({
      [`USDC:${CIRCLE_STELLAR_ISSUERS.public.USDC}`]: PUB_USDC,
      [`EURC:${CIRCLE_STELLAR_ISSUERS.public.EURC}`]: PUB_EURC,
      CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75: stellarContract(PUB_USDC),
      CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV: stellarContract(PUB_EURC),
      CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA: XLM,
    }),
    [STELLAR_TESTNET]: Object.freeze({
      [`USDC:${CIRCLE_STELLAR_ISSUERS.testnet.USDC}`]: TEST_USDC,
      [`EURC:${CIRCLE_STELLAR_ISSUERS.testnet.EURC}`]: TEST_EURC,
      CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA: stellarContract(TEST_USDC),
      CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ: stellarContract(TEST_EURC),
      CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC: XLM,
    }),
  }),
  near: Object.freeze({
    mainnet: Object.freeze({
      // Circle lists the account; Circle states no NEAR decimals, NEAR's SDK lists 6 (as on every chain but Stellar).
      '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': usdc([CIRCLE_USDC, CIRCLE_DECIMALS, NEAR_API_JS_TOKENS]),
      'wrap.near': Object.freeze({ symbol: 'wNEAR', name: 'Wrapped NEAR', decimals: 24, kind: 'token', sources: [WNEAR_README], read: READ }),
    }),
    testnet: Object.freeze({
      '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af': usdc([CIRCLE_USDC, CIRCLE_DECIMALS, NEAR_API_JS_TOKENS]),
      // Not in the README (mainnet only): NEAR's own SDK lists it, with the same contract and decimals.
      'wrap.testnet': Object.freeze({ symbol: 'wNEAR', name: 'Wrapped NEAR', decimals: 24, kind: 'token', sources: [NEAR_API_JS_TOKENS, WNEAR_README], read: READ }),
    }),
  }),
}) as KnownTokenList;

/**
 * The entry for exactly this id on exactly this network, or null. EVM addresses match in any letter case (one
 * address); Stellar and NEAR ids match exactly. `list` is for tests.
 */
export function knownToken(net: TokenNetwork, id: string, list: KnownTokenList = KNOWN_TOKENS): KnownTokenEntry | null {
  let table: Readonly<Record<string, KnownTokenEntry>> | undefined;
  if (net.kind === 'evm') table = Object.hasOwn(list.evm, net.chainId) ? list.evm[net.chainId] : undefined;
  else if (net.kind === 'stellar') table = Object.hasOwn(list.stellar, net.networkPassphrase) ? list.stellar[net.networkPassphrase] : undefined;
  else table = Object.hasOwn(list.near, net.network) ? list.near[net.network] : undefined;
  if (!table) return null;
  if (net.kind === 'evm') {
    const a = id.toLowerCase();
    for (const [k, v] of Object.entries(table)) if (k.toLowerCase() === a) return v;
    return null;
  }
  return Object.hasOwn(table, id) ? (table[id] as KnownTokenEntry) : null;
}

/** Characters people read as others in a code: each to the letter it imitates. */
const CONFUSABLE: Readonly<Record<string, string>> = Object.freeze({ '0': 'O', '1': 'I', L: 'I', '5': 'S', '8': 'B', '2': 'Z' });

/**
 * A code's shape for comparing: upper case, trailing digits dropped, each confusable character (0, 1, l, 5, 8, 2) read
 * as the letter it imitates. "usdc", "USDC2", "U5DC" and "USDC" have one shape; "USDCX" and "XUSDC" don't share it.
 */
export const codeShape = (code: string): string =>
  Array.from(code.toUpperCase().replace(/[0-9]+$/u, ''), (ch) => CONFUSABLE[ch] ?? ch).join('');

/**
 * The listed token symbol a code on this network imitates, or null: an exact listed symbol, or one with the same
 * shape (codeShape). Only for Stellar, whose asset code is part of the asset's identity in the request; the caller
 * asks only for an asset that isn't itself listed, so a listed asset never gets here.
 */
export function imitatedSymbolOn(net: TokenNetwork, code: string, list: KnownTokenList = KNOWN_TOKENS): string | null {
  const table = net.kind === 'stellar' && Object.hasOwn(list.stellar, net.networkPassphrase) ? list.stellar[net.networkPassphrase] : undefined;
  if (!table) return null;
  const shape = codeShape(code);
  if (shape === '') return null;
  for (const t of Object.values(table)) if (t.kind === 'token' && codeShape(t.symbol) === shape) return t.symbol;
  return null;
}
