// The NEAR meta-transaction relay's keys (D734): full-access keys of `near.relay.account`, generated here into
// .secrets/<env>/near-relay-keys.json (0600, never overwritten) for the API's NEAR_RELAY_KEYS secret. Prints only the
// public keys and the exact commands the user runs to add them on chain and upload the secret. Testnet only: the
// manifest schema allows no other network, and this refuses one anyway.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { KeyPair } from '@near-js/crypto';
import { type Manifest, loadEnv, repoRoot } from '@hana-id/env';
import { CliError, parseCli } from './cli.ts';
import { SECRET_FILES, readSecretJson, secretsDir, writeSecretJson } from './secrets.ts';

export const NEAR_RELAY_KEYS_USAGE = `usage: near-relay-keys <env> [--count N]

  Generates N (default 2, at most 8) ed25519 keys for the NEAR relay account (manifest near.relay.account) into
  .secrets/<env>/near-relay-keys.json (0600) when that file doesn't exist, then prints their public keys and the
  commands that add them as full-access keys and upload NEAR_RELAY_KEYS. Never prints a secret key.`;

export interface NearRelayKeysDeps {
  root?: string;
  loadManifest?: (name: string) => Manifest;
  log?: (line: string) => void;
}

/** Returns the public keys of the env's relay keys (generated when missing). */
export async function nearRelayKeys(argv: readonly string[], deps: NearRelayKeysDeps = {}): Promise<string[]> {
  const args = parseCli(argv, { strings: ['count'] });
  const [envName] = args.positionals;
  if (!envName || args.positionals.length !== 1) throw new CliError('one <env> is required');
  const count = args.int('count', 2, { min: 1, max: 8 });
  const m = (deps.loadManifest ?? loadEnv)(envName);
  const log = deps.log ?? ((l: string) => console.log(l));
  if (m.network !== 'testnet') throw new Error('The NEAR relay is testnet only');
  const relay = m.near?.relay;
  if (!relay) throw new Error(`envs/${envName}.json has no near.relay: add it first (docs/operations.md "NEAR relay")`);
  const file = join(secretsDir(m.name, deps.root ?? repoRoot), SECRET_FILES.nearRelayKeys);
  let secrets = readSecretJson<unknown>(file);
  const fresh = secrets === undefined && !existsSync(file);
  if (fresh) {
    secrets = Array.from({ length: count }, () => KeyPair.fromRandom('ed25519').toString());
    writeSecretJson(file, secrets);
  }
  if (!Array.isArray(secrets) || secrets.length === 0 || !secrets.every((k) => typeof k === 'string' && /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/u.test(k))) {
    throw new Error(`.secrets/${m.name}/${SECRET_FILES.nearRelayKeys} must be a non-empty JSON array of ed25519 secret keys`);
  }
  const publicKeys = (secrets as string[]).map((k) => KeyPair.fromString(k as `ed25519:${string}`).getPublicKey().toString());
  log(`${fresh ? 'Wrote' : 'Kept'} .secrets/${m.name}/${SECRET_FILES.nearRelayKeys} (${publicKeys.length} keys). Add each as a full-access key of ${relay.account}:`);
  for (const pk of publicKeys) {
    log(`  near account add-key ${relay.account} grant-full-access use-manually-provided-public-key ${pk} network-config testnet sign-with-legacy-keychain send`);
  }
  log('Then upload the secret (from the repo root, after `corepack pnpm --filter @hana-id/api gen <env>`):');
  log(`  node -e 'process.stdout.write(JSON.stringify(require("./.secrets/${m.name}/${SECRET_FILES.nearRelayKeys}")))' | corepack pnpm --dir apps/api exec wrangler secret put NEAR_RELAY_KEYS`);
  return publicKeys;
}
