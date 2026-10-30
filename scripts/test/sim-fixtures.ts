// Shared fixtures for the governance script tests: temp keychain/.secrets roots, keys and access-key entries.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from '@near-js/crypto';
import type { GovernanceView } from '../lib/contract.ts';
import type { AccessKeyListEntry } from '../lib/near.ts';

export const NEAR = 10n ** 24n;
export const NOW = 1_800_000_000_000;
export const UPDATER = ['set_issuer_key', 'propose_issuer_key_removal', 'execute_issuer_key_change'];
export const V1_UPDATER = ['set_issuer_key', 'remove_issuer_key'];
/** The owner as envs/sandbox-dev.json had it before the handover to the council DAO: tests that start from an account
 * owner spread this over the real manifest, whose `owner` is now the DAO. */
export const ACCOUNT_OWNER = { owner: 'hana-id-admin-dev1.testnet', ownerKind: 'account' as const };

export const GOVERNANCE_DEFAULT: GovernanceView = {
  state_version: 2,
  watchdogs: [],
  keys_slow_until_ms: 0,
  updater_keys: [],
  pending_upgrade: null,
  pending_owner: null,
  pending_withdrawal: null,
};

export const fullEntry = (k: KeyPair | string): AccessKeyListEntry => ({ public_key: typeof k === 'string' ? k : k.getPublicKey().toString(), access_key: { nonce: 1, permission: 'FullAccess' } });

export const fcEntry = (k: KeyPair | string, receiver_id: string, method_names: string[], allowance: string | null = NEAR.toString()): AccessKeyListEntry => ({
  public_key: typeof k === 'string' ? k : k.getPublicKey().toString(),
  access_key: { nonce: 1, permission: { FunctionCall: { allowance, receiver_id, method_names } } },
});

/** A temp dir with `home` (a ~/.near-credentials/testnet keychain) and `repo` (where .secrets/ goes). */
export function tempRoots(): { home: string; secretsRoot: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hana-id-gov-'));
  const home = join(dir, 'home');
  const secretsRoot = join(dir, 'repo');
  mkdirSync(join(home, '.near-credentials', 'testnet'), { recursive: true });
  mkdirSync(secretsRoot);
  return { home, secretsRoot, dir };
}

/** Writes a full-access key for `account` into the temp keychain and returns it. */
export function keychainKey(home: string, account: string): KeyPair {
  const k = KeyPair.fromRandom('ed25519');
  writeFileSync(join(home, '.near-credentials', 'testnet', `${account}.json`), JSON.stringify({ account_id: account, public_key: k.getPublicKey().toString(), private_key: k.toString() }), { mode: 0o600 });
  return k;
}

/** Every secret-key string of `keys`, and a 20-char slice of each, for "never printed" checks. */
export function secretFragments(keys: KeyPair[]): string[] {
  return keys.flatMap((k) => [k.toString(), k.toString().slice('ed25519:'.length, 'ed25519:'.length + 20)]);
}
