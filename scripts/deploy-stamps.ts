// deploy-stamps.ts <env> [--yes] [--lock] [--wasm path] [--skip-build]
//
// Deploys the Journear Passport stamps demo contract contracts/hana-stamps to the env's near.demoStamps account (D796):
// the code and new() in one transaction. Prints the plan first and changes nothing without --yes; re-running plans
// only what is missing. The account must exist and be funded; its full-access key is read from the near CLI legacy
// keychain (~/.near-credentials/testnet/<account>.json). --lock deletes every access key on the account afterwards.
// The logic is deploy-guestbook's (lib/demo-deploy.ts); this contract's settings are in lib/stamps-deploy.ts.
import { run } from './lib/cli.ts';
import { STAMPS_USAGE, stampsMain } from './lib/stamps-deploy.ts';

run(async () => {
  const code = await stampsMain(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}, STAMPS_USAGE);
