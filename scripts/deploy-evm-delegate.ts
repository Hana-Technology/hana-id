// deploy-evm-delegate.ts <env> [--chain <id>] [--rpc <url>] [--yes --account <keystore>] [--verify] [--json]
//
// Deploys contracts/evm-delegate's HanaDelegateExecutor and CheckIn to a test chain (default Base Sepolia, 84532)
// through the deterministic deployment proxy, at the CREATE2 addresses their checked-in artifacts predict (D841, D849).
// Prints the plan and changes nothing without --yes; an address that already has the artifact's code is "already
// deployed, matches", other code there is a MISMATCH and a failure. `cast send` signs with the user's Foundry keystore
// (--account) and asks for its password itself: this script never handles a key. Then it prints the explorer
// verification commands (--verify runs them) and the follow-up PR's pinned-table entry and manifest block. Testnet
// only; mainnet chain ids are refused. See lib/evm-delegate-deploy.ts and docs/operations.md "EVM sponsorship relay".
import { run } from './lib/cli.ts';
import { DEPLOY_EVM_DELEGATE_USAGE, evmDeployMain } from './lib/evm-delegate-deploy.ts';

run(async () => {
  const code = await evmDeployMain(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}, DEPLOY_EVM_DELEGATE_USAGE);
