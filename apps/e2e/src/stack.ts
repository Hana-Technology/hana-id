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

export const ENV_NAME = 'local-e2e';

/** The default HANA_E2E_PORT_BASE. */
export const DEFAULT_PORT_BASE = 4410;

/**
 * The first of the stack's ports, from HANA_E2E_PORT_BASE (default 4410); the stack uses base … base + 50. Give each
 * worktree that runs the suite at the same time its own base (4410, 4510, …). Playwright passes its environment to
 * the webServer, so the build, the servers and the tests all see the same value.
 */
export function portBase(value: string | undefined = process.env.HANA_E2E_PORT_BASE): number {
  if (value === undefined || value.trim() === '') return DEFAULT_PORT_BASE;
  const n = Number(value);
  if (!/^\d+$/u.test(value.trim()) || !Number.isSafeInteger(n) || n < 1024 || n + 50 > 65535) {
    throw new Error(`HANA_E2E_PORT_BASE must be an integer from 1024 to 65485 (the stack uses base … base + 50), not ${JSON.stringify(value)}`);
  }
  const blocked = Object.values(portsFrom(n)).filter((p) => BROWSER_BLOCKED_PORTS.has(p));
  if (blocked.length) {
    throw new Error(`HANA_E2E_PORT_BASE ${n} puts the stack on port ${blocked.join(', ')}, which browsers refuse to connect to (the Fetch standard's bad ports): pick another base`);
  }
  return n;
}

/**
 * The Fetch standard's "bad ports" at or above 1024 (https://fetch.spec.whatwg.org/#port-blocking): every browser
 * refuses requests to them, so a stack port there fails its tests (base 5010 puts the EVM RPC on 5060, SIP).
 */
export const BROWSER_BLOCKED_PORTS: ReadonlySet<number> = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

/** The stack's ports for `base`. */
export function portsFrom(base: number) {
  return Object.freeze({
    partner: base,
    /**
     * A second partner site, neither localhost nor the Hana pages' 127.0.0.1: the storage-partitioning case, where
     * two partner sites are each cross-site to the vault. A `*.localhost` name (browsers resolve it to loopback and
     * treat it as potentially trustworthy) rather than [::1]: CSP source expressions have no IPv6 form, so no
     * browser lets a [::1] page embed the vault through its frame-ancestors.
     */
    siteB: base + 1,
    /** The hosted demo (apps/demo), served by its own Worker handler over its e2e build. */
    demo: base + 2,
    vault: base + 10,
    /** Live mode's vault, auth and API hosts (LIVE_ENV): reached only through the test's routes from https origins. */
    liveVault: base + 11,
    auth: base + 20,
    liveAuth: base + 21,
    api: base + 30,
    liveApi: base + 31,
    /** The email issuer (apps/email-issuer's Worker), on its own origin as on sandbox-dev (D230). */
    issuer: base + 32,
    near: base + 40,
    /**
     * A second NEAR RPC on the same mocked chain: the env's `rpcFallback`, the independent provider a member's path is
     * confirmed on (D263).
     */
    nearFallback: base + 41,
    evm: base + 50,
  });
}

/**
 * The ports of this run. They are fixed for a run: the bundles inline the origins, so they can't change between the
 * build and the tests.
 */
export const PORTS = portsFrom(portBase());

export const PARTNER_ORIGIN = `http://localhost:${PORTS.partner}`;
export const SITE_B_ORIGIN = `http://site-b.localhost:${PORTS.siteB}`;
export const DEMO_ORIGIN = `http://localhost:${PORTS.demo}`;
export const VAULT_ORIGIN = `http://127.0.0.1:${PORTS.vault}`;
export const AUTH_ORIGIN = `http://127.0.0.1:${PORTS.auth}`;
export const API_URL = `http://127.0.0.1:${PORTS.api}`;
export const ISSUER_URL = `http://127.0.0.1:${PORTS.issuer}`;
/** The email tokens' iss (`{emailIssuer.url}/v1/email`, D230). */
export const EMAIL_ISS = `${ISSUER_URL}/v1/email`;
export const NEAR_RPC = `http://127.0.0.1:${PORTS.near}`;
export const NEAR_RPC_FALLBACK = `http://127.0.0.1:${PORTS.nearFallback}`;
export const EVM_RPC = `http://127.0.0.1:${PORTS.evm}`;
/** A foreign site, served by Playwright routes only (see tests/fixtures.ts): it never runs Hana code. */
export const EVIL_ORIGIN = 'http://evil.e2e.test';

/** The mocked EVM chain (anvil's id). */
export const EVM_CHAIN_ID = 31337;

/**
 * The test MPC's master secret. Test-only and public on purpose: the e2e env pins its public key, so the mock MPC can
 * answer CKD requests that pass the vault's pairing check. It is a small constant so no scanner mistakes it for a key.
 */
export const TEST_MPC_MSK = 0x5eed_e2e0_0000_0001n;

const G2 = bls.G2.ProjectivePoint;

export const TEST_CKD_NETWORK_KEY = `bls12381g2:${base58.encode(G2.BASE.multiply(TEST_MPC_MSK).toRawBytes(true))}`;

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
 * The demo's app key. The demo bakes its key in at build time, as the hosted one does, so its e2e app has this fixed
 * key (POST /__e2e/apps with `publishableKey` creates it once and returns it after that). Public, like every pk.
 */
export const DEMO_PK = 'pk_test_DemoE2eDemoE2eDemoE2e';

/** Where src/build.ts writes the bundles, and the servers read them. */
export const BUILD_DIR = new URL('../.build/', import.meta.url);
