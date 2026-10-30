// Fixed test inputs: a manifest shaped like sandbox-dev's (pinned here, so a change to envs/ never changes a test) and
// the configuration it gives.
import { type Manifest, manifestSchema } from '@hana-id/env';
import { type DemoConfig, demoConfigFromVars } from '../src/config.ts';

export const MANIFEST: Manifest = manifestSchema.parse({
  name: 'sandbox-dev',
  network: 'testnet',
  signer: 'signer.test.near',
  relayer: 'relayer.test.near',
  owner: 'owner.test.near',
  mpc: 'mpc.test.near',
  ckdDomainId: 2,
  ckdNetworkKey: 'UNSET',
  rpc: 'https://rpc.test.invalid',
  apiUrl: 'https://hana-id-api-sandbox-dev.tingtc.workers.dev',
  vaultOrigin: 'https://hana-id-vault-sandbox-dev.tingtc.workers.dev',
  authOrigin: 'https://hana-id-auth-sandbox-dev.tingtc.workers.dev',
  changeDelayMs: 60_000,
  appChangeDelayMs: 60_000,
  googleClientIds: [],
  sharedGoogleClientIds: [],
  consoleAudiences: [],
  cloudflare: { workerName: 'hana-id-api-sandbox-dev', d1Name: 'hana-id-sandbox-dev' },
});

/** A manifest variant, validated by the real schema. */
export const variant = (patch: Partial<Manifest>): Manifest => manifestSchema.parse({ ...MANIFEST, ...patch });

export const CONFIG: DemoConfig = demoConfigFromVars({}, () => MANIFEST);

export const ADDRESSES = { stellar: 'GAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSH7S', evm: '0x8ba1f109551bD432803012645Ac136ddd64DBA72' };
