// identity-key.ts <env> <init [--local] | put | next | switch | retire | show | kms-init | kms-add | kms-switch |
//                        kms-retire | kms-put-aws-key> [--yes]
//
// The partner identity token's keys. Testnet: the Worker secrets (IDENTITY_SIGNING_KEY, IDENTITY_SIGNING_KEY_STANDBY,
// IDENTITY_SUB_KEY), generated here, kept in .secrets/<env>/identity-* (0600, never overwritten), the public keys
// written to envs/<env>.json, set on the API Worker through wrangler's stdin (lib/identity-key.ts). AWS KMS (staging
// and mainnet): the keys' ARNs and public keys into the manifest, the sub key, and the signer's AWS access key on the
// Worker (lib/identity-kms.ts). Never prints a private key or a credential.
import { run } from './lib/cli.ts';
import { IDENTITY_KEY_USAGE, defaultIdentityKeyDeps, identityKey } from './lib/identity-key.ts';

run(async () => identityKey(process.argv.slice(2), defaultIdentityKeyDeps()), IDENTITY_KEY_USAGE);
