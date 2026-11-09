// Key loading. Full-access keys (owner, signer, relayer) come from the near CLI legacy keychain
// (~/.near-credentials/<network>/<account>.json, written by `near ... save-to-legacy-keychain`). Generated
// function-call keys live in .secrets/<env>/ (see secrets.ts). Secret key strings are never printed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { SECRET_FILES, parseSecretJson, readSecretJson, secretsDir, writeSecretJson } from './secrets.ts';

export interface LoadedKey {
  accountId: string;
  keyPair: KeyPair;
  publicKey: string;
  /** Where it was read from (for messages). */
  source: string;
}

interface CredentialFile {
  account_id?: string;
  public_key?: string;
  private_key?: string;
  secret_key?: string;
}

export function credentialsDir(network: string, home: string = homedir()): string {
  return join(home, '.near-credentials', network);
}

/** Parses a `ed25519:…` secret key string; the error names only `source`, never the text. */
export function parseKeyPair(raw: string, source: string): KeyPair {
  if (!/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/u.test(raw)) throw new Error(`${source} does not hold a NEAR secret key`);
  return KeyPair.fromString(raw as KeyPairString);
}
const parseKey = parseKeyPair;

/**
 * Finds a full-access key for `accountId` in the legacy keychain: `<dir>/<account>.json`, else the first
 * `<dir>/<account>/*.json` (near-cli-rs also writes one file per key there). Returns null if none.
 */
export function findLegacyCredential(accountId: string, network: string, home: string = homedir()): LoadedKey | null {
  const dir = credentialsDir(network, home);
  const candidates: string[] = [join(dir, `${accountId}.json`)];
  const sub = join(dir, accountId);
  if (existsSync(sub) && statSync(sub).isDirectory()) {
    for (const f of readdirSync(sub).sort()) if (f.endsWith('.json')) candidates.push(join(sub, f));
  }
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const json = parseSecretJson<CredentialFile>(readFileSync(file, 'utf8'), file);
    const secret = json.private_key ?? json.secret_key;
    if (!secret) continue;
    if (json.account_id && json.account_id !== accountId) continue;
    const keyPair = parseKey(secret, file);
    const publicKey = keyPair.getPublicKey().toString();
    if (json.public_key && json.public_key !== publicKey) throw new Error(`${file}: public_key does not match private_key`);
    return { accountId, keyPair, publicKey, source: file };
  }
  return null;
}

export function loadLegacyCredential(accountId: string, network: string, home: string = homedir()): LoadedKey {
  const key = findLegacyCredential(accountId, network, home);
  if (!key) {
    throw new Error(
      `No key for ${accountId} in ${credentialsDir(network, home)}. Import it with near CLI, e.g.\n` +
        `  near account import-account using-seed-phrase … network-config ${network}   (then choose save-to-legacy-keychain)\n` +
        `or create the account with: near account create-account sponsor-by-faucet-service ${accountId} autogenerate-new-keypair save-to-legacy-keychain network-config ${network} create`,
    );
  }
  return key;
}

export function generateKey(): KeyPair {
  return KeyPair.fromRandom('ed25519');
}

// --- .secrets/<env>/ key files ---

/** The relayer's function-call key pools: `session` (RELAYER_KEYS), `owner` (OWNER_RELAYER_KEYS) and `home` (HOME_RELAYER_KEYS). */
export type KeyPool = 'session' | 'owner' | 'home';
export const KEY_POOLS: readonly KeyPool[] = ['session', 'owner', 'home'];

export function poolFileName(pool: KeyPool): string {
  return { session: SECRET_FILES.relayerKeys, owner: SECRET_FILES.ownerRelayerKeys, home: SECRET_FILES.homeRelayerKeys }[pool];
}

export function poolKeysFile(env: string, pool: KeyPool, root?: string): string {
  return join(secretsDir(env, root), poolFileName(pool));
}

export function relayerKeysFile(env: string, root?: string): string {
  return poolKeysFile(env, 'session', root);
}

export function keysUpdaterFile(env: string, root?: string): string {
  return join(secretsDir(env, root), SECRET_FILES.keysUpdater);
}

/** One pool's relayer function-call keys (KeyPairs), in file order. */
export function readPoolKeys(env: string, pool: KeyPool, root?: string): KeyPair[] {
  const file = poolKeysFile(env, pool, root);
  const raw = readSecretJson<unknown>(file);
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((k) => typeof k === 'string')) throw new Error(`${file} must be a JSON array of secret key strings`);
  return raw.map((k) => parseKey(k, file));
}

export function writePoolKeys(env: string, pool: KeyPool, keys: KeyPair[], root?: string): void {
  writeSecretJson(poolKeysFile(env, pool, root), keys.map((k) => k.toString()));
}

/** Session-pool keys (relayer-keys.json). */
export const readRelayerKeys = (env: string, root?: string): KeyPair[] => readPoolKeys(env, 'session', root);
export const writeRelayerKeys = (env: string, keys: KeyPair[], root?: string): void => writePoolKeys(env, 'session', keys, root);

export function readKeysUpdater(env: string, root?: string): LoadedKey | null {
  const file = keysUpdaterFile(env, root);
  const raw = readSecretJson<CredentialFile>(file);
  if (!raw) return null;
  if (!raw.account_id || !raw.private_key) throw new Error(`${file} must contain account_id and private_key`);
  const keyPair = parseKey(raw.private_key, file);
  return { accountId: raw.account_id, keyPair, publicKey: keyPair.getPublicKey().toString(), source: file };
}

export function writeKeysUpdater(env: string, accountId: string, keyPair: KeyPair, root?: string): void {
  writeSecretJson(keysUpdaterFile(env, root), { account_id: accountId, public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() });
}
