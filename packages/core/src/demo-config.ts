// The mainnet demo's constants (D428, D429) that the API Worker and the auth host need without the rest of core (no
// imports, so `@hana-id/core/demo-config` adds nothing else to a bundle). The valuation that uses them is
// `@hana-id/core/mainnet-demo`; the partner client's chain check is networks.ts.

/**
 * The EVM mainnets a `pk_test_` app with Hana's mainnet demo on may sign for (the user, 2026-11-06: Base and Stellar
 * only): Base. Stellar's public network is the other one.
 */
export const MAINNET_DEMO_EVM_CHAINS: readonly number[] = Object.freeze([8453]);

/** The mainnet demo's per-transaction cap in USD micros, fee included: $9.99 (the user: "limit funds to <$10"). */
export const MAINNET_DEMO_TX_CAP_USD_MICROS = 9_990_000n;

/**
 * Where the approval popup reads a mainnet demo wallet's balance (D429): public endpoints Hana pins, never the
 * partner's RPC (which could say anything). Listed in `/approve`'s CSP `connect-src` in dev-env builds only.
 */
export const MAINNET_DEMO_BALANCE_ENDPOINTS = Object.freeze({
  evm: Object.freeze({ 8453: 'https://mainnet.base.org' }) as Readonly<Record<number, string>>,
  stellar: 'https://horizon.stellar.org',
});

/** The origins of MAINNET_DEMO_BALANCE_ENDPOINTS, in a fixed order. */
export const MAINNET_DEMO_BALANCE_ORIGINS: readonly string[] = Object.freeze([
  ...Object.values(MAINNET_DEMO_BALANCE_ENDPOINTS.evm).map((u) => new URL(u).origin),
  new URL(MAINNET_DEMO_BALANCE_ENDPOINTS.stellar).origin,
]);

/** Stellar's public network passphrase (networks.ts STELLAR_MAINNET_PASSPHRASE, the same string; tested). */
export const MAINNET_DEMO_STELLAR_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

/** `POST /v1/mainnet-demo/events`: the vault's report of one mainnet demo signature. */
export const MAINNET_DEMO_EVENTS_ENDPOINT = '/v1/mainnet-demo/events';
