// identity-key init / put / next / switch / retire / show against a temp .secrets root, an in-memory manifest and a
// fake wrangler: the --yes gate, file modes, never overwriting a key or published keys, the offline standby (never
// uploaded until a switch), a rotation from start to end with the Worker always holding the active kid, and that no
// private value is ever printed.
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY_SECRET_FILES, type Manifest, loadEnv, manifestPath, manifestSchema, p256Thumbprint } from '@hana-id/env';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import {
  type IdentityKeyDeps,
  type IdentitySecret,
  type SigningSlot,
  identityKey,
  insertManifestBlock,
  newP256,
  replaceManifestBlock,
  wranglerSecretArgv,
  wranglerSecretDeleteArgv,
} from '../lib/identity-key.ts';
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
let deletes: SigningSlot[];
/** The Worker's secrets as the fake wrangler leaves them. */
let worker: Map<IdentitySecret, string>;
let text: string;

const manifest = (): Manifest => manifestSchema.parse(JSON.parse(text));
const activeKid = (): string => (manifest().identityToken!.signer as { activeKid: string }).activeKid;
const deps = (): IdentityKeyDeps => ({
  putSecret: (m, name, value) => {
    expect(m.name).toBe(base.name);
    puts.push({ name, value });
    worker.set(name, value);
  },
  deleteSecret: (m, name) => {
    expect(m.name).toBe(base.name);
    deletes.push(name);
    worker.delete(name);
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
const kidOf = (k: 'signingKey' | 'standbyKey' | 'nextKey' | 'previousKey') => p256Thumbprint(JSON.parse(readFileSync(file(k), 'utf8')) as { kty: string; crv: string; x: string; y: string });
/** The kids of the signing keys on the fake Worker. */
const workerKids = (): string[] => (['IDENTITY_SIGNING_KEY', 'IDENTITY_SIGNING_KEY_STANDBY'] as const).flatMap((s) => (worker.has(s) ? [p256Thumbprint(JSON.parse(worker.get(s)!))] : []));
/** No private value (a `d`, the sub key) in anything printed. */
const expectNoSecretsPrinted = () => {
  const printed = out.join('\n');
  for (const { value } of puts) {
    expect(printed).not.toContain(value);
    if (value.startsWith('{')) expect(printed).not.toContain((JSON.parse(value) as { d: string }).d);
  }
  for (const f of readdirSync(dir).filter((n) => n.startsWith('identity-signing-key'))) expect(printed).not.toContain((JSON.parse(readFileSync(join(dir, f), 'utf8')) as { d: string }).d);
  if (existsSync(file('subKey'))) expect(printed).not.toContain(readFileSync(file('subKey'), 'utf8').trim());
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hana-id-idk-'));
  dir = join(root, '.secrets', base.name);
  out = [];
  puts = [];
  deletes = [];
  worker = new Map();
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

  it('--yes: 0600 files, both public keys published, the active key and the sub key uploaded, never the standby', () => {
    run('init', '--yes');
    for (const k of ['signingKey', 'standbyKey', 'subKey', 'slots'] as const) expect(mode(file(k))).toBe(0o600);
    const t = manifest().identityToken!;
    expect(t.iss).toBe(`${base.apiUrl}/v1/identity`);
    expect(t.signer).toEqual({ kind: 'worker-secret', activeKid: kidOf('signingKey') });
    expect(t.publicKeys.map((k) => k.kid)).toEqual([kidOf('signingKey'), kidOf('standbyKey')]);
    expect(text).not.toContain('"d"');
    expect(text.indexOf('"identityToken"')).toBeGreaterThan(text.indexOf('"apiUrl"'));
    expect(puts.map((p) => p.name)).toEqual(['IDENTITY_SIGNING_KEY', 'IDENTITY_SUB_KEY']);
    // The standby is published, but no Worker secret holds it: a leak of the Worker's secrets doesn't reach it (D177).
    expect(workerKids()).toEqual([kidOf('signingKey')]);
    expect(JSON.parse(readFileSync(file('slots'), 'utf8'))).toEqual({ IDENTITY_SIGNING_KEY: kidOf('signingKey'), IDENTITY_SIGNING_KEY_STANDBY: null });
    expect(Buffer.from(worker.get('IDENTITY_SUB_KEY')!, 'base64')).toHaveLength(32);
    expectNoSecretsPrinted();
  });

  it('--local: files and manifest, no Worker secret', () => {
    run('init', '--local', '--yes');
    expect(puts).toEqual([]);
    expect(manifest().identityToken).toBeDefined();
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
    expect(() => run('put', '--to', 'next')).toThrow(CliError);
    expect(() => identityKey([base.name], deps())).toThrow(CliError);
  });
});

describe('identity-key put and show', () => {
  it('put sets the active key and the sub key again (never the standby)', () => {
    run('init', '--local', '--yes');
    run('put');
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(puts).toEqual([]);
    run('put', '--yes');
    expect(puts.map((p) => p.name)).toEqual(['IDENTITY_SIGNING_KEY', 'IDENTITY_SUB_KEY']);
    expect(workerKids()).toEqual([kidOf('signingKey')]);
    expectNoSecretsPrinted();
  });

  it('put refuses an active key file that isn’t the manifest’s active kid', () => {
    run('init', '--local', '--yes');
    const m = JSON.parse(text) as { identityToken: { signer: { activeKid: string } } };
    m.identityToken.signer.activeKid = kidOf('standbyKey');
    text = JSON.stringify(m);
    expect(() => run('put', '--yes')).toThrow(/active kid/u);
    expect(puts).toEqual([]);
  });

  it('put refuses a secret file others can read', () => {
    run('init', '--local', '--yes');
    chmodSync(file('subKey'), 0o644);
    expect(() => run('put', '--yes')).toThrow(/mode 644/u);
  });

  it('show prints the kids, the active one, roles and slots, nothing private', () => {
    run('show');
    expect(out.at(-1)).toMatch(/no identityToken/u);
    run('init', '--yes');
    out = [];
    run('show');
    const t = manifest().identityToken!;
    expect(out).toEqual([`iss ${t.iss}`, `kid ${t.publicKeys[0]!.kid} (active: signs) role signing in IDENTITY_SIGNING_KEY`, `kid ${t.publicKeys[1]!.kid} role standby not on the Worker`]);
    expectNoSecretsPrinted();
  });

  it('testnet only, and wrangler gets values on stdin, never argv', () => {
    expect(wranglerSecretArgv(base, 'IDENTITY_SUB_KEY')).toEqual(['exec', 'wrangler', 'secret', 'put', 'IDENTITY_SUB_KEY', '--name', base.cloudflare.workerName]);
    expect(wranglerSecretDeleteArgv(base, 'IDENTITY_SIGNING_KEY')).toEqual(['exec', 'wrangler', 'secret', 'delete', 'IDENTITY_SIGNING_KEY', '--name', base.cloudflare.workerName]);
    const mainnet = { ...deps(), loadManifest: () => ({ ...manifest(), network: 'mainnet' }) as unknown as Manifest };
    expect(() => identityKey([base.name, 'show'], mainnet)).toThrow(/not a testnet env/u);
  });
});

describe('identity-key rotation: next, switch, retire', () => {
  it('a scheduled rotation: the Worker always holds the active kid, the old key keeps verifying until retired', () => {
    run('init', '--yes');
    const first = kidOf('signingKey');
    run('next', '--yes');
    const next = kidOf('nextKey');
    expect(manifest().identityToken!.publicKeys.map((k) => k.kid)).toContain(next);
    expect(activeKid()).toBe(first);
    expect(workerKids()).toEqual([first]);
    expect(() => run('next', '--yes')).toThrow(/exists/u);

    run('switch', '--to', 'next', '--yes');
    expect(activeKid()).toBe(next);
    // Both keys on the Worker now: whichever manifest is deployed, a key with its active kid is there.
    expect(workerKids().sort()).toEqual([first, next].sort());
    expect(kidOf('signingKey')).toBe(next);
    expect(kidOf('previousKey')).toBe(first);
    expect(existsSync(file('nextKey'))).toBe(false);
    expect(manifest().identityToken!.publicKeys.map((k) => k.kid)).toContain(first);
    expect(() => run('switch', '--to', 'standby', '--yes')).toThrow(/retire it first/u);

    run('retire', '--key', 'previous', '--yes');
    expect(manifest().identityToken!.publicKeys.map((k) => k.kid)).not.toContain(first);
    expect(deletes).toEqual(['IDENTITY_SIGNING_KEY']);
    expect(workerKids()).toEqual([next]);
    expect(existsSync(file('previousKey'))).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith('identity-signing-key-retired-'))).toBe(true);
    expectNoSecretsPrinted();
  });

  it('a compromise of the Worker’s secrets: switch to the offline standby, then retire the leaked key at once', () => {
    run('init', '--yes');
    const leaked = kidOf('signingKey');
    const standby = kidOf('standbyKey');
    run('switch', '--to', 'standby', '--yes');
    expect(activeKid()).toBe(standby);
    expect(puts.at(-1)!.name).toBe('IDENTITY_SIGNING_KEY_STANDBY');
    run('retire', '--key', 'previous', '--yes');
    expect(manifest().identityToken!.publicKeys.map((k) => k.kid)).toEqual([standby]);
    expect(workerKids()).toEqual([standby]);
    expect(leaked).not.toBe(standby);
    // A new standby comes from `next` (published, not uploaded).
    run('next', '--yes');
    expect(workerKids()).toEqual([standby]);
  });

  it('both keys exposed: retire the standby too, rotate to a fresh key', () => {
    run('init', '--yes');
    const [first, standby] = [kidOf('signingKey'), kidOf('standbyKey')];
    run('retire', '--key', 'standby', '--yes');
    run('next', '--yes');
    run('switch', '--to', 'next', '--yes');
    run('retire', '--key', 'previous', '--yes');
    const kids = manifest().identityToken!.publicKeys.map((k) => k.kid);
    expect(kids).toHaveLength(1);
    expect(kids).not.toContain(first);
    expect(kids).not.toContain(standby);
    expect(workerKids()).toEqual(kids);
  });

  it('refuses to retire the active key, a switch to an unpublished key, and a fifth key', () => {
    run('init', '--yes');
    expect(() => run('retire', '--key', 'active')).toThrow(CliError);
    expect(() => run('switch', '--to', 'next', '--yes')).toThrow(/doesn't exist/u);
    run('next', '--yes');
    // Unpublish the next key by hand: a switch must refuse it.
    const m = JSON.parse(text) as { identityToken: { publicKeys: { kid: string }[] } };
    m.identityToken.publicKeys = m.identityToken.publicKeys.filter((k) => k.kid !== kidOf('nextKey'));
    text = JSON.stringify(m);
    expect(() => run('switch', '--to', 'next', '--yes')).toThrow(/isn't in identityToken.publicKeys/u);
    expect(puts.filter((p) => p.name === 'IDENTITY_SIGNING_KEY_STANDBY')).toEqual([]);
  });

  it('without --yes, next, switch and retire change nothing', () => {
    run('init', '--yes');
    const before = text;
    run('next');
    run('retire', '--key', 'standby');
    expect(text).toBe(before);
    expect(existsSync(file('nextKey'))).toBe(false);
    expect(deletes).toEqual([]);
  });
});

describe('manifest blocks', () => {
  it('insert refuses a key that exists, and validates the result', () => {
    const t = baseText();
    expect(() => insertManifestBlock(t, 'apiUrl', {}, 'name')).toThrow(/already has/u);
    expect(() => insertManifestBlock(t, 'identityToken', { iss: 'x' }, 'apiUrl')).toThrow();
  });

  it('replace swaps only that block and validates', () => {
    run('init', '--local', '--yes');
    const t = manifest().identityToken!;
    const changed = replaceManifestBlock(text, 'identityToken', { ...t, publicKeys: t.publicKeys.slice(0, 1) });
    expect((JSON.parse(changed) as { identityToken: { publicKeys: unknown[] } }).identityToken.publicKeys).toHaveLength(1);
    expect(changed.slice(0, changed.indexOf('"identityToken"'))).toBe(text.slice(0, text.indexOf('"identityToken"')));
    expect(() => replaceManifestBlock(text, 'identityToken', { ...t, publicKeys: [] })).toThrow();
    expect(() => replaceManifestBlock(baseText(), 'identityToken', t)).toThrow(/has no/u);
  });
});
