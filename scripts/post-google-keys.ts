// post-google-keys.ts <env> [--dry-run] [--execute]
//
// One-off Google JWKS sync (the same rules as the API's cron), signed with the keys-updater function-call key from
// .secrets/<env>/keys-updater.json. On the governance contract it proposes new kids and removals (they activate when
// a watchdog confirms them or after issuer_key_delay_ms) and, with --execute, executes due changes; on a v1 contract
// it sets and removes keys directly. The owner path (--as-owner) is gone: owner posts wait the same delay (D86).
// The logic lives in lib/google-keys.ts (tested against a stub RPC in test/google-keys.test.ts).
import { run } from './lib/cli.ts';
import { POST_KEYS_USAGE, postGoogleKeysMain } from './lib/google-keys.ts';
import { NearRpc } from './lib/near.ts';

run(() => postGoogleKeysMain(process.argv.slice(2), { rpc: (url) => new NearRpc(url), log: (line) => console.log(line) }), POST_KEYS_USAGE);
