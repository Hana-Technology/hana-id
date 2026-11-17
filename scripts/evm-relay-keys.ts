// evm-relay-keys.ts <env> [--show-address]
//
// The EVM sponsorship relayer's key (the API's EVM_RELAY_KEYS, D834, D849): one fresh secp256k1 key generated into
// .secrets/<env>/evm-relay-keys.json (0600, never overwritten, never where git would track it); prints only its
// address and the user's next steps. --show-address prints an existing file's address. See lib/evm-relay-keys.ts.
import { run } from './lib/cli.ts';
import { EVM_RELAY_KEYS_USAGE, evmRelayKeys } from './lib/evm-relay-keys.ts';

run(async () => {
  await evmRelayKeys(process.argv.slice(2));
}, EVM_RELAY_KEYS_USAGE);
