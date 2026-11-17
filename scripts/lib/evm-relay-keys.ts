// The EVM sponsorship relayer's key (D834, D849): one fresh secp256k1 key from the platform CSPRNG, written once into
// .secrets/<env>/evm-relay-keys.json (0600, directory 0700) for the API's EVM_RELAY_KEYS secret, in exactly the shape
// the API's gen reads (apps/api/scripts/gen-wrangler.ts `evmRelayKeysLine`): a JSON array of one `0x` + 64 lowercase
// hex key. It never overwrites the file (it is the only copy of the key) and refuses a path git would track. It prints
// only the key's address and the user's next steps; `--show-address` prints an existing file's address. Testnet only.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Manifest, checksumEvmAddress, loadEnv, repoRoot } from '@hana-id/env';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { CliError, parseCli } from './cli.ts';
import { SECRET_FILES, assertPrivate, parseSecretJson, secretsDir, writeSecretJson } from './secrets.ts';

export const EVM_RELAY_KEYS_USAGE = `usage: evm-relay-keys <env> [--show-address]

  Generates the EVM sponsorship relayer's key (one secp256k1 key) into .secrets/<env>/evm-relay-keys.json (0600) and
  prints its address and the next steps. Refuses to overwrite the file. Never prints the key.
  --show-address  print the address of the existing file's key (and whether envs/<env>.json names it)`;

const KEY_RE = /^0x[0-9a-f]{64}$/u;

/** The EIP-55 address of a 32-byte secp256k1 key. */
export function evmKeyAddress(key: Uint8Array): string {
  return checksumEvmAddress(`0x${bytesToHex(keccak_256(secp256k1.getPublicKey(key, false).subarray(1)).subarray(-20))}`);
}

/** A fresh key: 32 bytes from the platform CSPRNG, drawn again in the (negligible) case it is not a valid scalar. */
export function freshEvmKey(random: (n: number) => Uint8Array = (n) => randomBytes(n)): Uint8Array {
  for (let i = 0; i < 16; i++) {
    const k = random(32);
    if (k.length === 32 && secp256k1.utils.isValidPrivateKey(k)) return k;
  }
  throw new Error('The random source gave no valid secp256k1 key in 16 draws: it is broken');
}

/**
 * Reads .secrets/<env>/evm-relay-keys.json (0600 enforced) in gen's shape. Returns the key's address and the secret's
 * value (`JSON.stringify([key])`, what EVM_RELAY_KEYS holds); errors name the file, never the key.
 */
export function readEvmRelayKeys(file: string, shown: string = file): { address: string; value: string } {
  assertPrivate(file);
  const keys = parseSecretJson<unknown>(readFileSync(file, 'utf8'), shown);
  if (!Array.isArray(keys) || keys.length !== 1 || typeof keys[0] !== 'string' || !KEY_RE.test(keys[0])) {
    throw new Error(`${shown} must be a JSON array of one 0x + 64 lowercase hex secp256k1 private key`);
  }
  const bytes = hexToBytes(keys[0].slice(2));
  if (!secp256k1.utils.isValidPrivateKey(bytes)) throw new Error(`${shown}: the key is not a valid secp256k1 private key`);
  return { address: evmKeyAddress(bytes), value: JSON.stringify([keys[0]]) };
}

/** Whether git would track `file`: it is inside a work tree and neither ignored nor already tracked. */
export function gitWouldTrack(file: string): boolean {
  let cwd = dirname(file);
  while (!existsSync(cwd) && dirname(cwd) !== cwd) cwd = dirname(cwd);
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8' });
  if (inside.error) throw new Error(`git could not run (${inside.error.message}): can't tell whether the key file would be committed`);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return false;
  // check-ignore exits 0 for an ignored path and 1 for one that isn't (a tracked path counts as not ignored).
  const ignored = spawnSync('git', ['check-ignore', '-q', file], { cwd });
  return ignored.status !== 0;
}

export interface EvmRelayKeysDeps {
  root?: string;
  loadManifest?: (name: string) => Manifest;
  log?: (line: string) => void;
  random?: (n: number) => Uint8Array;
  gitWouldTrack?: (file: string) => boolean;
}

/** Runs `evm-relay-keys <argv>`. Returns the relayer's address. */
export async function evmRelayKeys(argv: readonly string[], deps: EvmRelayKeysDeps = {}): Promise<string> {
  const args = parseCli(argv, { booleans: ['show-address'] });
  const [envName] = args.positionals;
  if (!envName || args.positionals.length !== 1) throw new CliError('one <env> is required');
  const m = (deps.loadManifest ?? loadEnv)(envName);
  const log = deps.log ?? ((l: string) => console.log(l));
  if (m.network !== 'testnet') throw new Error('EVM sponsorship is testnet only');
  const file = join(secretsDir(m.name, deps.root ?? repoRoot), SECRET_FILES.evmRelayKeys);
  const shown = `.secrets/${m.name}/${SECRET_FILES.evmRelayKeys}`;
  const named = m.evm?.sponsor?.relayerAddress;

  if (args.flag('show-address')) {
    if (!existsSync(file)) throw new Error(`${shown} doesn't exist: run evm-relay-keys ${m.name} to make it`);
    const { address } = readEvmRelayKeys(file, shown);
    log(`${shown}: the relayer's address is ${address}`);
    if (named === undefined) log(`envs/${m.name}.json has no evm.sponsor yet: put this address in its relayerAddress`);
    else if (named === address) log(`envs/${m.name}.json evm.sponsor.relayerAddress names it`);
    else throw new Error(`envs/${m.name}.json evm.sponsor.relayerAddress is ${named}, not this key's ${address}: gen refuses the pair. Fix the manifest, or restore the key that matches`);
    return address;
  }

  if (existsSync(file)) {
    throw new Error(`${shown} already exists: refusing to overwrite it (it is the only copy of the relayer's key). Its address: evm-relay-keys ${m.name} --show-address`);
  }
  if ((deps.gitWouldTrack ?? gitWouldTrack)(file)) {
    throw new Error(`${shown} is not ignored by git here: refusing to write a key where it could be committed (.secrets/ must be in .gitignore)`);
  }
  const key = freshEvmKey(deps.random);
  writeSecretJson(file, [`0x${bytesToHex(key)}`]);
  key.fill(0);
  // Read back through the same check the API's gen and env-secrets apply.
  const { address } = readEvmRelayKeys(file, shown);
  log(`Wrote ${shown} (0600). The relayer's address: ${address}`);
  log('Next (docs/operations.md "EVM sponsorship relay (not live)"):');
  log(`  1. Put it in envs/${m.name}.json as evm.sponsor.relayerAddress${named !== undefined ? ` (it names ${named} now: replace it)` : ''}.`);
  log('  2. Fund it with test ETH from a faucet for the chain (Base Sepolia: about 0.1 ETH; never a mainnet transfer).');
  log(`  3. After \`corepack pnpm --filter @hana-id/api gen ${m.name}\`, upload the secret (from the repo root):`);
  log(`     node -e 'process.stdout.write(JSON.stringify(require("./${shown}")))' | corepack pnpm --dir apps/api exec wrangler secret put EVM_RELAY_KEYS`);
  log('  Back the file up offline with the other .secrets files; it is never printed, and a lost key means a new relayer address.');
  return address;
}
