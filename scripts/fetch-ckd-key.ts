// fetch-ckd-key.ts <env> [--dry-run]
//
// Reads the MPC network's CKD public key (BLS12-381 G2, `bls12381g2:<base58>`) for manifest.ckdDomainId from the
// MPC contract's `state` view and pins it in envs/<env>.json (ckdNetworkKey). Public data, safe to print.
import { readFileSync, writeFileSync } from 'node:fs';
import { loadEnv, manifestPath } from '@hana-id/env';
import { CliError, parseCli, run } from './lib/cli.ts';
import { setManifestString } from './lib/manifest-edit.ts';
import { ckdKeyFromState, type MpcState } from './lib/ckd.ts';
import { NearRpc } from './lib/near.ts';

const USAGE = 'Usage: fetch-ckd-key.ts <env> [--dry-run]';

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2), { booleans: ['dry-run', 'help'] });
  if (args.flag('help')) return void console.log(USAGE);
  const envName = args.positionals[0];
  if (!envName || args.positionals.length > 1) throw new CliError('Expected exactly one <env>');
  const m = loadEnv(envName);
  const rpc = new NearRpc(m.rpc);
  if ((await rpc.chainId()) !== 'testnet') throw new Error(`${m.rpc} is not a testnet RPC`);

  const key = ckdKeyFromState(await rpc.view<MpcState>(m.mpc, 'state', {}), m.ckdDomainId);
  console.log(`${m.mpc} CKD domain ${m.ckdDomainId}: ${key}`);
  if (m.ckdNetworkKey === key) return void console.log(`envs/${m.name}.json already has it.`);
  if (args.flag('dry-run')) return void console.log('Dry run: manifest not changed.');
  const file = manifestPath(m.name);
  writeFileSync(file, setManifestString(readFileSync(file, 'utf8'), 'ckdNetworkKey', key));
  console.log(`Wrote ckdNetworkKey to envs/${m.name}.json${m.ckdNetworkKey.startsWith('UNSET') ? '' : ` (was ${m.ckdNetworkKey}: the MPC key changed, every pinned client must update)`}.`);
}

run(main, USAGE);
