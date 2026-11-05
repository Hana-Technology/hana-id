// deploy-check.ts <env> [--only <groups>] [--skip <groups>] [--d1] [--skip-head] [--strict]
//
// After a deploy: do the env's Workers (the API, page Workers, email issuer, console, console-auth, files, admin and,
// with `--only watchdog`, the watchdog) and the page bundles they serve all run this checkout's commit, and (--d1) are
// this checkout's D1 migrations all applied? Exits 1 if not (D384, D406). Holds no secret. See lib/deploy-check.ts and
// docs/operations.md "Checking a deploy".
import { run } from './lib/cli.ts';
import { DEPLOY_CHECK_USAGE, deployCheck } from './lib/deploy-check.ts';

run(async () => {
  process.exitCode = await deployCheck(process.argv.slice(2));
}, DEPLOY_CHECK_USAGE);
