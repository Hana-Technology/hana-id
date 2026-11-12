// Reports, the ledger and statements (docs/batch-c-spec.md "Reports", "Monthly statements"; batch C12): the RPC inputs
// of `ConsoleRpc.usage` / `statements` / `ledger`, the exact decimal formats every view shares (Tgas, NEAR, USD), the
// mapping of the Neon functions' rows (`usage.org_report`, `usage.org_ledger`, `usage.org_statements`) to the RPC views,
// and the stored shape of a statement's totals with the one rendering the on-screen statement and the PDF both use
// (D92: the CSV, the PDF and the on-screen statement show the same totals and the CSV's sha256).
import { z } from '@hana-id/env/zod';
import { appIdInput, orgIdInput } from './rpc.ts';
import { ctx, day, month, ms, type UsageRow } from './types.ts';

// ---- limits ----

/** A report covers at most this many UTC days (`from` to `to` inclusive) and this many apps. */
export const REPORT_MAX_DAYS = 400;
export const REPORT_MAX_APPS = 100;
/** Rows per `ConsoleRpc.ledger` page (the Neon function allows 1..1000). */
export const LEDGER_PAGE = 1000;
/** A ledger cursor: the last row's `<request_id>,<at ms>` (rows are ordered by request id, then time). */
export const LEDGER_CURSOR_RE = /^[A-Za-z0-9_-]{8,128},(0|[1-9]\d{0,15})$/u;

const dayMs = (d: string): number => Date.parse(`${d}T00:00:00Z`);
/** Days from `from` to `to` inclusive. */
export const daysInRange = (from: string, to: string): number => Math.round((dayMs(to) - dayMs(from)) / 86_400_000) + 1;

// ---- ConsoleRpc inputs ----

export const usageInput = ctx
  .extend({
    orgId: orgIdInput,
    appIds: z.array(appIdInput).min(1).max(REPORT_MAX_APPS).optional(),
    from: day,
    to: day,
    by: z.enum(['day', 'month']),
  })
  .strict()
  .refine((i) => i.from <= i.to, { message: 'from is after to', path: ['to'] })
  .refine((i) => daysInRange(i.from, i.to) <= REPORT_MAX_DAYS, { message: `A report covers at most ${REPORT_MAX_DAYS} days`, path: ['to'] });
export const statementsInput = ctx.extend({ orgId: orgIdInput }).strict();
export const ledgerInput = ctx
  .extend({ orgId: orgIdInput, month, asOf: ms.max(8_640_000_000_000_000).optional(), after: z.string().regex(LEDGER_CURSOR_RE).optional() })
  .strict();
export type UsageInput = z.infer<typeof usageInput>;
export type StatementsInput = z.infer<typeof statementsInput>;
export type LedgerInput = z.infer<typeof ledgerInput>;

// ---- exact decimals ----

const DECIMAL = /^(0|[1-9]\d*)$/u;

/** A non-negative integer amount of `10^-decimals` units as an exact decimal: trailing zeros dropped, '0' for zero. */
export function formatUnits(v: bigint | string, decimals: number): string {
  const n = typeof v === 'bigint' ? v : DECIMAL.test(v) ? BigInt(v) : null;
  if (n === null || n < 0n) throw new RangeError('formatUnits: a non-negative integer');
  const s = n.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/u, '');
  return frac ? `${int}.${frac}` : int;
}
/** Gas units → Tgas (10^12). */
export const formatTgas = (gas: bigint | string): string => formatUnits(gas, 12);
/** yoctoNEAR → NEAR (10^24). */
export const formatNear = (yocto: bigint | string): string => formatUnits(yocto, 24);
/** Micro-dollars → USD (10^6). */
export const formatUsd = (micros: bigint | string): string => formatUnits(micros, 6);

/** USD micro-dollars of `yocto` at `usdMicros` per NEAR: round half up (amounts are never negative), as the report SQL. */
export function usdMicrosOf(yocto: bigint, usdMicros: bigint): bigint {
  const d = 10n ** 24n;
  return (yocto * usdMicros * 2n + d) / (2n * d);
}

// ---- report rows (usage.org_report) ----

/** One row of `usage.org_report` as `pg` returns it (bigint columns may come back as strings). */
export interface ReportSqlRow {
  period: string;
  app_id: string | null;
  scope_id: string;
  /** 'app', 'scope' (owner actions) or 'home' (Hana Home logins); absent before migrations-usage 0008. */
  kind?: string | null;
  /** Absent before migrations-usage 0008. */
  home_logins?: number | string | null;
  logins: number | string;
  derives: number | string;
  revokes: number | string;
  unlocks: number | string;
  owner_actions: number | string;
  link_actions: number | string;
  active_users: number | string;
  new_users: number | string;
  identity_tokens: number | string;
  failures: Record<string, number | string> | string | null;
  gas: string;
  rejected_gas: string;
  error_gas: string;
  burnt_yocto: string;
  rejected_yocto: string;
  error_yocto: string;
  usd_micros: string | null;
  rejected_usd_micros: string | null;
  near_usd_rate: number | string | null;
  rate_source: string | null;
  login_p50: number | null;
  login_p95: number | null;
  derive_p50: number | null;
  derive_p95: number | null;
  unsettled: number | string;
  after_statement: number | string;
}

const int = (v: number | string | null | undefined): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('A count out of range');
  return n;
};
const dec = (v: string | null | undefined): string => {
  const s = String(v ?? '0');
  if (!DECIMAL.test(s)) throw new RangeError('A decimal out of range');
  return s;
};
export const failuresOf = (v: ReportSqlRow['failures']): Record<string, number> => {
  const o = typeof v === 'string' ? (JSON.parse(v) as Record<string, number | string>) : (v ?? {});
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, int(o[k])]));
};
const latency = (v: number | null | undefined): number | undefined => (v === null || v === undefined ? undefined : int(v));

export type ReportRowKind = 'app' | 'scope' | 'home';
/** What a report row is about. A row from before migrations-usage 0008 names no kind: an app's, else a scope's owner actions. */
export const reportRowKind = (r: Pick<ReportSqlRow, 'kind' | 'app_id'>): ReportRowKind => (r.kind === 'home' ? 'home' : r.app_id !== null ? 'app' : 'scope');
/** The label of a scope's Hana Home line, wherever a report or a statement shows it. */
export const HOME_LOGINS_LABEL = 'Passport Home logins';

/** A report row as the RPC's UsageRow (docs/batch-c-spec.md "Types"; the C12 additions are optional). */
export function usageRowOf(orgId: string, r: ReportSqlRow): UsageRow {
  const p50 = { login: latency(r.login_p50), derive: latency(r.derive_p50) };
  const p95 = { login: latency(r.login_p95), derive: latency(r.derive_p95) };
  const strip = (o: { login?: number; derive?: number }) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  return {
    orgId,
    ...(r.app_id !== null ? { appId: r.app_id } : {}),
    scopeId: r.scope_id,
    period: r.period,
    logins: int(r.logins),
    derives: int(r.derives),
    revokes: int(r.revokes),
    unlocks: int(r.unlocks),
    ownerActions: int(r.owner_actions),
    linkActions: int(r.link_actions),
    identityTokens: int(r.identity_tokens),
    kind: reportRowKind(r),
    ...(reportRowKind(r) === 'home' ? { homeLogins: int(r.home_logins) } : {}),
    activeUsers: int(r.active_users),
    newUsers: int(r.new_users),
    failuresByCode: failuresOf(r.failures),
    tgas: formatTgas(dec(r.gas)),
    relayedRejectedTgas: formatTgas(dec(r.rejected_gas)),
    errorTgas: formatTgas(dec(r.error_gas)),
    burntYocto: dec(r.burnt_yocto),
    relayedRejectedBurntYocto: dec(r.rejected_yocto),
    ...(r.usd_micros !== null ? { usdMicros: dec(r.usd_micros) } : {}),
    ...(r.rejected_usd_micros !== null ? { relayedRejectedUsdMicros: dec(r.rejected_usd_micros) } : {}),
    p50: strip(p50),
    p95: strip(p95),
    unsettled: int(r.unsettled),
    afterStatement: int(r.after_statement),
  };
}

// ---- ledger rows (usage.org_ledger) ----

export const GAS_STATUSES = ['final', 'unsettled', 'pending', 'none'] as const;
export const ledgerRow = z
  .object({
    requestId: z.string(),
    at: ms,
    orgId: z.string(),
    scopeId: z.string(),
    appId: z.string().optional(),
    endpoint: z.string(),
    outcome: z.string(),
    relayed: z.boolean(),
    nearTx: z.string().optional(),
    gasStatus: z.enum(GAS_STATUSES),
    gasBurnt: z.string().regex(DECIMAL).optional(),
    tokensBurnt: z.string().regex(DECIMAL).optional(),
  })
  .strict();
export type LedgerRow = z.infer<typeof ledgerRow>;

export interface LedgerSqlRow {
  request_id: string;
  at_ms: number | string;
  org_id: string;
  scope_id: string;
  app_id: string | null;
  endpoint: string;
  outcome: string;
  relayed: boolean;
  near_tx: string | null;
  gas_status: (typeof GAS_STATUSES)[number];
  gas_burnt: string | null;
  tokens_burnt: string | null;
}

export function ledgerRowOf(r: LedgerSqlRow): LedgerRow {
  return {
    requestId: r.request_id,
    at: int(r.at_ms),
    orgId: r.org_id,
    scopeId: r.scope_id,
    ...(r.app_id !== null ? { appId: r.app_id } : {}),
    endpoint: r.endpoint,
    outcome: r.outcome,
    relayed: r.relayed,
    ...(r.near_tx !== null ? { nearTx: r.near_tx } : {}),
    gasStatus: r.gas_status,
    ...(r.gas_burnt !== null ? { gasBurnt: dec(r.gas_burnt) } : {}),
    ...(r.tokens_burnt !== null ? { tokensBurnt: dec(r.tokens_burnt) } : {}),
  };
}
/** The cursor after a page's last row. */
export const ledgerCursor = (r: Pick<LedgerRow, 'requestId' | 'at'>): string => `${r.requestId},${r.at}`;

/** The ledger CSV's columns (docs/batch-c-spec.md "Ledger CSV"). */
export const LEDGER_CSV_COLUMNS = ['request_id', 'at', 'org_id', 'scope_id', 'app_id', 'endpoint', 'outcome', 'relayed', 'near_tx', 'gas_status', 'gas_burnt', 'tokens_burnt'] as const;
/** One ledger row as CSV cells (the CSV writer quotes and guards them). */
export const ledgerCsvCells = (r: LedgerRow): string[] => [
  r.requestId,
  new Date(r.at).toISOString(),
  r.orgId,
  r.scopeId,
  r.appId ?? '',
  r.endpoint,
  r.outcome,
  r.relayed ? 'true' : 'false',
  r.nearTx ?? '',
  r.gasStatus,
  r.gasBurnt ?? '',
  r.tokensBurnt ?? '',
];

// ---- CSV (statements and the ledger: RFC 4180, UTF-8, LF; docs/batch-c-spec.md "CSV") ----

const NUMBER_CELL = /^-?\d+(\.\d+)?$/u;
const FORMULA_START = /^[=+\-@\t\r]/u;
/** One CSV cell: a number is left as is; other text starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`. */
export function csvCell(v: string): string {
  const s = !NUMBER_CELL.test(v) && FORMULA_START.test(v) ? `'${v}` : v;
  return /[",\r\n]/u.test(s) ? `"${s.replace(/"/gu, '""')}"` : s;
}
export const csvLine = (cells: readonly string[]): string => `${cells.map(csvCell).join(',')}\n`;

// ---- statements ----

/**
 * A statement's CSV columns (docs/batch-c-spec.md "CSV"; `link_actions` and `identity_tokens` added by C12, D324;
 * `row_kind` and `home_logins` by Hana Home's billing, appended last so no earlier column moves, D587: a scope's Hana
 * Home logins are rows of their own, with `row_kind` = `home`, no app, and the gas of those logins only).
 */
export const STATEMENT_CSV_COLUMNS = [
  'month', 'org_id', 'org_name', 'scope_id', 'app_id', 'app_name', 'environment', 'day',
  'logins', 'derives', 'revokes', 'unlocks', 'owner_actions', 'link_actions', 'identity_tokens', 'mau', 'new_users', 'failures_by_code',
  'tgas', 'relayed_rejected_tgas', 'error_tgas', 'near', 'relayed_rejected_near', 'near_usd_rate', 'rate_source', 'usd', 'relayed_rejected_usd',
  'login_p50_ms', 'login_p95_ms', 'derive_p50_ms', 'derive_p95_ms', 'unsettled', 'as_of', 'row_kind', 'home_logins',
] as const;

const decimalText = z.string().regex(/^(0|[1-9]\d*)(\.\d*[1-9])?$/u);
const count = z.number().int().nonnegative();

/** One app's or scope's month (the CSV's `day = total` row), as stored in `usage.statements.totals`. */
export const statementTotalRow = z
  .object({
    /** `home`: the scope's Hana Home logins (D461), a line of their own. */
    kind: z.enum(['app', 'scope', 'home']),
    scopeId: z.string(),
    appId: z.string().optional(),
    appName: z.string().optional(),
    environment: z.string().optional(),
    logins: count,
    derives: count,
    revokes: count,
    unlocks: count,
    ownerActions: count,
    linkActions: count,
    identityTokens: count,
    /** Absent in statements issued before Hana Home logins were counted. */
    homeLogins: count.optional(),
    mau: count.optional(),
    newUsers: count,
    failures: z.record(z.string(), count),
    tgas: decimalText,
    relayedRejectedTgas: decimalText,
    errorTgas: decimalText,
    near: decimalText,
    relayedRejectedNear: decimalText,
    usd: decimalText,
    relayedRejectedUsd: decimalText,
    unsettled: count,
  })
  .strict();
export type StatementTotalRow = z.infer<typeof statementTotalRow>;

/** `usage.statements.totals`: the per-app and per-scope totals, the org's sums, and the billed and not-billed lines. */
export const statementTotals = z
  .object({
    v: z.literal(1),
    orgId: z.string(),
    orgName: z.string(),
    month,
    asOf: ms,
    /** The env's NEAR network; on a test network the amounts are valued at the mainnet price and labelled (D93). */
    network: z.string(),
    rows: z.array(statementTotalRow),
    sum: statementTotalRow.omit({ kind: true, scopeId: true, appId: true, appName: true, environment: true, mau: true, failures: true }),
    /** Billed by default (D91): everything settled but the relayed-then-rejected gas. */
    billed: z.object({ tgas: decimalText, near: decimalText, usd: decimalText }).strict(),
    notBilled: z.object({ relayedRejectedTgas: decimalText, relayedRejectedNear: decimalText, relayedRejectedUsd: decimalText }).strict(),
  })
  .strict();
export type StatementTotals = z.infer<typeof statementTotals>;

/** A statement as the RPC lists it: the spec's StatementMeta plus the stored totals (the on-screen statement). */
export interface StatementWithTotals {
  orgId: string;
  month: string;
  asOf: number;
  csvSha256: string;
  pdfSha256?: string;
  issuedBy: string;
  issuedAt: number;
  totals: StatementTotals;
  /** The files' keys in STATEMENTS (`statements/<org>/<YYYY-MM>/<as_of>.{csv,pdf}`): server-side reads only. */
  csvKey: string;
  pdfKey?: string;
}

export interface StatementSqlRow {
  month: string;
  as_of_ms: number | string;
  csv_key: string;
  csv_sha256: string;
  pdf_key: string | null;
  pdf_sha256: string | null;
  totals: unknown;
  issued_by: string;
  issued_at_ms: number | string;
}

/** A `usage.org_statements` row as the RPC's view (the totals checked against their schema). */
export function statementOf(orgId: string, r: StatementSqlRow): StatementWithTotals {
  const totals = statementTotals.parse(typeof r.totals === 'string' ? JSON.parse(r.totals) : r.totals);
  return {
    orgId,
    month: r.month,
    asOf: int(r.as_of_ms),
    csvSha256: r.csv_sha256,
    ...(r.pdf_sha256 ? { pdfSha256: r.pdf_sha256 } : {}),
    issuedBy: r.issued_by,
    issuedAt: int(r.issued_at_ms),
    totals,
    csvKey: r.csv_key,
    ...(r.pdf_key ? { pdfKey: r.pdf_key } : {}),
  };
}

const isTestNetwork = (network: string): boolean => network !== 'mainnet';
export const TESTNET_PRICE_NOTE = 'Testnet usage, valued at the mainnet NEAR/USD price (D93).';
export const HOME_LOGINS_NOTE = 'Passport Home logins: users of these apps opening their wallet from Passport Home. Each is billed at its gas, like a login.';
export const REJECTED_NOTE = 'Relayed-then-rejected gas is not billed by default (D91); it is shown on its own line.';

/** What the on-screen statement and the PDF show, in order: the same labels and values in both (D92). */
export interface StatementView {
  title: string;
  header: [string, string][];
  /** One line per app and scope: label, then the figures in `tableColumns` order. */
  tableColumns: string[];
  table: { label: string; cells: string[] }[];
  summary: [string, string][];
  notes: string[];
}

export function statementView(s: { csvSha256: string; pdfSha256?: string; totals: StatementTotals }): StatementView {
  const t = s.totals;
  const name = (r: StatementTotalRow) =>
    r.kind === 'app' ? `${r.appName ?? r.appId ?? ''} (${r.appId ?? ''})` : r.kind === 'home' ? `${HOME_LOGINS_LABEL}, scope ${r.scopeId}` : `Owner actions, scope ${r.scopeId}`;
  const notes = [REJECTED_NOTE];
  const home = t.rows.some((r) => r.kind === 'home');
  if (home) notes.push(HOME_LOGINS_NOTE);
  if (isTestNetwork(t.network)) notes.unshift(TESTNET_PRICE_NOTE);
  return {
    title: `Journear Passport usage statement ${t.month}`,
    header: [
      ['Organisation', `${t.orgName} (${t.orgId})`],
      ['Month', t.month],
      ['Network', t.network],
      ['Covers events received up to', new Date(t.asOf).toISOString()],
      ['Statement hash (SHA-256 of the CSV)', s.csvSha256],
    ],
    // The Home column and summary line appear only on a statement that has a Home line, so an older statement renders as it did.
    tableColumns: ['Logins', 'Derives', 'Owner actions', ...(home ? ['Home logins'] : []), 'MAU', 'New users', 'Tgas', 'NEAR', 'USD', 'Unsettled'],
    table: t.rows.map((r) => ({
      label: name(r),
      cells: [String(r.logins), String(r.derives), String(r.ownerActions), ...(home ? [String(r.homeLogins ?? 0)] : []), r.mau === undefined ? '' : String(r.mau), String(r.newUsers), r.tgas, r.near, r.usd, String(r.unsettled)],
    })),
    summary: [
      ['Logins', String(t.sum.logins)],
      ['Derives', String(t.sum.derives)],
      ['Revokes', String(t.sum.revokes)],
      ['Unlocks', String(t.sum.unlocks)],
      ['Owner actions', String(t.sum.ownerActions)],
      ['Link actions', String(t.sum.linkActions)],
      ['Identity tokens', String(t.sum.identityTokens)],
      ...(home ? ([[HOME_LOGINS_LABEL, String(t.sum.homeLogins ?? 0)]] as [string, string][]) : []),
      ['New users', String(t.sum.newUsers)],
      ['All settled gas (Tgas)', t.sum.tgas],
      ['All settled NEAR', t.sum.near],
      ['All settled USD', t.sum.usd],
      ['Error gas (Tgas, included above)', t.sum.errorTgas],
      ['Billed (Tgas)', t.billed.tgas],
      ['Billed (NEAR)', t.billed.near],
      ['Billed (USD)', t.billed.usd],
      ['Relayed-then-rejected, not billed (Tgas)', t.notBilled.relayedRejectedTgas],
      ['Relayed-then-rejected, not billed (NEAR)', t.notBilled.relayedRejectedNear],
      ['Relayed-then-rejected, not billed (USD)', t.notBilled.relayedRejectedUsd],
      ['Unsettled relayed events (not billed)', String(t.sum.unsettled)],
    ],
    notes,
  };
}
