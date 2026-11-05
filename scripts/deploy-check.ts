// deploy-check.ts <env> [--d1] [--skip-head] [--strict]
//
// After a deploy: do the env's API, page Workers, page bundles and email issuer all run this checkout's commit, and
// (--d1) are this checkout's D1 migrations all applied? Exits 1 if not (D384). Holds no secret. See
// lib/deploy-check.ts and docs/operations.md "Checking a deploy".
import { run } from './lib/cli.ts';
import { DEPLOY_CHECK_USAGE, deployCheck } from './lib/deploy-check.ts';

run(async () => {
  process.exitCode = await deployCheck(process.argv.slice(2));
}, DEPLOY_CHECK_USAGE);
