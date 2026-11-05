// The staff Support ID lookup (batch C15; docs/batch-c-spec.md "Support ID lookup"; D96, D144, D276 as amended by D346,
// D394–D396, D399): the backend of the admin console's lookup screen (`/support` in the SPA).
//
//   POST /api/support/lookup {query, ticket, requestIds?, days?}
//        query       a Support ID (HANA-XXXX-XXXX, any case, prefix and dashes optional), a User ID (u1_…) or an internal
//                    id (hu_…); a wallet address or a sub goes through the Users search first
//        ticket      the support reference (1–64 letters, digits or ._#:-; console-core SUPPORT_TICKET_RE): it is stored
//                    in the console's audit and, for the email join, the issuer's
//        requestIds  up to 20 request IDs from the partner's escalation (their ledger events, errors included)
//        days        the window, 1–731 (30 by default)
//     → console-core SupportLookupView (the matches: the directory's user, the scope's apps, the vault shares that
//       haven't expired, the apps' changes; each match's ok login/session/derive events, the request IDs' events, and
//       `ledger: {available}`) plus `emails`: the issuer's directory row of each identity the matches hold.
//
// Order (D396, D399): (1) the audit row (`StaffRpc.recordStaffAction`, `support.lookup`, org-less: the staff email, the
// query as given, the ticket, the request-ID count and the window), and nothing is read when it can't be written; (2)
// the hot-DB part (`AdminRpc.supportLookup`); (3) together, the ledger part as `usage_admin` over USAGE_DB and the email
// join: for each distinct identity of the matches (at most SUPPORT_EMAILS_MAX), `DirectoryRpc.get` with the request's
// Access JWT, the same ticket and `purpose: 'support_lookup'`, so the issuer's own audit row says why the address was
// read and names this request (the console row's request id). Without USAGE_DB (a dev env with usage capture off, as
// sandbox-dev today) or when Neon doesn't answer, the answer still comes with the directory part and `ledger:
// {available: false, reason: "ledger unavailable…"}`; without the issuer, or past the staff member's row budget, each
// identity's email says why it wasn't read. Never a guess, never an error page.
//
// POST so no code lands in a URL (the spec's BFF table). Nothing here logs the query, a sub, an address or a row: the
// bff log line has counts only.
import {
  DIRECTORY_PROVIDERS,
  type DirectoryBudgetRefusal,
  type DirectoryUserRow,
  LEDGER_UNAVAILABLE,
  SUPPORT_DAYS_DEFAULT,
  type SupportLookupResult,
  type SupportLookupView,
  UNVERIFIED_CLAIM_WARNING,
  formatSupportId,
  parseSupportQuery,
  supportLookupBody,
  withSupportLedger,
} from '@hana-id/console-core';
import { errorResponse, json } from './http.ts';
import { type LedgerStore, ledgerSource } from './ledger.ts';
import { errorName, log } from './log.ts';
import type { RouteCtx } from './routes.ts';
import { staffCtx } from './rpc.ts';
import { budgetAlert, staffCall } from './users.ts';

const ROUTE = 'POST /api/support/lookup';

/**
 * Distinct identities whose address one lookup reads (one `DirectoryRpc.get` each, in parallel). With the audit row, the
 * hot-DB read and the ledger's one connection, a lookup stays inside D380's 30 service-binding calls of a request; the
 * identities past it are `not_read` (ten matches of two identities each fit).
 */
export const SUPPORT_EMAILS_MAX = 20;

/** Why an identity's address isn't shown. */
export type SupportEmailMissing = 'not_found' | 'not_read' | 'no_directory' | 'directory_unavailable' | 'directory_refused' | 'rate_limited' | 'failed';

/** The issuer's directory row of one identity of the matches (by `directoryKey`), or why there is none. */
export type SupportEmail = { provider: string; sub: string } & (
  | ({ found: true } & Pick<DirectoryUserRow, 'email' | 'emailVerified' | 'hosted' | 'unverifiedClaim' | 'firstSeenMs' | 'lastSeenMs'>)
  | { found: false; reason: SupportEmailMissing }
);

/** The route's answer: the lookup and the email join. */
export type SupportLookupAnswer = SupportLookupView & {
  emails: SupportEmail[];
  /** Why some or all addresses weren't read (no issuer, the row budget), for the screen; never an address. */
  emailsNote?: string;
  /** console-core UNVERIFIED_CLAIM_WARNING, when an address is a Google account's unverified claim. */
  unverifiedWarning?: string;
};

const ISSUER_PROVIDERS: ReadonlySet<string> = new Set(DIRECTORY_PROVIDERS);

/** The email join (D399): each distinct identity's directory row, read as `support_lookup` with the lookup's ticket. */
async function lookupEmails(c: RouteCtx, result: SupportLookupResult, ticket: string): Promise<Pick<SupportLookupAnswer, 'emails' | 'emailsNote'>> {
  const keys: { provider: string; sub: string }[] = [];
  const seen = new Set<string>();
  for (const m of result.matches)
    for (const i of m.user.identities) {
      if (!i.directoryKey) continue;
      const k = `${i.directoryKey.provider}\n${i.directoryKey.sub}`;
      if (seen.has(k)) continue;
      seen.add(k);
      keys.push({ provider: i.directoryKey.provider, sub: i.directoryKey.sub });
    }
  if (keys.length === 0) return { emails: [] };
  const issuer = c.env.ISSUER;
  if (!issuer) return { emails: keys.map((k) => ({ ...k, found: false, reason: 'directory_unavailable' })), emailsNote: 'No email issuer is bound in this environment: addresses not read' };
  const call = staffCall(c);
  let budget: DirectoryBudgetRefusal | null = null;
  let refused = false;
  let read = 0;
  const emails = await Promise.all(
    keys.map(async (k): Promise<SupportEmail> => {
      if (!ISSUER_PROVIDERS.has(k.provider)) return { ...k, found: false, reason: 'no_directory' };
      if (read >= SUPPORT_EMAILS_MAX) return { ...k, found: false, reason: 'not_read' };
      read++;
      try {
        const r = await issuer.get({ ...call, ticket, provider: k.provider, sub: k.sub, purpose: 'support_lookup' });
        if (r.ok) {
          const u = r.user;
          return { ...k, found: true, email: u.email, emailVerified: u.emailVerified, hosted: u.hosted, unverifiedClaim: u.unverifiedClaim, firstSeenMs: u.firstSeenMs, lastSeenMs: u.lastSeenMs };
        }
        switch (r.code) {
          case 'not_found':
            return { ...k, found: false, reason: 'not_found' };
          case 'rate_limited':
            budget ??= r.budget ?? null;
            return { ...k, found: false, reason: 'rate_limited' };
          case 'unauthenticated':
          case 'not_staff':
            refused = true;
            return { ...k, found: false, reason: 'directory_refused' };
          case 'access_unavailable':
            return { ...k, found: false, reason: 'directory_unavailable' };
          default:
            return { ...k, found: false, reason: 'failed' };
        }
      } catch {
        return { ...k, found: false, reason: 'directory_unavailable' };
      }
    }),
  );
  // The issuer refusing a staff identity this Worker accepted is config drift between the two (D388): an error line.
  if (refused) log({ event: 'directory_refused', route: ROUTE, requestId: c.staff.requestId, outcome: 'error', code: 'directory_refused' }, 'error');
  const b = budget as DirectoryBudgetRefusal | null;
  if (b) await budgetAlert(c, b);
  const notes: string[] = [];
  if (b) notes.push(`Directory row budget reached (${b.limit} identities ${b.window === '1h' ? 'an hour' : 'a day'} per staff member); Hana security has been emailed. Reads open again in ${Math.max(1, Math.ceil(b.retryAfterMs / 60_000))} min`);
  if (emails.some((e) => !e.found && e.reason === 'not_read')) notes.push(`Only the first ${SUPPORT_EMAILS_MAX} identities' addresses are read per lookup`);
  return { emails, ...(notes.length ? { emailsNote: notes.join('. ') } : {}) };
}

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

  // 3. The ledger part, degrading to "ledger unavailable", and the email join, together.
  let store: LedgerStore | null = null;
  let unavailable = `${LEDGER_UNAVAILABLE}: USAGE_DB is not bound in this environment (usage capture is off)`;
  const emailsPart = lookupEmails(c, result, body.ticket);
  try {
    store = await ledgerSource.open(c.env.USAGE_DB);
  } catch (err) {
    unavailable = `${LEDGER_UNAVAILABLE}: no connection`;
    log({ event: 'bff', route: ROUTE, requestId: c.staff.requestId, outcome: 'error', code: 'ledger_unavailable', error: errorName(err) }, 'warn');
  }
  try {
    const [view, mail] = await Promise.all([withSupportLedger(result, { days, requestIds, reader: store?.support ?? null, unavailable }), emailsPart]);
    const answer: SupportLookupAnswer = { ...view, ...mail, ...(mail.emails.some((e) => e.found && e.unverifiedClaim) ? { unverifiedWarning: UNVERIFIED_CLAIM_WARNING } : {}) };
    log({
      event: 'bff',
      route: ROUTE,
      requestId: c.staff.requestId,
      outcome: 'ok',
      count: view.matches.length,
      // The email join's counts only (its outbound calls), never an address or a sub.
      calls: { directoryRead: mail.emails.filter((e) => e.found).length, directoryMissing: mail.emails.filter((e) => !e.found).length },
      ...(view.ledger.available ? {} : { code: 'ledger_unavailable' }),
    });
    return json(200, answer);
  } finally {
    await store?.close();
  }
}
