// Fixed test inputs: a manifest shaped like sandbox-dev's (pinned here, so a change to envs/ never changes a test) with
// the stamps contract set through the fixture (`near.demoStamps`: the contract build adds the field to the schema on
// its branch; until then the real schema doesn't know it, so it is added after parsing), and the configuration it gives.
import { type Manifest, manifestSchema } from '@hana-id/env';
import { type StampsConfig, stampsConfigFromVars } from '../src/config.ts';

export const STAMPS = 'hana-id-stamps-dev1.testnet';
export const PK = 'pk_test_StampsTestStampsTest1';

const BASE = manifestSchema.parse({
  name: 'sandbox-dev',
  network: 'testnet',
  signer: 'signer.test.near',
  relayer: 'relayer.test.near',
  owner: 'owner.test.near',
  mpc: 'mpc.test.near',
  ckdDomainId: 2,
  ckdNetworkKey: 'UNSET',
  rpc: 'https://rpc.test.invalid',
  rpcFallback: 'https://rpc.other.invalid',
  apiUrl: 'https://hana-id-api-sandbox-dev.tingtc.workers.dev',
  vaultOrigin: 'https://hana-id-vault-sandbox-dev.tingtc.workers.dev',
  authOrigin: 'https://hana-id-auth-sandbox-dev.tingtc.workers.dev',
  changeDelayMs: 60_000,
  appChangeDelayMs: 60_000,
  googleClientIds: [],
  sharedGoogleClientIds: [],
  consoleAudiences: [],
  cloudflare: { workerName: 'hana-id-api-sandbox-dev', d1Name: 'hana-id-sandbox-dev' },
  near: { demoGuestbook: 'hana-id-guestbook-dev1.testnet', relay: { account: 'hana-id-near-relay-dev1.testnet', receivers: ['hana-id-guestbook-dev1.testnet'], maxGasTgas: 10 } },
});

/** `m` with `near.demoStamps` set (or removed with undefined), as the contract build's schema will allow. */
export function withStamps(m: Manifest, demoStamps: unknown): Manifest {
  const near = { ...m.near } as Record<string, unknown>;
  if (demoStamps === undefined) delete near.demoStamps;
  else near.demoStamps = demoStamps;
  return Object.assign({}, m, { near: near as Manifest['near'] });
}

export const MANIFEST: Manifest = withStamps(BASE, STAMPS);

/** A manifest variant, validated by the real schema, with the stamps contract kept. */
export const variant = (patch: Partial<Manifest>): Manifest => withStamps(manifestSchema.parse({ ...BASE, ...patch }), STAMPS);

export const CONFIG: StampsConfig = stampsConfigFromVars({ HANA_STAMPS_PUBLISHABLE_KEY: PK }, () => MANIFEST);

/** The NEAR implicit account of a fixed test key (public). */
export const NEAR_ACCOUNT = '6e5e4e30c4f2b48f6a3a5c1f1c5d3b2a9e8f7d6c5b4a39281706f5e4d3c2b1a0';
export const OTHER_ACCOUNT = 'a'.repeat(64);

/** A session's addresses: the Stellar and EVM ones exist in the SDK, and the site must never show them. */
export const ADDRESSES = { stellar: 'GAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSH7S', evm: '0x8ba1f109551bD432803012645Ac136ddd64DBA72', near: NEAR_ACCOUNT };
