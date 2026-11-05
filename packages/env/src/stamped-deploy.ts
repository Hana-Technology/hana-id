// The one deploy wrapper of every Worker (D384, D406): `wrangler deploy <args…> --var HANA_BUILD:<build id>` from the
// current directory, the build id being this checkout's (./local-build.ts). Each app's `deploy` script runs it from
// its own directory (`tsx ../../packages/env/src/stamped-deploy.ts [args…]`): the API (and `deploy:pages`, with
// `-c wrangler.vault.jsonc` / `-c wrangler.auth.jsonc`), the email issuer, the console (after `vite build`),
// console-auth, files, admin and the watchdog. A raw `wrangler deploy` leaves the Worker unstamped, which
// `deploy-check <env>` fails. Exits with wrangler's status.
import { stampedDeploy } from './local-build.ts';

process.exitCode = stampedDeploy(process.argv.slice(2));
