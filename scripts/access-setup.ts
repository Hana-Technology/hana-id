// access-setup.ts <env> [--yes | --check] [--write-manifest] [--account-id <id>]
//
// The admin console's Cloudflare Access application and staff policies from the manifest's `admin` block (D409),
// with the API token in .secrets/<env>/cloudflare-access-token. Dry run by default; --check reports drift and exits 1
// on any. Never prints the token or a response body. See lib/access-setup.ts and docs/operations.md "Admin Worker"
// step 1.
import { ACCESS_SETUP_USAGE, accessSetup, defaultAccessSetupDeps } from './lib/access-setup.ts';
import { run } from './lib/cli.ts';

run(() => accessSetup(process.argv.slice(2), defaultAccessSetupDeps()), ACCESS_SETUP_USAGE);
