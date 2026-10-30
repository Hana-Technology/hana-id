// The ledger tests' database (D140): PGlite (Postgres 18 compiled to WASM, in process, no network or container) by
// default; a real Postgres through `pg` when USAGE_TEST_DATABASE_URL points at a superuser connection to a local
// server (a container; never Neon). Each test file gets a fresh database with every migration applied.
import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export const MIGRATIONS_DIR = new URL('../migrations-usage/', import.meta.url).pathname;

export interface TestDb {
  /** Runs a script of one or more statements without parameters. */
  exec(sql: string): Promise<void>;
  /** Runs one statement with parameters and returns its rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs `fn` with the session's role set to `role` (as Hyperdrive's connection for that role would run). */
  asRole<T>(role: 'usage_writer' | 'usage_admin', fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(MIGRATIONS_DIR + name, 'utf8') }));
}

function withRole(db: Omit<TestDb, 'asRole'>): TestDb {
  return {
    ...db,
    async asRole(role, fn) {
      await db.exec(`SET ROLE ${role}`);
      try {
        return await fn();
      } finally {
        await db.exec('RESET ROLE');
      }
    },
  };
}

async function pgliteDb(): Promise<TestDb> {
  const db = new PGlite();
  return withRole({
    exec: async (sql) => void (await db.exec(sql)),
    query: async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows,
    close: () => db.close(),
  });
}

async function realDb(url: string): Promise<TestDb> {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const name = `hana_usage_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: target.toString() });
  await client.connect();
  return withRole({
    exec: async (sql) => void (await client.query(sql)),
    query: async <T>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[],
    close: async () => {
      await client.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    },
  });
}

/** A fresh database, with every migration in migrations-usage applied unless `migrate` is false. */
export async function freshDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const url = process.env.USAGE_TEST_DATABASE_URL;
  const db = url ? await realDb(url) : await pgliteDb();
  if (opts.migrate !== false) for (const m of migrationFiles()) await db.exec(m.sql);
  return db;
}

/** The SQLSTATE and message of a statement's failure, or null when it succeeded. */
export async function failure(p: Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code ?? '', message: err.message ?? String(e) };
  }
}
