// deploy-contract.ts <env> [--yes] [--relayer-keys N] [--relayer-allowance NEAR] [--owner-relayer-keys N]
//                              [--owner-relayer-allowance NEAR] [--upgrade] [--wasm path] [--skip-build]
//                              [--transfer-owner] [--member <m>] [--approve-with <m>]
// deploy-contract.ts <env> --creation-plan [--wasm path] [--updater-public-key pk] [--creation-public-key pk]
//
// Deploys and configures hana-signer for one environment. Prints the plan first and changes nothing without --yes.
// Re-running plans only what is missing. Accounts must already exist and be funded; their full-access keys are read
// from the near CLI legacy keychain (~/.near-credentials/testnet/<account>.json). Generated keys go to .secrets/<env>/.
// Governance (docs/governance-spec.md): a v1 contract is refused (no migrate_v1 since contract v3, D154); a v2
// contract changes code only through propose_upgrade → execute_upgrade; owner steps go through the owner account or
// the council DAO (lib/owner-tx.ts). --creation-plan only prints the mainnet-style creation batch.
// The logic lives in lib/deploy-run.ts (run against stub and simulated chains in test/deploy-run.test.ts and
// test/governance-run.test.ts).
import { run } from './lib/cli.ts';
import { DEPLOY_USAGE, deployMain } from './lib/deploy-run.ts';

run(async () => {
  const code = await deployMain(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}, DEPLOY_USAGE);
