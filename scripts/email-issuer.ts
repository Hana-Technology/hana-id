// email-issuer.ts <env> <init --from "<Name> <addr>" [--outbox] | put | show> [--yes]
//
// The email issuer's keys (ISSUER_SIGNING_KEY and its offline standby, K_sub, K_code, K_rl): generated here, kept in
// .secrets/<env>/email-* (0600, never overwritten), the public keys written to envs/<env>.json, and set on the issuer
// Worker through wrangler's stdin by `put`. Never prints a secret. See lib/email-issuer.ts.
import { run } from './lib/cli.ts';
import { EMAIL_ISSUER_USAGE, defaultEmailIssuerDeps, emailIssuer } from './lib/email-issuer.ts';

run(async () => emailIssuer(process.argv.slice(2), defaultEmailIssuerDeps()), EMAIL_ISSUER_USAGE);
