// Applies apps/api/migrations-usage to an env's Neon ledger (docs/batch-c-spec.md "Usage ledger"): in file order, one
// transaction per file, each recorded with its sha256 in hana_migrations.applied, under an advisory lock so two runs
// can't interleave. A file changed after it was applied, an applied file missing from the repo, or a gap refuses
// the whole run. Connection: the owner role over the direct (non-pooled) URL from .secrets/<env>/neon.json; the URL
// and its password are never printed.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MigrationFile {
  name: string;
  sql: string;
  sha256: string;
}

/** What the runner needs from a connection (pg's Client and PGlite both fit it through a small adapter). */
export interface SqlConn {
  /** One or more statements, no parameters. */
  exec(sql: string): Promise<void>;
  /** One statement with parameters. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

const NAME_RE = /^(\d{4})_[a-z0-9_]+\.sql$/u;
/** pg_advisory_xact_lock key: a fixed number for "hana-id usage migrations". */
const LOCK_KEY = 7_310_026_001;

export function readMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  files.forEach((f, i) => {
    const m = NAME_RE.exec(f);
    if (!m) throw new Error(`${f}: migration files are named NNNN_lowercase_words.sql`);
    if (Number(m[1]) !== i + 1) throw new Error(`${f}: migrations are numbered 0001, 0002, … without gaps or repeats`);
  });
  return files.map((name) => {
    const sql = readFileSync(join(dir, name), 'utf8');
    return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
  });
}

const TRACKING_DDL = `CREATE SCHEMA IF NOT EXISTS hana_migrations;
REVOKE ALL ON SCHEMA hana_migrations FROM PUBLIC;
CREATE TABLE IF NOT EXISTS hana_migrations.applied (
  name       text PRIMARY KEY,
  sha256     text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);`;

async function applied(db: SqlConn): Promise<{ name: string; sha256: string }[]> {
  const exists = await db.query<{ r: string | null }>("SELECT to_regclass('hana_migrations.applied')::text AS r");
  if (!exists[0]?.r) return [];
  return db.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM hana_migrations.applied ORDER BY name');
}

/** The files still to apply, after checking the applied ones are an unchanged prefix of the repo's. */
export async function pendingMigrations(db: SqlConn, files: MigrationFile[]): Promise<MigrationFile[]> {
  const done = await applied(db);
  done.forEach((row, i) => {
    const file = files[i];
    if (!file || file.name !== row.name) throw new Error(`Applied migration ${row.name} is not the repo's file #${i + 1} (${file?.name ?? 'none'}): the database and the repo disagree`);
    if (file.sha256 !== row.sha256) throw new Error(`${row.name} changed after it was applied (sha256 ${row.sha256.slice(0, 12)}… → ${file.sha256.slice(0, 12)}…); add a new migration instead`);
  });
  return files.slice(done.length);
}

/** Applies the pending files, each in its own transaction with its tracking row. Returns the names applied. */
export async function applyMigrations(db: SqlConn, files: MigrationFile[], log: (line: string) => void = () => undefined): Promise<string[]> {
  await db.exec(TRACKING_DDL);
  const out: string[] = [];
  for (const file of await pendingMigrations(db, files)) {
    await db.exec('BEGIN');
    try {
      await db.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      // Another run may have applied it while this one waited for the lock.
      const already = await db.query('SELECT 1 FROM hana_migrations.applied WHERE name = $1', [file.name]);
      if (already.length) {
        await db.exec('ROLLBACK');
        throw new Error(`${file.name} was applied by another run meanwhile; run again to re-check`);
      }
      await db.exec(file.sql);
      await db.query('INSERT INTO hana_migrations.applied (name, sha256) VALUES ($1, $2)', [file.name, file.sha256]);
      await db.exec('COMMIT');
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => undefined);
      throw e;
    }
    log(`applied ${file.name}`);
    out.push(file.name);
  }
  return out;
}

/**
 * Why `url` can't be the ledger's owner connection, or null: a postgres(ql) URL with a user and password, on Neon in
 * Sydney (`*.ap-southeast-2.aws.neon.tech`, D73), the direct endpoint (Neon's pooler, `-pooler` in the host, runs in
 * transaction mode and is for the Workers' Hyperdrive, not DDL), with TLS required.
 */
export function ownerUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'is not a URL';
  }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') return 'must be a postgresql:// URL';
  if (!u.username || !u.password) return 'must name the owner role and its password';
  if (!u.hostname.endsWith('.ap-southeast-2.aws.neon.tech')) return 'must be a Neon endpoint in aws-ap-southeast-2 (D73)';
  if (u.hostname.split('.')[0]!.endsWith('-pooler')) return 'must be the direct endpoint (DATABASE_URL_DIRECT), not the pooler';
  const ssl = u.searchParams.get('sslmode');
  if (ssl !== 'require' && ssl !== 'verify-full') return 'must require TLS (sslmode=require or verify-full)';
  return null;
}

export const USAGE_MIGRATE_USAGE = `Usage: usage-migrate.ts <env> [--yes]
  Applies apps/api/migrations-usage to the env's Neon ledger as the owner role, over DATABASE_URL_DIRECT from
  .secrets/<env>/neon.json. Without --yes, lists the pending files and changes nothing.`;

export interface UsageMigrateDeps {
  /** .secrets/<env>/neon.json, read with the 0600 check; undefined when absent. */
  readNeonSecrets(env: string): { DATABASE_URL_DIRECT?: unknown } | undefined;
  /** Opens the owner connection. */
  connect(url: string): Promise<SqlConn & { close(): Promise<void> }>;
  migrationsDir: string;
  log(line: string): void;
}

/** The usage-migrate command: validates the env name, reads and checks the URL, then lists or applies. */
export async function usageMigrate(argv: string[], deps: UsageMigrateDeps, validateEnv: (name: string) => void): Promise<string[]> {
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const flags = argv.filter((a) => a.startsWith('--'));
  if (positionals.length !== 1 || flags.some((f) => f !== '--yes')) throw new Error(USAGE_MIGRATE_USAGE);
  const env = positionals[0]!;
  validateEnv(env);
  const url = deps.readNeonSecrets(env)?.DATABASE_URL_DIRECT;
  if (typeof url !== 'string') throw new Error(`.secrets/${env}/neon.json has no DATABASE_URL_DIRECT (docs/operations.md "Secrets")`);
  const problem = ownerUrlProblem(url);
  if (problem) throw new Error(`DATABASE_URL_DIRECT in .secrets/${env}/neon.json ${problem}`);

  const files = readMigrations(deps.migrationsDir);
  let db: (SqlConn & { close(): Promise<void> }) | undefined;
  try {
    db = await deps.connect(url);
    if (!flags.includes('--yes')) {
      const pending = await pendingMigrations(db, files);
      deps.log(pending.length ? `pending on ${env}: ${pending.map((f) => f.name).join(', ')} (run again with --yes to apply)` : `${env} is up to date (${files.length} applied)`);
      return [];
    }
    const done = await applyMigrations(db, files, deps.log);
    deps.log(done.length ? `${env}: applied ${done.length} migration(s)` : `${env} is up to date (${files.length} applied)`);
    return done;
  } catch (e) {
    throw new Error(redact(e instanceof Error ? e.message : String(e), url));
  } finally {
    await db?.close().catch(() => undefined);
  }
}

/** An error message with the URL and its password removed (a driver error may quote either). */
export function redact(message: string, url: string): string {
  let out = message.split(url).join('<url>');
  try {
    const { password } = new URL(url);
    if (password) out = out.split(decodeURIComponent(password)).join('<password>').split(password).join('<password>');
  } catch {
    // not a URL: nothing more to redact
  }
  return out;
}
