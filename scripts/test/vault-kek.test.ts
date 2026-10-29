// vault-kek init / put / rotate against a temp .secrets root and a fake wrangler: the --yes gate, file modes, never
// overwriting a key, resuming a rotation that stopped, and that no key value ever reaches the output.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Manifest, loadEnv } from '@hana-id/env';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import { DRY_RUN_LINE, KEK_FILES, type KekSecret, type VaultKekDeps, kekId, newKekValue, readKekFile, vaultKek, wranglerSecretArgv, writeNewSecretFile } from '../lib/vault-kek.ts';

/** A fixture manifest (the real envs/*.json may change as they are deployed). */
const m: Manifest = { ...loadEnv('sandbox-dev'), name: 'kek-test', cloudflare: { workerName: 'hana-id-api-kek-test', d1Name: 'hana-id-kek-test' } };
const mode = (p: string) => statSync(p).mode & 0o777;

let root: string;
let dir: string;
let out: string[];
let puts: { name: KekSecret; value: string }[];
let failPut: KekSecret | null;
let seed: number;

const deps = (): VaultKekDeps => ({
  putSecret: (manifest, name, value) => {
    expect(manifest.name).toBe(m.name);
    if (failPut === name) throw new Error('wrangler secret put failed (exit 1)');
    puts.push({ name, value });
  },
  // Distinct, deterministic keys per call.
  randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (seed * 31 + i) % 256).map((b, i) => (i === 0 ? ++seed : b)),
  log: (line) => out.push(line),
  secretsRoot: root,
  loadManifest: (name) => {
    expect(name).toBe(m.name);
    return m;
  },
});

const run = (...argv: string[]) => vaultKek([m.name, ...argv], deps());
const file = (k: keyof typeof KEK_FILES) => join(dir, KEK_FILES[k]);
const read = (k: keyof typeof KEK_FILES) => readFileSync(file(k), 'utf8');
/** No key value (or its base64 part) in anything printed. */
const expectNoSecretsPrinted = () => {
  const text = out.join('\n');
  for (const { value } of puts) {
    expect(text).not.toContain(value);
    expect(text).not.toContain(value.split(':')[1]!);
  }
  for (const k of ['current', 'previous', 'next'] as const) if (existsSync(file(k))) expect(text).not.toContain(read(k).split(':')[1]!);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hana-id-kek-'));
  dir = join(root, '.secrets', m.name);
  out = [];
  puts = [];
  failPut = null;
  seed = 1;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('vault-kek init', () => {
  it('without --yes only prints the plan: no file, no secret', () => {
    run('init');
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(out.join('\n')).toContain(`set VAULT_KEK on Worker ${m.cloudflare.workerName}`);
    expect(existsSync(file('current'))).toBe(false);
    expect(puts).toEqual([]);
  });

  it('writes key id 1 to .secrets/<env>/vault-kek (0600, dir 0700) and sets VAULT_KEK with the same value', () => {
    run('init', '--yes');
    const value = read('current');
    expect(kekId(value)).toBe(1);
    expect(value).toMatch(/^1:[A-Za-z0-9+/]{43}=$/u);
    expect(mode(file('current'))).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(root, '.secrets'))).toBe(0o700);
    expect(puts).toEqual([{ name: 'VAULT_KEK', value }]);
    expectNoSecretsPrinted();
  });

  it('refuses to overwrite an existing key file (or run beside a rotation’s files), changing nothing', () => {
    run('init', '--yes');
    const before = read('current');
    puts = [];
    expect(() => run('init', '--yes')).toThrow(/already exists: refusing to overwrite/u);
    expect(read('current')).toBe(before);
    expect(puts).toEqual([]);
    rmSync(file('current'));
    writeFileSync(file('previous'), before, { mode: 0o600 });
    expect(() => run('init', '--yes')).toThrow(/vault-kek.previous already exists/u);
    expect(existsSync(file('current'))).toBe(false);
  });

  it('keeps the file when setting the secret fails, and `put` sets it from the file', () => {
    failPut = 'VAULT_KEK';
    expect(() => run('init', '--yes')).toThrow(/wrangler secret put failed/u);
    const value = read('current');
    failPut = null;
    run('put', '--yes');
    expect(puts).toEqual([{ name: 'VAULT_KEK', value }]);
    expectNoSecretsPrinted();
  });
});

describe('vault-kek rotate', () => {
  it('moves the current key to VAULT_KEK_PREVIOUS and vault-kek.previous, and a new id to VAULT_KEK and vault-kek', () => {
    run('init', '--yes');
    const first = read('current');
    puts = [];
    run('rotate');
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(puts).toEqual([]);
    expect(existsSync(file('previous'))).toBe(false);
    run('rotate', '--yes');
    const second = read('current');
    expect(kekId(second)).toBe(2);
    expect(second).not.toBe(first);
    expect(read('previous')).toBe(first);
    expect(existsSync(file('next'))).toBe(false);
    for (const k of ['current', 'previous'] as const) expect(mode(file(k))).toBe(0o600);
    // PREVIOUS first, so the Worker never lacks the key its rows are under.
    expect(puts).toEqual([
      { name: 'VAULT_KEK_PREVIOUS', value: first },
      { name: 'VAULT_KEK', value: second },
    ]);
    expect(out.join('\n')).toContain('SELECT COUNT(*) AS n FROM vault_shares WHERE kek_id = 1');
    expectNoSecretsPrinted();
  });

  it('refuses to rotate again until the previous rotation is finished', () => {
    run('init', '--yes');
    run('rotate', '--yes');
    const state = [read('current'), read('previous')];
    puts = [];
    expect(() => run('rotate', '--yes')).toThrow(/A rotation from key id 1 is not finished/u);
    expect([read('current'), read('previous')]).toEqual(state);
    expect(puts).toEqual([]);
    // Finished by hand (secret deleted, file removed): the next rotation goes to id 3.
    rmSync(file('previous'));
    run('rotate', '--yes');
    expect(kekId(read('current'))).toBe(3);
    expect(read('previous')).toBe(state[0]);
  });

  it('a rotation that stopped after writing its files resumes with the same new key', () => {
    run('init', '--yes');
    const first = read('current');
    puts = [];
    failPut = 'VAULT_KEK';
    expect(() => run('rotate', '--yes')).toThrow(/wrangler secret put failed/u);
    // Nothing lost: the current key is still vault-kek (and in .previous), the new one waits in .next.
    expect(read('current')).toBe(first);
    expect(read('previous')).toBe(first);
    const pending = read('next');
    expect(kekId(pending)).toBe(2);
    failPut = null;
    puts = [];
    // put refuses while a rotation is half done.
    expect(() => run('put', '--yes')).toThrow(/rotation stopped part way/u);
    run('rotate', '--yes');
    expect(out.join('\n')).toContain('Resuming a rotation: key id 1 → 2.');
    expect(puts).toEqual([
      { name: 'VAULT_KEK_PREVIOUS', value: first },
      { name: 'VAULT_KEK', value: pending },
    ]);
    expect(read('current')).toBe(pending);
    expect(existsSync(file('next'))).toBe(false);
    expectNoSecretsPrinted();
  });

  it('refuses to resume when vault-kek.previous is not a copy of vault-kek', () => {
    run('init', '--yes');
    writeNewSecretFile(file('next'), newKekValue(2, () => new Uint8Array(32).fill(9)));
    expect(() => run('rotate', '--yes')).toThrow(/is not a copy of/u);
    writeNewSecretFile(file('previous'), newKekValue(7, () => new Uint8Array(32).fill(8)));
    expect(() => run('rotate', '--yes')).toThrow(/is not a copy of/u);
  });

  it('needs a key to rotate', () => {
    expect(() => run('rotate', '--yes')).toThrow();
    expect(puts).toEqual([]);
  });
});

describe('vault-kek put', () => {
  it('sets VAULT_KEK_PREVIOUS too while a rotation is in progress', () => {
    run('init', '--yes');
    run('rotate', '--yes');
    puts = [];
    run('put', '--yes');
    expect(puts).toEqual([
      { name: 'VAULT_KEK_PREVIOUS', value: read('previous') },
      { name: 'VAULT_KEK', value: read('current') },
    ]);
    expectNoSecretsPrinted();
  });
});

describe('key files', () => {
  it('refuses a key file group or others can read, and a malformed one, naming only the file', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file('current'), newKekValue(1, () => new Uint8Array(32).fill(3)), { mode: 0o644 });
    expect(() => run('put', '--yes')).toThrow(/mode 644/u);
    rmSync(file('current'));
    writeFileSync(file('current'), 'not-a-kek-secret-value', { mode: 0o600 });
    let message = '';
    try {
      run('put', '--yes');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/is not a VAULT_KEK value/u);
    expect(message).not.toContain('not-a-kek-secret-value');
    expect(puts).toEqual([]);
  });

  it('never writes outside .secrets, and never over an existing file', () => {
    expect(() => writeNewSecretFile(join(root, 'vault-kek'), 'x')).toThrow(/outside a .secrets directory/u);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file('current'), 'old', { mode: 0o600 });
    expect(() => writeNewSecretFile(file('current'), 'new')).toThrow(/EEXIST/u);
    expect(read('current')).toBe('old');
  });

  it('reads a value with a trailing newline (a hand-written file) and checks its id', () => {
    mkdirSync(dir, { recursive: true });
    const value = newKekValue(4, () => new Uint8Array(32).fill(1));
    writeFileSync(file('current'), `${value}\n`, { mode: 0o600 });
    expect(readKekFile(file('current'))).toEqual({ value, id: 4 });
    expect(kekId('0:AAAA')).toBeNull();
    expect(kekId(`1:${Buffer.alloc(31).toString('base64')}`)).toBeNull();
  });
});

describe('arguments and wrangler', () => {
  it('refuses unknown commands, extra arguments and flags', () => {
    expect(() => run()).toThrow(CliError);
    expect(() => run('delete', '--yes')).toThrow(/Unknown command delete/u);
    expect(() => run('init', 'extra')).toThrow(/Unexpected argument extra/u);
    expect(() => run('init', '--force')).toThrow(CliError);
  });

  it('targets the env’s Worker by name, the value only on stdin', () => {
    const argv = wranglerSecretArgv(m, 'VAULT_KEK');
    expect(argv).toEqual(['exec', 'wrangler', 'secret', 'put', 'VAULT_KEK', '--name', m.cloudflare.workerName]);
    expect(argv.join(' ')).not.toMatch(/:/u);
  });
});
