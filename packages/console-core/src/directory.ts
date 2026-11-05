// The staff Users screen's read path into the email issuer's user directory (D269, D275 as confirmed 2026-11-05;
// docs/batch-c-spec.md "Users and Support ID"): `DirectoryRpc`, a WorkerEntrypoint the issuer exports with no route and
// only the admin Worker binds (`ISSUER`). Every call carries the staff request's Cloudflare Access JWT, which the issuer
// verifies itself (the admin application's AUD, the team domain, the staff list) and records as the actor; every read
// writes its `email_admin_audit` row in the same D1 batch; each staff email gets at most DIRECTORY_ROWS_PER_HOUR and
// DIRECTORY_ROWS_PER_DAY identities back. A support reference (`ticket`) is required to open one identity (`get`) and
// optional for a search. A `get` is audited as `user_view` (the Users detail) or `support_lookup` (the Support ID
// lookup's email join, D399).
//
// Partners never reach any of this: no partner Worker binds the issuer, and no ConsoleRpc, `/v1` or SDK field carries a
// directory value (tests in apps/email-issuer/scripts/test/directory-rpc-source.test.ts and apps/admin's config tests).
import { z } from 'zod';
import { requestId } from './types.ts';

export const DIRECTORY_PROVIDERS = ['email', 'google'] as const;
export type DirectoryProvider = (typeof DIRECTORY_PROVIDERS)[number];

/** The actions of `email_admin_audit` (issuer migration 0003's CHECK list; a migration test compares them). */
export const DIRECTORY_AUDIT_ACTIONS = ['client_proof', 'unlock', 'unsuppress', 'revoke_tickets', 'user_search', 'user_view', 'support_lookup'] as const;
export type DirectoryAuditAction = (typeof DIRECTORY_AUDIT_ACTIONS)[number];

/**
 * Identities one staff email can get back from the directory (search rows and opened details), per hour and per UTC
 * day, counted in the issuer's RateLimiter (provisional numbers, D275 as confirmed 2026-11-05). Past either, the call
 * answers `rate_limited` with `budget` and the admin Worker emails the security alias (`directory_budget`).
 */
export const DIRECTORY_ROWS_PER_HOUR = 500;
export const DIRECTORY_ROWS_PER_DAY = 2000;

export const DIRECTORY_PAGE_DEFAULT = 50;
export const DIRECTORY_PAGE_MAX = 100;
/** An address term shorter than this that isn't a full address is refused (a scan per search, D275). */
export const DIRECTORY_SUBSTRING_MIN = 3;
export const DIRECTORY_AUDIT_PAGE_MAX = 200;

/**
 * A support reference: the issuer's staff routes' rule (apps/email-issuer/src/handlers.ts `SUPPORT_TICKET_RE`): 1–64
 * characters of letters, digits and `._#:-`. Never an address (no `@`).
 */
export const SUPPORT_TICKET_RE = /^[A-Za-z0-9._#:-]{1,64}$/u;

/** The CLI's words for a Google account's unverified claim to an address (scripts/lib/admin-users.ts uses this text). */
export const UNVERIFIED_CLAIM_WARNING = 'UNVERIFIED: this Google account claims the address but Google hasn’t verified it; don’t treat it as the owner';

/** The Access JWT as Cloudflare puts it in `Cf-Access-Jwt-Assertion` (about 1 KB; longer is refused unread). */
const accessJwt = z.string().min(16).max(8192);
const ticket = z.string().regex(SUPPORT_TICKET_RE);
const provider = z.enum(DIRECTORY_PROVIDERS);
/** A sub as on chain: e1.… for email, Google's digits; ≤ 255 (the directory's own bound). */
const sub = z.string().min(1).max(255).regex(/^\S+$/u);
const appId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
/** An address term: a full address (exact) or a part of one (substring, ≥ 3 characters); never logged or audited. */
const addressTerm = z.string().trim().min(1).max(320);

/**
 * The page cursor: `<claim>:<lastSeenMs>:<provider>:<sub>` of the page's last row, in the search's order (verified rows
 * first, then newest first; `claim` is 1 for a Google account's unverified claim). The sub is the row's own, already
 * on chain; the cursor never holds an address.
 */
export const DIRECTORY_CURSOR_RE = /^[01]:\d{1,16}:(email|google):\S{1,255}$/u;

export const staffCall = z.object({ requestId, accessJwt });

export const directorySearchInput = staffCall
  .extend({
    ticket: ticket.optional(),
    q: addressTerm.optional(),
    provider: provider.optional(),
    appId: appId.optional(),
    sub: sub.optional(),
    unverifiedOnly: z.boolean().optional(),
    cursor: z.string().regex(DIRECTORY_CURSOR_RE).optional(),
    limit: z.number().int().min(1).max(DIRECTORY_PAGE_MAX).optional(),
  })
  .strict();

/**
 * Why one identity is opened, which names its audit row: `user_view` (the Users detail, the default) or
 * `support_lookup` (the Support ID lookup's email join, D399: the identity of a match the console's `support.lookup`
 * row recorded under the same request ID and ticket).
 */
export const DIRECTORY_GET_PURPOSES = ['user_view', 'support_lookup'] as const;
export type DirectoryGetPurpose = (typeof DIRECTORY_GET_PURPOSES)[number];

export const directoryGetInput = staffCall.extend({ ticket, provider, sub, purpose: z.enum(DIRECTORY_GET_PURPOSES).optional() }).strict();

/** Rows after `id` oldest first (the feed-like walk), or before `before` newest first (the audit screen): one of the two. */
export const directoryAuditInput = staffCall
  .extend({
    id: z.number().int().min(0).optional(),
    before: z.number().int().min(1).optional(),
    staff: z.string().email().max(254).optional(),
    action: z.enum(DIRECTORY_AUDIT_ACTIONS).optional(),
    limit: z.number().int().min(1).max(DIRECTORY_AUDIT_PAGE_MAX),
  })
  .strict()
  .refine((v) => (v.id === undefined) !== (v.before === undefined), { message: 'Give id or before, exactly one' });

export type DirectorySearchInput = z.infer<typeof directorySearchInput>;
export type DirectoryGetInput = z.infer<typeof directoryGetInput>;
export type DirectoryAuditInput = z.infer<typeof directoryAuditInput>;

/** One identity of the directory (`user_emails`), as staff see it. */
export interface DirectoryUserRow {
  provider: DirectoryProvider;
  /** As on chain. */
  sub: string;
  /** Personal data: staff only, never logged, never in an audit row. */
  email: string;
  emailVerified: boolean;
  /** Google-hosted (D158); null for email. */
  hosted: boolean | null;
  /** A Google account's claim to an address Google hasn't verified (CLI `unverifiedClaim`): never the owner. */
  unverifiedClaim: boolean;
  /** When the issuer saw the identity (writes are best effort, so a lost one leaves a gap). */
  firstSeenMs: number;
  lastSeenMs: number;
  appCount: number;
}

/** One app the identity logged in to (`user_email_apps`). */
export interface DirectoryUserApp {
  appId: string;
  scopeId: string;
  firstSeenMs: number;
  lastSeenMs: number;
}

/** One `email_admin_audit` row: the staff email, the ticket and `detail`, never an end user's address. */
export interface DirectoryAuditRow {
  id: number;
  atMs: number;
  staff: string;
  action: string;
  ticket: string | null;
  scopeId: string | null;
  actionNonce: number | null;
  jti: string | null;
  subject: string | null;
  detail: unknown;
}

export const DIRECTORY_CODES = ['bad_request', 'not_found', 'rate_limited', 'internal', 'unauthenticated', 'not_staff', 'access_unavailable'] as const;
export type DirectoryCode = (typeof DIRECTORY_CODES)[number];

/** The window a budget refusal names, and when it opens again. */
export interface DirectoryBudgetRefusal {
  window: '1h' | '1d';
  limit: number;
  retryAfterMs: number;
}

export type DirectoryFail = { ok: false; code: DirectoryCode; error?: string; budget?: DirectoryBudgetRefusal };
export type DirectoryAnswer<T extends object> = Promise<({ ok: true } & T) | DirectoryFail>;

/** The issuer's entrypoint as the admin Worker calls it over `ISSUER` (apps/email-issuer/src/directory-rpc.ts). */
export interface DirectoryRpcClient {
  search(c: unknown): DirectoryAnswer<{ users: DirectoryUserRow[]; next?: string }>;
  get(c: unknown): DirectoryAnswer<{ user: DirectoryUserRow; apps: DirectoryUserApp[] }>;
  auditSince(c: unknown): DirectoryAnswer<{ rows: DirectoryAuditRow[] }>;
}

/** A full address (an exact, indexed match) as opposed to a part of one (a substring scan). */
export const isFullAddress = (term: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(term.trim());
