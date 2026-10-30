import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from '@near-js/crypto';
import { loadEnv, manifestSchema, repoRoot } from '@hana-id/env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRelayerKeys } from '../../src/relayer-config.ts';
import { IDENTITY_PER_ROOT_MINUTE, IDENTITY_PER_SESSION_MINUTE } from '../../src/identity/limits.ts';
import { SHARE_PER_MINUTE, VAULT_PER_IP_MINUTE } from '../../src/vault/limits.ts';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { IDENTITY_SECRET_FILES, identityIssuerFor, p256Thumbprint, type Manifest } from '@hana-id/env';
import {
  LOCAL_D1_ID,
  TEST_MANIFEST,
  devVarsContent,
  existingD1Id,
  identityDevVarsLines,
  identityVars,
  main,
  testWranglerConfig,
  writeDevVars,
  writeWranglerConfig,
  wranglerConfig,
} from '../gen-wrangler.ts';

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
  writeFileSync(join(dir, 'relayer-keys.json'), JSON.stringify(relayerKeys), { mode: 0o600 });
  writeFileSync(join(dir, 'owner-relayer-keys.json'), JSON.stringify(ownerRelayerKeys), { mode: 0o600 });
  writeFileSync(join(dir, 'keys-updater.json'), JSON.stringify({ account_id: 'x.testnet', public_key: 'ed25519:abc', private_key: updaterKey }), { mode: 0o600 });
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

  it('refuses secret files group or others can read, and never quotes a key in a parse error (OPER-5)', () => {
    const root = tmp();
    seedSecrets(root);
    const file = join(root, '.secrets', manifest.name, 'relayer-keys.json');
    chmodSync(file, 0o644);
    expect(() => writeDevVars(manifest.name, root, tmp())).toThrow(/mode 644; secret files must be 0600/u);
    // A trailing comma: Node's own SyntaxError would quote the text around it (the end of a key).
    writeFileSync(file, `${JSON.stringify(relayerKeys).slice(0, -1)},]`, { mode: 0o600 });
    chmodSync(file, 0o600);
    let message = '';
    try {
      writeDevVars(manifest.name, root, tmp());
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/relayer-keys\.json is not valid JSON/u);
    for (const k of relayerKeys) expect(message).not.toContain(k.slice(-10));
  });

  it('replaces an existing world-readable .dev.vars with a fresh 0600 file (never writes secrets into it)', () => {
    const root = tmp();
    const out = tmp();
    seedSecrets(root);
    const path = join(out, '.dev.vars');
    writeFileSync(path, 'OLD=1\n', { mode: 0o644 });
    chmodSync(path, 0o644);
    const before = statSync(path).ino;
    writeDevVars(manifest.name, root, out);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(path).ino).not.toBe(before);
    expect(readFileSync(path, 'utf8')).not.toContain('OLD=1');
  });
});

describe('generated configs are never committed', () => {
  const GENERATED = ['wrangler.jsonc', 'wrangler.vault.jsonc', 'wrangler.auth.jsonc', 'wrangler.vitest.jsonc'].map((f) => `apps/api/${f}`);

  it('every generated wrangler config is gitignored and untracked', () => {
    const git = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
    if (git(['rev-parse', '--git-dir']).status !== 0) return; // not a checkout (e.g. an exported tree)
    for (const path of GENERATED) expect(git(['check-ignore', '-q', '--no-index', path]).status, path).toBe(0);
    expect(git(['ls-files', '--', ...GENERATED]).stdout.trim()).toBe('');
  });

  it('the tests’ config comes from the same generator, for a fixed manifest with no real account or D1 id', () => {
    expect(manifestSchema.parse(TEST_MANIFEST)).toEqual(TEST_MANIFEST);
    const test = testWranglerConfig() as Record<string, unknown> & { d1_databases: { database_id: string }[]; vars: Record<string, string> };
    const real = wranglerConfig(manifest, '11111111-2222-4333-8444-555555555555') as Record<string, unknown>;
    // Everything but the env's names, vars and D1 database is the same as any env gets.
    for (const key of Object.keys(real).filter((k) => !['name', 'vars', 'd1_databases'].includes(k))) expect(test[key], key).toEqual(real[key]);
    expect(test.d1_databases[0]!.database_id).toBe(LOCAL_D1_ID);
    expect(test.vars).not.toHaveProperty('DO_LOCATION_HINT');
    expect(JSON.stringify(test)).not.toMatch(/\.testnet|workers\.dev/u);
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
      ...(manifest.rpcFallback ? { NEAR_RPC_FALLBACK: manifest.rpcFallback } : {}),
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
      APP_CHANGE_DELAY_MS: String(manifest.appChangeDelayMs),
      NETWORK: 'testnet',
      REFUSED_ORIGINS: JSON.stringify([new URL(manifest.apiUrl).origin, manifest.vaultOrigin, manifest.authOrigin].sort()),
    });
    expect(config.d1_databases[0]).toMatchObject({ database_name: manifest.cloudflare.d1Name, database_id: LOCAL_D1_ID });
    expect(text).not.toMatch(/ed25519:/u);
    expect(text).not.toMatch(/RELAYER_KEYS|KEYS_UPDATER_KEY/u);
    expect(text).not.toMatch(/OWNER_RELAYER_KEYS/u);
    expect(text).not.toMatch(/VAULT_KEK/u);
  });

  it('keeps Workers Logs for the Worker’s own lines but turns off invocation logs, which carry request URLs and so relay ids (APIV-3)', () => {
    expect((wranglerConfig(manifest, LOCAL_D1_ID) as { observability: unknown }).observability).toEqual({ enabled: true, logs: { invocation_logs: false } });
  });

  it('passes rpcFallback as NEAR_RPC_FALLBACK only when the manifest sets it', () => {
    const { rpcFallback: _, ...noFallback } = manifest;
    expect((wranglerConfig(manifestSchema.parse(noFallback), LOCAL_D1_ID) as { vars: Record<string, string> }).vars).not.toHaveProperty('NEAR_RPC_FALLBACK');
    const withFallback = manifestSchema.parse({ ...manifest, rpcFallback: 'https://rpc.fallback.example' });
    expect((wranglerConfig(withFallback, LOCAL_D1_ID) as { vars: Record<string, string> }).vars.NEAR_RPC_FALLBACK).toBe('https://rpc.fallback.example');
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

  it('binds the vault’s per-IP and per-share and the identity token’s per-session Rate Limiting bindings, distinct namespaces (D95)', () => {
    const config = wranglerConfig(manifest, LOCAL_D1_ID) as { ratelimits: { name: string; namespace_id: string; simple: { limit: number; period: number } }[] };
    expect(config.ratelimits).toEqual([
      { name: 'VAULT_IP_LIMIT', namespace_id: '95001', simple: { limit: 60, period: 60 } },
      { name: 'VAULT_SHARE_LIMIT', namespace_id: '95002', simple: { limit: 10, period: 60 } },
      { name: 'IDENTITY_SESSION_LIMIT', namespace_id: '95003', simple: { limit: 10, period: 60 } },
      { name: 'IDENTITY_ROOT_LIMIT', namespace_id: '95004', simple: { limit: 30, period: 60 } },
    ]);
    expect(config.ratelimits.map((r) => r.simple.limit)).toEqual([VAULT_PER_IP_MINUTE, SHARE_PER_MINUTE, IDENTITY_PER_SESSION_MINUTE, IDENTITY_PER_ROOT_MINUTE]);
    expect(new Set(config.ratelimits.map((r) => r.namespace_id)).size).toBe(config.ratelimits.length);
    for (const r of config.ratelimits) {
      // Cloudflare's rules: a positive integer namespace id (a string), a period of 10 or 60 s.
      expect(r.namespace_id).toMatch(/^[1-9]\d*$/u);
      expect([10, 60]).toContain(r.simple.period);
    }
    // Same bindings in every env and in the tests' config (a namespace is account-wide; keys carry the env name).
    expect((testWranglerConfig() as { ratelimits: unknown }).ratelimits).toEqual(config.ratelimits);
    const written = readFileSync(writeWranglerConfig(manifest, undefined, tmp()).path, 'utf8');
    expect((JSON.parse(written.slice(written.indexOf('\n') + 1)) as { ratelimits: unknown }).ratelimits).toEqual(config.ratelimits);
  });

  it('has one quarter-hourly cron trigger (JWKS sync every run, vault maintenance at :00, src/index.ts isHourlyRun)', () => {
    expect((wranglerConfig(manifest, LOCAL_D1_ID) as { triggers: unknown }).triggers).toEqual({ crons: ['*/15 * * * *'] });
    expect((wranglerConfig(manifest, LOCAL_D1_ID) as { placement: unknown }).placement).toEqual({ region: 'aws:ap-east-1' });
  });

  it('refuses an env without vaultOrigin and authOrigin', () => {
    const { vaultOrigin: _v, authOrigin: _a, ...bare } = manifest;
    expect(() => wranglerConfig(bare, LOCAL_D1_ID)).toThrow(/needs vaultOrigin and authOrigin/u);
    expect(() => wranglerConfig({ ...manifest, authOrigin: undefined }, LOCAL_D1_ID)).toThrow(/needs vaultOrigin and authOrigin/u);
  });

  it('passes batch C’s delay, network and refused origins; FILES_ORIGIN only with the dashboard blocks', () => {
    const vars = (m: typeof manifest) => wranglerConfig(m, LOCAL_D1_ID).vars as Record<string, string>;
    expect(vars({ ...manifest, appChangeDelayMs: 86_400_000 }).APP_CHANGE_DELAY_MS).toBe('86400000');
    expect(vars(manifest)).not.toHaveProperty('FILES_ORIGIN');
    const host = (w: string) => `https://${w}.tingtc.workers.dev`;
    const full = manifestSchema.parse({
      ...manifest,
      console: { workerName: 'c', d1Name: 'c', origin: host('c'), authWorkerName: 'ca', authOrigin: host('ca') },
      files: { workerName: 'f', origin: host('f'), logosBucket: 'logos', statementsBucket: 'statements', exportsBucket: 'exports' },
      admin: { workerName: 'a', origin: host('a'), accessTeamDomain: 'hana.cloudflareaccess.com', accessAud: 'UNSET', staffEmails: ['s@example.com'] },
      usage: { neonRegion: 'aws-ap-southeast-2', writerHyperdrive: 'uw', adminHyperdrive: 'ua' },
      email: { from: 'no-reply@mail.example.com', securityAlias: 'security@example.com' },
      ownerGrantDelayMs: 60_000,
    });
    expect(vars(full).FILES_ORIGIN).toBe(host('f'));
    const refused = JSON.parse(vars(full).REFUSED_ORIGINS!) as string[];
    expect(refused).toEqual([new URL(manifest.apiUrl).origin, manifest.vaultOrigin, manifest.authOrigin, host('c'), host('ca'), host('f'), host('a')].sort());
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
    writeFileSync(join(dir, 'relayer-keys.json'), JSON.stringify(relayerKeys), { mode: 0o600 });
    const { path, count } = writeDevVars(manifest.name, root, out);
    expect(count).toBe(1);
    expect(Object.keys(dotenvParse(readFileSync(path, 'utf8')))).toEqual(['RELAYER_KEYS']);
  });

  it('main writes nothing when the page configs refuse the env (they are built first)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = tmp();
    // workers.dev page origins outside dev envs: the schema accepts them, the page Workers don't.
    const refused = manifestSchema.parse({
      ...manifest,
      name: 'prod-test',
      apiUrl: 'https://api.hana.example',
      vaultOrigin: 'https://v.acct1.workers.dev',
      authOrigin: 'https://a.acct2.workers.dev',
    });
    expect(() => main(['prod-test'], { dir, loadManifest: () => refused })).toThrow(/workers\.dev hostnames are for local\*\/sandbox\* envs only/u);
    for (const file of ['wrangler.jsonc', 'wrangler.vault.jsonc', 'wrangler.auth.jsonc', '.dev.vars']) expect(existsSync(join(dir, file)), file).toBe(false);
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

describe('the identity token', () => {
  /** A throwaway P-256 key: its private JWK (as identity-key.ts writes it) and its JWKS entry. */
  function p256() {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = privateKey.export({ format: 'jwk' }) as { kty: 'EC'; crv: 'P-256'; x: string; y: string; d: string };
    const kid = p256Thumbprint(jwk);
    return { priv: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }, pub: { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x, y: jwk.y, kid, use: 'sig' as const, alg: 'ES256' as const } };
  }
  const active = p256();
  const standby = p256();
  const subKey = randomBytes(32).toString('base64');
  const withIdentity = (): Manifest =>
    manifestSchema.parse({ ...manifest, identityToken: { iss: identityIssuerFor(manifest.apiUrl), signer: { kind: 'worker-secret', activeKid: active.pub.kid }, publicKeys: [active.pub, standby.pub] } });

  it('vars: the issuer, the public keys only and the active kid; none without the block', () => {
    const vars = (wranglerConfig(withIdentity(), LOCAL_D1_ID) as { vars: Record<string, string> }).vars;
    expect(vars.IDENTITY_ISS).toBe(`${manifest.apiUrl}/v1/identity`);
    expect(JSON.parse(vars.IDENTITY_PUBLIC_KEYS!)).toEqual([active.pub, standby.pub]);
    expect(vars.IDENTITY_ACTIVE_KID).toBe(active.pub.kid);
    expect(vars.IDENTITY_PUBLIC_KEYS).not.toContain('"d"');
    const { identityToken: _, ...bare } = manifest;
    expect(identityVars(bare as Manifest)).toEqual({});
    expect(Object.keys((wranglerConfig(bare as Manifest, LOCAL_D1_ID) as { vars: Record<string, string> }).vars).filter((k) => k.startsWith('IDENTITY_'))).toEqual([]);
  });

  it('refuses the AWS KMS signer until the API has it (build step 7)', () => {
    const kms = manifestSchema.parse({ ...withIdentity(), identityToken: { ...withIdentity().identityToken, signer: { kind: 'aws-kms', awsRegion: 'ap-east-1', keys: { active: active.pub.kid, standby: standby.pub.kid } } } });
    expect(() => identityVars(kms)).toThrow(/not supported by the API yet/u);
  });

  it('.dev.vars: the active signing key and the sub key, round-tripped through wrangler’s parser; never the standby', () => {
    const parsed = dotenvParse(devVarsContent({ identity: identityDevVarsLines(withIdentity(), { signingKey: active.priv, subKey: `${subKey}\n` }) }));
    expect(JSON.parse(parsed.IDENTITY_SIGNING_KEY!)).toEqual(active.priv);
    expect(parsed.IDENTITY_SIGNING_KEY_STANDBY).toBeUndefined();
    expect(parsed.IDENTITY_SUB_KEY).toBe(subKey);
  });

  it('refuses signing keys the manifest doesn’t publish, or none with the active kid', () => {
    const other = p256();
    expect(() => identityDevVarsLines(withIdentity(), { signingKey: other.priv })).toThrow(/doesn't match/u);
    // The standby is published but not the active key: refused as the signing key.
    expect(() => identityDevVarsLines(withIdentity(), { signingKey: standby.priv })).toThrow(/active kid/u);
    const { identityToken: _, ...bare } = manifest;
    expect(() => identityDevVarsLines(bare as Manifest, { signingKey: active.priv })).toThrow(/no identityToken/u);
    expect(() => identityDevVarsLines(withIdentity(), { signingKey: { ...active.priv, d: undefined } })).toThrow(/private JWK/u);
    expect(() => identityDevVarsLines(withIdentity(), { subKey: 'c2hvcnQ=' })).toThrow(/32 bytes/u);
  });

  it('writeDevVars reads the identity files from .secrets/<env>/ (0600 enforced) and counts them', () => {
    const root = tmp();
    const out = tmp();
    seedSecrets(root);
    const dir = join(root, '.secrets', manifest.name);
    writeFileSync(join(dir, IDENTITY_SECRET_FILES.signingKey), JSON.stringify(active.priv), { mode: 0o600 });
    writeFileSync(join(dir, IDENTITY_SECRET_FILES.standbyKey), JSON.stringify(standby.priv), { mode: 0o600 });
    writeFileSync(join(dir, IDENTITY_SECRET_FILES.subKey), subKey, { mode: 0o600 });
    const { path, count } = writeDevVars(manifest.name, root, out, withIdentity());
    expect(count).toBe(5);
    const parsed = dotenvParse(readFileSync(path, 'utf8'));
    expect(parsed.IDENTITY_SUB_KEY).toBe(subKey);
    expect(parsed.IDENTITY_SIGNING_KEY_STANDBY).toBeUndefined();
    chmodSync(join(dir, IDENTITY_SECRET_FILES.subKey), 0o644);
    expect(() => writeDevVars(manifest.name, root, tmp(), withIdentity())).toThrow(/mode 644/u);
  });
});
