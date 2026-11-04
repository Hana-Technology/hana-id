// The partner's usage reports, statements and ledger (docs/batch-c-spec.md "Reports", "Monthly statements"; batch C12):
// `ConsoleRpc.usage`, `statements` and `ledger` read Neon only, over the writer's `USAGE_DB` binding, by calling the
// owner's SECURITY DEFINER functions (migrations-usage 0006), which filter by `org_id` themselves: the writer role has
// no table privilege (D73). No hot-DB statement, so they aren't charged to the console's hot-DB budget; each member is
// limited on the `RateLimiter` object instead (REPORT_LIMITS). The console never reads `org_legacy`'s rows.
//
// Nothing here logs the connection string, a driver message or a row.
import {
  LEDGER_PAGE,
  LEGACY_ORG_ID,
  type LedgerInput,
  type LedgerRow,
  type LedgerSqlRow,
  type ReportSqlRow,
  type StatementSqlRow,
  type StatementWithTotals,
  type StatementsInput,
  type UsageInput,
  type UsageRow,
  ledgerCursor,
  ledgerRowOf,
  statementOf,
  usageRowOf,
} from '@hana-id/console-core';
import pg from 'pg';
import { refuse } from '../changes/cas.ts';
import type { Env } from '../env.ts';
import type { Limit } from '../rate-limiter.ts';

export const REPORT_CONNECT_TIMEOUT_MS = 5_000;
/** The writer role's statement_timeout is 5 s too (migrations-usage 0001). */
export const REPORT_QUERY_TIMEOUT_MS = 5_000;
export const ORG_REPORT_SQL = 'SELECT * FROM usage.org_report($1, $2::date, $3::date, $4, $5::text[], NULL)';
export const ORG_STATEMENTS_SQL = 'SELECT * FROM usage.org_statements($1)';
export const ORG_LEDGER_SQL = 'SELECT * FROM usage.org_ledger($1, $2::date, $3::timestamptz, $4, $5)';

/** Per member (the actor's user id): a report screen's loads, a CSV's pages. */
export const REPORT_LIMITS: Limit[] = [
  { name: 'minute', windowMs: 60_000, max: 60 },
  { name: 'hour', windowMs: 60 * 60_000, max: 1_200 },
];

/** One statement over a new connection, closed after it (Hyperdrive pools). Replaceable, so tests need no server. */
export const reportTransport = {
  async rows(binding: Hyperdrive, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    const client = new pg.Client({ connectionString: binding.connectionString, connectionTimeoutMillis: REPORT_CONNECT_TIMEOUT_MS, query_timeout: REPORT_QUERY_TIMEOUT_MS });
    try {
      await client.connect();
      return (await client.query(sql, params)).rows as Record<string, unknown>[];
    } finally {
      await client.end().catch(() => undefined);
    }
  },
};

/** The checks every report method makes before Neon: not the legacy org, the ledger bound, the member's limit. */
async function admit(env: Env, orgId: string, memberId: string, now: number): Promise<Hyperdrive> {
  if (orgId === LEGACY_ORG_ID) refuse('forbidden', `The console can't read ${LEGACY_ORG_ID}`);
  const binding = env.USAGE_DB;
  if (!binding) return refuse('internal', 'The usage ledger is not configured in this environment');
  const limiter = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`console-report:${memberId}`));
  const r = await limiter.hit(REPORT_LIMITS, now);
  if (!r.ok) refuse('rate_limited', 'Too many report requests: try again shortly');
  return binding;
}

export async function orgUsage(env: Env, i: UsageInput, now = Date.now()): Promise<UsageRow[]> {
  const binding = await admit(env, i.orgId, i.actor.id, now);
  const rows = await reportTransport.rows(binding, ORG_REPORT_SQL, [i.orgId, i.from, i.to, i.by, i.appIds ?? null]);
  return rows.map((r) => usageRowOf(i.orgId, r as unknown as ReportSqlRow));
}

export async function orgStatements(env: Env, i: StatementsInput, now = Date.now()): Promise<StatementWithTotals[]> {
  const binding = await admit(env, i.orgId, i.actor.id, now);
  const rows = await reportTransport.rows(binding, ORG_STATEMENTS_SQL, [i.orgId]);
  return rows.map((r) => statementOf(i.orgId, r as unknown as StatementSqlRow));
}

/**
 * One page of the org's ledger for a month, bounded by `asOf` (received_at ≤ as_of). Without one, the call's own time
 * is used and answered, so the caller passes it back with `next` and every page of one CSV has the same bound.
 */
export async function orgLedger(env: Env, i: LedgerInput, now = Date.now()): Promise<{ rows: LedgerRow[]; next?: string; asOf: number }> {
  const binding = await admit(env, i.orgId, i.actor.id, now);
  const asOf = i.asOf ?? now;
  const rows = (await reportTransport.rows(binding, ORG_LEDGER_SQL, [i.orgId, `${i.month}-01`, new Date(asOf).toISOString(), i.after ?? null, LEDGER_PAGE])).map((r) => ledgerRowOf(r as unknown as LedgerSqlRow));
  const last = rows[rows.length - 1];
  return { rows, ...(rows.length === LEDGER_PAGE && last ? { next: ledgerCursor(last) } : {}), asOf };
}
