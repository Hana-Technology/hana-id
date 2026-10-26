import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeyPair } from '@near-js/crypto';
import { assertPrivate, readSecretJson, secretsDir, writeSecretJson } from '../lib/secrets.ts';
import { findLegacyCredential, keysUpdaterFile, loadLegacyCredential, readKeysUpdater, readRelayerKeys, writeKeysUpdater, writeRelayerKeys } from '../lib/keys.ts';

const mode = (p: string) => statSync(p).mode & 0o777;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hana-id-scripts-'));
});
afterEach(() => {
  // temp dirs are left to the OS; they contain only test keys
});

describe('secret files', () => {
  it('creates .secrets/<env> as 0700 and files as 0600', () => {
    const file = join(secretsDir('sandbox-dev', root), 'x.json');
    writeSecretJson(file, { a: 1 });
    expect(mode(file)).toBe(0o600);
    expect(mode(join(root, '.secrets'))).toBe(0o700);
    expect(mode(join(root, '.secrets', 'sandbox-dev'))).toBe(0o700);
    expect(readSecretJson(file)).toEqual({ a: 1 });
  });

  it('tightens loose existing permissions and overwrites atomically', () => {
    const dir = join(root, '.secrets', 'e1');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
    const file = join(dir, 'k.json');
    writeSecretJson(file, [1]);
    writeSecretJson(file, [2]);
    expect(mode(dir)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([2]);
  });

  it('refuses to write outside a .secrets directory', () => {
    expect(() => writeSecretJson(join(root, 'elsewhere', 'k.json'), {})).toThrow('.secrets');
  });

  it('refuses to read group/world-readable secrets', () => {
    const file = join(secretsDir('e2', root), 'k.json');
    writeSecretJson(file, {});
    chmodSync(file, 0o644);
    expect(() => assertPrivate(file)).toThrow('0600');
    expect(() => readSecretJson(file)).toThrow();
  });

  it('rejects path-like env names', () => {
    expect(() => secretsDir('../x', root)).toThrow();
  });
});

describe('generated key files', () => {
  it('round-trips relayer keys and the keys-updater key', () => {
    const keys = [KeyPair.fromRandom('ed25519'), KeyPair.fromRandom('ed25519')];
    writeRelayerKeys('e3', keys, root);
    expect(readRelayerKeys('e3', root).map((k) => k.getPublicKey().toString())).toEqual(keys.map((k) => k.getPublicKey().toString()));
    // RELAYER_KEYS format: a JSON array of ed25519:… strings
    const raw = JSON.parse(readFileSync(join(root, '.secrets', 'e3', 'relayer-keys.json'), 'utf8')) as string[];
    expect(raw.every((k) => k.startsWith('ed25519:'))).toBe(true);

    const u = KeyPair.fromRandom('ed25519');
    writeKeysUpdater('e3', 'signer.testnet', u, root);
    expect(mode(keysUpdaterFile('e3', root))).toBe(0o600);
    const loaded = readKeysUpdater('e3', root);
    expect(loaded?.accountId).toBe('signer.testnet');
    expect(loaded?.publicKey).toBe(u.getPublicKey().toString());
  });

  it('returns empty when no files exist', () => {
    expect(readRelayerKeys('none', root)).toEqual([]);
    expect(readKeysUpdater('none', root)).toBeNull();
  });
});

describe('legacy keychain', () => {
  it('reads <account>.json and the per-key directory', () => {
    const k = KeyPair.fromRandom('ed25519');
    const dir = join(root, '.near-credentials', 'testnet');
    mkdirSync(join(dir, 'b.testnet'), { recursive: true });
    writeFileSync(join(dir, 'a.testnet.json'), JSON.stringify({ account_id: 'a.testnet', public_key: k.getPublicKey().toString(), private_key: k.toString() }));
    writeFileSync(join(dir, 'b.testnet', 'ed25519_x.json'), JSON.stringify({ account_id: 'b.testnet', private_key: k.toString() }));
    expect(findLegacyCredential('a.testnet', 'testnet', root)?.publicKey).toBe(k.getPublicKey().toString());
    expect(findLegacyCredential('b.testnet', 'testnet', root)?.publicKey).toBe(k.getPublicKey().toString());
    expect(findLegacyCredential('c.testnet', 'testnet', root)).toBeNull();
    expect(() => loadLegacyCredential('c.testnet', 'testnet', root)).toThrow('save-to-legacy-keychain');
  });

  it('rejects a mismatched public key', () => {
    const [k1, k2] = [KeyPair.fromRandom('ed25519'), KeyPair.fromRandom('ed25519')];
    const dir = join(root, '.near-credentials', 'testnet');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.testnet.json'), JSON.stringify({ account_id: 'a.testnet', public_key: k1.getPublicKey().toString(), private_key: k2.toString() }));
    expect(() => findLegacyCredential('a.testnet', 'testnet', root)).toThrow('does not match');
  });
});
