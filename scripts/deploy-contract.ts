// deploy-contract.ts <env> [--yes] [--relayer-keys N] [--relayer-allowance NEAR] [--updater-allowance NEAR]
//                              [--upgrade] [--wasm path] [--skip-build]
//
// Deploys hana-signer for one environment. Prints the plan first and changes nothing without --yes. Re-running
// plans only what is missing. Accounts must already exist and be funded; their full-access keys are read from the
// near CLI legacy keychain (~/.near-credentials/testnet/<account>.json). Generated keys go to .secrets/<env>/.
// The logic lives in lib/deploy-run.ts (run against a stub RPC in test/deploy-run.test.ts).
import { run } from './lib/cli.ts';
import { DEPLOY_USAGE, deployMain } from './lib/deploy-run.ts';

run(async () => {
  const code = await deployMain(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}, DEPLOY_USAGE);
