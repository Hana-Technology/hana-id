// The staff Support ID lookup (batch C15; docs/batch-c-spec.md "Support ID lookup"; D96, D144, D276 as amended by D346,
// D394–D396): the backend of the admin console's lookup screen, which is built after C8b (the Users screen and
// DirectoryRpc on the issuer) merges.
//
//   POST /api/support/lookup {query, ticket, requestIds?, days?}
//        query       a Support ID (HANA-XXXX-XXXX, any case, prefix and dashes optional), a User ID (u1_…) or an internal
//                    id (hu_…); a wallet address or a sub goes through the Users search first
//        ticket      the support reference or a short reason (1–64 printable characters, no `@`): it is stored
//        requestIds  up to 20 request IDs from the partner's escalation (their ledger events, errors included)
//        days        the window, 1–731 (30 by default)
//     → console-core SupportLookupView: the matches (the directory's user, the scope's apps, the vault shares that
//       haven't expired, the apps' changes), each match's ok login/session/derive events, the request IDs' events,
//       and `ledger: {available}`.
//
// Order (D396): (1) the audit row (`StaffRpc.recordStaffAction`, `support.lookup`, org-less: the staff email, the query
// as given, the ticket, the request-ID count and the window), and nothing is read when it can't be written; (2) the
// hot-DB part (`AdminRpc.supportLookup`); (3) the ledger part as `usage_admin` over USAGE_DB. Without the binding (a dev
// env with usage capture off, as sandbox-dev today) or when Neon doesn't answer, the answer still comes with the
// directory part and `ledger: {available: false, reason: "ledger unavailable…"}`: never a guess, never an error page.
//
// POST so no code lands in a URL (the spec's BFF table). Nothing here logs the query, a sub, an address or a row: the
// bff log line has counts only.
import { type SupportLookupResult, formatSupportId, parseSupportQuery, supportLookupBody, withSupportLedger, LEDGER_UNAVAILABLE, SUPPORT_DAYS_DEFAULT } from '@hana-id/console-core';
import { errorResponse, json } from './http.ts';
import { type LedgerStore, ledgerSource } from './ledger.ts';
import { errorName, log } from './log.ts';
import type { RouteCtx } from './routes.ts';
import { staffCtx } from './rpc.ts';

const ROUTE = 'POST /api/support/lookup';

export async function supportLookupRoute(c: RouteCtx): Promise<Response> {
  const parsed = supportLookupBody.safeParse(c.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return errorResponse('bad_request', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body');
  }
  const body = parsed.data;
  const query = parseSupportQuery(body.query);
  if (!query) return errorResponse('bad_request', 'query: not a Support ID (HANA-XXXX-XXXX), User ID (u1_…) or internal id (hu_…)');
  const days = body.days ?? SUPPORT_DAYS_DEFAULT;
  const requestIds = [...new Set(body.requestIds ?? [])];
  const target = query.kind === 'supportId' ? formatSupportId(query.code) : query.kind === 'userId' ? query.userId : query.internalId;
  const ctx = staffCtx(c.staff);

  // 1. The audit row first: no row, no data.
  try {
    const a = await c.env.CONSOLE.recordStaffAction({ ...ctx, action: 'support.lookup', target, details: { by: query.kind, ticket: body.ticket, requestIds: requestIds.length, days } });
    if (!a.ok) {
      log({ event: 'audit_failed', route: ROUTE, requestId: c.staff.requestId, code: a.code }, 'error');
      return errorResponse(a.code === 'bad_request' ? 'bad_request' : 'internal', a.code === 'bad_request' ? a.error : 'The lookup could not be recorded, so nothing was read');
    }
  } catch (err) {
    log({ event: 'audit_failed', route: ROUTE, requestId: c.staff.requestId, code: 'upstream_unavailable', error: errorName(err) }, 'error');
    return errorResponse('upstream_unavailable', 'The lookup could not be recorded, so nothing was read');
  }

  // 2. The hot-DB part: the directory's matches, their apps, shares and the apps' changes.
  let result: SupportLookupResult;
  try {
    const r = await c.env.API.supportLookup({ ...ctx, query: target, days });
    if (!r.ok) {
      log({ event: 'bff', route: ROUTE, requestId: c.staff.requestId, outcome: 'rejected', code: r.code });
      return errorResponse(r.code, r.error);
    }
    const { ok: _ok, ...rest } = r;
    result = rest;
  } catch (err) {
    log({ event: 'bff', route: ROUTE, requestId: c.staff.requestId, outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'error');
    return errorResponse('upstream_unavailable');
  }

  // 3. The ledger part, degrading to "ledger unavailable".
  let store: LedgerStore | null = null;
  let unavailable = `${LEDGER_UNAVAILABLE}: USAGE_DB is not bound in this environment (usage capture is off)`;
  try {
    store = await ledgerSource.open(c.env.USAGE_DB);
  } catch (err) {
    unavailable = `${LEDGER_UNAVAILABLE}: no connection`;
    log({ event: 'bff', route: ROUTE, requestId: c.staff.requestId, outcome: 'error', code: 'ledger_unavailable', error: errorName(err) }, 'warn');
  }
  try {
    const view = await withSupportLedger(result, { days, requestIds, reader: store?.support ?? null, unavailable });
    log({ event: 'bff', route: ROUTE, requestId: c.staff.requestId, outcome: 'ok', count: view.matches.length, ...(view.ledger.available ? {} : { code: 'ledger_unavailable' }) });
    return json(200, view);
  } finally {
    await store?.close();
  }
}
