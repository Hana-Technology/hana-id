// council-setup.ts <env> [--yes] [--funder <account>] [--member-balance NEAR]
//
// Dev envs on testnet only: creates the env's owner council (D81), three throwaway member accounts with keys in
// .secrets/<env>/council/ (0600) and a Sputnik DAO v2 from the testnet factory with contracts/sputnik/policy.json
// (2 of 3 for every proposal kind). Prints the plan; changes nothing without --yes. The logic lives in
// lib/council-setup.ts (run against a stub RPC in test/council-setup.test.ts).
import { run } from './lib/cli.ts';
import { COUNCIL_USAGE, councilSetupMain } from './lib/council-setup.ts';
import { NearRpc } from './lib/near.ts';

run(async () => {
  const code = await councilSetupMain(process.argv.slice(2), { rpc: (url) => new NearRpc(url), log: (line) => console.log(line) });
  if (code !== 0) process.exitCode = code;
}, COUNCIL_USAGE);
