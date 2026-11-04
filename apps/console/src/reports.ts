// The partner console's usage report, statements and ledger CSV (docs/batch-c-spec.md "Console BFF routes": `GET
// /api/orgs/:org/usage`, `/statements`, `/statements/:month`, `/statements/:month.csv`, `.pdf`, `/ledger/:month.csv`;
// "Reports", "Monthly statements"; batch C12). The backend only: each route needs a session and a member of the org
// (viewer or owner), which the session routes of C9/C10 check before they call these; no route reaches them until then
// (as logo.ts). Every read is `ConsoleRpc.usage` / `statements` / `ledger` (Neon only on the API side, limited per
// member there); the statement files come from STATEMENTS with `get` only (D74: read only by code), each checked
// against the sha256 the statement froze in Neon before it is served, with the hash beside it.
import { type Actor, LEDGER_CSV_COLUMNS, type LedgerRow, type StatementWithTotals, csvLine, ledgerCsvCells, statementView } from '@hana-id/console-core';
import type { Env } from './env.ts';
import { type ErrorCode, errorResponse, json } from './http.ts';
import type { RequestInfo } from './links.ts';
import { log } from './log.ts';

/** The member a session route resolved (C9/C10): the caller has checked the session and the org membership. */
export interface ReportCaller {
  orgId: string;
  actor: Extract<Actor, { kind: 'member' }>;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/u;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/u;
/** The most ledger pages one CSV download reads (1000 rows each): past it the CSV ends with a truncation line. */
export const LEDGER_CSV_MAX_PAGES = 200;

const ctxOf = (info: RequestInfo, c: ReportCaller) => ({ actor: c.actor, requestId: info.requestId, clientIp: info.clientIp });

function rpcError(info: RequestInfo, c: ReportCaller, route: string, r: { code: string; error?: string }): Response {
  log({ event: 'report', method: route, requestId: info.requestId, orgId: c.orgId, outcome: 'rejected', code: r.code });
  return errorResponse(r.code as ErrorCode, r.error);
}

function upstream(info: RequestInfo, c: ReportCaller, route: string): Response {
  log({ event: 'report', method: route, requestId: info.requestId, orgId: c.orgId, outcome: 'error', code: 'internal' }, 'error');
  return errorResponse('internal', 'The usage service did not answer; try again shortly');
}

/** `GET /api/orgs/:org/usage?from&to&by&apps` → `{rows: UsageRow[]}` (≤ 400 days, ≤ 100 apps: the RPC refuses more). */
export async function usageRoute(env: Env, info: RequestInfo, c: ReportCaller, url: URL): Promise<Response> {
  const q = url.searchParams;
  const from = q.get('from') ?? '';
  const to = q.get('to') ?? '';
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) return errorResponse('bad_request', 'from and to: YYYY-MM-DD');
  const apps = q.get('apps');
  let r;
  try {
    r = await env.API.usage({ ...ctxOf(info, c), orgId: c.orgId, from, to, by: q.get('by') === 'month' ? 'month' : 'day', ...(apps ? { appIds: apps.split(',').filter(Boolean) } : {}) });
  } catch {
    return upstream(info, c, 'usage');
  }
  if (!r.ok) return rpcError(info, c, 'usage', r);
  return json(200, { rows: r.rows });
}

const listItem = (s: StatementWithTotals) => ({ orgId: s.orgId, month: s.month, asOf: s.asOf, csvSha256: s.csvSha256, ...(s.pdfSha256 ? { pdfSha256: s.pdfSha256 } : {}), issuedBy: s.issuedBy, issuedAt: s.issuedAt });

async function statementsOf(env: Env, info: RequestInfo, c: ReportCaller): Promise<{ ok: true; statements: StatementWithTotals[] } | { ok: false; res: Response }> {
  let r;
  try {
    r = await env.API.statements({ ...ctxOf(info, c), orgId: c.orgId });
  } catch {
    return { ok: false, res: upstream(info, c, 'statements') };
  }
  if (!r.ok) return { ok: false, res: rpcError(info, c, 'statements', r) };
  return { ok: true, statements: r.statements };
}

/** `GET /api/orgs/:org/statements` → the metadata and hashes (StatementMeta[]; no file keys). */
export async function statementsRoute(env: Env, info: RequestInfo, c: ReportCaller): Promise<Response> {
  const s = await statementsOf(env, info, c);
  return s.ok ? json(200, { statements: s.statements.map(listItem) }) : s.res;
}

/** `GET /api/orgs/:org/statements/:month` → the on-screen statement (D92): the stored totals, the view, the hashes. */
export async function statementViewRoute(env: Env, info: RequestInfo, c: ReportCaller, month: string): Promise<Response> {
  if (!MONTH_RE.test(month)) return errorResponse('bad_request', 'month: YYYY-MM');
  const s = await statementsOf(env, info, c);
  if (!s.ok) return s.res;
  const st = s.statements.find((x) => x.month === month);
  if (!st) return errorResponse('not_found', `No ${month} statement`);
  return json(200, { statement: { ...listItem(st), totals: st.totals }, view: statementView(st) });
}

const sha256Hex = async (bytes: Uint8Array): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** `GET /api/orgs/:org/statements/:month.csv` / `.pdf`: the frozen file, served only when it matches its hash. */
export async function statementFileRoute(env: Env, info: RequestInfo, c: ReportCaller, month: string, ext: 'csv' | 'pdf'): Promise<Response> {
  if (!MONTH_RE.test(month)) return errorResponse('bad_request', 'month: YYYY-MM');
  const s = await statementsOf(env, info, c);
  if (!s.ok) return s.res;
  const st = s.statements.find((x) => x.month === month);
  const key = ext === 'csv' ? st?.csvKey : st?.pdfKey;
  const want = ext === 'csv' ? st?.csvSha256 : st?.pdfSha256;
  if (!st || !key || !want) return errorResponse('not_found', `No ${month} statement ${ext.toUpperCase()}`);
  // A key of this org's statements only (defence: the RPC already filters by org).
  if (!key.startsWith(`statements/${c.orgId}/${month}/`)) return errorResponse('not_found', `No ${month} statement ${ext.toUpperCase()}`);
  const obj = await env.STATEMENTS?.get(key);
  if (!obj) {
    log({ event: 'report', method: 'statement_file', requestId: info.requestId, orgId: c.orgId, outcome: 'error', code: 'statement_file_missing' }, 'error');
    return errorResponse('internal', 'The statement file is unavailable; tell Hana');
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if ((await sha256Hex(bytes)) !== want) {
    log({ event: 'report', method: 'statement_file', requestId: info.requestId, orgId: c.orgId, outcome: 'error', code: 'statement_hash_mismatch' }, 'error');
    return errorResponse('internal', 'The stored file does not match its statement hash; tell Hana');
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': ext === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf',
      'content-disposition': `attachment; filename="hana-id-statement-${month}.${ext}"`,
      'x-hana-sha256': want,
      'cache-control': 'no-store',
    },
  });
}

/**
 * `GET /api/orgs/:org/ledger/:month.csv[?asOf=<ms>]`: the ledger CSV streamed page by page from `ConsoleRpc.ledger`,
 * every page at the same as_of (the first page's, or the given one: a statement's, to reconcile it). The first page is
 * read before the answer starts, so a refusal is a proper error; a failure later ends the CSV with an `# incomplete`
 * line, never a silently short file.
 */
export async function ledgerCsvRoute(env: Env, info: RequestInfo, c: ReportCaller, month: string, url: URL): Promise<Response> {
  if (!MONTH_RE.test(month)) return errorResponse('bad_request', 'month: YYYY-MM');
  const rawAsOf = url.searchParams.get('asOf');
  if (rawAsOf !== null && !/^\d{1,16}$/u.test(rawAsOf)) return errorResponse('bad_request', 'asOf: milliseconds');
  const base = { ...ctxOf(info, c), orgId: c.orgId, month };
  let first;
  try {
    first = await env.API.ledger({ ...base, ...(rawAsOf !== null ? { asOf: Number(rawAsOf) } : {}) });
  } catch {
    return upstream(info, c, 'ledger');
  }
  if (!first.ok) return rpcError(info, c, 'ledger', first);
  const asOf = first.asOf;
  const enc = new TextEncoder();
  type Page = { rows: LedgerRow[]; next?: string };
  let page: Page | null = first;
  let pages = 1;
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      ctl.enqueue(enc.encode(csvLine(LEDGER_CSV_COLUMNS)));
    },
    async pull(ctl) {
      const current: Page | null = page;
      if (!current) return ctl.close();
      ctl.enqueue(enc.encode(current.rows.map((r) => csvLine(ledgerCsvCells(r))).join('')));
      page = null;
      if (!current.next) return ctl.close();
      if (pages >= LEDGER_CSV_MAX_PAGES) {
        ctl.enqueue(enc.encode(`# incomplete: more than ${LEDGER_CSV_MAX_PAGES * 1000} rows; ask Hana for the full export\n`));
        return ctl.close();
      }
      try {
        const next = await env.API.ledger({ ...base, asOf, after: current.next });
        if (!next.ok) throw new Error(next.code);
        page = next;
        pages++;
      } catch {
        log({ event: 'report', method: 'ledger', requestId: info.requestId, orgId: c.orgId, outcome: 'error', code: 'ledger_page_failed' }, 'error');
        ctl.enqueue(enc.encode('# incomplete: a page could not be read; download again\n'));
        ctl.close();
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="hana-id-ledger-${month}.csv"`, 'x-hana-as-of': String(asOf), 'cache-control': 'no-store' },
  });
}
