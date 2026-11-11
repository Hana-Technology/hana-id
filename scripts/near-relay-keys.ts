// near-relay-keys.ts <env> [--count N]
//
// The NEAR meta-transaction relay's full-access keys (the API's NEAR_RELAY_KEYS, D734): generated into
// .secrets/<env>/near-relay-keys.json (0600, never overwritten); prints the public keys and the user's commands.
// Never prints a secret key. See lib/near-relay-keys.ts.
import { run } from './lib/cli.ts';
import { NEAR_RELAY_KEYS_USAGE, nearRelayKeys } from './lib/near-relay-keys.ts';

run(async () => {
  await nearRelayKeys(process.argv.slice(2));
}, NEAR_RELAY_KEYS_USAGE);
