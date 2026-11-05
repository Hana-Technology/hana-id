// d1-move.ts's body: copies one of an env's D1 databases from the old Cloudflare account to a new, empty database of
// the same name on the new account (D404, docs/operations.md "Moving an env to another Cloudflare account"):
//
//   d1-move <env> --db api|issuer|watchdog|console --from-account <id> [--to-account <id>] [--step export|import|compare|all]
//           [--file <export>] [--from-profile <name>] [--to-profile <name>] [--yes]
//
//   export   `wrangler d1 export <db> --remote --output .secrets/<env>/d1-export-<db>-<yyyymmdd>.sql` on the old
//            account: schema and data, `d1_migrations` included (so `migrations list` on the new database stays
//            right). The file is created 0600 before wrangler writes into it (the issuer's export holds users' email
//            addresses, the API's the wallet directory and the wrapped vault shares), and never overwritten.
//   import   refuses unless the new database has no table yet (never `migrations apply` it first: the export carries
//            the schema), then `wrangler d1 execute <db> --remote --file <export> --yes` on the new account (D1's
//            import: the database is unavailable to queries while it runs).
//   compare  every table's row count in the export file, on the new account and on the old one now (a single SELECT …
//            UNION ALL a side); fails when the new database differs from the export, and names the tables the old
//            one changed in since (writes the move would lose).
//   all      the three in order (the default).
//
// Accounts: `--from-account` is the old account; `--to-account` defaults to CLOUDFLARE_ACCOUNT_ID, and must be the
// manifest's account for that database once the manifest names one. Each side's wrangler runs with that side's
// CLOUDFLARE_ACCOUNT_ID, and with HANA_FROM_CLOUDFLARE_API_TOKEN / HANA_TO_CLOUDFLARE_API_TOKEN as its
// CLOUDFLARE_API_TOKEN when set (an API token per account), or with `--profile <name>` (wrangler's named login
// profiles, `wrangler auth create <name>`), else with the one wrangler login (a user who is a member of both
// accounts). Wrangler runs in an empty scratch directory, so no generated wrangler.jsonc can bind the database name
// to the other account's id. Nothing here prints a token or a row: only names and counts.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { CLOUDFLARE_ACCOUNT_ID_RE, type Manifest, loadEnv, repoRoot } from '@hana-id/env';
import { CliError, parseCli } from './cli.ts';
import { PRIVATE_WRANGLER_ENV, parseD1Json, redactQuoted } from './d1.ts';
import { FILE_MODE, ensureSecretDir, secretsDir } from './secrets.ts';

export const D1_MOVE_USAGE = `Usage: d1-move.ts <env> --db api|issuer|watchdog|console --from-account <old account id> [--to-account <new account id>]
                  [--step export|import|compare|all] [--file <export .sql>] [--from-profile <name>] [--to-profile <name>] [--yes]
  export   wrangler d1 export --remote (old account) into .secrets/<env>/d1-export-<db>-<yyyymmdd>.sql (0600)
  import   into the new, empty database of the same name: wrangler d1 execute --remote --file (new account)
  compare  row counts of every table: the export, the new database, the old one now (d1_migrations included)
  all      export, import, compare (default)
  --to-account   default CLOUDFLARE_ACCOUNT_ID; must be the manifest's account for that database when it names one
  --file         the export to import/compare (default: today's file from export)
  --from-profile / --to-profile   wrangler auth profiles (wrangler auth create <name>) for each account
  Tokens: HANA_FROM_CLOUDFLARE_API_TOKEN / HANA_TO_CLOUDFLARE_API_TOKEN, when set, are each side's CLOUDFLARE_API_TOKEN.

Without --yes it prints the plan and runs nothing. Never prints a token or a row.`;

export const DRY_RUN_LINE = 'Dry run: nothing exported or imported. Re-run with --yes to run it.';

export const D1_DBS = ['api', 'issuer', 'watchdog', 'console'] as const;
export type D1Db = (typeof D1_DBS)[number];
export const D1_STEPS = ['export', 'import', 'compare', 'all'] as const;
export type D1Step = (typeof D1_STEPS)[number];

/** The database's name and the manifest field naming its account. */
export function d1Target(m: Manifest, db: D1Db): { name: string; accountId: string | undefined; accountField: string } {
  const main = { accountId: m.cloudflare.accountId, accountField: 'cloudflare.accountId' };
  switch (db) {
    case 'api':
      return { name: m.cloudflare.d1Name, ...main };
    case 'issuer':
      if (!m.emailIssuer) throw new Error(`envs/${m.name}.json has no emailIssuer`);
      return { name: m.emailIssuer.cloudflare.d1Name, ...main };
    case 'console':
      if (!m.console) throw new Error(`envs/${m.name}.json has no console block`);
      return { name: m.console.d1Name, ...main };
    case 'watchdog': {
      if (!m.watchdog) throw new Error(`envs/${m.name}.json has no watchdog block`);
      const id = m.watchdog.cloudflare.accountId;
      return { name: m.watchdog.cloudflare.d1Name, accountId: id === 'UNSET' ? undefined : id, accountField: 'watchdog.cloudflare.accountId' };
    }
  }
}

/** One side of the move. */
export interface Side {
  label: 'old' | 'new';
  accountId: string;
  /** wrangler's `--profile`, if any. */
  profile?: string;
  /** The API token for this account (never printed), if any. */
  token?: string;
}

/** A wrangler run: its argv (after the binary), its environment overrides, and its output. */
export type Wrangler = (argv: string[], env: Record<string, string>) => { status: number | null; stdout: string; stderr: string; error?: Error };

export interface D1MoveDeps {
  wrangler: Wrangler;
  log: (line: string) => void;
  /** Directory holding .secrets/ (default: the repo root). */
  root?: string;
  loadManifest?: (name: string) => Manifest;
  env?: Readonly<Record<string, string | undefined>>;
  /** Today, for the export's file name (default: now). */
  today?: () => Date;
}

/** The wrangler binary of the repo's pinned version, run with node in an empty scratch directory (no config to find). */
export function defaultD1MoveDeps(): D1MoveDeps {
  const bin = join(repoRoot, 'apps', 'api', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  return {
    wrangler: (argv, env) => {
      if (!existsSync(bin)) throw new Error('apps/api has no wrangler: run corepack pnpm install first');
      const cwd = mkdtempSync(join(tmpdir(), 'hana-d1-move-'));
      try {
        const res = spawnSync(process.execPath, [bin, ...argv], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', ...(res.error ? { error: res.error } : {}) };
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    log: (line) => console.log(line),
  };
}

/** Environment for one side's wrangler: its account, its token if any, no debug log file (D269), no telemetry. */
export function sideEnv(side: Side): Record<string, string> {
  return { ...PRIVATE_WRANGLER_ENV, CLOUDFLARE_ACCOUNT_ID: side.accountId, ...(side.token ? { CLOUDFLARE_API_TOKEN: side.token } : {}) };
}

const profileArgs = (side: Side): string[] => (side.profile ? ['--profile', side.profile] : []);

export const exportArgv = (db: string, file: string, side: Side): string[] => ['d1', 'export', db, '--remote', `--output=${file}`, '--skip-confirmation', ...profileArgs(side)];
export const importArgv = (db: string, file: string, side: Side): string[] => ['d1', 'execute', db, '--remote', `--file=${file}`, '--yes', ...profileArgs(side)];
export const queryArgv = (db: string, sql: string, side: Side): string[] => ['d1', 'execute', db, '--remote', '--json', `--command=${sql}`, ...profileArgs(side)];

/** User tables (D1's own `_cf_*` and SQLite's `sqlite_*` aside), `d1_migrations` included. */
export const TABLES_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name";

const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

/** One SELECT counting every table's rows (table names checked, then quoted). */
export function countSql(tables: readonly string[]): string {
  if (tables.length === 0) throw new Error('No tables to count');
  for (const t of tables) if (!TABLE_NAME_RE.test(t)) throw new Error(`Unexpected table name ${JSON.stringify(t)}`);
  return tables.map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM "${t}"`).join(' UNION ALL ');
}

/** The rows of `wrangler d1 execute --json` (an array of statement results), concatenated (d1.ts's parser, redacted). */
export const parseRows = <Row>(stdout: string): Row[] => parseD1Json<Row>(stdout, true);

/** `.secrets/<env>/d1-export-<db>-<yyyymmdd>.sql`. */
export function exportFile(m: Manifest, db: D1Db, today: Date, root: string): string {
  const day = today.toISOString().slice(0, 10).replaceAll('-', '');
  return join(secretsDir(m.name, root), `d1-export-${db}-${day}.sql`);
}

/** Runs `d1-move <argv>`. */
export function d1Move(argv: readonly string[], deps: D1MoveDeps): void {
  const args = parseCli(argv, { strings: ['db', 'from-account', 'to-account', 'step', 'file', 'from-profile', 'to-profile'], booleans: ['yes', 'help'] });
  if (args.flag('help')) return void deps.log(D1_MOVE_USAGE);
  const [envName, ...rest] = args.positionals;
  if (!envName) throw new CliError('Expected <env>');
  if (rest.length) throw new CliError(`Unexpected argument ${rest.join(' ')}`);
  const db = args.required('db');
  if (!(D1_DBS as readonly string[]).includes(db)) throw new CliError(`--db must be one of ${D1_DBS.join(', ')}`);
  const step = args.str('step') ?? 'all';
  if (!(D1_STEPS as readonly string[]).includes(step)) throw new CliError(`--step must be one of ${D1_STEPS.join(', ')}`);
  const env = deps.env ?? process.env;
  const from = args.required('from-account');
  const to = args.str('to-account') ?? env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!to) throw new CliError('--to-account (or CLOUDFLARE_ACCOUNT_ID) is required: the new account');
  for (const [flag, id] of [['--from-account', from], ['--to-account', to]] as const) {
    if (!CLOUDFLARE_ACCOUNT_ID_RE.test(id)) throw new CliError(`${flag} must be a Cloudflare account id (32 lowercase hex characters)`);
  }
  if (from === to) throw new CliError('--from-account and --to-account are the same account');
  const m = (deps.loadManifest ?? loadEnv)(envName);
  if (m.network !== 'testnet') throw new Error(`envs/${m.name}.json is not a testnet env`);
  const target = d1Target(m, db as D1Db);
  if (target.accountId !== undefined && target.accountId !== to) {
    throw new Error(`--to-account ${to} is not ${target.accountField} ${target.accountId} in envs/${m.name}.json: the database moves to the account its Worker deploys to`);
  }
  if (target.accountId === from) throw new Error(`${target.accountField} is still the old account ${from}: commit the manifest's move first`);
  const root = deps.root ?? repoRoot;
  const oldSide: Side = { label: 'old', accountId: from, ...(args.str('from-profile') ? { profile: args.str('from-profile')! } : {}), ...(env.HANA_FROM_CLOUDFLARE_API_TOKEN ? { token: env.HANA_FROM_CLOUDFLARE_API_TOKEN } : {}) };
  const newSide: Side = { label: 'new', accountId: to, ...(args.str('to-profile') ? { profile: args.str('to-profile')! } : {}), ...(env.HANA_TO_CLOUDFLARE_API_TOKEN ? { token: env.HANA_TO_CLOUDFLARE_API_TOKEN } : {}) };
  const file = args.str('file') ?? exportFile(m, db as D1Db, (deps.today ?? (() => new Date()))(), root);
  const shown = relative(root, file) || file;
  const auth = (s: Side) => (s.token ? 'its API token' : s.profile ? `wrangler profile ${s.profile}` : "wrangler's login");
  const steps: Exclude<D1Step, 'all'>[] = step === 'all' ? ['export', 'import', 'compare'] : [step as Exclude<D1Step, 'all'>];

  deps.log(`Plan (env ${m.name}, D1 ${target.name}): ${steps.join(', ')}; old account ${from} (${auth(oldSide)}), new account ${to} (${auth(newSide)}); export file ${shown}.`);
  if (steps.includes('export')) deps.log(`  export: wrangler d1 export ${target.name} --remote --output=${shown} (old account; blocks the database's other requests while it runs)`);
  if (steps.includes('import')) deps.log(`  import: refused unless ${target.name} on the new account has no table; then wrangler d1 execute ${target.name} --remote --file=${shown} --yes (new account)`);
  if (steps.includes('compare')) deps.log('  compare: every table\'s row count in the export, on the new account and on the old one now, d1_migrations included');
  if (!args.flag('yes')) return void deps.log(DRY_RUN_LINE);

  const run = (side: Side, argv: string[], what: string): string => {
    const res = deps.wrangler(argv, sideEnv(side));
    if (res.error) throw new Error(`wrangler ${what} (${side.label} account) failed: ${res.error.message}`);
    if (res.status !== 0) throw new Error(`wrangler ${what} (${side.label} account) failed (exit ${res.status}):\n${redactQuoted(`${res.stdout}\n${res.stderr}`.trim()).slice(-2000)}`);
    return res.stdout;
  };
  const tables = (side: Side): string[] => parseRows<{ name: string }>(run(side, queryArgv(target.name, TABLES_SQL, side), 'd1 execute (tables)')).map((r) => r.name);

  if (steps.includes('export')) {
    if (existsSync(file)) throw new Error(`${shown} exists: refusing to overwrite an export (pass --file to import it, or move it away)`);
    ensureSecretDir(secretsDir(m.name, root));
    // Created 0600 first: wrangler writes into the existing file, which keeps its mode.
    writeFileSync(file, '', { mode: FILE_MODE, flag: 'wx' });
    chmodSync(file, FILE_MODE);
    run(oldSide, exportArgv(target.name, file, oldSide), 'd1 export');
    chmodSync(file, FILE_MODE);
    deps.log(`Exported ${target.name} (old account) to ${shown} (0600; it holds the database's rows: delete it once the move is checked).`);
  }
  if (steps.includes('import')) {
    if (!existsSync(file)) throw new Error(`${shown} doesn't exist: export first (--step export), or pass --file`);
    const existing = tables(newSide);
    if (existing.length) {
      throw new Error(`${target.name} on the new account already has tables (${existing.join(', ')}): import only into a new, empty database (the export carries the schema and d1_migrations; never run migrations apply first)`);
    }
    run(newSide, importArgv(target.name, file, newSide), 'd1 execute --file (import)');
    deps.log(`Imported ${shown} into ${target.name} (new account).`);
  }
  if (steps.includes('compare')) {
    if (!existsSync(file)) throw new Error(`${shown} doesn't exist: compare checks the new database against the export (pass --file)`);
    const exported = exportCounts(readFileSync(file, 'utf8'));
    const newTables = tables(newSide);
    const oldTables = tables(oldSide);
    const counts = (side: Side, list: string[]) =>
      new Map(list.length ? parseRows<{ t: string; n: number }>(run(side, queryArgv(target.name, countSql(list), side), 'd1 execute (counts)')).map((r) => [r.t, Number(r.n)]) : []);
    const newCounts = counts(newSide, newTables);
    const oldCounts = counts(oldSide, oldTables);
    const all = [...new Set([...exported.keys(), ...newTables, ...oldTables])].sort();
    const missing: string[] = [];
    const since: string[] = [];
    for (const t of all) {
      const e = exported.get(t);
      const n = newCounts.get(t);
      const o = oldCounts.get(t);
      if (n !== e) missing.push(t);
      if (o !== e) since.push(t);
      deps.log(`  ${t}: export ${e ?? 'no table'}, new ${n ?? 'no table'}, old now ${o ?? 'no table'}${n !== e ? '  <- the import differs' : o !== e ? '  (old changed since the export)' : ''}`);
    }
    if (!all.includes('d1_migrations')) deps.log('  (no d1_migrations table: this database has never had a migration applied)');
    if (missing.length) throw new Error(`The new database differs from the export in ${missing.join(', ')}: the import stopped part way, or something wrote to the new database (re-import into a fresh, empty one)`);
    deps.log(`The new database matches the export in all ${all.length} tables.`);
    if (since.length) {
      deps.log(
        `The old database changed since the export in ${since.join(', ')}: those writes are not on the new account. Expected for the crons' own tables while the old Workers run; ` +
          'for apps, origins, settings, users or the wallet directory, stop the writes (retire the old Workers) and repeat the export and import into a fresh database.',
      );
    }
  }
}

/**
 * The statements of an SQL file, split on `;` outside quotes: '…' strings (with '' inside), "…" identifiers, and
 * `--` comments, so a value holding a `;`, a quote or a line starting with INSERT never splits or starts a statement.
 */
export function sqlStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      const end = sql.indexOf(c, i + 1);
      if (end < 0) break;
      // '' (or "") inside a literal is an escaped quote: the loop simply reopens at the next character.
      i = end + 1;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl + 1;
      continue;
    }
    if (c === ';') {
      out.push(sql.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter((st) => st.length > 0);
}

const IDENT = String.raw`(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_]*))`;
const INSERT_RE = new RegExp(String.raw`^INSERT\s+INTO\s+${IDENT}`, 'iu');
const CREATE_RE = new RegExp(String.raw`^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}`, 'iu');

/**
 * Rows per table in a `wrangler d1 export` file (one `INSERT INTO "<table>" … VALUES(…)` statement per row), tables
 * created without rows at 0, D1's own `_cf_*` and SQLite's `sqlite_*` tables left out.
 */
export function exportCounts(sql: string): Map<string, number> {
  const out = new Map<string, number>();
  const name = (m: RegExpExecArray) => (m[1] !== undefined ? m[1].replaceAll('""', '"') : m[2]!);
  const internal = (t: string) => t.startsWith('_cf_') || t.startsWith('sqlite_');
  for (const st of sqlStatements(sql)) {
    const ins = INSERT_RE.exec(st);
    if (ins && !internal(name(ins))) out.set(name(ins), (out.get(name(ins)) ?? 0) + 1);
    const cr = CREATE_RE.exec(st);
    if (cr && !internal(name(cr)) && !out.has(name(cr))) out.set(name(cr), 0);
  }
  return out;
}
