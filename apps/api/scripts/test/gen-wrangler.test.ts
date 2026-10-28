import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from '@near-js/crypto';
import { loadEnv } from '@hana-id/env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRelayerKeys } from '../../src/relayer-config.ts';
import { LOCAL_D1_ID, devVarsContent, existingD1Id, main, writeDevVars, writeWranglerConfig, wranglerConfig } from '../gen-wrangler.ts';

/**
 * dotenv 16.3.1 `parse`, exactly as bundled in wrangler 4.x (wrangler-dist/cli.js, used by tryLoadDotDevDotVars to
 * read .dev.vars). Copied so the test checks the generated file against the parser wrangler really uses.
 */
function dotenvParse(src: string): Record<string, string> {
  const LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gmu;
  const obj: Record<string, string> = {};
  const lines = src.replace(/\r\n?/gmu, '\n');
  let match: RegExpExecArray | null;
  while ((match = LINE.exec(lines)) != null) {
    let value = (match[2] ?? '').trim();
    const maybeQuote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gmu, '$2');
    if (maybeQuote === '"') value = value.replace(/\\n/gu, '\n').replace(/\\r/gu, '\r');
    obj[match[1]!] = value;
  }
  return obj;
}

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'hana-gen-wrangler-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const relayerKeys = [KeyPair.fromRandom('ed25519').toString(), KeyPair.fromRandom('ed25519').toString()];
const ownerRelayerKeys = [KeyPair.fromRandom('ed25519').toString()];
const updaterKey = KeyPair.fromRandom('ed25519').toString();
const manifest = loadEnv('sandbox-dev');

function seedSecrets(root: string, env = manifest.name): void {
  const dir = join(root, '.secrets', env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'relayer-keys.json'), JSON.stringify(relayerKeys));
  writeFileSync(join(dir, 'owner-relayer-keys.json'), JSON.stringify(ownerRelayerKeys));
  writeFileSync(join(dir, 'keys-updater.json'), JSON.stringify({ account_id: 'x.testnet', public_key: 'ed25519:abc', private_key: updaterKey }));
}

describe('.dev.vars', () => {
  it('round-trips RELAYER_KEYS, OWNER_RELAYER_KEYS and KEYS_UPDATER_KEY through wrangler’s dotenv parser', () => {
    const parsed = dotenvParse(devVarsContent({ relayerKeys, ownerRelayerKeys, keysUpdaterKey: updaterKey }));
    expect(parseRelayerKeys(parsed.RELAYER_KEYS)).toEqual(relayerKeys);
    expect(parseRelayerKeys(parsed.OWNER_RELAYER_KEYS, 'OWNER_RELAYER_KEYS')).toEqual(ownerRelayerKeys);
    expect(parsed.KEYS_UPDATER_KEY).toBe(updaterKey);
    expect(Object.keys(parsed).sort()).toEqual(['KEYS_UPDATER_KEY', 'OWNER_RELAYER_KEYS', 'RELAYER_KEYS']);
  });

  it('rejects malformed secrets instead of writing them', () => {
    expect(() => devVarsContent({ relayerKeys: ["ed25519:a'b"] })).toThrow();
    expect(() => devVarsContent({ relayerKeys: 'ed25519:abc' })).toThrow();
    expect(() => devVarsContent({ ownerRelayerKeys: ["ed25519:a'b"] })).toThrow();
    expect(() => devVarsContent({ ownerRelayerKeys: [] })).toThrow();
    expect(() => devVarsContent({ ownerRelayerKeys: { keys: relayerKeys } })).toThrow();
    expect(() => devVarsContent({ keysUpdaterKey: 'secp256k1:abc' })).toThrow();
  });

  it('writes .dev.vars with mode 0600 from .secrets/<env>/', () => {
    const root = tmp();
    const out = tmp();
    seedSecrets(root);
    const { path, count } = writeDevVars(manifest.name, root, out);
    expect(count).toBe(3);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const parsed = dotenvParse(readFileSync(path, 'utf8'));
    expect(parseRelayerKeys(parsed.RELAYER_KEYS)).toEqual(relayerKeys);
    expect(parseRelayerKeys(parsed.OWNER_RELAYER_KEYS, 'OWNER_RELAYER_KEYS')).toEqual(ownerRelayerKeys);
    expect(parsed.KEYS_UPDATER_KEY).toBe(updaterKey);
  });
});

describe('wrangler.jsonc', () => {
  it('takes vars from the manifest and never contains a secret key', () => {
    const dir = tmp();
    const { path } = writeWranglerConfig(manifest, undefined, dir);
    const text = readFileSync(path, 'utf8');
    const config = JSON.parse(text.slice(text.indexOf('\n') + 1)) as { vars: Record<string, string>; d1_databases: { database_name: string; database_id: string }[] };
    expect(config.vars).toEqual({
      NEAR_RPC: manifest.rpc,
      SIGNER_ACCOUNT: manifest.signer,
      RELAYER_ACCOUNT: manifest.relayer,
      ENV_NAME: manifest.name,
      MPC_ACCOUNT: manifest.mpc,
      VAULT_ORIGIN: manifest.vaultOrigin,
      AUTH_ORIGIN: manifest.authOrigin,
      API_URL: manifest.apiUrl,
      BLS_PRECHECK: '0',
      REJECT_PII_ON_SESSIONS: '0',
      ...(manifest.cloudflare.durableObjectLocation ? { DO_LOCATION_HINT: manifest.cloudflare.durableObjectLocation } : {}),
    });
    expect(config.d1_databases[0]).toMatchObject({ database_name: manifest.cloudflare.d1Name, database_id: LOCAL_D1_ID });
    expect(text).not.toMatch(/ed25519:/u);
    expect(text).not.toMatch(/RELAYER_KEYS|KEYS_UPDATER_KEY/u);
    expect(text).not.toMatch(/OWNER_RELAYER_KEYS/u);
    expect(text).not.toMatch(/VAULT_KEK/u);
  });

  it('binds the LoginRelay Durable Object, created by a v2 migration after v1', () => {
    const config = wranglerConfig(manifest, LOCAL_D1_ID) as {
      durable_objects: { bindings: { name: string; class_name: string }[] };
      migrations: { tag: string; new_sqlite_classes: string[] }[];
    };
    expect(config.durable_objects.bindings).toEqual([
      { name: 'RELAYER_KEY', class_name: 'RelayerKey' },
      { name: 'RATE_LIMITER', class_name: 'RateLimiter' },
      { name: 'LOGIN_RELAY', class_name: 'LoginRelay' },
    ]);
    // Deployed migrations are append-only: v1 stays exactly as it was.
    expect(config.migrations).toEqual([
      { tag: 'v1', new_sqlite_classes: ['RelayerKey', 'RateLimiter'] },
      { tag: 'v2', new_sqlite_classes: ['LoginRelay'] },
    ]);
  });

  it('refuses an env without vaultOrigin and authOrigin', () => {
    const { vaultOrigin: _v, authOrigin: _a, ...bare } = manifest;
    expect(() => wranglerConfig(bare, LOCAL_D1_ID)).toThrow(/needs vaultOrigin and authOrigin/u);
    expect(() => wranglerConfig({ ...manifest, authOrigin: undefined }, LOCAL_D1_ID)).toThrow(/needs vaultOrigin and authOrigin/u);
  });

  it('sets DO_LOCATION_HINT only when the manifest names a Durable Object location', () => {
    const vars = (m: typeof manifest) => wranglerConfig(m, LOCAL_D1_ID).vars as Record<string, string>;
    expect(vars({ ...manifest, cloudflare: { ...manifest.cloudflare, durableObjectLocation: 'weur' } }).DO_LOCATION_HINT).toBe('weur');
    const { durableObjectLocation: _, ...cloudflare } = manifest.cloudflare;
    expect(vars({ ...manifest, cloudflare })).not.toHaveProperty('DO_LOCATION_HINT');
  });

  it('keeps an existing D1 id only for the same database', () => {
    const dir = tmp();
    const id = '11111111-2222-4333-8444-555555555555';
    writeWranglerConfig(manifest, id, dir);
    const path = join(dir, 'wrangler.jsonc');
    expect(existingD1Id(path, manifest.cloudflare.d1Name)).toBe(id);
    // Regenerating for the same env keeps it.
    expect(writeWranglerConfig(manifest, undefined, dir).d1Id).toBe(id);
    // Another env (other database name) must not inherit it.
    const other = { ...manifest, name: 'other-env', cloudflare: { ...manifest.cloudflare, d1Name: 'hana-id-other-env' } };
    expect(existingD1Id(path, other.cloudflare.d1Name)).toBeNull();
    expect(writeWranglerConfig(other, undefined, dir).d1Id).toBe(LOCAL_D1_ID);
  });

  it('writes only the secrets that exist (no owner pool yet: no OWNER_RELAYER_KEYS line)', () => {
    const root = tmp();
    const out = tmp();
    const dir = join(root, '.secrets', manifest.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'relayer-keys.json'), JSON.stringify(relayerKeys));
    const { path, count } = writeDevVars(manifest.name, root, out);
    expect(count).toBe(1);
    expect(Object.keys(dotenvParse(readFileSync(path, 'utf8')))).toEqual(['RELAYER_KEYS']);
  });

  it('main writes the API and page Worker configs and .dev.vars, and never prints secret values', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    const root = tmp();
    const dir = tmp();
    seedSecrets(root);
    main([manifest.name, '--dev-vars'], { root, dir });
    expect(logs).toHaveLength(4);
    expect(logs.join('\n')).not.toMatch(/ed25519:|[1-9A-HJ-NP-Za-km-z]{40,}/u);
    expect(statSync(join(dir, '.dev.vars')).mode & 0o777).toBe(0o600);
    for (const file of ['wrangler.jsonc', 'wrangler.vault.jsonc', 'wrangler.auth.jsonc']) {
      expect(readFileSync(join(dir, file), 'utf8')).not.toMatch(/ed25519:|RELAYER_KEYS|VAULT_KEK/u);
    }
  });
});
