// vault-kek.ts's body: the API's vault share wrapping key (VAULT_KEK, apps/api/src/vault/kek.ts), generated here,
// kept in .secrets/<env>/vault-kek (0600) and set as a Worker secret through wrangler's stdin. Cloudflare never gives a
// secret back, and a rotation needs the current value (it becomes VAULT_KEK_PREVIOUS), so the file is the only copy:
// nothing here overwrites it, and nothing prints a key.
//
//   init    generate key id 1, write vault-kek, set VAULT_KEK
//   put     set VAULT_KEK (and VAULT_KEK_PREVIOUS during a rotation) again from the files
//   rotate  current → vault-kek.previous and VAULT_KEK_PREVIOUS; a new key (id + 1) → vault-kek and VAULT_KEK
//
// Every command prints its plan and changes nothing without --yes. Dependencies (secret store, randomness, output)
// are injectable so tests run every flow against a temp directory and a fake wrangler.
import { spawnSync } from 'node:child_process';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { type Manifest, loadEnv, repoRoot } from '@hana-id/env';
import { CliError, parseCli } from './cli.ts';
import { FILE_MODE, assertPrivate, ensureSecretDir, secretsDir } from './secrets.ts';

export const VAULT_KEK_USAGE = `Usage: vault-kek.ts <env> <init | put | rotate> [--yes]
  init     generate VAULT_KEK (key id 1), write .secrets/<env>/vault-kek (0600) and set the Worker secret
  put      set VAULT_KEK from .secrets/<env>/vault-kek again (and VAULT_KEK_PREVIOUS from vault-kek.previous, if any)
  rotate   move the current key to VAULT_KEK_PREVIOUS (and vault-kek.previous), then a new key with the next id to
           VAULT_KEK (and vault-kek); re-run it to resume one that stopped part way
  --yes    do it (without it, only print the plan)

No key is ever printed. Testnet envs only. Set the secrets on a deployed Worker (cloudflare.workerName).`;

export const DRY_RUN_LINE = 'Dry run: nothing changed. Re-run with --yes to apply.';

export type KekSecret = 'VAULT_KEK' | 'VAULT_KEK_PREVIOUS';

/** File names in .secrets/<env>/. */
export const KEK_FILES = { current: 'vault-kek', previous: 'vault-kek.previous', next: 'vault-kek.next' } as const;

/** `<id>:<base64 of 32 bytes>`, as apps/api/src/vault/kek.ts parses it (id a positive integer, at most 9 digits). */
const KEK_RE = /^([1-9]\d{0,8}):([A-Za-z0-9+/]{43}=)$/u;
export const KEK_BYTES = 32;

export interface VaultKekDeps {
  /** Sets a Worker secret, the value on wrangler's stdin (never in argv, never printed). */
  putSecret: (m: Manifest, name: KekSecret, value: string) => void;
  randomBytes: (n: number) => Uint8Array;
  log: (line: string) => void;
  /** Directory holding .secrets/ (default: the repo root). */
  secretsRoot?: string;
  /** Reads envs/<name>.json (default loadEnv; tests pass a fixture). */
  loadManifest?: (name: string) => Manifest;
}

const apiDir = join(repoRoot, 'apps', 'api');

/** `pnpm exec wrangler secret put <name> --name <worker>` (run from apps/api); the value goes on stdin. */
export function wranglerSecretArgv(m: Manifest, name: KekSecret): string[] {
  return ['exec', 'wrangler', 'secret', 'put', name, '--name', m.cloudflare.workerName];
}

export function defaultVaultKekDeps(): VaultKekDeps {
  return {
    putSecret: (m, name, value) => {
      // stdin carries the value; wrangler's own output never contains it.
      const res = spawnSync('pnpm', wranglerSecretArgv(m, name), { cwd: apiDir, input: value, stdio: ['pipe', 'inherit', 'inherit'] });
      if (res.error) throw res.error;
      if (res.status !== 0) throw new Error(`wrangler secret put ${name} failed (exit ${res.status})`);
    },
    randomBytes: (n) => new Uint8Array(nodeRandomBytes(n)),
    log: (line) => console.log(line),
  };
}

/** The command that counts the shares still under a key id (to know when a rotation is done). */
export function leftUnderQuery(m: Manifest, id: number): string {
  return `wrangler d1 execute ${m.cloudflare.d1Name} --remote --command "SELECT COUNT(*) AS n FROM vault_shares WHERE kek_id = ${id}"`;
}

/** A new KEK secret value with this id. */
export function newKekValue(id: number, randomBytes: (n: number) => Uint8Array): string {
  const raw = randomBytes(KEK_BYTES);
  if (raw.length !== KEK_BYTES) throw new Error('randomBytes returned the wrong length');
  const value = `${id}:${Buffer.from(raw).toString('base64')}`;
  raw.fill(0);
  if (!KEK_RE.test(value)) throw new Error(`Key id ${id} is out of range`);
  return value;
}

/** The id of a KEK value, or null when it isn't `<id>:<base64 of 32 bytes>`. */
export function kekId(value: string): number | null {
  const m = KEK_RE.exec(value);
  return m && Buffer.from(m[2]!, 'base64').length === KEK_BYTES ? Number(m[1]) : null;
}

/** Writes a new secret file, 0600, failing if it exists (flag `wx`): a key file is never overwritten. */
export function writeNewSecretFile(file: string, value: string): void {
  const abs = resolve(file);
  if (!abs.split(sep).includes('.secrets')) throw new Error(`Refusing to write a secret outside a .secrets directory: ${relative(process.cwd(), abs)}`);
  ensureSecretDir(resolve(abs, '..'));
  writeFileSync(abs, value, { mode: FILE_MODE, flag: 'wx' });
  chmodSync(abs, FILE_MODE);
}

/** A KEK file's value and id (0600 enforced, format checked). The error names the file only. */
export function readKekFile(file: string): { value: string; id: number } {
  assertPrivate(file);
  const value = readFileSync(file, 'utf8').trim();
  const id = kekId(value);
  if (id === null) throw new Error(`${file} is not a VAULT_KEK value (<id>:<base64 of 32 bytes>)`);
  return { value, id };
}

/** Runs `vault-kek <argv>`. */
export function vaultKek(argv: readonly string[], deps: VaultKekDeps): void {
  const args = parseCli(argv, { booleans: ['yes', 'help'] });
  if (args.flag('help')) return void deps.log(VAULT_KEK_USAGE);
  const [envName, command, ...rest] = args.positionals;
  if (!envName || !command) throw new CliError('Expected <env> <init | put | rotate>');
  if (rest.length) throw new CliError(`Unexpected argument ${rest.join(' ')}`);
  if (command !== 'init' && command !== 'put' && command !== 'rotate') throw new CliError(`Unknown command ${command}`);
  const m = (deps.loadManifest ?? loadEnv)(envName);
  if (m.network !== 'testnet') throw new Error(`envs/${m.name}.json is not a testnet env`);
  const dir = secretsDir(m.name, deps.secretsRoot ?? repoRoot);
  const file = (k: keyof typeof KEK_FILES) => join(dir, KEK_FILES[k]);
  const shown = (k: keyof typeof KEK_FILES) => `.secrets/${m.name}/${KEK_FILES[k]}`;
  const worker = m.cloudflare.workerName;
  const apply = args.flag('yes');
  const put = (name: KekSecret, value: string, id: number) => {
    deps.putSecret(m, name, value);
    deps.log(`Set ${name} (key id ${id}) on Worker ${worker}.`);
  };

  if (command === 'init') {
    for (const k of ['current', 'previous', 'next'] as const) {
      if (existsSync(file(k))) {
        throw new Error(`${shown(k)} already exists: refusing to overwrite a key. Use \`put\` to set it on the Worker again, or \`rotate\` to replace it.`);
      }
    }
    deps.log(`Plan (env ${m.name}): generate VAULT_KEK key id 1, write ${shown('current')} (0600), set VAULT_KEK on Worker ${worker}.`);
    if (!apply) return void deps.log(DRY_RUN_LINE);
    const value = newKekValue(1, deps.randomBytes);
    // On disk before it goes anywhere else: the file is the only copy Cloudflare won't give back.
    writeNewSecretFile(file('current'), value);
    deps.log(`Wrote ${shown('current')} (0600, value not shown).`);
    put('VAULT_KEK', value, 1);
    return;
  }

  if (command === 'put') {
    const current = readKekFile(file('current'));
    const previous = existsSync(file('previous')) ? readKekFile(file('previous')) : null;
    if (existsSync(file('next'))) throw new Error(`${shown('next')} exists: a rotation stopped part way. Run \`rotate\` again to finish it.`);
    if (previous && previous.id === current.id) throw new Error(`${shown('previous')} has the same key id as ${shown('current')} (${current.id})`);
    deps.log(`Plan (env ${m.name}): set VAULT_KEK (key id ${current.id}) from ${shown('current')}${previous ? ` and VAULT_KEK_PREVIOUS (key id ${previous.id}) from ${shown('previous')}` : ''} on Worker ${worker}.`);
    if (!apply) return void deps.log(DRY_RUN_LINE);
    if (previous) put('VAULT_KEK_PREVIOUS', previous.value, previous.id);
    put('VAULT_KEK', current.value, current.id);
    return;
  }

  // rotate
  const current = readKekFile(file('current'));
  let next: { value: string; id: number } | null = null;
  if (existsSync(file('next'))) {
    // Resume: the files were written, the Worker secrets maybe not (or only one of them).
    next = readKekFile(file('next'));
    if (!existsSync(file('previous')) || readKekFile(file('previous')).value !== current.value) {
      throw new Error(`${shown('next')} exists but ${shown('previous')} is not a copy of ${shown('current')}: check the files by hand`);
    }
    if (next.id === current.id) throw new Error(`${shown('next')} has the current key id ${current.id}`);
    deps.log(`Resuming a rotation: key id ${current.id} → ${next.id}.`);
  } else if (existsSync(file('previous'))) {
    const previous = readKekFile(file('previous'));
    throw new Error(
      `A rotation from key id ${previous.id} is not finished (${shown('previous')} exists). Once no row is left under key id ${previous.id} ` +
        `(${leftUnderQuery(m, previous.id)} gives 0), delete the Worker secret VAULT_KEK_PREVIOUS and ${shown('previous')}, then rotate again.`,
    );
  }
  const nextId = next ? next.id : current.id + 1;
  deps.log(
    `Plan (env ${m.name}): copy ${shown('current')} (key id ${current.id}) to ${shown('previous')} and set it as VAULT_KEK_PREVIOUS; ` +
      `generate key id ${nextId}, set it as VAULT_KEK on Worker ${worker}, and make it ${shown('current')}.`,
  );
  if (!apply) return void deps.log(DRY_RUN_LINE);
  if (!next) {
    const value = newKekValue(nextId, deps.randomBytes);
    // Both files before any Worker change, so a stop at any point can be resumed (or undone) from disk.
    writeNewSecretFile(file('previous'), current.value);
    writeNewSecretFile(file('next'), value);
    next = { value, id: nextId };
    deps.log(`Wrote ${shown('previous')} and ${shown('next')} (0600, values not shown).`);
  }
  // PREVIOUS first: until VAULT_KEK changes, the Worker still unlocks every row with the current key.
  put('VAULT_KEK_PREVIOUS', current.value, current.id);
  put('VAULT_KEK', next.value, next.id);
  renameSync(file('next'), file('current'));
  deps.log(`${shown('current')} is now key id ${next.id}; ${shown('previous')} keeps key id ${current.id}.`);
  deps.log(
    `Next: unlocks and the hourly cron (up to 2000 rows a run) re-wrap rows under key id ${current.id}. When no row is left under it ` +
      `(${leftUnderQuery(m, current.id)} gives 0), delete VAULT_KEK_PREVIOUS (wrangler secret delete VAULT_KEK_PREVIOUS --name ${worker}) and ${shown('previous')}.`,
  );
}
