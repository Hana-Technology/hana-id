// Council member keys (D81). Dev envs (local*, sandbox*): throwaway testnet accounts whose full-access keys live in
// .secrets/<env>/council/<account>.json (0600, `{account_id, public_key, private_key}`), created by council-setup and
// driven by the scripts. Other envs: a member signs with their own key from ~/.near-credentials (the scripts never
// write one), and mainnet members use Ledgers only: no council key is ever read from disk for mainnet.
import { join } from 'node:path';
import { isDevEnv, type Manifest } from '@hana-id/env';
import type { KeyPair } from '@near-js/crypto';
import { CliError } from './cli.ts';
import { findLegacyCredential, type LoadedKey, parseKeyPair } from './keys.ts';
import { readSecretJson, secretsDir, writeSecretJson } from './secrets.ts';

const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/u;

export function councilDir(env: string, root?: string): string {
  return join(secretsDir(env, root), 'council');
}

export function councilKeyFile(env: string, account: string, root?: string): string {
  if (!ACCOUNT.test(account)) throw new Error(`Invalid NEAR account: ${account}`);
  return join(councilDir(env, root), `${account}.json`);
}

/** The member's key from .secrets/<env>/council/, or null if there is no file. */
export function readCouncilKey(env: string, account: string, root?: string): LoadedKey | null {
  const file = councilKeyFile(env, account, root);
  const raw = readSecretJson<{ account_id?: string; private_key?: string; public_key?: string }>(file);
  if (!raw) return null;
  if (raw.account_id !== account || !raw.private_key) throw new Error(`${file} must contain account_id ${account} and private_key`);
  const keyPair = parseKeyPair(raw.private_key, file);
  const publicKey = keyPair.getPublicKey().toString();
  if (raw.public_key && raw.public_key !== publicKey) throw new Error(`${file}: public_key does not match private_key`);
  return { accountId: account, keyPair, publicKey, source: file };
}

export function writeCouncilKey(env: string, account: string, keyPair: KeyPair, root?: string): void {
  writeSecretJson(councilKeyFile(env, account, root), { account_id: account, public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() });
}

/** Council keys on disk are for dev envs on testnet only. */
export function councilKeysOnDisk(m: Pick<Manifest, 'name' | 'network'>): boolean {
  return m.network === 'testnet' && isDevEnv(m.name);
}

/**
 * The key a council member signs with: dev envs read .secrets/<env>/council/<member>.json; other testnet envs read
 * the member's own ~/.near-credentials key. Refuses an account that isn't a council member, and any network but testnet.
 */
export function loadMemberKey(m: Manifest, member: string, opts: { home?: string | undefined; secretsRoot?: string | undefined } = {}): LoadedKey {
  if (!m.council) throw new CliError(`envs/${m.name}.json has no council`);
  if (!m.council.members.includes(member)) throw new CliError(`${member} is not a council member (${m.council.members.join(', ')})`);
  if (m.network !== 'testnet') throw new Error('Council keys are never read from disk outside testnet: members sign with their Ledgers');
  if (councilKeysOnDisk(m)) {
    const key = readCouncilKey(m.name, member, opts.secretsRoot);
    if (!key) throw new Error(`No .secrets/${m.name}/council/${member}.json (council-setup ${m.name} creates it)`);
    return key;
  }
  const key = findLegacyCredential(member, m.network, opts.home);
  if (!key) throw new Error(`No key for ${member} in ~/.near-credentials/${m.network}/ (the member signs with their own key)`);
  return key;
}
