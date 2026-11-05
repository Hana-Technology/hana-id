// d1-move against a fake wrangler holding one database per account: the plan without --yes, export (0600, never
// overwritten), the empty-target gate, the import, the row-count comparison (export vs new, and the old one's writes
// since), each side's account and token, and argument checks. No token or row reaches the output.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Manifest, loadEnv } from '@hana-id/env';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import { DRY_RUN_LINE, type D1MoveDeps, countSql, d1Move, d1Target, exportCounts, parseRows, TABLES_SQL } from '../lib/d1-move.ts';

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW = '0123456789abcdef0123456789abcdef';
const WD_NEW = 'fedcba9876543210fedcba9876543210';
// sandbox-dev without its dashboard blocks (it has them since M4, D414): these tests are about an env without a dashboard.
const { console: _console, files: _files, admin: _admin, usage: _usage, email: _email, ownerGrantDelayMs: _ownerGrant, ...sandboxBare } = loadEnv('sandbox-dev');
const base = sandboxBare as Manifest;
const m: Manifest = {
  ...base,
  name: 'sandbox-mv',
  cloudflare: { ...base.cloudflare, accountId: NEW },
  watchdog: { ...base.watchdog!, cloudflare: { ...base.watchdog!.cloudflare, accountId: WD_NEW } },
} as Manifest;
const DB = m.cloudflare.d1Name;
const ROW_SECRET = 'wrapped-share-ciphertext-xyz';

type Tables = Record<string, string[]>;
/** Each account's databases: name → table → rows (rows are opaque strings). */
let accounts: Record<string, Record<string, Tables>>;
let calls: { argv: string[]; env: Record<string, string> }[];
let out: string[];
let root: string;
let failImportPartWay: boolean;

/** A tiny stand-in for wrangler's d1 export / execute on the account CLOUDFLARE_ACCOUNT_ID names. */
const wrangler: D1MoveDeps['wrangler'] = (argv, env) => {
  calls.push({ argv, env });
  const account = accounts[env.CLOUDFLARE_ACCOUNT_ID!] ?? {};
  const [, cmd, name] = argv;
  const db = account[name!];
  if (!db) return { status: 1, stdout: '', stderr: `no database named "${name}"` };
  if (cmd === 'export') {
    const file = argv.find((a) => a.startsWith('--output='))!.slice('--output='.length);
    const sql = Object.entries(db)
      .map(([t, rows]) => [`CREATE TABLE "${t}" (v TEXT);`, ...rows.map((r) => `INSERT INTO "${t}" VALUES('${r}');`)].join('\n'))
      .join('\n');
    writeFileSync(file, `PRAGMA defer_foreign_keys=TRUE;\n${sql}\n`);
    return { status: 0, stdout: 'exported', stderr: '' };
  }
  const fileArg = argv.find((a) => a.startsWith('--file='));
  if (fileArg) {
    const sql = readFileSync(fileArg.slice('--file='.length), 'utf8');
    for (const [, t] of sql.matchAll(/^CREATE TABLE "([^"]+)"/gmu)) db[t!] = [];
    let n = 0;
    for (const [, t, v] of sql.matchAll(/^INSERT INTO "([^"]+)" VALUES\('([^']*)'\);/gmu)) {
      if (failImportPartWay && ++n > 1) break;
      db[t!]!.push(v!);
    }
    return { status: 0, stdout: 'imported', stderr: '' };
  }
  const sql = argv.find((a) => a.startsWith('--command='))!.slice('--command='.length);
  if (sql === TABLES_SQL) return { status: 0, stdout: JSON.stringify([{ results: Object.keys(db).sort().map((t) => ({ name: t })), success: true }]), stderr: '' };
  const results = [...sql.matchAll(/SELECT '([^']+)' AS t/gu)].map(([, t]) => ({ t, n: db[t!]!.length }));
  return { status: 0, stdout: `\u001b[2m wrangler 4\u001b[0m\n${JSON.stringify([{ results, success: true }])}`, stderr: '' };
};

const deps = (env: Record<string, string | undefined> = {}): D1MoveDeps => ({
  wrangler,
  log: (l) => out.push(l),
  root,
  loadManifest: (name) => {
    expect(name).toBe(m.name);
    return m;
  },
  env,
  today: () => new Date('2026-11-05T10:00:00Z'),
});
const run = (argv: string[], env?: Record<string, string | undefined>) => d1Move([m.name, '--db', 'api', '--from-account', OLD, ...argv], deps(env));
const exportPath = () => join(root, '.secrets', m.name, 'd1-export-api-20261105.sql');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hana-d1-move-test-'));
  mkdirSync(join(root, '.secrets', m.name), { recursive: true, mode: 0o700 });
  accounts = {
    [OLD]: { [DB]: { apps: ['a1', 'a2'], d1_migrations: ['0001', '0002', '0011'], vault_shares: [ROW_SECRET], empty_table: [] } },
    [NEW]: { [DB]: {} },
  };
  calls = [];
  out = [];
  failImportPartWay = false;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('d1-move', () => {
  it('without --yes prints the plan and runs nothing', () => {
    run(['--to-account', NEW]);
    expect(out[0]).toBe(`Plan (env ${m.name}, D1 ${DB}): export, import, compare; old account ${OLD} (wrangler's login), new account ${NEW} (wrangler's login); export file .secrets/${m.name}/d1-export-api-20261105.sql.`);
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(calls).toEqual([]);
  });

  it('--yes: exports (0600), imports into the empty new database, and the counts match, d1_migrations included', () => {
    run(['--yes'], { CLOUDFLARE_ACCOUNT_ID: NEW });
    expect(statSync(exportPath()).mode & 0o777).toBe(0o600);
    expect(accounts[NEW]![DB]).toEqual(accounts[OLD]![DB]);
    expect(out).toContain('  d1_migrations: export 3, new 3, old now 3');
    expect(out).toContain('  empty_table: export 0, new 0, old now 0');
    expect(out).toContain('The new database matches the export in all 4 tables.');
    // Each side on its own account; export from the old, import into the new, no config to resolve names from.
    expect(calls.map((c) => `${c.argv[1]} ${c.env.CLOUDFLARE_ACCOUNT_ID}${c.argv.some((a) => a.startsWith('--file=')) ? ' file' : ''}`)).toEqual([
      `export ${OLD}`,
      `execute ${NEW}`,
      `execute ${NEW} file`,
      `execute ${NEW}`,
      `execute ${OLD}`,
      `execute ${NEW}`,
      `execute ${OLD}`,
    ]);
    expect(calls[0]!.argv).toEqual(['d1', 'export', DB, '--remote', `--output=${exportPath()}`, '--skip-confirmation']);
    expect(calls[2]!.argv).toEqual(['d1', 'execute', DB, '--remote', `--file=${exportPath()}`, '--yes']);
    for (const c of calls) expect(c.env).toMatchObject({ WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false' });
    expect(out.join('\n')).not.toContain(ROW_SECRET);
  });

  it('names the tables the old database changed in since the export (writes the move would lose)', () => {
    run(['--to-account', NEW, '--step', 'export', '--yes']);
    accounts[OLD]![DB]!.apps!.push('a3');
    run(['--to-account', NEW, '--step', 'import', '--yes']);
    run(['--to-account', NEW, '--step', 'compare', '--yes']);
    expect(out).toContain('  apps: export 2, new 2, old now 3  (old changed since the export)');
    expect(out.join('\n')).toMatch(/The old database changed since the export in apps: those writes are not on the new account/u);
  });

  it('refuses to import into a database that already has tables (never migrations apply first)', () => {
    accounts[NEW]![DB] = { d1_migrations: [] };
    expect(() => run(['--to-account', NEW, '--yes'])).toThrow(/already has tables \(d1_migrations\): import only into a new, empty database/u);
    expect(calls.some((c) => c.argv.some((a) => a.startsWith('--file=')))).toBe(false);
  });

  it('fails the comparison when the import stopped part way', () => {
    failImportPartWay = true;
    expect(() => run(['--to-account', NEW, '--yes'])).toThrow(/The new database differs from the export in apps, d1_migrations, vault_shares/u);
  });

  it('never overwrites an export, and imports a given --file', () => {
    run(['--to-account', NEW, '--step', 'export', '--yes']);
    expect(() => run(['--to-account', NEW, '--step', 'export', '--yes'])).toThrow(/exists: refusing to overwrite an export/u);
    const other = join(root, '.secrets', m.name, 'older.sql');
    writeFileSync(other, readFileSync(exportPath()), { mode: 0o600 });
    run(['--to-account', NEW, '--step', 'import', '--file', other, '--yes']);
    expect(accounts[NEW]![DB]!.apps).toEqual(['a1', 'a2']);
    rmSync(exportPath());
    expect(() => run(['--to-account', NEW, '--step', 'import', '--yes'])).toThrow(/doesn't exist: export first/u);
  });

  it("passes each side's API token and profile to that side only, never printing a token", () => {
    const env = { CLOUDFLARE_ACCOUNT_ID: NEW, HANA_FROM_CLOUDFLARE_API_TOKEN: 'old-token-secret', HANA_TO_CLOUDFLARE_API_TOKEN: 'new-token-secret' };
    run(['--from-profile', 'personal', '--to-profile', 'company', '--yes'], env);
    for (const c of calls) {
      const old = c.env.CLOUDFLARE_ACCOUNT_ID === OLD;
      expect(c.env.CLOUDFLARE_API_TOKEN).toBe(old ? 'old-token-secret' : 'new-token-secret');
      expect(c.argv.slice(-2)).toEqual(['--profile', old ? 'personal' : 'company']);
    }
    expect(out.join('\n')).not.toMatch(/token-secret/u);
    expect(out[0]).toContain(`old account ${OLD} (its API token), new account ${NEW} (its API token)`);
  });

  it("checks the accounts against the manifest and each other", () => {
    expect(() => run([])).toThrow(/--to-account \(or CLOUDFLARE_ACCOUNT_ID\) is required/u);
    expect(() => run(['--to-account', OLD])).toThrow(/are the same account/u);
    expect(() => run(['--to-account', 'nope'])).toThrow(/32 lowercase hex/u);
    expect(() => run(['--to-account', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'])).toThrow(/is not cloudflare.accountId 0123/u);
    // The watchdog's database moves to the watchdog's account.
    expect(() => d1Move([m.name, '--db', 'watchdog', '--from-account', OLD, '--to-account', NEW], deps())).toThrow(/is not watchdog.cloudflare.accountId fedcba/u);
    expect(() => d1Move([m.name, '--db', 'console', '--from-account', OLD, '--to-account', NEW], deps())).toThrow(/has no console block/u);
    expect(() => d1Move([m.name, '--db', 'other', '--from-account', OLD], deps())).toThrow(CliError);
    expect(() => run(['--step', 'everything', '--to-account', NEW])).toThrow(/--step must be one of/u);
    expect(() => d1Move([m.name, '--from-account', OLD], deps())).toThrow(/--db is required/u);
  });

  it('a manifest still naming the old account is refused (commit the move first)', () => {
    const stale = { ...m, cloudflare: { ...m.cloudflare, accountId: OLD } } as Manifest;
    expect(() => d1Move([stale.name, '--db', 'api', '--from-account', OLD, '--to-account', NEW], { ...deps(), loadManifest: () => stale })).toThrow(/is not cloudflare.accountId a+/u);
  });

  it('a failed wrangler run names the step and redacts quoted text', () => {
    delete accounts[NEW]![DB];
    expect(() => run(['--to-account', NEW, '--yes'])).toThrow(/wrangler d1 execute \(tables\) \(new account\) failed \(exit 1\):\nno database named '…'/u);
  });
});

describe('d1-move helpers', () => {
  it('targets each database by its manifest name', () => {
    expect(d1Target(m, 'api')).toEqual({ name: DB, accountId: NEW, accountField: 'cloudflare.accountId' });
    expect(d1Target(m, 'issuer').name).toBe(m.emailIssuer!.cloudflare.d1Name);
    expect(d1Target(m, 'watchdog')).toEqual({ name: m.watchdog!.cloudflare.d1Name, accountId: WD_NEW, accountField: 'watchdog.cloudflare.accountId' });
  });

  it('counts rows per table in an export, quoted or not, with empty tables at 0', () => {
    const sql = 'CREATE TABLE "a" (x);\nCREATE TABLE b (y);\nCREATE TABLE "_cf_KV" (k);\nINSERT INTO "a" VALUES(\'1\');\nINSERT INTO "a" VALUES(\'two\nINSERT INTO lines\');\nINSERT INTO c VALUES(1);\n';
    expect(Object.fromEntries(exportCounts(sql))).toEqual({ a: 2, b: 0, c: 1 });
  });

  it('builds one count statement over checked table names', () => {
    expect(countSql(['apps', 'd1_migrations'])).toBe(`SELECT 'apps' AS t, COUNT(*) AS n FROM "apps" UNION ALL SELECT 'd1_migrations' AS t, COUNT(*) AS n FROM "d1_migrations"`);
    expect(() => countSql(['x"; DROP TABLE apps; --'])).toThrow(/Unexpected table name/u);
    expect(() => countSql([])).toThrow(/No tables/u);
    expect(parseRows<{ n: number }>('noise\n[{"results":[{"n":1}]},{"results":[{"n":2}]}]')).toEqual([{ n: 1 }, { n: 2 }]);
    expect(() => parseRows('no json')).toThrow(/no JSON/u);
    expect(existsSync(root)).toBe(true);
  });
});
