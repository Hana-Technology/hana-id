// The one deploy wrapper of every Worker (D384, D406, D931): it resolves one wrangler config (`-c <file>`, else the
// first of wrangler.json, wrangler.jsonc, wrangler.toml in the current directory), checks it (./local-build.ts
// `stampedDeploy`: no `local*` env, no env section, nothing that would make wrangler read it differently, no refused
// environment variable; the app's migrations applied when its script passes `--require-migrations`), then runs
// `wrangler deploy -c <that file, absolute> [--dry-run] --var HANA_BUILD:<build id>`, the build id being this
// checkout's. It takes no other argument. Each app's `deploy` script runs it from its own directory: the API (and
// `deploy:pages`, with `-c wrangler.vault.jsonc` / `-c wrangler.auth.jsonc`), the email issuer, the console (after
// `vite build`), console-auth, files, admin and the watchdog. A raw `wrangler deploy` leaves the Worker unstamped, which
// `deploy-check <env>` fails. Exits with wrangler's status (1 for a refusal).
import { stampedDeploy } from './local-build.ts';

process.exitCode = stampedDeploy(process.argv.slice(2));
