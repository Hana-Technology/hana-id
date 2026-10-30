import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { repoRoot } from '@hana-id/env';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, ownerUrlProblem, pendingMigrations, readMigrations, redact, type SqlConn, usageMigrate } from '../lib/usage-migrate.ts';

const REPO_MIGRATIONS = join(repoRoot, 'apps', 'api', 'migrations-usage');
// A placeholder of the shape Neon gives (not a real endpoint or password).
const URL_OK = 'postgresql://neondb_owner:not-a-real-password@ep-quiet-sky-a1b2c3d4.ap-southeast-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const conn = (db: PGlite): SqlConn & { close(): Promise<void> } => ({
  exec: async (sql) => void (await db.exec(sql)),
  query: async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows,
  close: async () => undefined,
});

const dirs: string[] = [];
const tmp = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-migrate-'));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('readMigrations', () => {
  it('reads the repo files in order with their sha256', () => {
    const files = readMigrations(REPO_MIGRATIONS);
    expect(files[0]!.name).toBe('0001_ledger.sql');
    expect(files.every((f) => /^[0-9a-f]{64}$/u.test(f.sha256))).toBe(true);
  });

  it('refuses bad names, gaps and repeats', () => {
    expect(() => readMigrations(tmp({ '0001_a.sql': '', '0003_c.sql': '' }))).toThrow(/without gaps/u);
    expect(() => readMigrations(tmp({ '0001_a.sql': '', '0001_b.sql': '' }))).toThrow(/without gaps or repeats/u);
    expect(() => readMigrations(tmp({ '1_a.sql': '' }))).toThrow(/named NNNN/u);
    expect(() => readMigrations(tmp({ '0001_A.sql': '' }))).toThrow(/named NNNN/u);
  });
});

describe('applyMigrations (PGlite)', () => {
  it('applies the ledger once; a second run applies nothing', async () => {
    const db = new PGlite();
    const files = readMigrations(REPO_MIGRATIONS);
    expect(await applyMigrations(conn(db), files)).toEqual(files.map((f) => f.name));
    expect(await applyMigrations(conn(db), files)).toEqual([]);
    expect((await db.query<{ name: string }>('SELECT name FROM hana_migrations.applied')).rows.map((r) => r.name)).toEqual(files.map((f) => f.name));
    expect((await db.query<{ r: string }>("SELECT to_regclass('usage.events')::text AS r")).rows[0]!.r).toBe('usage.events');
    await db.close();
  });

  it('rolls a failing file back whole and records nothing for it', async () => {
    const db = new PGlite();
    const files = readMigrations(tmp({ '0001_ok.sql': 'CREATE TABLE a (x int);', '0002_bad.sql': 'CREATE TABLE b (x int); SELECT nope();' }));
    await expect(applyMigrations(conn(db), files)).rejects.toThrow(/nope/u);
    expect((await db.query("SELECT to_regclass('public.b') AS r")).rows[0]).toEqual({ r: null });
    expect((await db.query<{ name: string }>('SELECT name FROM hana_migrations.applied')).rows.map((r) => r.name)).toEqual(['0001_ok.sql']);
    await db.close();
  });

  it('refuses a file changed after it was applied, and an applied file the repo no longer has', async () => {
    const db = new PGlite();
    await applyMigrations(conn(db), readMigrations(tmp({ '0001_a.sql': 'CREATE TABLE a (x int);' })));
    await expect(pendingMigrations(conn(db), readMigrations(tmp({ '0001_a.sql': 'CREATE TABLE a (x bigint);' })))).rejects.toThrow(/changed after it was applied/u);
    await expect(pendingMigrations(conn(db), readMigrations(tmp({ '0001_b.sql': 'SELECT 1;' })))).rejects.toThrow(/disagree/u);
    await expect(pendingMigrations(conn(db), [])).rejects.toThrow(/disagree/u);
    await db.close();
  });
});

describe('the owner URL', () => {
  it('must be the direct Sydney Neon endpoint with TLS', () => {
    expect(ownerUrlProblem(URL_OK)).toBeNull();
    expect(ownerUrlProblem(URL_OK.replace('ep-quiet-sky-a1b2c3d4.', 'ep-quiet-sky-a1b2c3d4-pooler.'))).toMatch(/direct endpoint/u);
    expect(ownerUrlProblem(URL_OK.replace('ap-southeast-2', 'us-east-1'))).toMatch(/aws-ap-southeast-2/u);
    expect(ownerUrlProblem(URL_OK.replace('sslmode=require', 'sslmode=disable'))).toMatch(/TLS/u);
    expect(ownerUrlProblem(URL_OK.replace('postgresql:', 'mysql:'))).toMatch(/postgresql/u);
    expect(ownerUrlProblem(URL_OK.replace(':not-a-real-password', ''))).toMatch(/password/u);
    expect(ownerUrlProblem('postgresql://u:p@localhost/db?sslmode=require')).toMatch(/Neon/u);
    expect(ownerUrlProblem('nope')).toMatch(/not a URL/u);
  });

  it('redact removes the URL and the password from a message', () => {
    expect(redact(`connect failed for ${URL_OK}`, URL_OK)).toBe('connect failed for <url>');
    expect(redact('password not-a-real-password rejected', URL_OK)).toBe('password <password> rejected');
  });
});

describe('usageMigrate (the command)', () => {
  const run = async (argv: string[], over: { url?: unknown; db?: PGlite; failConnect?: string } = {}) => {
    const lines: string[] = [];
    const db = over.db ?? new PGlite();
    const result = await usageMigrate(
      argv,
      {
        readNeonSecrets: () => ('url' in over ? { DATABASE_URL_DIRECT: over.url } : { DATABASE_URL_DIRECT: URL_OK }),
        connect: async () => {
          if (over.failConnect) throw new Error(over.failConnect);
          return conn(db);
        },
        migrationsDir: REPO_MIGRATIONS,
        log: (l) => lines.push(l),
      },
      (env) => {
        if (env !== 'sandbox-dev') throw new Error(`No manifest ${env}`);
      },
    );
    return { result, lines, db };
  };

  it('lists pending files without --yes and changes nothing; applies with --yes', async () => {
    const dry = await run(['sandbox-dev']);
    expect(dry.result).toEqual([]);
    expect(dry.lines.join('\n')).toMatch(/pending on sandbox-dev: 0001_ledger\.sql/u);
    expect((await dry.db.query("SELECT to_regclass('usage.events') AS r")).rows[0]).toEqual({ r: null });
    const real = await run(['sandbox-dev', '--yes'], { db: dry.db });
    expect(real.result).toEqual(['0001_ledger.sql']);
    expect((await run(['sandbox-dev'], { db: dry.db })).lines.join('\n')).toMatch(/up to date/u);
  });

  it('refuses bad arguments, a missing or wrong URL, and never prints the URL', async () => {
    await expect(run([])).rejects.toThrow(/Usage/u);
    await expect(run(['sandbox-dev', '--force'])).rejects.toThrow(/Usage/u);
    await expect(run(['prod'])).rejects.toThrow(/No manifest/u);
    await expect(run(['sandbox-dev'], { url: undefined })).rejects.toThrow(/no DATABASE_URL_DIRECT/u);
    const pooled = URL_OK.replace('a1b2c3d4.', 'a1b2c3d4-pooler.');
    const e = await run(['sandbox-dev'], { url: pooled }).catch((err: Error) => err);
    expect((e as Error).message).toMatch(/not the pooler/u);
    expect((e as Error).message).not.toContain('not-a-real-password');
    const c = await run(['sandbox-dev'], { failConnect: `could not connect to ${URL_OK} (password not-a-real-password)` }).catch((err: Error) => err);
    expect((c as Error).message).not.toContain('not-a-real-password');
    expect((c as Error).message).not.toContain('ep-quiet-sky');
  });
});
