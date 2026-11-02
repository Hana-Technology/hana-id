// The hot DB as the RPC writers see it (docs/batch-c-spec.md §RPC "Hot-DB budget"): every read and the one batch go
// through here, so a ConsoleRpc call is held to at most two reads and one batch of at most eight statements, and the
// tests can count what each method issues. Going over is a bug in the method (it throws before the query runs), never a
// partner's doing: the partner-facing limit is the token bucket in the RateLimiter object (changes/guard.ts).
import { type Q, prepare } from './sql.ts';

export interface HotDbLimits {
  reads: number;
  batches: number;
  statements: number;
}

/** ConsoleRpc's per-call ceiling (spec §RPC "Hot-DB budget"). */
export const CONSOLE_LIMITS: HotDbLimits = { reads: 2, batches: 1, statements: 8 };

export class BudgetExceededError extends Error {
  constructor(what: string) {
    super(`hot-DB budget exceeded: ${what}`);
    this.name = 'BudgetExceededError';
  }
}

/** Counts (and, with limits, caps) the statements of one RPC call. A read batch counts as the call's batch. */
export class HotDb {
  reads = 0;
  batches = 0;
  statements = 0;
  /** Test hook (fault injection): the batch statement at this index is replaced by one that fails. */
  faultAt?: number;

  constructor(
    readonly db: D1Database,
    readonly limits?: HotDbLimits,
  ) {}

  private read(): void {
    this.reads++;
    this.statements++;
    if (this.limits && this.reads > this.limits.reads) throw new BudgetExceededError(`more than ${this.limits.reads} reads`);
  }

  async first<T>(s: Q): Promise<T | null> {
    this.read();
    return prepare(this.db, s).first<T>();
  }

  async all<T>(s: Q): Promise<T[]> {
    this.read();
    return (await prepare(this.db, s).all<T>()).results;
  }

  /** One D1 batch: a single serialised transaction (all or nothing). */
  async batch(stmts: readonly Q[]): Promise<D1Result[]> {
    this.batches++;
    this.statements += stmts.length;
    if (this.limits && this.batches > this.limits.batches) throw new BudgetExceededError(`more than ${this.limits.batches} batch`);
    if (this.limits && stmts.length > this.limits.statements) throw new BudgetExceededError(`a batch of ${stmts.length} statements`);
    const prepared = stmts.map((s, i) => (i === this.faultAt ? this.db.prepare('INSERT INTO fault_injected_no_such_table VALUES (1)') : prepare(this.db, s)));
    return this.db.batch(prepared);
  }
}
