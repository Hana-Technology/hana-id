// The local stack the Playwright suite runs against (docs/batch-b-spec.md "Tests → Playwright"): the partner on
// http://localhost, a second partner site on http://site-b.localhost, the vault and auth origins on http://127.0.0.1
// (a `local` env, so both partner sites are cross-site to Hana, as in production), apps/api's own Worker for the Hana
// API (with /v1/login and /v1/derive mocked), a mocked NEAR RPC and EVM chain RPC, and a test MPC whose network key is
// pinned in the bundles.
//
// The env lives here, not in envs/: a manifest there would put a loopback env into every build's HANA_ENVS (the list
// the published partner client accepts). The bundles are built for it by src/build.ts with the real per-env build
// scripts of @hana-id/web, so it is pinned exactly as a deployed env's constants are.
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
  return n;
}

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
    vault: base + 10,
    auth: base + 20,
    api: base + 30,
    near: base + 40,
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
export const VAULT_ORIGIN = `http://127.0.0.1:${PORTS.vault}`;
export const AUTH_ORIGIN = `http://127.0.0.1:${PORTS.auth}`;
export const API_URL = `http://127.0.0.1:${PORTS.api}`;
export const NEAR_RPC = `http://127.0.0.1:${PORTS.near}`;
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
  ckdNetworkKey: TEST_CKD_NETWORK_KEY,
  devEnv: true,
});

/** The scope's shared Google client (any string: the OIDC stub accepts any client id the API hands out). */
export const GOOGLE_CLIENT_ID = 'e2e-shared.apps.googleusercontent.com';

/** Where src/build.ts writes the bundles, and the servers read them. */
export const BUILD_DIR = new URL('../.build/', import.meta.url);
