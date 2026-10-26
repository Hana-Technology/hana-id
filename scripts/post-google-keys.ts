// post-google-keys.ts <env> [--dry-run] [--as-owner]
//
// One-off Google JWKS sync (same logic as the API's hourly cron): compares Google's published RS256 keys with
// get_issuer("google") and calls set_issuer_key / remove_issuer_key for the difference. Signs with the keys-updater
// function-call key from .secrets/<env>/keys-updater.json, or with the owner's full-access key (--as-owner).
import { loadEnv } from '@hana-id/env';
import { actionCreators } from '@near-js/transactions';
import { CliError, parseCli, run } from './lib/cli.ts';
import { GOOGLE_PROVIDER, normaliseIssuer, tryView } from './lib/contract.ts';
import { diffJwks, fetchGoogleJwks } from './lib/jwks.ts';
import { loadLegacyCredential, readKeysUpdater } from './lib/keys.ts';
import { explorerTx, NearRpc, TGAS } from './lib/near.ts';

const USAGE = `Usage: post-google-keys.ts <env> [--dry-run] [--as-owner]
  --dry-run    print the diff only
  --as-owner   sign with the owner's key (~/.near-credentials) instead of .secrets/<env>/keys-updater.json`;

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2), { booleans: ['dry-run', 'as-owner', 'help'] });
  if (args.flag('help')) return void console.log(USAGE);
  const envName = args.positionals[0];
  if (!envName || args.positionals.length > 1) throw new CliError('Expected exactly one <env>');
  const m = loadEnv(envName);
  const rpc = new NearRpc(m.rpc);
  if ((await rpc.chainId()) !== 'testnet') throw new Error(`${m.rpc} is not a testnet RPC`);

  const raw = await tryView<unknown>(rpc, m.signer, 'get_issuer', { provider: GOOGLE_PROVIDER });
  const issuer = normaliseIssuer(raw);
  if (!issuer) throw new Error(`${m.signer} has no "${GOOGLE_PROVIDER}" issuer (run deploy-contract.ts first)`);
  const diff = diffJwks(issuer.kids, await fetchGoogleJwks());

  console.log(`On chain: ${issuer.kids.length ? issuer.kids.join(', ') : '(none)'}`);
  for (const k of diff.set) console.log(`  + set_issuer_key ${k.kid}`);
  for (const kid of diff.remove) console.log(`  - remove_issuer_key ${kid}`);
  if (!diff.set.length && !diff.remove.length) return void console.log('In sync.');
  if (args.flag('dry-run')) return void console.log('Dry run: nothing changed.');

  let signer;
  if (args.flag('as-owner')) {
    signer = loadLegacyCredential(m.owner, m.network);
  } else {
    signer = readKeysUpdater(m.name);
    if (!signer) throw new Error(`No .secrets/${m.name}/keys-updater.json (deploy-contract.ts creates it); or pass --as-owner`);
    if (signer.accountId !== m.signer) throw new Error(`keys-updater.json is for ${signer.accountId}, not ${m.signer}`);
  }
  const tx = { accountId: signer.accountId, keyPair: signer.keyPair };
  // Add new keys before removing old ones so a token signed by either verifies throughout.
  for (const k of diff.set) {
    const { hash } = await rpc.sendTx(tx, m.signer, [actionCreators.functionCall('set_issuer_key', { provider: GOOGLE_PROVIDER, kid: k.kid, n: k.n, e: k.e }, 50n * TGAS, 0n)]);
    console.log(`  set ${k.kid}: ${explorerTx(hash)}`);
  }
  for (const kid of diff.remove) {
    const { hash } = await rpc.sendTx(tx, m.signer, [actionCreators.functionCall('remove_issuer_key', { provider: GOOGLE_PROVIDER, kid }, 30n * TGAS, 0n)]);
    console.log(`  removed ${kid}: ${explorerTx(hash)}`);
  }
  console.log('Done.');
}

run(main, USAGE);
