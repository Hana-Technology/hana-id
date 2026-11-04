// The admin Worker's own state in the usage ledger's `ops` schema (docs/batch-c-spec.md "Usage ledger"; Neon through
// the `USAGE_DB` Hyperdrive binding, role `usage_admin`, which has SELECT, INSERT, UPDATE, DELETE on `ops` and nothing
// that writes the ledger itself):
//
//   ops.state           key → value: the feed's cursors (`feed.app_changes.seq`, `feed.audit_log.seq`) and the
//                       watcher's scope cursor (`watch.scope_cursor`), each with its `updated_at`.
//   ops.scope_snapshot  per scope: the owners, clients and allow_shared last seen on chain (the watcher's diff base).
//   ops.scope_watch     per (scope, pending change id): when the watcher first saw it and when its email was accepted.
//
// Every statement is parameterised; nothing here builds SQL from input. The store takes a `query` function, so the
// same code runs over `pg` in the Worker and over PGlite in test-ops/ (as the usage_admin role, on the real
// migrations).
import pg from 'pg';
import type { ScopeState } from './email/messages.ts';

export type Query = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

export interface WatchRow {
  changeId: number;
  notifiedAt: number | null;
}

export interface OpsStore {
  getState(keys: readonly string[]): Promise<Map<string, { value: string; updatedAt: number }>>;
  setState(key: string, value: string): Promise<void>;
  getSnapshot(scopeId: string): Promise<(ScopeState & { seenAt: number }) | null>;
  putSnapshot(scopeId: string, s: ScopeState, seenAt: number): Promise<void>;
  watchRows(scopeId: string): Promise<WatchRow[]>;
  /** Records that the watcher saw the change (first time only), and, with `notifiedAt`, that its email went out. */
  markWatch(scopeId: string, changeId: number, seenAt: number, notifiedAt: number | null): Promise<void>;
  close(): Promise<void>;
}

const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());

export function sqlOps(query: Query, close: () => Promise<void> = async () => {}): OpsStore {
  return {
    async getState(keys) {
      const rows = await query('SELECT key, value, updated_at FROM ops.state WHERE key = ANY($1::text[])', [keys]);
      return new Map(rows.map((r) => [String(r.key), { value: String(r.value), updatedAt: ms(r.updated_at) }]));
    },
    async setState(key, value) {
      await query('INSERT INTO ops.state (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', [key, value]);
    },
    async getSnapshot(scopeId) {
      const rows = await query('SELECT owners, clients, allow_shared, seen_at FROM ops.scope_snapshot WHERE scope_id = $1', [scopeId]);
      const r = rows[0];
      if (!r) return null;
      const parse = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);
      return { owners: parse(r.owners) as unknown[], clients: parse(r.clients) as [string, string][], allowShared: r.allow_shared === true, seenAt: ms(r.seen_at) };
    },
    async putSnapshot(scopeId, s, seenAt) {
      await query(
        `INSERT INTO ops.scope_snapshot (scope_id, owners, clients, allow_shared, seen_at) VALUES ($1, $2::jsonb, $3::jsonb, $4, to_timestamp($5::double precision / 1000))
         ON CONFLICT (scope_id) DO UPDATE SET owners = EXCLUDED.owners, clients = EXCLUDED.clients, allow_shared = EXCLUDED.allow_shared, seen_at = EXCLUDED.seen_at`,
        [scopeId, JSON.stringify(s.owners), JSON.stringify(s.clients), s.allowShared, seenAt],
      );
    },
    async watchRows(scopeId) {
      const rows = await query('SELECT change_id, notified_at FROM ops.scope_watch WHERE scope_id = $1', [scopeId]);
      return rows.map((r) => ({ changeId: Number(r.change_id), notifiedAt: r.notified_at === null || r.notified_at === undefined ? null : ms(r.notified_at) }));
    },
    async markWatch(scopeId, changeId, seenAt, notifiedAt) {
      await query(
        `INSERT INTO ops.scope_watch (scope_id, change_id, first_seen_at, notified_at)
         VALUES ($1, $2, to_timestamp($3::double precision / 1000), CASE WHEN $4::double precision IS NULL THEN NULL ELSE to_timestamp($4::double precision / 1000) END)
         ON CONFLICT (scope_id, change_id) DO UPDATE SET notified_at = COALESCE(ops.scope_watch.notified_at, EXCLUDED.notified_at)`,
        [scopeId, changeId, seenAt, notifiedAt],
      );
    },
    close,
  };
}

export const OPS_CONNECT_TIMEOUT_MS = 5_000;
export const OPS_QUERY_TIMEOUT_MS = 10_000;

/**
 * Where the cron gets its store: one `pg` connection for the run over the Hyperdrive binding (Hyperdrive pools the real
 * ones), closed after it. A property, so the workerd tests swap in an in-memory store; production never replaces it.
 * Null without the binding. Connection errors are thrown to the caller, which logs the class name only (a driver
 * message can name the host).
 */
export const opsSource = {
  async open(binding: Hyperdrive | undefined): Promise<OpsStore | null> {
    if (!binding) return null;
    const client = new pg.Client({ connectionString: binding.connectionString, connectionTimeoutMillis: OPS_CONNECT_TIMEOUT_MS, query_timeout: OPS_QUERY_TIMEOUT_MS });
    await client.connect();
    return sqlOps(
      async (sql, params) => (await client.query(sql, params)).rows as Record<string, unknown>[],
      () => client.end().catch(() => undefined),
    );
  },
};
