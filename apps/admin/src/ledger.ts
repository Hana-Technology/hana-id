// The admin Worker's reads and writes of the usage ledger for batch C12 (docs/batch-c-spec.md "Usage ledger",
// "Settlement", "Daily nonce cross-check", "Rejection-rate check", "Reports", "Monthly statements"), as the
// `usage_admin` role over the `USAGE_DB` Hyperdrive binding. What the role may do is its grants (migrations-usage 0001
// and 0006): SELECT on `usage`, INSERT on gas_settlements, near_usd_rates (a fetched rate, never a replacement) and
// statements, the report functions, `usage.override_rate` (the audited override), and the `ops` tables. It can't
// update or delete an event, a settlement or a statement.
//
// Every statement is parameterised; nothing builds SQL from input. As ops.ts, the store takes a `query` function, so
// the same code runs over `pg` in the Worker and over PGlite in test-ops/ (as usage_admin, on the real migrations).
import { type LedgerSqlRow, type ReportSqlRow, type StatementSqlRow, type SupportLedgerReader, sqlSupportLedger } from '@hana-id/console-core';
import pg from 'pg';
import { type OpsStore, type Query, sqlOps } from './ops.ts';
import { type RetentionStore, sqlRetention } from './retention-store.ts';

const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());
const msOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : ms(v));
const iso = (t: number): string => new Date(t).toISOString();

export interface QueuedEvent {
  requestId: string;
  at: number;
  orgId: string;
  /** The event's endpoint: settlement holds a Home derive to the Home pool's keys and every other event to the other pools'. */
  endpoint: string;
  nearTx: string;
  relayerPk: string;
  relayerNonce: bigint;
}

export interface SettlementWrite {
  requestId: string;
  at: number;
  nearTx: string;
  result: 'final' | 'unsettled';
  gasBurnt?: bigint;
  tokensBurnt?: bigint;
  reason?: 'not_final' | 'duplicate_tx' | 'signer_mismatch';
}

export interface SettlementAlert {
  requestId: string;
  at: number;
  orgId: string;
  nearTx: string;
  reason: 'duplicate_tx' | 'signer_mismatch';
  detail: Record<string, unknown>;
  detectedAt: number;
  alertedAt: number | null;
}

export interface NonceCheck {
  relayerPk: string;
  checkedAt: number;
  chainNonce: bigint;
  explained: boolean;
  ledgerRelayedSinceLast: number;
  alertedAt: number | null;
  /** Why the check was taken as explained without the ledger: `capture_off`, `capture_on` (nonce-check.ts); else null. */
  reason: string | null;
}

export interface RejectionAlert {
  orgId: string;
  day: string;
  relayed: number;
  rejected: number;
  alertedAt: number | null;
}

export interface Rate {
  day: string;
  usdMicros: bigint;
  source: string;
  enteredBy: string | null;
  fetchedAt: number;
}

export interface RateOverride {
  id: number;
  day: string;
  usdMicros: bigint;
  previousUsdMicros: bigint | null;
  previousSource: string | null;
  enteredBy: string;
  reason: string;
  at: number;
}

export interface StatementInsert {
  orgId: string;
  month: string;
  asOf: number;
  csvKey: string;
  csvSha256: string;
  pdfKey: string;
  pdfSha256: string;
  totals: unknown;
  issuedBy: string;
}

export interface LedgerStore {
  // settlement
  settlementQueue(limit: number, now: number, retryAfterMs: number): Promise<QueuedEvent[]>;
  /** Relayed events (any org, any month) that carry this transaction hash. */
  relayedWithTx(nearTx: string): Promise<{ requestId: string; at: number; orgId: string }[]>;
  /** True when written; false when the event already had a settlement row (another run's). */
  recordSettlement(s: SettlementWrite): Promise<boolean>;
  recordTry(requestId: string, at: number, now: number, error: string): Promise<void>;
  addSettlementAlert(a: Omit<SettlementAlert, 'detectedAt' | 'alertedAt'>): Promise<void>;
  settlementAlerts(o: { unalertedOnly: boolean; limit: number }): Promise<SettlementAlert[]>;
  markSettlementAlerted(keys: { requestId: string; at: number }[], now: number): Promise<void>;
  settlementBacklog(): Promise<{ pending: number; oldestAt: number | null }>;
  // the nonce check
  lastNonceCheck(relayerPk: string): Promise<NonceCheck | null>;
  relayedWithNonce(relayerPk: string, nonce: bigint): Promise<boolean>;
  hasRelayedRows(relayerPk: string): Promise<boolean>;
  relayedSince(relayerPk: string, since: number | null, until: number): Promise<number>;
  recordNonceCheck(c: Omit<NonceCheck, 'alertedAt' | 'reason'> & { reason?: string | null }): Promise<void>;
  nonceChecks(o: { unalertedUnexplainedOnly: boolean; limit: number }): Promise<NonceCheck[]>;
  markNonceAlerted(keys: { relayerPk: string; checkedAt: number }[], now: number): Promise<void>;
  // rates
  ratesBetween(fromDay: string, toDay: string): Promise<Rate[]>;
  /** A fetched rate for a day that has none; false when the day already has one (never replaced). */
  insertFetchedRate(day: string, usdMicros: bigint, source: string): Promise<boolean>;
  overrideRate(day: string, usdMicros: bigint, enteredBy: string, reason: string): Promise<number>;
  rateOverrides(fromDay: string, toDay: string): Promise<RateOverride[]>;
  // rejection rate
  rejectionRates(day: string): Promise<{ orgId: string; relayed: number; rejected: number }[]>;
  addRejectionAlert(a: Omit<RejectionAlert, 'alertedAt'>): Promise<boolean>;
  rejectionAlerts(o: { unalertedOnly: boolean; limit: number }): Promise<RejectionAlert[]>;
  markRejectionAlerted(keys: { orgId: string; day: string }[], now: number): Promise<void>;
  // partitions
  ensurePartitions(monthsAhead: number): Promise<number>;
  /** Monthly partitions of usage.events after the current UTC month. */
  partitionsAhead(): Promise<number>;
  // reports and statements
  report(orgId: string, fromDay: string, toDay: string, by: 'day' | 'month', appIds: string[] | null, asOf: number | null): Promise<ReportSqlRow[]>;
  ledgerPage(orgId: string, month: string, asOf: number, after: string | null, limit: number): Promise<LedgerSqlRow[]>;
  statements(orgId: string): Promise<StatementSqlRow[]>;
  blockers(orgId: string, month: string): Promise<{ pending: number; missingRateDays: string[] }>;
  /** 'exists' when the org and month already have a statement (the primary key: the commit point). */
  insertStatement(s: StatementInsert): Promise<'ok' | 'exists'>;
  unnoticedStatements(limit: number): Promise<{ orgId: string; month: string; asOf: number; csvSha256: string; pdfSha256: string | null; issuedBy: string }[]>;
  markStatementNoticed(orgId: string, month: string): Promise<void>;
  /** `ops.state` on this connection (the 15-minute cron's last run, the System status page's reads; D425). */
  state: Pick<OpsStore, 'getState' | 'setState'>;
  /** The monthly retention job's runs, state and Neon functions (C13), over the same connection. */
  readonly retention: RetentionStore;
  /** The Support ID lookup's reads (C15): a uid's ok events, the request IDs' events (console-core support.ts). */
  readonly support: SupportLedgerReader;
  close(): Promise<void>;
}

const isUniqueViolation = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === '23505';

export function sqlLedger(query: Query, close: () => Promise<void> = async () => {}): LedgerStore {
  const nonceRow = (r: Record<string, unknown>): NonceCheck => ({
    relayerPk: String(r.relayer_pk),
    checkedAt: ms(r.checked_at),
    chainNonce: BigInt(String(r.chain_nonce)),
    explained: r.explained === true,
    ledgerRelayedSinceLast: Number(r.ledger_relayed_since_last),
    alertedAt: msOrNull(r.alerted_at),
    reason: typeof r.reason === 'string' ? r.reason : null,
  });
  return {
    async settlementQueue(limit, now, retryAfterMs) {
      const rows = await query(
        `SELECT e.request_id, e.at, e.org_id, e.endpoint, e.near_tx, e.relayer_pk, e.relayer_nonce::text AS relayer_nonce
           FROM usage.events e
          WHERE e.relayed
            AND NOT EXISTS (SELECT 1 FROM usage.gas_settlements g WHERE g.request_id = e.request_id)
            AND NOT EXISTS (SELECT 1 FROM ops.settlement_tries t WHERE t.request_id = e.request_id AND t.at = e.at AND t.last_tried_at > $2::timestamptz)
          ORDER BY e.at, e.request_id
          LIMIT $1`,
        [limit, iso(now - retryAfterMs)],
      );
      return rows.map((r) => ({ requestId: String(r.request_id), at: ms(r.at), orgId: String(r.org_id), endpoint: String(r.endpoint), nearTx: String(r.near_tx), relayerPk: String(r.relayer_pk), relayerNonce: BigInt(String(r.relayer_nonce)) }));
    },
    async relayedWithTx(nearTx) {
      const rows = await query('SELECT request_id, at, org_id FROM usage.events WHERE relayed AND near_tx = $1 ORDER BY at, request_id LIMIT 20', [nearTx]);
      return rows.map((r) => ({ requestId: String(r.request_id), at: ms(r.at), orgId: String(r.org_id) }));
    },
    async recordSettlement(s) {
      const rows = await query(
        `INSERT INTO usage.gas_settlements (request_id, at, near_tx, result, gas_burnt, tokens_burnt, reason)
         VALUES ($1, $2::timestamptz, $3, $4, $5::bigint, $6::numeric, $7) ON CONFLICT (request_id) DO NOTHING RETURNING request_id`,
        [s.requestId, iso(s.at), s.nearTx, s.result, s.gasBurnt === undefined ? null : s.gasBurnt.toString(), s.tokensBurnt === undefined ? null : s.tokensBurnt.toString(), s.reason ?? null],
      );
      await query('DELETE FROM ops.settlement_tries WHERE request_id = $1 AND at = $2::timestamptz', [s.requestId, iso(s.at)]);
      return rows.length === 1;
    },
    async recordTry(requestId, at, now, error) {
      await query(
        `INSERT INTO ops.settlement_tries (request_id, at, tries, last_tried_at, last_error) VALUES ($1, $2::timestamptz, 1, $3::timestamptz, $4)
         ON CONFLICT (request_id, at) DO UPDATE SET tries = ops.settlement_tries.tries + 1, last_tried_at = EXCLUDED.last_tried_at, last_error = EXCLUDED.last_error`,
        [requestId, iso(at), iso(now), error.slice(0, 64)],
      );
    },
    async addSettlementAlert(a) {
      await query(
        `INSERT INTO ops.settlement_alerts (request_id, at, org_id, near_tx, reason, detail) VALUES ($1, $2::timestamptz, $3, $4, $5, $6::jsonb) ON CONFLICT (request_id, at) DO NOTHING`,
        [a.requestId, iso(a.at), a.orgId, a.nearTx, a.reason, JSON.stringify(a.detail)],
      );
    },
    async settlementAlerts(o) {
      const rows = await query(
        `SELECT request_id, at, org_id, near_tx, reason, detail, detected_at, alerted_at FROM ops.settlement_alerts
          WHERE NOT $1::boolean OR alerted_at IS NULL ORDER BY detected_at DESC, request_id LIMIT $2`,
        [o.unalertedOnly, o.limit],
      );
      return rows.map((r) => ({
        requestId: String(r.request_id),
        at: ms(r.at),
        orgId: String(r.org_id),
        nearTx: String(r.near_tx),
        reason: r.reason as SettlementAlert['reason'],
        detail: (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail) as Record<string, unknown>,
        detectedAt: ms(r.detected_at),
        alertedAt: msOrNull(r.alerted_at),
      }));
    },
    async markSettlementAlerted(keys, now) {
      for (const k of keys) await query('UPDATE ops.settlement_alerts SET alerted_at = $3::timestamptz WHERE request_id = $1 AND at = $2::timestamptz AND alerted_at IS NULL', [k.requestId, iso(k.at), iso(now)]);
    },
    async settlementBacklog() {
      const [r] = await query(
        `SELECT count(*)::text AS n, min(e.at) AS oldest FROM usage.events e
          WHERE e.relayed AND NOT EXISTS (SELECT 1 FROM usage.gas_settlements g WHERE g.request_id = e.request_id)`,
        [],
      );
      return { pending: Number(r?.n ?? 0), oldestAt: msOrNull(r?.oldest) };
    },

    async lastNonceCheck(relayerPk) {
      const [r] = await query('SELECT relayer_pk, checked_at, chain_nonce::text AS chain_nonce, explained, ledger_relayed_since_last, alerted_at, reason FROM ops.nonce_checks WHERE relayer_pk = $1 ORDER BY checked_at DESC LIMIT 1', [relayerPk]);
      return r ? nonceRow(r) : null;
    },
    async relayedWithNonce(relayerPk, nonce) {
      return (await query('SELECT 1 AS x FROM usage.events WHERE relayed AND relayer_pk = $1 AND relayer_nonce = $2::bigint LIMIT 1', [relayerPk, nonce.toString()])).length > 0;
    },
    async hasRelayedRows(relayerPk) {
      return (await query('SELECT 1 AS x FROM usage.events WHERE relayed AND relayer_pk = $1 LIMIT 1', [relayerPk])).length > 0;
    },
    async relayedSince(relayerPk, since, until) {
      const [r] = await query(
        'SELECT count(*)::text AS n FROM usage.events WHERE relayed AND relayer_pk = $1 AND ($2::timestamptz IS NULL OR received_at > $2::timestamptz) AND received_at <= $3::timestamptz',
        [relayerPk, since === null ? null : iso(since), iso(until)],
      );
      return Number(r?.n ?? 0);
    },
    async recordNonceCheck(c) {
      await query(
        `INSERT INTO ops.nonce_checks (relayer_pk, checked_at, chain_nonce, explained, ledger_relayed_since_last, reason) VALUES ($1, $2::timestamptz, $3::bigint, $4, $5, $6)
         ON CONFLICT (relayer_pk, checked_at) DO NOTHING`,
        [c.relayerPk, iso(c.checkedAt), c.chainNonce.toString(), c.explained, c.ledgerRelayedSinceLast, c.reason ?? null],
      );
    },
    async nonceChecks(o) {
      const rows = o.unalertedUnexplainedOnly
        ? await query('SELECT relayer_pk, checked_at, chain_nonce::text AS chain_nonce, explained, ledger_relayed_since_last, alerted_at, reason FROM ops.nonce_checks WHERE NOT explained AND alerted_at IS NULL ORDER BY checked_at, relayer_pk LIMIT $1', [o.limit])
        : await query(
            `SELECT DISTINCT ON (relayer_pk) relayer_pk, checked_at, chain_nonce::text AS chain_nonce, explained, ledger_relayed_since_last, alerted_at, reason
               FROM ops.nonce_checks ORDER BY relayer_pk, checked_at DESC LIMIT $1`,
            [o.limit],
          );
      return rows.map(nonceRow);
    },
    async markNonceAlerted(keys, now) {
      for (const k of keys) await query('UPDATE ops.nonce_checks SET alerted_at = $3::timestamptz WHERE relayer_pk = $1 AND checked_at = $2::timestamptz AND alerted_at IS NULL', [k.relayerPk, iso(k.checkedAt), iso(now)]);
    },

    async ratesBetween(fromDay, toDay) {
      const rows = await query("SELECT to_char(day, 'YYYY-MM-DD') AS day, usd_micros::text AS usd_micros, source, entered_by, fetched_at FROM usage.near_usd_rates WHERE day >= $1::date AND day <= $2::date ORDER BY day", [fromDay, toDay]);
      return rows.map((r) => ({ day: String(r.day), usdMicros: BigInt(String(r.usd_micros)), source: String(r.source), enteredBy: r.entered_by === null ? null : String(r.entered_by), fetchedAt: ms(r.fetched_at) }));
    },
    async insertFetchedRate(day, usdMicros, source) {
      const rows = await query('INSERT INTO usage.near_usd_rates (day, usd_micros, source) VALUES ($1::date, $2::bigint, $3) ON CONFLICT (day) DO NOTHING RETURNING day', [day, usdMicros.toString(), source]);
      return rows.length === 1;
    },
    async overrideRate(day, usdMicros, enteredBy, reason) {
      const [r] = await query('SELECT usage.override_rate($1::date, $2::bigint, $3, $4)::text AS id', [day, usdMicros.toString(), enteredBy, reason]);
      return Number(r?.id);
    },
    async rateOverrides(fromDay, toDay) {
      const rows = await query(
        `SELECT id::text AS id, to_char(day, 'YYYY-MM-DD') AS day, usd_micros::text AS usd_micros, previous_usd_micros::text AS previous_usd_micros, previous_source, entered_by, reason, at
           FROM usage.rate_overrides WHERE day >= $1::date AND day <= $2::date ORDER BY at DESC, id DESC LIMIT 500`,
        [fromDay, toDay],
      );
      return rows.map((r) => ({
        id: Number(r.id),
        day: String(r.day),
        usdMicros: BigInt(String(r.usd_micros)),
        previousUsdMicros: r.previous_usd_micros === null ? null : BigInt(String(r.previous_usd_micros)),
        previousSource: r.previous_source === null ? null : String(r.previous_source),
        enteredBy: String(r.entered_by),
        reason: String(r.reason),
        at: ms(r.at),
      }));
    },

    async rejectionRates(day) {
      const rows = await query('SELECT org_id, relayed::text AS relayed, rejected::text AS rejected FROM usage.rejection_rates($1::date)', [day]);
      return rows.map((r) => ({ orgId: String(r.org_id), relayed: Number(r.relayed), rejected: Number(r.rejected) }));
    },
    async addRejectionAlert(a) {
      const rows = await query('INSERT INTO ops.rejection_alerts (org_id, day, relayed, rejected) VALUES ($1, $2::date, $3, $4) ON CONFLICT (org_id, day) DO NOTHING RETURNING org_id', [a.orgId, a.day, a.relayed, a.rejected]);
      return rows.length === 1;
    },
    async rejectionAlerts(o) {
      const rows = await query(
        "SELECT org_id, to_char(day, 'YYYY-MM-DD') AS day, relayed::text AS relayed, rejected::text AS rejected, alerted_at FROM ops.rejection_alerts WHERE NOT $1::boolean OR alerted_at IS NULL ORDER BY day DESC, org_id LIMIT $2",
        [o.unalertedOnly, o.limit],
      );
      return rows.map((r) => ({ orgId: String(r.org_id), day: String(r.day), relayed: Number(r.relayed), rejected: Number(r.rejected), alertedAt: msOrNull(r.alerted_at) }));
    },
    async markRejectionAlerted(keys, now) {
      for (const k of keys) await query('UPDATE ops.rejection_alerts SET alerted_at = $3::timestamptz WHERE org_id = $1 AND day = $2::date AND alerted_at IS NULL', [k.orgId, k.day, iso(now)]);
    },

    async ensurePartitions(monthsAhead) {
      const [r] = await query('SELECT usage.ensure_partitions($1) AS n', [monthsAhead]);
      return Number(r?.n ?? 0);
    },
    async partitionsAhead() {
      const [r] = await query(
        `SELECT count(*)::text AS n FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'usage.events'::regclass AND c.relname > 'events_' || to_char(now() AT TIME ZONE 'UTC', 'YYYY_MM')`,
        [],
      );
      return Number(r?.n ?? 0);
    },

    async report(orgId, fromDay, toDay, by, appIds, asOf) {
      return (await query('SELECT * FROM usage.org_report($1, $2::date, $3::date, $4, $5::text[], $6::timestamptz)', [orgId, fromDay, toDay, by, appIds, asOf === null ? null : iso(asOf)])) as unknown as ReportSqlRow[];
    },
    async ledgerPage(orgId, month, asOf, after, limit) {
      return (await query('SELECT * FROM usage.org_ledger_full($1, $2::date, $3::timestamptz, $4, $5)', [orgId, `${month}-01`, iso(asOf), after, limit])) as unknown as LedgerSqlRow[];
    },
    async statements(orgId) {
      return (await query('SELECT * FROM usage.org_statements($1)', [orgId])) as unknown as StatementSqlRow[];
    },
    async blockers(orgId, month) {
      const [r] = await query('SELECT pending::text AS pending, missing_rate_days FROM usage.statement_blockers($1, $2::date)', [orgId, `${month}-01`]);
      const days = r?.missing_rate_days;
      return { pending: Number(r?.pending ?? 0), missingRateDays: Array.isArray(days) ? days.map(String) : [] };
    },
    async insertStatement(s) {
      try {
        await query(
          `INSERT INTO usage.statements (org_id, month, as_of, csv_key, csv_sha256, pdf_key, pdf_sha256, totals, issued_by)
           VALUES ($1, $2::date, $3::timestamptz, $4, decode($5, 'hex'), $6, decode($7, 'hex'), $8::jsonb, $9)`,
          [s.orgId, `${s.month}-01`, iso(s.asOf), s.csvKey, s.csvSha256, s.pdfKey, s.pdfSha256, JSON.stringify(s.totals), s.issuedBy],
        );
        return 'ok';
      } catch (err) {
        if (isUniqueViolation(err)) return 'exists';
        throw err;
      }
    },
    async unnoticedStatements(limit) {
      const rows = await query(
        `SELECT s.org_id, to_char(s.month, 'YYYY-MM') AS month, s.as_of, encode(s.csv_sha256, 'hex') AS csv_sha256, encode(s.pdf_sha256, 'hex') AS pdf_sha256, s.issued_by
           FROM usage.statements s
          WHERE NOT EXISTS (SELECT 1 FROM ops.statement_notices n WHERE n.org_id = s.org_id AND n.month = s.month)
          ORDER BY s.issued_at, s.org_id LIMIT $1`,
        [limit],
      );
      return rows.map((r) => ({ orgId: String(r.org_id), month: String(r.month), asOf: ms(r.as_of), csvSha256: String(r.csv_sha256), pdfSha256: r.pdf_sha256 === null ? null : String(r.pdf_sha256), issuedBy: String(r.issued_by) }));
    },
    async markStatementNoticed(orgId, month) {
      await query('INSERT INTO ops.statement_notices (org_id, month) VALUES ($1, $2::date) ON CONFLICT DO NOTHING', [orgId, `${month}-01`]);
    },
    retention: sqlRetention(query),
    support: sqlSupportLedger(query),
    state: sqlOps(query),
    close,
  };
}

export const LEDGER_CONNECT_TIMEOUT_MS = 5_000;
/** The admin role's statement_timeout is 60 s (a statement's report queries are the slowest). */
export const LEDGER_QUERY_TIMEOUT_MS = 60_000;

/**
 * One `pg` connection for a cron run or a staff request over the Hyperdrive binding, closed after it. A property, so the
 * workerd tests swap in their own store; production never replaces it. Null without the binding. Connection errors are
 * thrown to the caller, which logs the class name only.
 */
export const ledgerSource = {
  async open(binding: Hyperdrive | undefined): Promise<LedgerStore | null> {
    if (!binding) return null;
    const client = new pg.Client({ connectionString: binding.connectionString, connectionTimeoutMillis: LEDGER_CONNECT_TIMEOUT_MS, query_timeout: LEDGER_QUERY_TIMEOUT_MS });
    await client.connect();
    return sqlLedger(
      async (sql, params) => (await client.query(sql, params)).rows as Record<string, unknown>[],
      () => client.end().catch(() => undefined),
    );
  },
};
