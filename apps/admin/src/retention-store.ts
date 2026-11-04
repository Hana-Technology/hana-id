// The monthly retention job's reads and writes of the usage ledger (migrations-usage 0007; batch C13), as the
// `usage_admin` role over the same connection as the rest of the 15-minute run (ledger.ts). The role may only call the
// retention functions (it can't update an event or delete an app_users row itself) and read and write the `ops` runs,
// state and erasure records. Every statement is parameterised.
import type { RetentionStatus } from '@hana-id/console-core';
import type { Query } from './ops.ts';

const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());
const msOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : ms(v));
const iso = (t: number): string => new Date(t).toISOString();
const num = (v: unknown): number => Number(v ?? 0);

export type RetentionRows = Record<string, number | string | null | Record<string, number | string | null>>;

export interface RetentionRun {
  id: number;
  month: string;
  startedAt: number;
  finishedAt: number | null;
  status: RetentionStatus;
  rows: RetentionRows;
  error: string | null;
  alertedAt: number | null;
}

export interface Erasure {
  id: number;
  at: number;
  ticket: string;
  operator: string;
  scopeId: string;
  rows: Record<string, unknown>;
}

export interface RetentionStore {
  /** Closes runs still `running` that started before `before` (a run killed mid-way) as failed; their ids. */
  closeStale(before: number, now: number): Promise<number[]>;
  /** The month's latest run (any status), or null. */
  latestRun(month: string): Promise<RetentionRun | null>;
  /** Whether the month has a complete (`ok`) run. */
  monthDone(month: string): Promise<boolean>;
  /** A new `running` run; null when another run is running (the one-running index). */
  startRun(month: string, now: number): Promise<number | null>;
  finishRun(id: number, status: Exclude<RetentionStatus, 'running'>, rows: RetentionRows, error: string | null, now: number): Promise<void>;
  runs(limit: number): Promise<RetentionRun[]>;
  unalertedFailures(limit: number): Promise<RetentionRun[]>;
  markAlerted(ids: number[], now: number): Promise<void>;
  getState(key: string): Promise<string | null>;
  setState(key: string, value: string): Promise<void>;
  // the Neon functions
  stripUids(maxRows: number): Promise<{ events: number; appUsers: number; more: boolean }>;
  dropExpiredPartitions(): Promise<{ partitions: number; settlements: number; identityTokens: number; emailCounts: number; settlementAlerts: number; settlementTries: number }>;
  purgeOps(): Promise<{ nonceChecks: number; rejectionAlerts: number; scopeWatch: number; retentionRuns: number; erasures: number }>;
  purgeAppUsers(appId: string): Promise<number>;
  due(): Promise<{ statements: number; rates: number; rateOverrides: number; oldestStatement: string | null }>;
  erasures(limit: number): Promise<Erasure[]>;
}

const runOf = (r: Record<string, unknown>): RetentionRun => ({
  id: Number(r.id),
  month: String(r.month),
  startedAt: ms(r.started_at),
  finishedAt: msOrNull(r.finished_at),
  status: r.status as RetentionStatus,
  rows: (typeof r.rows === 'string' ? JSON.parse(r.rows) : (r.rows ?? {})) as RetentionRows,
  error: r.error === null || r.error === undefined ? null : String(r.error),
  alertedAt: msOrNull(r.alerted_at),
});

const RUN_COLUMNS = "id::text AS id, to_char(month, 'YYYY-MM') AS month, started_at, finished_at, status, rows, error, alerted_at";

export function sqlRetention(query: Query): RetentionStore {
  return {
    async closeStale(before, now) {
      const rows = await query(
        "UPDATE ops.retention_runs SET status = 'failed', finished_at = $2::timestamptz, error = 'abandoned: the run did not finish' WHERE status = 'running' AND started_at < $1::timestamptz RETURNING id::text AS id",
        [iso(before), iso(now)],
      );
      return rows.map((r) => Number(r.id));
    },
    async latestRun(month) {
      const [r] = await query(`SELECT ${RUN_COLUMNS} FROM ops.retention_runs WHERE month = $1::date ORDER BY started_at DESC, id DESC LIMIT 1`, [`${month}-01`]);
      return r ? runOf(r) : null;
    },
    async monthDone(month) {
      return (await query("SELECT 1 AS x FROM ops.retention_runs WHERE month = $1::date AND status = 'ok' LIMIT 1", [`${month}-01`])).length > 0;
    },
    async startRun(month, now) {
      try {
        const [r] = await query('INSERT INTO ops.retention_runs (started_at, month) VALUES ($1::timestamptz, $2::date) RETURNING id::text AS id', [iso(now), `${month}-01`]);
        return r ? Number(r.id) : null;
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code === '23505') return null;
        throw err;
      }
    },
    async finishRun(id, status, rows, error, now) {
      await query("UPDATE ops.retention_runs SET status = $2, rows = $3::jsonb, error = $4, finished_at = $5::timestamptz WHERE id = $1::bigint AND status = 'running'", [
        String(id),
        status,
        JSON.stringify(rows),
        error,
        iso(now),
      ]);
    },
    async runs(limit) {
      return (await query(`SELECT ${RUN_COLUMNS} FROM ops.retention_runs ORDER BY started_at DESC, id DESC LIMIT $1`, [limit])).map(runOf);
    },
    async unalertedFailures(limit) {
      return (await query(`SELECT ${RUN_COLUMNS} FROM ops.retention_runs WHERE status = 'failed' AND alerted_at IS NULL ORDER BY started_at, id LIMIT $1`, [limit])).map(runOf);
    },
    async markAlerted(ids, now) {
      if (ids.length) await query("UPDATE ops.retention_runs SET alerted_at = $2::timestamptz WHERE id = ANY($1::bigint[]) AND status = 'failed' AND alerted_at IS NULL", [ids.map(String), iso(now)]);
    },
    async getState(key) {
      const [r] = await query('SELECT value FROM ops.state WHERE key = $1', [key]);
      return r ? String(r.value) : null;
    },
    async setState(key, value) {
      await query('INSERT INTO ops.state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', [key, value]);
    },

    async stripUids(maxRows) {
      const [r] = await query('SELECT events::text AS events, app_users::text AS app_users, more FROM usage.strip_uids($1)', [maxRows]);
      return { events: num(r?.events), appUsers: num(r?.app_users), more: r?.more === true };
    },
    async dropExpiredPartitions() {
      const [r] = await query(
        'SELECT partitions, settlements::text AS settlements, identity_tokens::text AS identity_tokens, email_counts::text AS email_counts, settlement_alerts::text AS settlement_alerts, settlement_tries::text AS settlement_tries FROM usage.drop_expired_partitions()',
        [],
      );
      return {
        partitions: num(r?.partitions),
        settlements: num(r?.settlements),
        identityTokens: num(r?.identity_tokens),
        emailCounts: num(r?.email_counts),
        settlementAlerts: num(r?.settlement_alerts),
        settlementTries: num(r?.settlement_tries),
      };
    },
    async purgeOps() {
      const [r] = await query(
        'SELECT nonce_checks::text AS nonce_checks, rejection_alerts::text AS rejection_alerts, scope_watch::text AS scope_watch, retention_runs::text AS retention_runs, erasures::text AS erasures FROM ops.purge_expired()',
        [],
      );
      return { nonceChecks: num(r?.nonce_checks), rejectionAlerts: num(r?.rejection_alerts), scopeWatch: num(r?.scope_watch), retentionRuns: num(r?.retention_runs), erasures: num(r?.erasures) };
    },
    async purgeAppUsers(appId) {
      const [r] = await query('SELECT usage.purge_app_users($1)::text AS n', [appId]);
      return num(r?.n);
    },
    async due() {
      const [r] = await query('SELECT statements::text AS statements, rates::text AS rates, rate_overrides::text AS rate_overrides, oldest_statement FROM usage.retention_due()', []);
      return { statements: num(r?.statements), rates: num(r?.rates), rateOverrides: num(r?.rate_overrides), oldestStatement: r?.oldest_statement === null || r?.oldest_statement === undefined ? null : String(r.oldest_statement) };
    },
    async erasures(limit) {
      const rows = await query('SELECT id::text AS id, at, ticket, operator, scope_id, rows FROM ops.erasures ORDER BY at DESC, id DESC LIMIT $1', [limit]);
      return rows.map((r) => ({
        id: Number(r.id),
        at: ms(r.at),
        ticket: String(r.ticket),
        operator: String(r.operator),
        scopeId: String(r.scope_id),
        rows: (typeof r.rows === 'string' ? JSON.parse(r.rows) : (r.rows ?? {})) as Record<string, unknown>,
      }));
    },
  };
}
