// The local stack the Playwright suite runs against (docs/batch-b-spec.md "Tests → Playwright"): the partner on
// http://localhost, a second partner site on http://site-b.localhost, the vault and auth origins on http://127.0.0.1
// (a `local` env, so both partner sites are cross-site to Hana, as in production), apps/api's own Worker for the Hana
// API (with /v1/login and /v1/derive mocked), a mocked NEAR RPC and EVM chain RPC, and a test MPC whose network key is
// pinned in the bundles. Live mode (below) adds a second env for pk_live_ apps, on https origins the tests route.
//
// The envs live here, not in envs/: a manifest there would put a loopback (or routed-only) env into every build's
// HANA_ENVS (the list the published partner client accepts). The bundles are built for them by src/build.ts with the
// real per-env build scripts of @hana-id/web, so each is pinned exactly as a deployed env's constants are.
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { base58 } from '@scure/base';
import type { HanaEnv } from '@hana-id/web';
import { DEMO_CHECK_IN, DEMO_CHECK_IN_CALLDATA } from '@hana-id/core';
import { SPONSOR_DELEGATES } from '@hana-id/core/evm-sponsor';
import { portBase, portsFrom } from './ports.ts';

export const ENV_NAME = 'local-e2e';

export { BROWSER_BLOCKED_PORTS, DEFAULT_PORT_BASE, portBase, portsFrom } from './ports.ts';

/**
 * The ports of this run. They are fixed for a run: the bundles inline the origins, so they can't change between the
 * build and the tests.
 */
export const PORTS = portsFrom(portBase());

export const PARTNER_ORIGIN = `http://localhost:${PORTS.partner}`;
export const SITE_B_ORIGIN = `http://site-b.localhost:${PORTS.siteB}`;
export const DEMO_ORIGIN = `http://localhost:${PORTS.demo}`;
/** The stamps site (apps/stamps). */
export const STAMPS_ORIGIN = `http://localhost:${PORTS.stamps}`;
export const VAULT_ORIGIN = `http://127.0.0.1:${PORTS.vault}`;
export const AUTH_ORIGIN = `http://127.0.0.1:${PORTS.auth}`;
export const API_URL = `http://127.0.0.1:${PORTS.api}`;
export const ISSUER_URL = `http://127.0.0.1:${PORTS.issuer}`;
/** The email tokens' iss (`{emailIssuer.url}/v1/email`, D230). */
export const EMAIL_ISS = `${ISSUER_URL}/v1/email`;
export const NEAR_RPC = `http://127.0.0.1:${PORTS.near}`;
export const NEAR_RPC_FALLBACK = `http://127.0.0.1:${PORTS.nearFallback}`;
export const EVM_RPC = `http://127.0.0.1:${PORTS.evm}`;

/**
 * The staff admin portal's lanes (src/server/admin-lane.ts): `demo` for a person's hand test, one per browser project
 * for the suite. Each is apps/admin's Worker on its own origin, with its own relayer.
 */
export const ADMIN_LANES = Object.freeze({
  demo: `http://127.0.0.1:${PORTS.admin}`,
  chromium: `http://127.0.0.1:${PORTS.adminChromium}`,
  firefox: `http://127.0.0.1:${PORTS.adminFirefox}`,
  webkit: `http://127.0.0.1:${PORTS.adminWebkit}`,
});
export type AdminLaneName = keyof typeof ADMIN_LANES;
/** A foreign site, served by Playwright routes only (see tests/fixtures.ts): it never runs Hana code. */
export const EVIL_ORIGIN = 'http://evil.e2e.test';

/** The mocked EVM chain (anvil's id). */
export const EVM_CHAIN_ID = 31337;

/** Core's pinned delegate on the mocked chain (its deterministic local deployment, D834). */
export const E2E_SPONSOR_DELEGATE = (SPONSOR_DELEGATES[EVM_CHAIN_ID] as { address: string }).address;

/**
 * Gas sponsorship on the mocked chain (HanaEnv.evmSponsor, D834): core's pinned local delegate, the stack's relayer
 * (src/relayer-key.ts: a key made at the first run, kept in .build/; build.ts puts its address into the bundles) and
 * the mocked EVM RPC, ONE endpoint (only a local* env may have one: the vault reads the account's setup itself, D855).
 */
export const e2eEvmSponsor = (relayer: string): NonNullable<HanaEnv['evmSponsor']> =>
  Object.freeze({ [String(EVM_CHAIN_ID)]: Object.freeze({ delegate: E2E_SPONSOR_DELEGATE, relayer, rpc: EVM_RPC }) });

/** Journear's demo check-in on the mocked chain: core's pin (D854), never a copy of its address. */
export const E2E_CHECK_IN = (DEMO_CHECK_IN[EVM_CHAIN_ID] as { address: string }).address;

/** The CheckIn demo (contracts/evm-delegate) and the two made-up contracts the sponsorship tests call. */
export const E2E_SPONSOR_TARGETS = Object.freeze([
  { address: E2E_CHECK_IN, selectors: [DEMO_CHECK_IN_CALLDATA], maxDataBytes: 4, label: 'Check-in' },
  { address: '0x4444444444444444444444444444444444444444', selectors: ['0x183ff085'], maxDataBytes: 4, label: 'Unknown' },
  { address: '0x1111111111111111111111111111111111111111', selectors: ['0xa9059cbb', '0x095ea7b3'], maxDataBytes: 68, label: 'Token' },
]);

/**
 * The hosted demo's app (DEMO_PK) on the stack's allowlist: Journear's demo check-in only, and only its exact call data
 * (`exactCalldata`, D835: no trailing bytes), as a deployed env would list the demo app for the gas-free card (D867).
 */
export const E2E_DEMO_SPONSOR_TARGETS = Object.freeze([{ address: E2E_CHECK_IN, selectors: [DEMO_CHECK_IN_CALLDATA], exactCalldata: [DEMO_CHECK_IN_CALLDATA], maxDataBytes: 4, label: 'Demo check-in' }]);

/**
 * The API's EVM_SPONSOR (D836) for the mocked chain in this local env, sponsoring `appIds` (the API answers each
 * request with its own app's var: a manifest lists at most 8 apps) for `targets`. Wide limits: the suite's browsers
 * share one relayer.
 */
export const e2eEvmSponsorVar = (relayer: string, appIds: readonly string[] = [], targets: readonly object[] = E2E_SPONSOR_TARGETS): string =>
  JSON.stringify({
    relayerAddress: relayer,
    chains: {
      [String(EVM_CHAIN_ID)]: {
        rpc: EVM_RPC,
        delegate: E2E_SPONSOR_DELEGATE,
        opStack: false,
        maxGasPerTx: 300_000,
        maxFeePerGasGwei: 10,
        maxPriorityFeePerGasGwei: 1,
        maxCallsPerBatch: 4,
        deadlineMaxS: 300,
        minGas: 100_000,
        dailyBudgetEth: 1,
        appDailyBudgetEth: 0.5,
        lowBalanceEth: 0.01,
        perUserPerDay: 1000,
        perAppPerDay: 50_000,
        sendsPerDay: 100_000,
        sendsPerMinute: 10_000,
        // local* only (D836): the wallet proof of the session (D856) ties the account to the user.
        requireKnownAccount: false,
      },
    },
    apps: Object.fromEntries(appIds.map((id) => [id, { [String(EVM_CHAIN_ID)]: targets }])),
  });

/**
 * The test MPC's master secret. Test-only and public on purpose: the e2e env pins its public key, so the mock MPC can
 * answer CKD requests that pass the vault's pairing check. It is a small constant so no scanner mistakes it for a key.
 */
export const TEST_MPC_MSK = 0x5eed_e2e0_0000_0001n;

const G2 = bls.G2.ProjectivePoint;

export const TEST_CKD_NETWORK_KEY = `bls12381g2:${base58.encode(G2.BASE.multiply(TEST_MPC_MSK).toRawBytes(true))}`;

/** The demo guestbook's account on the mocked testnet (the demo's `near.guestbook`, src/server/chain.ts). */
export const E2E_GUESTBOOK = 'e2e-guestbook.testnet';

/** The stamps contract's account on the mocked testnet (the site's `near.stamps`, src/server/stamps-contract.ts). */
export const E2E_STAMPS = 'e2e-stamps.testnet';

export const E2E_ENV: HanaEnv = Object.freeze({
  name: ENV_NAME,
  network: 'testnet',
  apiUrl: API_URL,
  vaultOrigin: VAULT_ORIGIN,
  authOrigin: AUTH_ORIGIN,
  signer: 'e2e-signer.testnet',
  relayer: 'e2e-relayer.testnet',
  rpc: NEAR_RPC,
  rpcFallback: NEAR_RPC_FALLBACK,
  ckdNetworkKey: TEST_CKD_NETWORK_KEY,
  devEnv: true,
  emailIssuerUrl: ISSUER_URL,
  emailIss: EMAIL_ISS,
  // Journear's reviewed NEAR contracts (D885) on the mocked testnet: the stack's models of the two contracts
  // (src/server/stamps-contract.ts, src/server/chain.ts, held against the real wasm, D805), as a reviewed env's build
  // carries its manifest's locked accounts. Live mode's env inherits them.
  nearReviewed: Object.freeze({ stamps: E2E_STAMPS, guestbook: E2E_GUESTBOOK }),
});

// ---- live mode: a pk_live_ app end to end ----
//
// Every env allows loopback partner origins only for pk_test_ keys (apps/api origins.ts, the vault's parentAllowed),
// so a live app needs a partner page on a real-looking origin, and that page must be https: the SDK and the vault need
// a secure context, which an http page on a non-loopback host isn't. An https page can't embed or call the stack's
// http://127.0.0.1 Hana origins (WebKit blocks it as mixed content, Chromium as local network access), so live mode
// has a second env, LIVE_ENV, whose every origin is https on a `.test` name (reserved, RFC 2606). Nothing resolves
// those names: each test's browser context routes them (tests/fixtures.ts, LIVE_UPSTREAMS) to the stack's servers,
// as a TLS-terminating front would. The Hana hosts behind them are apps/api's own (vault page, auth pages, Worker) on
// the same D1 and mocked chain, configured with LIVE_ENV's origins; the bundles are built for LIVE_ENV by the same
// per-env build scripts. So a live app goes through the production rules unchanged: no env rule is relaxed, and no
// production env or manifest is touched.

export const LIVE_ENV_NAME = 'local-e2e-live';

/** The partner test app in live mode (the same page as PARTNER_ORIGIN, with `?env=local-e2e-live`). */
export const LIVE_PARTNER_ORIGIN = 'https://partner.e2e-live.test';
export const LIVE_VAULT_ORIGIN = 'https://vault.e2e-hana.test';
export const LIVE_AUTH_ORIGIN = 'https://auth.e2e-hana-auth.test';
export const LIVE_API_URL = 'https://api.e2e-hana.test';
export const LIVE_NEAR_RPC = 'https://rpc.e2e-near.test';
export const LIVE_EVM_RPC = 'https://rpc.e2e-evm.test';

/** Where each live origin is served: the routes in tests/fixtures.ts forward to these. */
export const LIVE_UPSTREAMS: Readonly<Record<string, string>> = Object.freeze({
  [LIVE_PARTNER_ORIGIN]: PARTNER_ORIGIN,
  [LIVE_VAULT_ORIGIN]: `http://127.0.0.1:${PORTS.liveVault}`,
  [LIVE_AUTH_ORIGIN]: `http://127.0.0.1:${PORTS.liveAuth}`,
  [LIVE_API_URL]: `http://127.0.0.1:${PORTS.liveApi}`,
  [LIVE_NEAR_RPC]: NEAR_RPC,
  [LIVE_EVM_RPC]: EVM_RPC,
});

/**
 * An env's constants without the email issuer and the second RPC: live mode runs no issuer, so no link, and its pages
 * (https) couldn't reach the stack's http fallback anyway.
 */
function withoutEmail(e: HanaEnv): HanaEnv {
  const { emailIssuerUrl: _u, emailIss: _i, rpcFallback: _f, ...rest } = e;
  return rest;
}

/** The live-mode env: E2E_ENV's chain accounts and test MPC, with the https origins above. */
export const LIVE_ENV: HanaEnv = Object.freeze({
  ...withoutEmail(E2E_ENV),
  name: LIVE_ENV_NAME,
  apiUrl: LIVE_API_URL,
  vaultOrigin: LIVE_VAULT_ORIGIN,
  authOrigin: LIVE_AUTH_ORIGIN,
  rpc: LIVE_NEAR_RPC,
});

/**
 * The scope of the stack's live apps. A pk_test_ app on a scope a pk_live_ app uses is refused (`scope_conflict`,
 * D51), so live apps never use the test apps' scope (`e2e`). Scope ids are `[a-z0-9]{1,64}` (@hana-id/core isScopeId).
 */
export const LIVE_SCOPE_ID = 'e2elive';

/** The scope's shared Google client (any string: the OIDC stub accepts any client id the API hands out). */
export const GOOGLE_CLIENT_ID = 'e2e-shared.apps.googleusercontent.com';
/**
 * Hana Home's exit Google client (D484), on the mocked chain's exit list beside the email exit `("email", "hana-home")`
 * (H6, as on sandbox-dev). The Google stub lets it answer only to `{authOrigin}/home/callback` (D491).
 */
export const EXIT_CLIENT_ID = 'e2e-exit.apps.googleusercontent.com';

/**
 * The demo's app key. The demo bakes its key in at build time, as the hosted one does, so its e2e app has this fixed
 * key (POST /__e2e/apps with `publishableKey` creates it once and returns it after that). Public, like every pk.
 */
export const DEMO_PK = 'pk_test_DemoE2eDemoE2eDemoE2e';

/** The stamps site's app key, baked in at build time as the deployed site's is (POST /__e2e/apps creates it once). */
export const STAMPS_PK = 'pk_test_StampsE2eStampsE2eStamps';

/** Where src/build.ts writes the bundles, and the servers read them. */
export const BUILD_DIR = new URL('../.build/', import.meta.url);
