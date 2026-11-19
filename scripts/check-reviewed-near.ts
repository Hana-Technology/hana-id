// check-reviewed-near.ts <env>
//
// Read-only (D885): are the env's reviewed NEAR contracts (core's REVIEWED_NEAR_DEPLOYS) still locked, running the
// reviewed code and no global contract, on both of the manifest's NEAR RPC endpoints? Exits 1 if not. A go-live gate
// before a pages deploy that carries reviewed calls, and before every later one (docs/operations.md "Reviewed NEAR
// calls: adding one"). See lib/reviewed-near-check.ts.
import { run } from './lib/cli.ts';
import { CHECK_REVIEWED_NEAR_USAGE, checkReviewedNearMain } from './lib/reviewed-near-check.ts';

run(async () => {
  process.exitCode = await checkReviewedNearMain(process.argv.slice(2));
}, CHECK_REVIEWED_NEAR_USAGE);
