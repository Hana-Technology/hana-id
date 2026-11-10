// An in-memory D1 for the local stack: node:sqlite with apps/api's real migrations applied, behind the part of the D1
// API the API Worker's code uses (`prepare(sql).bind(...).first() / .all() / .run()`, and `batch`). Apps are real rows, so the
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
    return this.runSync();
  }

  runSync(): { success: true; meta: { changes: number }; results: Row[] } {
    const stmt = this.db.prepare(this.sql);
    // A read, or a statement with RETURNING, answers rows (D1's batch gives them in `results`; GET /v1/home/apps reads
    // its listing in one batch).
    if (/^\s*select\b/iu.test(this.sql) || /\breturning\b/iu.test(this.sql)) {
      const results = stmt.all(...this.args).map(plain);
      return { success: true, meta: { changes: results.length }, results };
    }
    const r = stmt.run(...this.args);
    return { success: true, meta: { changes: Number(r.changes) }, results: [] };
  }
}

export class D1Shim {
  readonly db: DatabaseSync;

  /** `migrations`: the directory whose `*.sql` files are applied in name order (apps/api's by default). */
  constructor(migrations: string = MIGRATIONS) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON');
    const dir = migrations.endsWith('/') ? migrations : `${migrations}/`;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) this.db.exec(readFileSync(`${dir}${file}`, 'utf8'));
  }

  prepare(sql: string): Statement {
    return new Statement(this.db, sql);
  }

  /** D1's batch: the statements in order, in one transaction (all or none). */
  async batch(statements: Statement[]): Promise<{ success: true; meta: { changes: number }; results: Row[] }[]> {
    this.db.exec('BEGIN');
    try {
      const out = statements.map((s) => s.runSync());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
