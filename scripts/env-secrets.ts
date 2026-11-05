// env-secrets.ts <env> [--worker api|issuer|watchdog|console|admin|files] [--yes]
//
// Every Worker secret of an env and its source file in .secrets/<env>/; with --yes, uploads them all through
// wrangler's stdin (moving an env to another Cloudflare account, D404). Never prints a value. See lib/env-secrets.ts.
import { run } from './lib/cli.ts';
import { ENV_SECRETS_USAGE, defaultEnvSecretsDeps, envSecrets } from './lib/env-secrets.ts';

run(async () => envSecrets(process.argv.slice(2), defaultEnvSecretsDeps()), ENV_SECRETS_USAGE);
