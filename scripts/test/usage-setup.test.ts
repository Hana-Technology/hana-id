// usage-setup roles / hyperdrive / user-id-key against a temp .secrets root, PGlite as the Neon owner (D140) and a fake
// wrangler: the --yes gate, file modes, reuse on a re-run, SCRAM verifiers instead of plain passwords, and that no
// password, URL or key ever reaches the output.
import { createHash, createHmac } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { type Manifest, loadEnv, repoRoot } from '@hana-id/env';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import { applyMigrations, readMigrations, type SqlConn } from '../lib/usage-migrate.ts';
import { ROLE_FILES, USER_ID_KEY_FILE, type UsageSetupDeps, type WranglerResult, hyperdriveNames, roleUrl, scramVerifier, usageSetup } from '../lib/usage-setup.ts';
import { DRY_RUN_LINE } from '../lib/vault-kek.ts';

const m: Manifest = { ...loadEnv('sandbox-dev'), name: 'usage-test', cloudflare: { workerName: 'hana-id-api-usage-test', d1Name: 'hana-id-usage-test' } };
// A placeholder of the shape Neon gives (not a real endpoint or password).
const OWNER = 'postgresql://neondb_owner:owner-pw-not-real@ep-quiet-sky-a1b2c3d4.ap-southeast-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const mode = (p: string) => statSync(p).mode & 0o777;

let root: string;
let dir: string;
let out: string[];
let calls: { args: string[]; input?: string }[];
let wranglerReply: (args: string[]) => WranglerResult;
let db: PGlite;
let connects: number;
let seed: number;

const conn = (): SqlConn & { close(): Promise<void> } => ({
  exec: async (sql) => void (await db.exec(sql)),
  query: async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows,
  close: async () => undefined,
});

const deps = (over: Partial<UsageSetupDeps> = {}): UsageSetupDeps => ({
  readNeonSecrets: () => ({ DATABASE_URL_DIRECT: OWNER }),
  connect: async (url) => {
    expect(url).toBe(OWNER);
    connects++;
    return conn();
  },
  wrangler: (args, input) => {
    calls.push({ args, input });
    return wranglerReply(args);
  },
  // Distinct, deterministic bytes per call.
  randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (seed * 37 + i * 11) % 256).map((b, i) => (i === 0 ? ++seed % 256 : b)),
  log: (line) => out.push(line),
  secretsRoot: root,
  loadManifest: (name) => {
    if (name !== m.name) throw new Error(`No manifest ${name}`);
    return m;
  },
  ...over,
});
const run = (argv: string[], over: Partial<UsageSetupDeps> = {}) => usageSetup([m.name, ...argv], deps(over));
const printed = () => out.join('\n');

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'usage-setup-'));
  dir = join(root, '.secrets', m.name);
  out = [];
  calls = [];
  connects = 0;
  seed = 1;
  wranglerReply = () => ({ status: 0, stdout: '', stderr: '' });
  db = new PGlite();
  await applyMigrations(conn(), readMigrations(join(repoRoot, 'apps', 'api', 'migrations-usage')));
});
afterEach(async () => {
  rmSync(root, { recursive: true, force: true });
  await db.close();
});

const fileUrl = (role: keyof typeof ROLE_FILES) => new URL(readFileSync(join(dir, ROLE_FILES[role]), 'utf8').trim());
const authid = async (role: string) => (await db.query<{ rolcanlogin: boolean; rolpassword: string | null }>('SELECT rolcanlogin, rolpassword FROM pg_authid WHERE rolname = $1', [role])).rows[0]!;

/** StoredKey and ServerKey of a stored verifier match the password (recomputed with its salt and iterations). */
function verifierMatches(stored: string, password: string): boolean {
  const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/u.exec(stored);
  if (!m) return false;
  return scramVerifier(password, Buffer.from(m[2]!, 'base64'), Number(m[1])) === stored;
}

describe('scramVerifier', () => {
  it('matches RFC 7677’s SCRAM-SHA-256 example (user "user", password "pencil")', () => {
    const v = scramVerifier('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'), 4096);
    const [, keys] = v.split('$').slice(1) as [string, string];
    const [storedKey, serverKey] = keys.split(':').map((k) => Buffer.from(k, 'base64')) as [Buffer, Buffer];
    const nonce = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
    const authMessage = `n=user,r=rOprNGfwEbeRWgbNEkqO,r=${nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=${nonce}`;
    // The server's signature, as the RFC's server-final message carries it.
    expect(createHmac('sha256', serverKey).update(authMessage).digest('base64')).toBe('6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
    // The client's proof: ClientKey = proof XOR HMAC(StoredKey, AuthMessage), and StoredKey = SHA-256(ClientKey).
    const proof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64');
    const sig = createHmac('sha256', storedKey).update(authMessage).digest();
    const clientKey = Buffer.from(proof.map((b, i) => b ^ sig[i]!));
    expect(createHash('sha256').update(clientKey).digest().equals(storedKey)).toBe(true);
  });
});

describe('usage-setup roles', () => {
  it('prints its plan and changes nothing without --yes', async () => {
    await run(['roles']);
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(existsSync(dir)).toBe(false);
    expect(connects).toBe(0);
    expect((await authid('usage_writer')).rolcanlogin).toBe(false);
  });

  it('writes each role’s URL (0600) and gives both roles LOGIN with a SCRAM verifier of that password; prints none of it', async () => {
    await run(['roles', '--yes']);
    expect(mode(dir)).toBe(0o700);
    for (const role of ['usage_writer', 'usage_admin'] as const) {
      const file = join(dir, ROLE_FILES[role]);
      expect(mode(file)).toBe(0o600);
      const u = fileUrl(role);
      const owner = new URL(OWNER);
      expect([u.protocol, u.username, u.host, u.pathname, u.search]).toEqual(['postgresql:', role, owner.host, owner.pathname, '?sslmode=require']);
      expect(u.password).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      const row = await authid(role);
      expect(row.rolcanlogin).toBe(true);
      // Postgres kept the verifier as sent (a plain password would have been hashed into a different one).
      expect(verifierMatches(row.rolpassword!, u.password)).toBe(true);
      expect(printed()).not.toContain(u.password);
    }
    expect(fileUrl('usage_writer').password).not.toBe(fileUrl('usage_admin').password);
    expect(printed()).not.toMatch(/owner-pw-not-real|neon\.tech|postgresql:/u);
  });

  it('a re-run reuses the passwords in the files (and generates only a missing one)', async () => {
    await run(['roles', '--yes']);
    const writer = readFileSync(join(dir, ROLE_FILES.usage_writer), 'utf8');
    rmSync(join(dir, ROLE_FILES.usage_admin));
    await run(['roles', '--yes']);
    expect(readFileSync(join(dir, ROLE_FILES.usage_writer), 'utf8')).toBe(writer);
    for (const role of ['usage_writer', 'usage_admin'] as const) expect(verifierMatches((await authid(role)).rolpassword!, fileUrl(role).password)).toBe(true);
  });

  it('refuses a missing or wrong owner URL, a non-testnet env, a bad command; a database error has the URL and passwords removed', async () => {
    await expect(run(['roles', '--yes'], { readNeonSecrets: () => undefined })).rejects.toThrow(/no DATABASE_URL_DIRECT/u);
    await expect(run(['roles', '--yes'], { readNeonSecrets: () => ({ DATABASE_URL_DIRECT: OWNER.replace('ep-quiet-sky-a1b2c3d4', 'ep-quiet-sky-a1b2c3d4-pooler') }) })).rejects.toThrow(/direct endpoint/u);
    await expect(usageSetup(['mainnet-x', 'roles'], deps({ loadManifest: () => ({ ...m, name: 'mainnet-x', network: 'mainnet' }) as unknown as Manifest }))).rejects.toThrow(/not a testnet env/u);
    await expect(run(['nope'])).rejects.toBeInstanceOf(CliError);
    await expect(run([])).rejects.toBeInstanceOf(CliError);
    const failing = (): SqlConn & { close(): Promise<void> } => ({ ...conn(), exec: async (sql) => {
      if (sql.startsWith('ALTER')) throw new Error(`role failed for ${OWNER} with ${sql}`);
      await db.exec(sql);
    } });
    const err = await run(['roles', '--yes'], { connect: async () => failing() }).catch((e: Error) => e);
    expect(String(err)).not.toMatch(/owner-pw-not-real|SCRAM-SHA-256\$4096:[^<]/u);
    expect(String(err)).not.toContain(fileUrl('usage_writer').password);
    // Nothing applied (one transaction), and the files stay for the next run.
    expect((await authid('usage_writer')).rolcanlogin).toBe(false);
    expect(existsSync(join(dir, ROLE_FILES.usage_writer))).toBe(true);
  });
});

describe('usage-setup hyperdrive', () => {
  const ID_W = '0123456789abcdef0123456789abcdef';
  const ID_A = 'fedcba9876543210fedcba9876543210';

  it('creates both configs with caching disabled from the role files and prints only names and ids', async () => {
    await run(['roles', '--yes']);
    out = [];
    await run(['hyperdrive']);
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(calls).toEqual([]);
    // Another 32-hex value comes first (an account id in wrangler's banner): only the "Created" line's id counts.
    wranglerReply = (args) => ({
      status: 0,
      stdout: `account aaaaaaaabbbbbbbbccccccccdddddddd\n🚧 Creating '${args[2]}'\n✅ Created new Hyperdrive PostgreSQL config: ${args[2] === hyperdriveNames(m).usage_writer ? ID_W : ID_A}\n{"origin": {"host": "ep-quiet-sky-a1b2c3d4.ap-southeast-2.aws.neon.tech", "user": "usage_writer"}}`,
      stderr: '',
    });
    await run(['hyperdrive', '--yes']);
    expect(calls.map((c) => [c.args.slice(0, 3), c.args.slice(4)])).toEqual([
      [['hyperdrive', 'create', 'hana-id-usage-writer-usage-test'], ['--caching-disabled']],
      [['hyperdrive', 'create', 'hana-id-usage-admin-usage-test'], ['--caching-disabled']],
    ]);
    expect(calls[0]!.args[3]).toBe(`--connection-string=${fileUrl('usage_writer').toString()}`);
    expect(out).toEqual(expect.arrayContaining([`hana-id-usage-writer-usage-test (usage_writer): ${ID_W}`, `hana-id-usage-admin-usage-test (usage_admin): ${ID_A}`]));
    expect(printed()).not.toMatch(/neon\.tech|postgresql:/u);
    expect(printed()).not.toContain(fileUrl('usage_writer').password);
  });

  it('uses the manifest’s usage block names; refuses without the role files; a failure’s output has the URL removed', async () => {
    expect(hyperdriveNames({ name: 'x', usage: { neonRegion: 'aws-ap-southeast-2', writerHyperdrive: 'w-x', adminHyperdrive: 'a-x' } })).toEqual({ usage_writer: 'w-x', usage_admin: 'a-x' });
    await expect(run(['hyperdrive', '--yes'])).rejects.toThrow();
    await run(['roles', '--yes']);
    const url = fileUrl('usage_writer').toString();
    wranglerReply = () => ({ status: 1, stdout: '', stderr: `✘ could not connect to ${url}` });
    const err = await run(['hyperdrive', '--yes']).catch((e: Error) => e);
    expect(String(err)).toMatch(/failed \(exit 1\)/u);
    expect(String(err)).not.toContain(fileUrl('usage_writer').password);
    // A role file someone loosened is refused.
    chmodSync(join(dir, ROLE_FILES.usage_admin), 0o644);
    await expect(run(['hyperdrive', '--yes'])).rejects.toThrow(/0600/u);
    chmodSync(join(dir, ROLE_FILES.usage_admin), 0o600);
    // Success without the "Created … config: <id>" line (a changed wrangler): refused, never a guessed id.
    wranglerReply = () => ({ status: 0, stdout: 'done 0123456789abcdef0123456789abcdef', stderr: '' });
    await expect(run(['hyperdrive', '--yes'])).rejects.toThrow(/printed no config id/u);
  });
});

describe('usage-setup user-id-key', () => {
  it('generates the key once (0600), sets it on the API Worker through stdin, never prints it; a re-run keeps the file', async () => {
    await run(['user-id-key']);
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(existsSync(join(dir, USER_ID_KEY_FILE))).toBe(false);
    await run(['user-id-key', '--yes']);
    const file = join(dir, USER_ID_KEY_FILE);
    expect(mode(file)).toBe(0o600);
    const value = readFileSync(file, 'utf8');
    expect(Buffer.from(value, 'base64')).toHaveLength(32);
    expect(calls).toEqual([{ args: ['secret', 'put', 'USER_ID_KEY', '--name', m.cloudflare.workerName], input: value }]);
    expect(printed()).toMatch(/offline backup/u);
    await run(['user-id-key', '--yes']);
    expect(readFileSync(file, 'utf8')).toBe(value);
    expect(calls.map((c) => c.input)).toEqual([value, value]);
    expect(printed()).not.toContain(value);
    expect(printed()).not.toContain(value.slice(0, 20));
  });

  it('refuses a malformed key file and a failed wrangler', async () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, USER_ID_KEY_FILE), 'not-a-key', { mode: 0o600 });
    await expect(run(['user-id-key', '--yes'])).rejects.toThrow(/not base64 of 32 bytes/u);
    rmSync(join(dir, USER_ID_KEY_FILE));
    wranglerReply = () => ({ status: 1, stdout: '', stderr: 'nope' });
    await expect(run(['user-id-key', '--yes'])).rejects.toThrow(/secret put USER_ID_KEY failed/u);
  });
});

describe('roleUrl', () => {
  it('keeps the owner’s endpoint and database, drops its other options, requires TLS', () => {
    expect(roleUrl(OWNER, 'usage_admin', 'pw_0')).toBe('postgresql://usage_admin:pw_0@ep-quiet-sky-a1b2c3d4.ap-southeast-2.aws.neon.tech/neondb?sslmode=require');
  });
});
