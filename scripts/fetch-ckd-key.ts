// fetch-ckd-key.ts <env> [--rpc <https url>]... [--dry-run]
//
// Reads the MPC network's CKD public key (BLS12-381 G2, `bls12381g2:<base58>`) for manifest.ckdDomainId from the
// MPC contract's `state` view at one final block, from at least three independent RPC providers that must all agree,
// and pins it with that block in envs/<env>.json (ckdNetworkKey, ckdNetworkKeySource). Public data, safe to print.
// See lib/ckd.ts.
import { loadEnv } from '@hana-id/env';
import { run } from './lib/cli.ts';
import { FETCH_CKD_KEY_USAGE, defaultFetchCkdKeyDeps, fetchCkdKey } from './lib/ckd.ts';

run(async () => fetchCkdKey(process.argv.slice(2), defaultFetchCkdKeyDeps(loadEnv)), FETCH_CKD_KEY_USAGE);
