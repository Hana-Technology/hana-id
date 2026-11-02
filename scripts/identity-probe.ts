// identity-probe.ts [<env>…]
//
// The outside probe of the partner identity token's JWKS and discovery document (D210): run by
// .github/workflows/identity-probe.yml every 15 min from outside Cloudflare; exits 1 on any finding. Holds no secret.
// See lib/identity-probe.ts.
import { run } from './lib/cli.ts';
import { IDENTITY_PROBE_USAGE, identityProbe } from './lib/identity-probe.ts';

run(async () => {
  process.exitCode = await identityProbe(process.argv.slice(2), { log: (line) => console.log(line) });
}, IDENTITY_PROBE_USAGE);
