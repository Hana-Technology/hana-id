// Issuing a monthly statement and exporting a ledger CSV (docs/batch-c-spec.md "Monthly statements", "Ledger CSV";
// D92, D308; D326, D327).
//
// Issue (`POST /api/statements/:org/:month/issue`, staff): allowed from the 3rd of the next month 00:00 UTC, once no
// relayed event of the month lacks a settlement and every day of the month has a rate. With `as_of` = now, the report
// rows (per day and per month, received_at ≤ as_of) give the CSV and the totals; the PDF renders the totals with the
// CSV's sha256; both go to `STATEMENTS` under new keys (`statements/<org>/<YYYY-MM>/<as_of>.{csv,pdf}`, sha256-checked
// by R2 on upload; the bucket lock keeps them 7 years), then `usage.statements` is inserted with both hashes and the
// totals: the commit point (its primary key refuses a second statement). The audit row (`statement.issued`, the
// console's audit_log through StaffRpc) follows; the statement notice to the org's contacts and billing email is the
// 15-minute run's (alerts.ts). A failure before the insert leaves orphan files only (locked, harmless): nothing points
// at them.
//
// Export (`POST /api/exports/:org/:month`): the ledger CSV of the month, as of a time (the statement's, to reconcile,
// or now), written to `EXPORTS` under `exports/` (the 30-day lifecycle rule, D308), at most EXPORT_MAX_ROWS rows.
import { LEDGER_CSV_COLUMNS, type LedgerSqlRow, type StatementWithTotals, csvLine, ledgerCsvCells, ledgerRowOf, statementOf, statementView } from '@hana-id/console-core';
import type { AdminRpcClient, StaffRpcClient } from './env.ts';
import type { LedgerStore } from './ledger.ts';
import { errorName, log } from './log.ts';
import { type StaffRequest, staffCtx } from './rpc.ts';
import { type StatementApp, buildStatement } from './statement.ts';
import { statementPdf } from './statement-pdf.ts';

export const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/u;
export const EXPORT_MAX_ROWS = 200_000;
export const LEDGER_PAGE_ROWS = 1000;

export type Refusal = { ok: false; code: 'bad_request' | 'not_found' | 'conflict' | 'internal' | 'upstream_unavailable'; error: string };

/** The first moment a month's statement may be issued: the 3rd of the next month, 00:00 UTC. */
export function issuableFrom(month: string): number {
  const m = MONTH_RE.exec(month);
  if (!m) throw new RangeError('month');
  return Date.UTC(Number(m[1]), Number(m[2]), 3);
}

/** The month's first and last UTC day. */
export function monthDays(month: string): { first: string; last: string } {
  const m = MONTH_RE.exec(month);
  if (!m) throw new RangeError('month');
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).toISOString().slice(0, 10);
  return { first: `${month}-01`, last };
}

export const statementKey = (orgId: string, month: string, asOf: number, ext: 'csv' | 'pdf'): string => `statements/${orgId}/${month}/${new Date(asOf).toISOString()}.${ext}`;

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

export interface IssueDeps {
  store: LedgerStore;
  api: Pick<AdminRpcClient, 'listApps'>;
  console: Pick<StaffRpcClient, 'getOrg' | 'recordStaffAction'>;
  /** The STATEMENTS bucket. */
  bucket: Pick<R2Bucket, 'put'>;
  network: string;
  staff: StaffRequest;
  now: number;
}

export interface Issued {
  ok: true;
  statement: StatementWithTotals & { csvKey: string; pdfKey: string };
  auditRecorded: boolean;
}

export async function issueStatement(d: IssueDeps, orgId: string, month: string): Promise<Issued | Refusal> {
  if (!MONTH_RE.test(month)) return { ok: false, code: 'bad_request', error: 'The month is YYYY-MM' };
  const from = issuableFrom(month);
  if (d.now < from) return { ok: false, code: 'conflict', error: `A statement for ${month} can be issued from ${new Date(from).toISOString()}` };
  if ((await d.store.statements(orgId)).some((s) => s.month === month)) return { ok: false, code: 'conflict', error: `The ${month} statement was already issued` };
  const blockers = await d.store.blockers(orgId, month);
  if (blockers.pending > 0) return { ok: false, code: 'conflict', error: `${blockers.pending} relayed event(s) of ${month} are not settled yet` };
  if (blockers.missingRateDays.length > 0) return { ok: false, code: 'conflict', error: `No NEAR/USD rate for ${blockers.missingRateDays.slice(0, 5).join(', ')}${blockers.missingRateDays.length > 5 ? ' and more' : ''}` };

  const ctx = staffCtx(d.staff);
  let org, apps;
  try {
    [org, apps] = await Promise.all([d.console.getOrg({ ...ctx, orgId }), d.api.listApps({ ...ctx, orgId })]);
  } catch {
    return { ok: false, code: 'upstream_unavailable', error: 'The console or the API did not answer' };
  }
  if (!org.ok) return { ok: false, code: org.code === 'not_found' ? 'not_found' : 'internal', error: org.error ?? org.code };
  if (!apps.ok) return { ok: false, code: 'internal', error: apps.error ?? apps.code };
  const appMap = new Map<string, StatementApp>(apps.apps.map((a) => [a.id, { name: a.name, environment: String(a.environment ?? ''), scopeId: a.scopeId }]));

  const asOf = d.now;
  const { first, last } = monthDays(month);
  const [dayRows, monthRows] = [await d.store.report(orgId, first, last, 'day', null, asOf), await d.store.report(orgId, first, last, 'month', null, asOf)];
  const built = buildStatement({ orgId, orgName: org.org.name, month, asOf, network: d.network, apps: appMap, dayRows, monthRows });
  const csvBytes = new TextEncoder().encode(built.csv);
  const csvSha256 = await sha256Hex(csvBytes);
  const pdfBytes = await statementPdf(statementView({ csvSha256, totals: built.totals }), asOf);
  const pdfSha256 = await sha256Hex(pdfBytes);
  const csvKey = statementKey(orgId, month, asOf, 'csv');
  const pdfKey = statementKey(orgId, month, asOf, 'pdf');
  await d.bucket.put(csvKey, csvBytes, { httpMetadata: { contentType: 'text/csv; charset=utf-8' }, sha256: csvSha256 });
  await d.bucket.put(pdfKey, pdfBytes, { httpMetadata: { contentType: 'application/pdf' }, sha256: pdfSha256 });

  const inserted = await d.store.insertStatement({ orgId, month, asOf, csvKey, csvSha256, pdfKey, pdfSha256, totals: built.totals, issuedBy: d.staff.actor.email });
  if (inserted === 'exists') return { ok: false, code: 'conflict', error: `The ${month} statement was already issued` };

  // The audit row, idempotent on its request id (one per org and month).
  let auditRecorded = false;
  try {
    const a = await d.console.recordStaffAction({ ...ctx, requestId: `statement_${orgId}_${month}`, orgId, action: 'statement.issued', target: month, details: { month, csvSha256, pdfSha256, asOf, lines: built.lines } });
    auditRecorded = a.ok || a.code === 'already_applied';
  } catch (err) {
    log({ event: 'statement', step: 'audit', orgId, outcome: 'error', error: errorName(err) }, 'error');
  }
  if (!auditRecorded) log({ event: 'statement', step: 'audit', orgId, outcome: 'error', code: 'audit_failed' }, 'error');
  const stored = (await d.store.statements(orgId)).find((s) => s.month === month);
  if (!stored) return { ok: false, code: 'internal', error: 'The statement was inserted but not read back' };
  return { ok: true, statement: { ...statementOf(orgId, stored), csvKey, pdfKey }, auditRecorded };
}

export interface Exported {
  ok: true;
  key: string;
  sha256: string;
  rows: number;
  asOf: number;
  finalGas: string;
  finalTokens: string;
}

/** The ledger CSV text of an org's month as of `asOf` (every page through usage.org_ledger), with its final sums. */
export async function ledgerCsv(store: Pick<LedgerStore, 'ledgerPage'>, orgId: string, month: string, asOf: number, maxRows = EXPORT_MAX_ROWS): Promise<{ csv: string; rows: number; finalGas: bigint; finalTokens: bigint } | null> {
  const parts = [csvLine(LEDGER_CSV_COLUMNS)];
  let after: string | null = null;
  let rows = 0;
  let finalGas = 0n;
  let finalTokens = 0n;
  for (;;) {
    const page: LedgerSqlRow[] = await store.ledgerPage(orgId, month, asOf, after, LEDGER_PAGE_ROWS);
    for (const raw of page) {
      const r = ledgerRowOf(raw);
      parts.push(csvLine(ledgerCsvCells(r)));
      if (r.gasStatus === 'final') {
        finalGas += BigInt(r.gasBurnt ?? '0');
        finalTokens += BigInt(r.tokensBurnt ?? '0');
      }
    }
    rows += page.length;
    if (rows > maxRows) return null;
    if (page.length < LEDGER_PAGE_ROWS) break;
    const last = page[page.length - 1]!;
    after = `${last.request_id},${String(last.at_ms)}`;
  }
  return { csv: parts.join(''), rows, finalGas, finalTokens };
}

export async function exportLedger(
  d: { store: LedgerStore; bucket: Pick<R2Bucket, 'put'>; console: Pick<StaffRpcClient, 'recordStaffAction'>; staff: StaffRequest; now: number },
  orgId: string,
  month: string,
  asOf?: number,
): Promise<Exported | Refusal> {
  if (!MONTH_RE.test(month)) return { ok: false, code: 'bad_request', error: 'The month is YYYY-MM' };
  const bound = asOf ?? d.now;
  if (!Number.isSafeInteger(bound) || bound < 0 || bound > d.now) return { ok: false, code: 'bad_request', error: 'asOf is a past time in milliseconds' };
  const out = await ledgerCsv(d.store, orgId, month, bound);
  if (!out) return { ok: false, code: 'conflict', error: `More than ${EXPORT_MAX_ROWS} rows: ask an engineer for a database export` };
  const bytes = new TextEncoder().encode(out.csv);
  const sha256 = await sha256Hex(bytes);
  const key = `exports/${orgId}/${month}/${new Date(bound).toISOString()}-${d.staff.requestId}.csv`;
  await d.bucket.put(key, bytes, { httpMetadata: { contentType: 'text/csv; charset=utf-8' }, sha256 });
  try {
    const a = await d.console.recordStaffAction({ ...staffCtx(d.staff), orgId, action: 'ledger.exported', target: month, details: { month, asOf: bound, rows: out.rows, sha256 } });
    if (!a.ok) log({ event: 'export', step: 'audit', orgId, outcome: 'error', code: a.code }, 'error');
  } catch (err) {
    log({ event: 'export', step: 'audit', orgId, outcome: 'error', error: errorName(err) }, 'error');
  }
  return { ok: true, key, sha256, rows: out.rows, asOf: bound, finalGas: out.finalGas.toString(), finalTokens: out.finalTokens.toString() };
}

/** An export's object key from its route parts, or null when they don't name one (no path tricks). */
export function exportKey(orgId: string, month: string, file: string): string | null {
  if (!/^org_[A-Za-z0-9]{1,64}$/u.test(orgId) || !MONTH_RE.test(month)) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[A-Za-z0-9_-]{8,128}\.csv$/u.test(file)) return null;
  return `exports/${orgId}/${month}/${file}`;
}
