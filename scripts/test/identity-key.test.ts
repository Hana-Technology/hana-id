// identity-key init / put / show against a temp .secrets root, an in-memory manifest and a fake wrangler: the --yes
// gate, file modes, never overwriting a key or published keys, the manifest block, and that no private value is ever
// printed.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY_SECRET_FILES, type Manifest, loadEnv, manifestPath, manifestSchema, p256Thumbprint } from '@hana-id/env';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import { type IdentityKeyDeps, type IdentitySecret, identityKey, insertManifestBlock, newP256, wranglerSecretArgv } from '../lib/identity-key.ts';
import { DRY_RUN_LINE } from '../lib/vault-kek.ts';

const base: Manifest = { ...loadEnv('sandbox-dev'), name: 'sandbox-idk-test', cloudflare: { workerName: 'hana-id-api-idk-test', d1Name: 'hana-id-idk-test' } };
const baseText = (): string => {
  const raw = JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Record<string, unknown>;
  delete raw.identityToken;
  return `${JSON.stringify({ ...raw, name: base.name, cloudflare: base.cloudflare }, null, 2)}\n`;
};
const mode = (p: string) => statSync(p).mode & 0o777;

let root: string;
let dir: string;
let out: string[];
let puts: { name: IdentitySecret; value: string }[];
let text: string;

const manifest = (): Manifest => manifestSchema.parse(JSON.parse(text));
const deps = (): IdentityKeyDeps => ({
  putSecret: (m, name, value) => {
    expect(m.name).toBe(base.name);
    puts.push({ name, value });
  },
  newP256,
  randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256),
  log: (line) => out.push(line),
  secretsRoot: root,
  loadManifest: (name) => {
    expect(name).toBe(base.name);
    return manifest();
  },
  readManifestText: () => text,
  writeManifestText: (_name, t) => {
    text = t;
  },
});
const run = (...argv: string[]) => identityKey([base.name, ...argv], deps());
const file = (k: keyof typeof IDENTITY_SECRET_FILES) => join(dir, IDENTITY_SECRET_FILES[k]);
/** No private value (a `d`, the sub key) in anything printed. */
const expectNoSecretsPrinted = () => {
  const printed = out.join('\n');
  for (const { value } of puts) {
    expect(printed).not.toContain(value);
    if (value.startsWith('{')) expect(printed).not.toContain((JSON.parse(value) as { d: string }).d);
  }
  for (const k of ['signingKey', 'standbyKey'] as const) if (existsSync(file(k))) expect(printed).not.toContain((JSON.parse(readFileSync(file(k), 'utf8')) as { d: string }).d);
  if (existsSync(file('subKey'))) expect(printed).not.toContain(readFileSync(file('subKey'), 'utf8').trim());
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hana-id-idk-'));
  dir = join(root, '.secrets', base.name);
  out = [];
  puts = [];
  text = baseText();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('identity-key init', () => {
  it('without --yes: a plan, nothing written or set', () => {
    run('init');
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(existsSync(dir)).toBe(false);
    expect(puts).toEqual([]);
    expect(manifest().identityToken).toBeUndefined();
  });

  it('--yes: three 0600 files, the manifest block with both public keys, three Worker secrets', () => {
    run('init', '--yes');
    for (const k of ['signingKey', 'standbyKey', 'subKey'] as const) expect(mode(file(k))).toBe(0o600);
    const active = JSON.parse(readFileSync(file('signingKey'), 'utf8')) as { x: string; y: string; d: string; kty: string; crv: string };
    const standby = JSON.parse(readFileSync(file('standbyKey'), 'utf8')) as typeof active;
    const t = manifest().identityToken!;
    expect(t.iss).toBe(`${base.apiUrl}/v1/identity`);
    expect(t.signer).toEqual({ kind: 'worker-secret', activeKid: p256Thumbprint(active) });
    expect(t.publicKeys.map((k) => k.kid)).toEqual([p256Thumbprint(active), p256Thumbprint(standby)]);
    expect(text).not.toContain('"d"');
    // The rest of the manifest keeps its formatting (the block goes in after apiUrl).
    expect(text.indexOf('"identityToken"')).toBeGreaterThan(text.indexOf('"apiUrl"'));
    expect(text).toContain(baseText().split('\n')[1]!);
    expect(puts.map((p) => p.name)).toEqual(['IDENTITY_SIGNING_KEY', 'IDENTITY_SIGNING_KEY_STANDBY', 'IDENTITY_SUB_KEY']);
    expect(JSON.parse(puts[0]!.value)).toEqual(active);
    expect(puts[2]!.value).toBe(readFileSync(file('subKey'), 'utf8').trim());
    expect(Buffer.from(puts[2]!.value, 'base64')).toHaveLength(32);
    expectNoSecretsPrinted();
  });

  it('--local: files and manifest, no Worker secret', () => {
    run('init', '--local', '--yes');
    expect(puts).toEqual([]);
    expect(manifest().identityToken).toBeDefined();
    expect(existsSync(file('subKey'))).toBe(true);
    expectNoSecretsPrinted();
  });

  it('never overwrites a key file or published keys', () => {
    run('init', '--local', '--yes');
    const before = readFileSync(file('signingKey'), 'utf8');
    expect(() => run('init', '--yes')).toThrow(/already exists/u);
    expect(readFileSync(file('signingKey'), 'utf8')).toBe(before);
    rmSync(dir, { recursive: true });
    expect(() => run('init', '--yes')).toThrow(/already has identityToken/u);
  });

  it('refuses arguments it doesn’t know', () => {
    expect(() => run('rotate')).toThrow(CliError);
    expect(() => run('put', '--local')).toThrow(CliError);
    expect(() => identityKey([base.name], deps())).toThrow(CliError);
  });
});

describe('identity-key put and show', () => {
  it('put sets the three secrets again from the files, after checking them against the manifest', () => {
    run('init', '--local', '--yes');
    run('put');
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(puts).toEqual([]);
    run('put', '--yes');
    expect(puts.map((p) => p.name)).toEqual(['IDENTITY_SIGNING_KEY', 'IDENTITY_SIGNING_KEY_STANDBY', 'IDENTITY_SUB_KEY']);
    expectNoSecretsPrinted();
  });

  it('put refuses files that don’t match the published keys', () => {
    run('init', '--local', '--yes');
    const m = JSON.parse(text) as { identityToken: { publicKeys: unknown[]; signer: { activeKid: string } } };
    const other = newP256();
    const kid = p256Thumbprint(other);
    m.identityToken.publicKeys = [{ kty: 'EC', crv: 'P-256', x: other.x, y: other.y, kid, use: 'sig', alg: 'ES256' }];
    m.identityToken.signer.activeKid = kid;
    text = JSON.stringify(m);
    expect(() => run('put', '--yes')).toThrow(/don't match/u);
    expect(puts).toEqual([]);
  });

  it('put refuses a secret file others can read', async () => {
    run('init', '--local', '--yes');
    const { chmodSync } = await import('node:fs');
    chmodSync(file('subKey'), 0o644);
    expect(() => run('put', '--yes')).toThrow(/mode 644/u);
  });

  it('show prints the kids and the active one, nothing private', () => {
    run('show');
    expect(out.at(-1)).toMatch(/no identityToken/u);
    run('init', '--local', '--yes');
    out = [];
    run('show');
    const t = manifest().identityToken!;
    expect(out).toEqual([`iss ${t.iss}`, `kid ${t.publicKeys[0]!.kid} (active: signs)`, `kid ${t.publicKeys[1]!.kid}`]);
    expectNoSecretsPrinted();
  });

  it('testnet only, and wrangler gets the value on stdin, never argv', () => {
    expect(wranglerSecretArgv(base, 'IDENTITY_SUB_KEY')).toEqual(['exec', 'wrangler', 'secret', 'put', 'IDENTITY_SUB_KEY', '--name', base.cloudflare.workerName]);
    const mainnet = { ...deps(), loadManifest: () => ({ ...manifest(), network: 'mainnet' }) as unknown as Manifest };
    expect(() => identityKey([base.name, 'show'], mainnet)).toThrow(/not a testnet env/u);
  });
});

describe('insertManifestBlock', () => {
  it('refuses a key that exists, and validates the result', () => {
    const t = baseText();
    expect(() => insertManifestBlock(t, 'apiUrl', {}, 'name')).toThrow(/already has/u);
    expect(() => insertManifestBlock(t, 'identityToken', { iss: 'x' }, 'apiUrl')).toThrow();
  });
});
