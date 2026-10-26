// Secret files: generated keys live in <repo>/.secrets/<env>/ (gitignored), directory 0700, files 0600.
// Nothing here prints file contents.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { manifestPath, repoRoot } from '@hana-id/env';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** <root>/.secrets/<env> (root defaults to the repo root). */
export function secretsDir(env: string, root: string = repoRoot): string {
  manifestPath(env); // validates the name (no path tricks)
  return join(root, '.secrets', env);
}

/** Creates the directory (and its parent .secrets) with 0700, tightening existing permissions. */
export function ensureSecretDir(dir: string): void {
  const parent = dirname(dir);
  for (const d of [parent, dir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: DIR_MODE });
    chmodSync(d, DIR_MODE);
  }
}

/** Writes a JSON secret atomically with mode 0600 (written to a 0600 temp file, then renamed). */
export function writeSecretJson(file: string, value: unknown): void {
  const abs = resolve(file);
  const dir = dirname(abs);
  if (!abs.split(sep).includes('.secrets')) throw new Error(`Refusing to write a secret outside a .secrets directory: ${relative(process.cwd(), abs)}`);
  ensureSecretDir(dir);
  const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE, flag: 'wx' });
  chmodSync(tmp, FILE_MODE);
  renameSync(tmp, abs);
}

/** Reads a JSON secret, or returns undefined if absent. Throws if the file is readable by group/others. */
export function readSecretJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  assertPrivate(file);
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** Throws if group or others have any permission on the file. */
export function assertPrivate(file: string): void {
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${file} has mode ${mode.toString(8)}; secret files must be 0600 (chmod 600 ${file})`);
  }
}

/** File names inside .secrets/<env>/. */
export const SECRET_FILES = {
  /** JSON array of `ed25519:…` secret keys: function-call keys on manifest.relayer (the API's RELAYER_KEYS). */
  relayerKeys: 'relayer-keys.json',
  /** `{account_id, public_key, private_key}`: function-call key on manifest.signer (the API's KEYS_UPDATER_KEY). */
  keysUpdater: 'keys-updater.json',
} as const;
