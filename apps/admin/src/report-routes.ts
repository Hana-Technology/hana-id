// The staff BFF's reports, statements, rates and exports (docs/batch-c-spec.md "Admin BFF routes"; batch C12; D326):
//
//   GET  /api/reports?org&from&to&by&apps               usage.org_report for any org (UsageRow[], with late events)
//   GET  /api/statements?org                            the org's statements (metadata, hashes, totals)
//   GET  /api/statements/:org/:month                    the on-screen statement (D92), or what still blocks issuing it
//   GET  /api/statements/:org/:month.csv | .pdf         the files from STATEMENTS, checked against their sha256 in Neon
//   POST /api/statements/:org/:month/issue              issue (statements.ts)
//   POST /api/exports/:org/:month {asOf?}               the ledger CSV to EXPORTS under exports/
//   GET  /api/exports/:org/:month/:file                 an export, from EXPORTS
//   GET  /api/rates?month                               the month's rates, the overrides and the missing days
//   PUT  /api/rates/:day {usd, reason}                  the audited override (refused once the month has a statement)
//
// Each opens one ledger connection (USAGE_DB, usage_admin) for the request; without the binding the answer is 503
// `ledger_unavailable`. Inputs are checked here (the Neon functions check them again).
import { type StatementSqlRow, statementOf, statementView, usageInput, usageRowOf } from '@hana-id/console-core';
import { errorResponse, json } from './http.ts';
import { type LedgerStore, ledgerSource } from './ledger.ts';
import { errorName, log } from './log.ts';
import type { RouteCtx } from './routes.ts';
import { staffCtx } from './rpc.ts';
import { MONTH_RE, type Refusal, exportKey, exportLedger, issueStatement, issuableFrom, monthDays, sha256Hex } from './statements.ts';

const ORG_RE = /^org_[A-Za-z0-9]{1,64}$/u;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/u;

async function withLedger(c: RouteCtx, route: string, fn: (store: LedgerStore) => Promise<Response>): Promise<Response> {
  let store: LedgerStore | null;
  try {
    store = await ledgerSource.open(c.env.USAGE_DB);
  } catch (err) {
    log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'error', code: 'ledger_unavailable', error: errorName(err) }, 'error');
    return errorResponse('ledger_unavailable');
  }
  if (!store) return errorResponse('ledger_unavailable', 'USAGE_DB is not bound in this environment');
  try {
    return await fn(store);
  } catch (err) {
    log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'error', code: 'internal', error: errorName(err) }, 'error');
    return errorResponse('internal');
  } finally {
    await store.close();
  }
}

const refused = (route: string, c: RouteCtx, r: Refusal): Response => {
  log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'rejected', code: r.code });
  return errorResponse(r.code, r.error);
};

export async function reportsRoute(c: RouteCtx): Promise<Response> {
  const q = c.url.searchParams;
  const apps = q.get('apps');
  const input = usageInput.safeParse({
    ...staffCtx(c.staff),
    orgId: q.get('org') ?? '',
    from: q.get('from') ?? '',
    to: q.get('to') ?? '',
    by: q.get('by') ?? 'day',
    ...(apps ? { appIds: apps.split(',').filter(Boolean) } : {}),
  });
  if (!input.success) {
    const issue = input.error.issues[0];
    return errorResponse('bad_request', issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'Invalid input');
  }
  const i = input.data;
  return withLedger(c, 'GET /api/reports', async (store) => {
    const rows = await store.report(i.orgId, i.from, i.to, i.by, i.appIds ?? null, null);
    log({ event: 'bff', route: 'GET /api/reports', requestId: c.staff.requestId, orgId: i.orgId, outcome: 'ok', count: rows.length });
    return json(200, { rows: rows.map((r) => usageRowOf(i.orgId, r)) });
  });
}

export async function statementsListRoute(c: RouteCtx): Promise<Response> {
  const org = c.url.searchParams.get('org') ?? '';
  if (!ORG_RE.test(org)) return errorResponse('bad_request', 'org: an org id');
  return withLedger(c, 'GET /api/statements', async (store) => json(200, { statements: (await store.statements(org)).map((r) => statementOf(org, r)) }));
}

const findStatement = async (store: LedgerStore, org: string, month: string): Promise<StatementSqlRow | undefined> => (await store.statements(org)).find((s) => s.month === month);

/** The on-screen statement, a file (`<month>.csv` / `<month>.pdf`), or for a month not issued yet its blockers. */
export async function statementRoute(c: RouteCtx): Promise<Response> {
  const org = c.params.org!;
  const m = /^(\d{4}-\d{2})(?:\.(csv|pdf))?$/u.exec(c.params.month!);
  if (!ORG_RE.test(org) || !m || !MONTH_RE.test(m[1]!)) return errorResponse('bad_request', 'An org id and a month (YYYY-MM)');
  const [, month, ext] = m as unknown as [string, string, 'csv' | 'pdf' | undefined];
  return withLedger(c, 'GET /api/statements/:org/:month', async (store) => {
    const s = await findStatement(store, org, month);
    if (!ext) {
      if (s) {
        const st = statementOf(org, s);
        return json(200, { statement: st, view: statementView(st) });
      }
      const blockers = await store.blockers(org, month);
      return json(200, { statement: null, issuableFrom: issuableFrom(month), blockers });
    }
    if (!s) return errorResponse('not_found', `No ${month} statement`);
    const key = ext === 'csv' ? s.csv_key : s.pdf_key;
    const want = ext === 'csv' ? s.csv_sha256 : s.pdf_sha256;
    if (!key || !want) return errorResponse('not_found', `No ${ext.toUpperCase()} for this statement`);
    const bucket = c.env.STATEMENTS;
    if (!bucket) return errorResponse('internal', 'STATEMENTS is not bound');
    const obj = await bucket.get(key);
    if (!obj) return errorResponse('not_found', 'The statement file is missing from R2');
    const bytes = new Uint8Array(await obj.arrayBuffer());
    // Tamper evidence: the file must still be the one whose hash Neon froze.
    if ((await sha256Hex(bytes)) !== want) {
      log({ event: 'bff', route: 'GET /api/statements/:org/:month', requestId: c.staff.requestId, orgId: org, outcome: 'error', code: 'statement_hash_mismatch' }, 'error');
      return errorResponse('internal', 'The stored file does not match its statement hash: tell Hana security');
    }
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': ext === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf',
        'content-disposition': `attachment; filename="statement-${org}-${month}.${ext}"`,
        'x-hana-sha256': want,
        'cache-control': 'no-store',
      },
    });
  });
}

export async function issueRoute(c: RouteCtx): Promise<Response> {
  const org = c.params.org!;
  const month = c.params.month!;
  if (!ORG_RE.test(org) || !MONTH_RE.test(month)) return errorResponse('bad_request', 'An org id and a month (YYYY-MM)');
  const bucket = c.env.STATEMENTS;
  if (!bucket) return errorResponse('internal', 'STATEMENTS is not bound in this environment');
  const network = c.env.NEAR_NETWORK;
  if (!network) return errorResponse('internal', 'NEAR_NETWORK is not set: a statement must name its network');
  return withLedger(c, 'POST /api/statements/:org/:month/issue', async (store) => {
    const r = await issueStatement({ store, api: c.env.API, console: c.env.CONSOLE, bucket, network, staff: c.staff, now: Date.now() }, org, month);
    if (!r.ok) return refused('POST /api/statements/:org/:month/issue', c, r);
    log({ event: 'bff', route: 'POST /api/statements/:org/:month/issue', requestId: c.staff.requestId, orgId: org, outcome: 'ok' });
    return json(200, { statement: r.statement, view: statementView(r.statement), auditRecorded: r.auditRecorded });
  });
}

export async function exportRoute(c: RouteCtx): Promise<Response> {
  const org = c.params.org!;
  const month = c.params.month!;
  if (!ORG_RE.test(org) || !MONTH_RE.test(month)) return errorResponse('bad_request', 'An org id and a month (YYYY-MM)');
  const asOf = c.body.asOf;
  if (asOf !== undefined && (typeof asOf !== 'number' || !Number.isSafeInteger(asOf))) return errorResponse('bad_request', 'asOf: milliseconds');
  const bucket = c.env.EXPORTS;
  if (!bucket) return errorResponse('internal', 'EXPORTS is not bound in this environment');
  return withLedger(c, 'POST /api/exports/:org/:month', async (store) => {
    const r = await exportLedger({ store, bucket, console: c.env.CONSOLE, staff: c.staff, now: Date.now() }, org, month, asOf as number | undefined);
    if (!r.ok) return refused('POST /api/exports/:org/:month', c, r);
    log({ event: 'bff', route: 'POST /api/exports/:org/:month', requestId: c.staff.requestId, orgId: org, outcome: 'ok', count: r.rows });
    const { ok: _ok, ...rest } = r;
    return json(200, { ...rest, file: r.key.split('/').pop() });
  });
}

export async function exportFileRoute(c: RouteCtx): Promise<Response> {
  const key = exportKey(c.params.org!, c.params.month!, c.params.file!);
  if (!key) return errorResponse('bad_request', 'Not an export name');
  const obj = await c.env.EXPORTS?.get(key);
  if (!obj) return errorResponse('not_found', 'No such export (exports are kept 30 days)');
  return new Response(obj.body, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="ledger-${c.params.org}-${c.params.month}.csv"`, 'cache-control': 'no-store' } });
}

export async function ratesRoute(c: RouteCtx): Promise<Response> {
  const month = c.url.searchParams.get('month') ?? new Date().toISOString().slice(0, 7);
  if (!MONTH_RE.test(month)) return errorResponse('bad_request', 'month: YYYY-MM');
  const { first, last } = monthDays(month);
  return withLedger(c, 'GET /api/rates', async (store) => {
    const rates = await store.ratesBetween(first, last);
    const overrides = await store.rateOverrides(first, last);
    const have = new Set(rates.map((r) => r.day));
    const missing: string[] = [];
    for (let t = Date.parse(`${first}T00:00:00Z`); t <= Date.parse(`${last}T00:00:00Z`); t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (!have.has(d) && t <= Date.now()) missing.push(d);
    }
    return json(200, {
      month,
      rates: rates.map((r) => ({ day: r.day, usdMicros: r.usdMicros.toString(), source: r.source, enteredBy: r.enteredBy, fetchedAt: r.fetchedAt })),
      overrides: overrides.map((o) => ({ ...o, usdMicros: o.usdMicros.toString(), previousUsdMicros: o.previousUsdMicros?.toString() ?? null })),
      missing,
    });
  });
}

/** A USD decimal (≤ 6 places) as micro-dollars, or null. */
export function usdToMicros(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^\d{1,7}(\.\d{1,6})?$/u.test(v)) return null;
  const [i, f = ''] = v.split('.');
  const micros = BigInt(i!) * 1_000_000n + BigInt(f.padEnd(6, '0'));
  return micros > 0n ? micros : null;
}

export async function rateOverrideRoute(c: RouteCtx): Promise<Response> {
  const day = c.params.day!;
  if (!DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return errorResponse('bad_request', 'day: YYYY-MM-DD');
  const micros = usdToMicros(c.body.usd);
  if (micros === null) return errorResponse('bad_request', 'usd: a positive decimal with at most 6 places, as a string');
  const reason = typeof c.body.reason === 'string' ? c.body.reason.trim() : '';
  if (reason.length < 10 || reason.length > 500) return errorResponse('bad_request', 'reason: 10 to 500 characters (it is kept with the rate)');
  return withLedger(c, 'PUT /api/rates/:day', async (store) => {
    let id: number;
    try {
      id = await store.overrideRate(day, micros, c.staff.actor.email, reason);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === '42501') return errorResponse('conflict', `The rate of ${day} is frozen: its month has a statement`);
      if (code === '22023') return errorResponse('bad_request', 'The rate was refused (a future day, or out of range)');
      throw err;
    }
    try {
      const a = await c.env.CONSOLE.recordStaffAction({ ...staffCtx(c.staff), action: 'rate.overridden', target: day, details: { day, usdMicros: micros.toString(), overrideId: id } });
      if (!a.ok) log({ event: 'bff', route: 'PUT /api/rates/:day', requestId: c.staff.requestId, outcome: 'error', code: 'audit_failed' }, 'error');
    } catch (err) {
      log({ event: 'bff', route: 'PUT /api/rates/:day', requestId: c.staff.requestId, outcome: 'error', code: 'audit_failed', error: errorName(err) }, 'error');
    }
    log({ event: 'bff', route: 'PUT /api/rates/:day', requestId: c.staff.requestId, outcome: 'ok' });
    return json(200, { day, usdMicros: micros.toString(), source: 'manual', overrideId: id });
  });
}
