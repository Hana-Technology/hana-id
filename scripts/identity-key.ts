// identity-key.ts <env> <init [--local] | put | show> [--yes]
//
// The partner identity token's Worker secrets (IDENTITY_SIGNING_KEY, IDENTITY_SIGNING_KEY_STANDBY, IDENTITY_SUB_KEY):
// generated here, kept in .secrets/<env>/identity-* (0600, never overwritten), the public keys written to
// envs/<env>.json, and set on the API Worker through wrangler's stdin. Never prints a private key. See
// lib/identity-key.ts.
import { run } from './lib/cli.ts';
import { IDENTITY_KEY_USAGE, defaultIdentityKeyDeps, identityKey } from './lib/identity-key.ts';

run(async () => identityKey(process.argv.slice(2), defaultIdentityKeyDeps()), IDENTITY_KEY_USAGE);
