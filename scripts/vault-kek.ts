// vault-kek.ts <env> <init | put | rotate> [--yes]
//
// The API's VAULT_KEK: generated here, kept in .secrets/<env>/vault-kek (0600, never overwritten) and set as a Worker
// secret through wrangler's stdin, so a rotation always has the current value for VAULT_KEK_PREVIOUS. Never prints a
// key. See lib/vault-kek.ts.
import { run } from './lib/cli.ts';
import { VAULT_KEK_USAGE, defaultVaultKekDeps, vaultKek } from './lib/vault-kek.ts';

run(async () => vaultKek(process.argv.slice(2), defaultVaultKekDeps()), VAULT_KEK_USAGE);
