// coop-canary.ts <env> [--headers-only]
//
// The manual pre-release check of D347's assumption (D386): Google's sign-in pages must not enforce
// Cross-Origin-Opener-Policy, or the vault's popup-close watch cancels logins while the user is still at Google.
// Run before each release (docs/operations.md "Before each release: the COOP canary"). Holds no secret; prints no
// cookie, query value or fragment. See lib/coop-canary.ts.
import { run } from './lib/cli.ts';
import { COOP_CANARY_USAGE, coopCanary } from './lib/coop-canary.ts';

run(async () => {
  process.exitCode = await coopCanary(process.argv.slice(2), { log: (line) => console.log(line) });
}, COOP_CANARY_USAGE);
