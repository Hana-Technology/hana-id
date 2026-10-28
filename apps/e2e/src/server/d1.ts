// An in-memory D1 for the local stack: node:sqlite with apps/api's real migrations applied, behind the part of the D1
// API the API Worker's code uses (`prepare(sql).bind(...).first() / .all() / .run()`). Apps are real rows, so the
// vault page is rendered by apps/api's handleVaultPage from the same SQL it runs on D1.
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../../../api/migrations/', import.meta.url));

type Row = Record<string, unknown>;

/** node:sqlite rows have a null prototype; the API code spreads and compares them as plain objects. */
const plain = (row: unknown): Row => ({ ...(row as Row) });

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly args: readonly SQLInputValue[] = [],
  ) {}

  bind(...args: unknown[]): Statement {
    return new Statement(this.db, this.sql, args.map((a) => (typeof a === 'boolean' ? Number(a) : a) as SQLInputValue));
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.args);
    if (row === undefined) return null;
    return (column === undefined ? plain(row) : plain(row)[column]) as T;
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true }> {
    return { results: this.db.prepare(this.sql).all(...this.args).map(plain) as T[], success: true };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(r.changes) } };
  }
}

export class D1Shim {
  readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON');
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) this.db.exec(readFileSync(`${MIGRATIONS}${file}`, 'utf8'));
  }

  prepare(sql: string): Statement {
    return new Statement(this.db, sql);
  }
}
