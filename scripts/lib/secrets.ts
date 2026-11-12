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
  return parseSecretJson<T>(readFileSync(file, 'utf8'), file);
}

/**
 * JSON.parse for secret files. The parser's own SyntaxError quotes the text around the error (on Node 22, the end of
 * a secret key), so this throws a message that names only the file.
 */
export function parseSecretJson<T>(text: string, file: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${file} is not valid JSON (check for a missing or trailing comma)`);
  }
}

/** Throws if group or others have any permission on the file. */
export function assertPrivate(file: string): void {
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${file} has mode ${mode.toString(8)}; secret files must be 0600 (chmod 600 ${file})`);
  }
}

/**
 * A one-line API key or token from its file (pasted by hand: the Neon API key, the Cloudflare Access token): present,
 * a file, 0600 (no group or other permission), one printable token of 20–512 characters. Errors name the file, `how`
 * to fix it and `what` it should hold, never the value.
 */
export function readOneLineSecret(file: string, shown: string, how: string, what: string): string {
  if (!existsSync(file)) throw new Error(`${shown} is missing: ${how}`);
  const st = statSync(file);
  if (!st.isFile()) throw new Error(`${shown} is not a file`);
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${shown} has mode ${mode.toString(8)}; it must be 0600 (chmod 600 ${shown})`);
  const value = readFileSync(file, 'utf8').trim();
  if (!value) throw new Error(`${shown} is empty: ${how}`);
  // Printable ASCII without spaces: a paste with a second line or a space is a paste of something else.
  if (!/^[\x21-\x7e]{20,512}$/u.test(value)) throw new Error(`${shown} doesn't hold ${what} (one line, 20–512 printable characters, no spaces)`);
  return value;
}

/** File names inside .secrets/<env>/. */
export const SECRET_FILES = {
  /** JSON array of `ed25519:…` secret keys: the session-pool function-call keys on manifest.relayer (the API's RELAYER_KEYS). */
  relayerKeys: 'relayer-keys.json',
  /** Same format: the owner-pool function-call keys on manifest.relayer (the API's OWNER_RELAYER_KEYS). */
  ownerRelayerKeys: 'owner-relayer-keys.json',
  /** Same format: the Home-pool function-call keys on manifest.relayer (the API's HOME_RELAYER_KEYS, POST /v1/home/login). */
  homeRelayerKeys: 'home-relayer-keys.json',
  /** Same format: full-access keys on manifest.near.relay.account (the API's NEAR_RELAY_KEYS, the NEAR meta-transaction relay, D734). */
  nearRelayKeys: 'near-relay-keys.json',
  /** `{account_id, public_key, private_key}`: function-call key on manifest.signer (the API's KEYS_UPDATER_KEY). */
  keysUpdater: 'keys-updater.json',
} as const;
