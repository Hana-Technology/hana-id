// The stamps site's build-time configuration: which env and app it runs as, and the NEAR testnet it reads and writes.
// Resolved once, by vite.config.ts (baked into the bundle as __HANA_STAMPS_CONFIG__) and by scripts/gen-wrangler.ts
// (the Worker's CSP), from the same shell variables:
//
//   HANA_STAMPS_ENV               envs/<name>.json, default sandbox-dev (testnet sandbox*/local* envs only)
//   HANA_STAMPS_PUBLISHABLE_KEY   the stamps app's pk_test_ key: required (no default; the e2e stack builds with its own)
//
// Everything here is public: publishable keys ship in partner pages, and the origins are in the manifest. This module
// runs in the browser too, so it takes the manifest as data (loading it needs Node). NEAR only: the site configures no
// other chain (D798).
import { isNearAccountId, isPublishableKey, isTestPublishableKey } from '@hana-id/core';
import { webOrigin } from '../../demo/src/config.ts';

export { webOrigin };

export const DEFAULT_ENV = 'sandbox-dev';

/** NEAR testnet's explorer (NearBlocks): `<explorer>/address/<id>`, `<explorer>/txns/<hash>`. */
export const NEAR_TESTNET_EXPLORER = 'https://testnet.nearblocks.io';
/**
 * A public NEAR testnet faucet, linked from "Own fare" while the account holds too little NEAR for the fee: the NEAR
 * docs' own (D807), which funds a 64-hex implicit account (5 NEAR, no sign-up). near-faucet.io, linked before, takes
 * only `*.testnet` names and EVM addresses, so it refused every Journear Passport account.
 */
export const NEAR_TESTNET_FAUCET = 'https://docs.near.org/getting-started/faucet';
/** Gas on a `collect` call when the manifest sets no relay cap: sandbox-dev's cap (`near.relay.maxGasTgas`, 10). */
export const DEFAULT_COLLECT_TGAS = 10;

export interface StampsNear {
  /** Manifest `rpc`: the page reads the passport, the user's access key, the latest block and the balance here. */
  rpcUrl: string;
  /** Manifest `rpcFallback`, read when `rpcUrl` fails; null when the env has none. */
  rpcFallbackUrl: string | null;
  /** Manifest `near.demoStamps` (contracts/hana-stamps): the contract every stamp is collected on. */
  stamps: string;
  /** Gas on each `collect` (Tgas): the manifest's relay cap `near.relay.maxGasTgas`, else DEFAULT_COLLECT_TGAS. */
  collectTgas: number;
  /** NearBlocks-style base URL, or null for none (the e2e stack). */
  explorer: string | null;
  /** A testnet faucet's page, or null for none. */
  faucet: string | null;
}

export interface StampsConfig {
  /** The env (`createHana({ environment })`). */
  environment: string;
  publishableKey: string;
  /** The env's vaultOrigin: the only frame-src of the page's CSP. */
  vaultOrigin: string;
  /** The env's API (manifest `apiUrl`): `hana.near.relay` and `hana.near.activate` call it from this page. */
  apiUrl: string;
  near: StampsNear;
}

/**
 * The manifest fields the site needs: a structural slice of @hana-id/env's Manifest. `near.demoStamps` is read
 * defensively (the contract build adds it to the schema): any value that isn't a `.testnet` account id is refused.
 */
export interface ManifestSlice {
  name: string;
  network: string;
  vaultOrigin?: string | undefined;
  apiUrl: string;
  rpc: string;
  rpcFallback?: string | undefined;
  near?: { demoStamps?: unknown; relay?: { maxGasTgas?: number | undefined; receivers?: readonly string[] | undefined } | undefined } | undefined;
}

/** Testnet dev envs only (@hana-id/env's isDevEnv): the site is a hackathon demo, never on a production env. */
export const isDevEnvName = (name: string): boolean => /^(local|sandbox)/u.test(name);

/** Checks a configuration and returns it frozen. Throws with every problem it finds. */
export function validateStampsConfig(c: StampsConfig): StampsConfig {
  const problems: string[] = [];
  const check = (f: () => void) => {
    try {
      f();
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
  };
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(c.environment)) problems.push(`environment ${JSON.stringify(c.environment)} is not an env name`);
  else if (!isDevEnvName(c.environment)) problems.push(`environment ${c.environment} is not a testnet sandbox*/local* env: the stamps site runs on those only`);
  if (!isPublishableKey(c.publishableKey)) problems.push('publishableKey is not a publishable key (pk_test_…)');
  // A live key would put real funds behind a testnet demo: refused outright.
  else if (!isTestPublishableKey(c.publishableKey)) problems.push('publishableKey must be a pk_test_ key: the stamps site is for NEAR testnet only');
  check(() => {
    if (webOrigin(c.vaultOrigin, 'vaultOrigin') !== c.vaultOrigin) throw new Error(`vaultOrigin must be an origin (no path): ${c.vaultOrigin}`);
  });
  check(() => webOrigin(c.apiUrl, 'apiUrl'));
  check(() => webOrigin(c.near.rpcUrl, 'near.rpcUrl'));
  if (c.near.rpcFallbackUrl !== null) check(() => webOrigin(c.near.rpcFallbackUrl!, 'near.rpcFallbackUrl'));
  if (c.near.explorer !== null) check(() => webOrigin(c.near.explorer!, 'near.explorer'));
  if (c.near.faucet !== null) check(() => webOrigin(c.near.faucet!, 'near.faucet'));
  // A testnet contract only: the site never writes to a mainnet account.
  if (!isNearAccountId(c.near.stamps) || !c.near.stamps.endsWith('.testnet')) problems.push(`near.stamps ${JSON.stringify(c.near.stamps)} is not a .testnet account`);
  if (!Number.isSafeInteger(c.near.collectTgas) || c.near.collectTgas < 1 || c.near.collectTgas > 300) problems.push(`near.collectTgas ${c.near.collectTgas} is not 1 to 300 Tgas`);
  if (problems.length) throw new Error(`Invalid stamps configuration:\n- ${problems.join('\n- ')}`);
  return Object.freeze({ ...c, near: Object.freeze({ ...c.near }) });
}

export type StampsVars = Readonly<Record<string, string | undefined>>;

/** The env name HANA_STAMPS_ENV selects (default sandbox-dev). */
export const stampsEnvName = (vars: StampsVars): string => vars.HANA_STAMPS_ENV?.trim() || DEFAULT_ENV;

/** The stamps contract of a manifest (`near.demoStamps`), or a clear refusal. */
export function stampsContractOf(m: ManifestSlice): string {
  const v = m.near?.demoStamps;
  if (v === undefined || v === null || v === '') {
    throw new Error(`envs/${m.name}.json sets no near.demoStamps: there is no stamps contract to collect on (deploy contracts/hana-stamps and add it to the manifest first)`);
  }
  if (typeof v !== 'string' || !isNearAccountId(v) || !v.endsWith('.testnet')) throw new Error(`envs/${m.name}.json near.demoStamps ${JSON.stringify(v)} is not a .testnet account`);
  return v;
}

/** The configuration for HANA_STAMPS_ENV / HANA_STAMPS_PUBLISHABLE_KEY, with `loadManifest` reading envs/<name>.json. */
export function stampsConfigFromVars(vars: StampsVars, loadManifest: (name: string) => ManifestSlice): StampsConfig {
  const environment = stampsEnvName(vars);
  const pk = vars.HANA_STAMPS_PUBLISHABLE_KEY?.trim();
  if (!pk) throw new Error(`HANA_STAMPS_PUBLISHABLE_KEY is required: the stamps app's pk_test_ key on ${environment} (apps/stamps/README.md "Deploy")`);
  if (!isDevEnvName(environment)) throw new Error(`The stamps site is for testnet sandbox*/local* envs only, not ${environment}`);
  const m = loadManifest(environment);
  if (m.name !== environment) throw new Error(`envs/${environment}.json is named ${m.name}`);
  if (m.network !== 'testnet') throw new Error(`envs/${environment}.json is not a testnet env`);
  if (!m.vaultOrigin) throw new Error(`envs/${environment}.json sets no vaultOrigin: there is no vault to sign in with`);
  const stamps = stampsContractOf(m);
  const cap = m.near?.relay?.maxGasTgas;
  return validateStampsConfig({
    environment,
    publishableKey: pk,
    vaultOrigin: m.vaultOrigin,
    apiUrl: m.apiUrl,
    near: {
      rpcUrl: m.rpc,
      rpcFallbackUrl: m.rpcFallback ?? null,
      stamps,
      collectTgas: typeof cap === 'number' ? cap : DEFAULT_COLLECT_TGAS,
      explorer: NEAR_TESTNET_EXPLORER,
      faucet: NEAR_TESTNET_FAUCET,
    },
  });
}
