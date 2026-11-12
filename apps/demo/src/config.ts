// The demo's build-time configuration: which Hana env and app it runs as, and the test networks it signs for. It is
// resolved once, by vite.config.ts (baked into the bundle as __HANA_DEMO_CONFIG__) and by scripts/gen-wrangler.ts
// (the Worker's CSP), from the same shell variables:
//
//   HANA_DEMO_ENV               envs/<name>.json, default sandbox-dev
//   HANA_DEMO_PUBLISHABLE_KEY   the app's pk_test_ key; default: the Smoke B app's key, for sandbox-dev only
//
// Everything here is public: publishable keys ship in partner pages, and the origins are in the manifest. This module
// runs in the browser too, so it takes the manifest as data (loading it needs Node).
import { STELLAR_MAINNET_PASSPHRASE, TEST_EVM_CHAINS, isNearAccountId, isPublishableKey, isTestEvmChain, isTestPublishableKey } from '@hana-id/core';

export const DEFAULT_ENV = 'sandbox-dev';

/**
 * The Smoke B app on sandbox-dev (shared Google client). Public, like every publishable key; the app's origins are what
 * protect it, so the demo's origin must be one of them (README "Deploy").
 */
export const DEFAULT_PUBLISHABLE_KEY = 'pk_test_85gdPtFF4kYzqgPisccZbsT9fQP1tq7ie';

export const STELLAR_TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

export interface DemoEvmChain {
  /** A chain in @hana-id/core's TEST_EVM_CHAINS (a test app can sign for no other). */
  id: number;
  name: string;
  /** The chain's JSON-RPC: the SDK forwards read-only calls there, so it is the CSP's connect-src. */
  rpcUrl: string;
  /** Block explorer base URL (`<explorer>/address/<0x…>`), or null for none. */
  explorer: string | null;
}

export interface DemoConfig {
  /** The Hana env (`createHana({ environment })`). */
  environment: string;
  publishableKey: string;
  /** The env's vaultOrigin: the only frame-src of the page's CSP. */
  vaultOrigin: string;
  evm: DemoEvmChain;
  stellar: {
    networkPassphrase: string;
    /** StellarExpert-style base URL (`<explorer>/account/<G…>`), or null for none. */
    explorer: string | null;
  };
  /** The env's Hana API (manifest `apiUrl`): `hana.near.relay` and `hana.near.activate` call it from this page. */
  apiUrl: string;
  near: DemoNear;
}

/** NEAR testnet, as the manifest names it (the env's own RPCs and the demo guestbook's account). */
export interface DemoNear {
  /** Manifest `rpc`: the page reads the user's access key, the latest block and the guestbook here. */
  rpcUrl: string;
  /** Manifest `rpcFallback`, read when `rpcUrl` fails; null when the env has none. */
  rpcFallbackUrl: string | null;
  /** Manifest `near.demoGuestbook` (contracts/hana-guestbook), or null: no guestbook on this env. */
  guestbook: string | null;
  /** NearBlocks-style base URL (`<explorer>/address/<id>`, `<explorer>/txns/<hash>`), or null for none. */
  explorer: string | null;
}

/** Base Sepolia: a testnet with a public RPC; the demo only signs on it, never broadcasts. */
export const DEFAULT_EVM: DemoEvmChain = Object.freeze({
  id: 84532,
  name: 'Base Sepolia',
  rpcUrl: 'https://sepolia.base.org',
  explorer: 'https://sepolia.basescan.org',
});

export const DEFAULT_STELLAR: DemoConfig['stellar'] = Object.freeze({
  networkPassphrase: STELLAR_TESTNET_PASSPHRASE,
  explorer: 'https://stellar.expert/explorer/testnet',
});

/** NEAR testnet's explorer (the RPCs and the guestbook come from the manifest). */
export const NEAR_TESTNET_EXPLORER = 'https://testnet.nearblocks.io';

/** The manifest fields the demo needs (a structural slice of @hana-id/env's Manifest). */
export interface ManifestSlice {
  name: string;
  network: string;
  vaultOrigin?: string | undefined;
  apiUrl: string;
  rpc: string;
  rpcFallback?: string | undefined;
  near?: { demoGuestbook?: string | undefined } | undefined;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** `value`'s origin when it is https (or http on a loopback host, for local stacks); throws otherwise. */
export function webOrigin(value: string, what: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${what} must be a URL, not ${JSON.stringify(value)}`);
  }
  const ok = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!ok || url.username || url.password) throw new Error(`${what} must be https (or http on localhost): ${JSON.stringify(value)}`);
  return url.origin;
}

/** Checks a configuration and returns it frozen. Throws with every problem it finds. */
export function validateDemoConfig(c: DemoConfig): DemoConfig {
  const problems: string[] = [];
  const check = (f: () => void) => {
    try {
      f();
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
  };
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(c.environment)) problems.push(`environment ${JSON.stringify(c.environment)} is not an env name`);
  if (!isPublishableKey(c.publishableKey)) problems.push('publishableKey is not a publishable key (pk_test_…)');
  // A live key would put real funds behind a testnet demo: refused outright.
  else if (!isTestPublishableKey(c.publishableKey)) problems.push('publishableKey must be a pk_test_ key: the demo is for test networks only');
  check(() => {
    if (webOrigin(c.vaultOrigin, 'vaultOrigin') !== c.vaultOrigin) throw new Error(`vaultOrigin must be an origin (no path): ${c.vaultOrigin}`);
  });
  if (!isTestEvmChain(c.evm.id)) problems.push(`EVM chain ${c.evm.id} is not a test chain Hana signs for (${Object.values(TEST_EVM_CHAINS).join(', ')})`);
  if (!c.evm.name.trim()) problems.push('evm.name is empty');
  check(() => webOrigin(c.evm.rpcUrl, 'evm.rpcUrl'));
  if (c.evm.explorer !== null) check(() => webOrigin(c.evm.explorer!, 'evm.explorer'));
  if (c.stellar.networkPassphrase === STELLAR_MAINNET_PASSPHRASE) problems.push('stellar.networkPassphrase must not be the public network');
  if (c.stellar.explorer !== null) check(() => webOrigin(c.stellar.explorer!, 'stellar.explorer'));
  check(() => webOrigin(c.apiUrl, 'apiUrl'));
  check(() => webOrigin(c.near.rpcUrl, 'near.rpcUrl'));
  if (c.near.rpcFallbackUrl !== null) check(() => webOrigin(c.near.rpcFallbackUrl!, 'near.rpcFallbackUrl'));
  if (c.near.explorer !== null) check(() => webOrigin(c.near.explorer!, 'near.explorer'));
  // A testnet guestbook only (the manifest's rule too): the demo never writes to a mainnet account.
  if (c.near.guestbook !== null && (!isNearAccountId(c.near.guestbook) || !c.near.guestbook.endsWith('.testnet'))) problems.push(`near.guestbook ${JSON.stringify(c.near.guestbook)} is not a .testnet account`);
  if (problems.length) throw new Error(`Invalid demo configuration:\n- ${problems.join('\n- ')}`);
  return Object.freeze({ ...c, evm: Object.freeze({ ...c.evm }), stellar: Object.freeze({ ...c.stellar }), near: Object.freeze({ ...c.near }) });
}

export type DemoVars = Readonly<Record<string, string | undefined>>;

/** The env name HANA_DEMO_ENV selects (default sandbox-dev). */
export const demoEnvName = (vars: DemoVars): string => vars.HANA_DEMO_ENV?.trim() || DEFAULT_ENV;

/** The configuration for HANA_DEMO_ENV / HANA_DEMO_PUBLISHABLE_KEY, with `loadManifest` reading envs/<name>.json. */
export function demoConfigFromVars(vars: DemoVars, loadManifest: (name: string) => ManifestSlice): DemoConfig {
  const environment = demoEnvName(vars);
  const pk = vars.HANA_DEMO_PUBLISHABLE_KEY?.trim();
  // The default key is an app of sandbox-dev's: another env needs its own.
  if (!pk && environment !== DEFAULT_ENV) throw new Error(`HANA_DEMO_PUBLISHABLE_KEY is required for env ${environment} (the default key is ${DEFAULT_ENV}'s)`);
  const m = loadManifest(environment);
  if (m.name !== environment) throw new Error(`envs/${environment}.json is named ${m.name}`);
  if (m.network !== 'testnet') throw new Error(`envs/${environment}.json is not a testnet env`);
  if (!m.vaultOrigin) throw new Error(`envs/${environment}.json sets no vaultOrigin: there is no vault to demo`);
  return validateDemoConfig({
    environment,
    publishableKey: pk || DEFAULT_PUBLISHABLE_KEY,
    vaultOrigin: m.vaultOrigin,
    evm: DEFAULT_EVM,
    stellar: DEFAULT_STELLAR,
    apiUrl: m.apiUrl,
    near: { rpcUrl: m.rpc, rpcFallbackUrl: m.rpcFallback ?? null, guestbook: m.near?.demoGuestbook ?? null, explorer: NEAR_TESTNET_EXPLORER },
  });
}
