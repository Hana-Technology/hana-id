import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from '@near-js/crypto';
import { loadEnv } from '@hana-id/env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRelayerKeys } from '../../src/relayer-config.ts';
import { LOCAL_D1_ID, devVarsContent, existingD1Id, main, writeDevVars, writeWranglerConfig } from '../gen-wrangler.ts';

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
const updaterKey = KeyPair.fromRandom('ed25519').toString();
const manifest = loadEnv('sandbox-dev');

function seedSecrets(root: string, env = manifest.name): void {
  const dir = join(root, '.secrets', env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'relayer-keys.json'), JSON.stringify(relayerKeys));
  writeFileSync(join(dir, 'keys-updater.json'), JSON.stringify({ account_id: 'x.testnet', public_key: 'ed25519:abc', private_key: updaterKey }));
}

describe('.dev.vars', () => {
  it('round-trips RELAYER_KEYS and KEYS_UPDATER_KEY through wrangler’s dotenv parser', () => {
    const parsed = dotenvParse(devVarsContent({ relayerKeys, keysUpdaterKey: updaterKey }));
    expect(parseRelayerKeys(parsed.RELAYER_KEYS)).toEqual(relayerKeys);
    expect(parsed.KEYS_UPDATER_KEY).toBe(updaterKey);
  });

  it('rejects malformed secrets instead of writing them', () => {
    expect(() => devVarsContent({ relayerKeys: ["ed25519:a'b"] })).toThrow();
    expect(() => devVarsContent({ relayerKeys: 'ed25519:abc' })).toThrow();
    expect(() => devVarsContent({ keysUpdaterKey: 'secp256k1:abc' })).toThrow();
  });

  it('writes .dev.vars with mode 0600 from .secrets/<env>/', () => {
    const root = tmp();
    const out = tmp();
    seedSecrets(root);
    const { path, count } = writeDevVars(manifest.name, root, out);
    expect(count).toBe(2);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const parsed = dotenvParse(readFileSync(path, 'utf8'));
    expect(parseRelayerKeys(parsed.RELAYER_KEYS)).toEqual(relayerKeys);
    expect(parsed.KEYS_UPDATER_KEY).toBe(updaterKey);
  });
});

describe('wrangler.jsonc', () => {
  it('takes vars from the manifest and never contains a secret key', () => {
    const dir = tmp();
    const { path } = writeWranglerConfig(manifest, undefined, dir);
    const text = readFileSync(path, 'utf8');
    const config = JSON.parse(text.slice(text.indexOf('\n') + 1)) as { vars: Record<string, string>; d1_databases: { database_name: string; database_id: string }[] };
    expect(config.vars).toEqual({ NEAR_RPC: manifest.rpc, SIGNER_ACCOUNT: manifest.signer, RELAYER_ACCOUNT: manifest.relayer, ENV_NAME: manifest.name });
    expect(config.d1_databases[0]).toMatchObject({ database_name: manifest.cloudflare.d1Name, database_id: LOCAL_D1_ID });
    expect(text).not.toMatch(/ed25519:/u);
    expect(text).not.toMatch(/RELAYER_KEYS|KEYS_UPDATER_KEY/u);
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

  it('main writes both files and never prints secret values', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    const root = tmp();
    const dir = tmp();
    seedSecrets(root);
    main([manifest.name, '--dev-vars'], { root, dir });
    expect(logs).toHaveLength(2);
    expect(logs.join('\n')).not.toMatch(/ed25519:|[1-9A-HJ-NP-Za-km-z]{40,}/u);
    expect(statSync(join(dir, '.dev.vars')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')).not.toMatch(/ed25519:/u);
  });
});
