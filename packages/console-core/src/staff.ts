// StaffRpc (apps/console, bound only by the admin Worker; docs/batch-c-spec.md "RPC interfaces") and the console's two
// emailed-link confirms (§Console BFF routes `POST /api/cancel`, `POST /api/owner-grants/cancel`), as zod schemas: the
// console validates every call with them before it reads anything, and the admin Worker (batch C8) builds its calls
// from the same types. Strict like rpc.ts: an unknown field is `bad_request`.
import { z } from '@hana-id/env/zod';
import { ACTOR_KINDS, ORG_KINDS, ctx, inviteView, ownerGrantView, requestId, role } from './types.ts';
import { orgIdInput } from './rpc.ts';

export const userIdInput = z.string().regex(/^usr_[A-Za-z0-9]{1,64}$/u);
export const inviteIdInput = z.string().regex(/^inv_[A-Za-z0-9]{1,64}$/u);
export const ownerGrantIdInput = z.string().regex(/^og_[A-Za-z0-9]{1,64}$/u);
/** b64url, no padding, of exactly 32 bytes (a link token or its sha256). */
const b64url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const limit = (max: number) => z.number().int().min(1).max(max);
/**
 * A time in ms or a row number: an integer the console can use as a SQL literal (`lit` refuses anything past 2^53 − 1),
 * so an out-of-range value is `bad_request`, never an `internal` from the query builder.
 */
const ms = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** At most this many open (unaccepted, unrevoked, unexpired) invites per org (docs/batch-c-spec.md "Invites"). */
export const MAX_OPEN_INVITES = 10;
/** An invite works for 7 days from its creation (the notice's wait counts against it). */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
/** The longest org name, in code points (the app-name rule, `normaliseAppName`). */
export const ORG_NAME_MAX = 64;

/**
 * An invitee's address as typed: trimmed and lowercased by the schema, never dot- or plus-normalised (the spec's
 * "exact after lowercasing" match at acceptance).
 */
export const inviteEmail = z
  .string()
  .trim()
  .max(254)
  .transform((e) => e.toLowerCase())
  .pipe(z.string().email());

export const listOrgsInput = ctx.extend({ cursor: orgIdInput.optional(), limit: limit(200) }).strict();
export const getOrgInput = ctx.extend({ orgId: orgIdInput }).strict();
export const issueInviteInput = ctx
  .extend({
    email: inviteEmail,
    role,
    orgId: orgIdInput.optional(),
    newOrgName: z.string().min(1).max(4 * ORG_NAME_MAX).optional(),
    kind: z.enum(ORG_KINDS).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if ((v.orgId === undefined) === (v.newOrgName === undefined)) c.addIssue({ code: z.ZodIssueCode.custom, path: ['orgId'], message: 'Exactly one of orgId and newOrgName' });
    if (v.kind !== undefined && v.newOrgName === undefined) c.addIssue({ code: z.ZodIssueCode.custom, path: ['kind'], message: 'kind is for a new org only' });
    if (v.newOrgName !== undefined && v.role !== 'owner') c.addIssue({ code: z.ZodIssueCode.custom, path: ['role'], message: "A new org's first member is its owner" });
  });
export const revokeInviteInput = ctx.extend({ inviteId: inviteIdInput }).strict();
export const pendingMemberNoticesInput = ctx.extend({ limit: limit(100) }).strict();
export const ackMemberNoticeInput = ctx
  .extend({ inviteId: inviteIdInput.optional(), grantId: ownerGrantIdInput.optional(), tokenHash: b64url32 })
  .strict()
  .refine((v) => (v.inviteId === undefined) !== (v.grantId === undefined), { message: 'Exactly one of inviteId and grantId', path: ['inviteId'] });
export const cancelOwnerGrantInput = ctx.extend({ grantId: ownerGrantIdInput }).strict();
export const listMembersInput = ctx.extend({ orgId: orgIdInput }).strict();
export const setMemberInput = ctx.extend({ orgId: orgIdInput, userId: userIdInput, role: role.nullable() }).strict();
export const disableUserInput = ctx.extend({ userId: userIdInput, disabled: z.boolean() }).strict();
export const freezeOrgInput = ctx.extend({ orgId: orgIdInput, frozen: z.boolean() }).strict();
export const auditSinceInput = ctx.extend({ seq: ms, limit: limit(500) }).strict();

/** `queryAudit` filters: all optional, ANDed. `from`/`to` are `at` bounds in ms (from inclusive, to exclusive). */
export const auditFilters = z
  .object({
    orgId: orgIdInput.optional(),
    appId: z.string().regex(/^app_[A-Za-z0-9]{1,64}$/u).optional(),
    actorKind: z.enum(ACTOR_KINDS).optional(),
    actorId: z.string().min(1).max(255).optional(),
    action: z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/u).max(64).optional(),
    from: ms.optional(),
    to: ms.optional(),
  })
  .strict();
export type AuditFilters = z.infer<typeof auditFilters>;
/** The cursor is the last row's `seq` (rows come newest first): at most 15 digits, so always a safe integer. */
export const queryAuditInput = ctx.extend({ filters: auditFilters, cursor: z.string().regex(/^[1-9]\d{0,14}$/u).optional(), limit: limit(500) }).strict();

/**
 * Staff actions of the admin Worker that have no StaffRpc or AdminRpc write of their own (batch C12, D327): a statement
 * issued, a ledger export, a rate override, and (batch C15, D396) a Support ID lookup, recorded before its data is read
 * (org-less, so no partner's audit view or feed ever shows it). `recordStaffAction` appends their `audit_log` row (Hana
 * actor), so the audit view shows them beside every other staff act. Details are ids, months, hashes and counts; a
 * lookup's are the query's kind, the ticket, the request-ID count, the request IDs themselves (`requestIdList`, at most
 * SUPPORT_REQUEST_IDS_MAX in the request-ID form: the only list a detail may hold, D410) and the window, and its target
 * is the query as given (a Support ID, User ID or internal id: never an address or a sub). A `users.find` (the Users
 * screen's wallet-directory find, D410) is org-less too: the query's kind and the ticket, the target the id or wallet
 * address looked up (never a sub).
 */
export const STAFF_ACTIONS = ['statement.issued', 'ledger.exported', 'rate.overridden', 'support.lookup', 'users.find'] as const;
/** Staff actions about an end user, not an org's act: recorded without an org, so no partner's view or feed shows them. */
export const ORGLESS_STAFF_ACTIONS: ReadonlySet<string> = new Set(['support.lookup', 'users.find']);
/** The one detail that is a list: a lookup's request IDs (at most 20, each in the request-ID form). */
export const STAFF_DETAIL_LIST_MAX = 20;
const isListDetail = (action: string, key: string) => action === 'support.lookup' && key === 'requestIdList';
export const recordStaffActionInput = ctx
  .extend({
    orgId: orgIdInput.optional(),
    action: z.enum(STAFF_ACTIONS),
    target: z.string().min(1).max(128).optional(),
    details: z
      .record(z.string().max(32), z.union([z.string().max(128), z.number(), z.boolean(), z.null(), z.array(requestId).max(STAFF_DETAIL_LIST_MAX)]))
      .refine((d) => Object.keys(d).length <= 16, 'At most 16 details'),
  })
  .strict()
  .refine((v) => Object.entries(v.details).every(([k, x]) => Array.isArray(x) === isListDetail(v.action, k)), {
    message: 'Only support.lookup’s requestIdList is a list (of request IDs), and it is always one',
    path: ['details'],
  });
export type RecordStaffActionInput = z.infer<typeof recordStaffActionInput>;

// The console's emailed-link confirms (no session; the token is the proof; CSRF rules apply).
export const cancelByLinkBody = z.object({ changeId: z.string().regex(/^gc_[A-Za-z0-9]{1,64}$/u), token: b64url32 }).strict();
export const ownerGrantCancelBody = z.object({ grantId: ownerGrantIdInput, token: b64url32 }).strict();

export type ListOrgsInput = z.infer<typeof listOrgsInput>;
export type GetOrgInput = z.infer<typeof getOrgInput>;
export type IssueInviteInput = z.infer<typeof issueInviteInput>;
export type RevokeInviteInput = z.infer<typeof revokeInviteInput>;
export type PendingMemberNoticesInput = z.infer<typeof pendingMemberNoticesInput>;
export type AckMemberNoticeInput = z.infer<typeof ackMemberNoticeInput>;
export type CancelOwnerGrantInput = z.infer<typeof cancelOwnerGrantInput>;
export type ListMembersInput = z.infer<typeof listMembersInput>;
export type SetMemberInput = z.infer<typeof setMemberInput>;
export type DisableUserInput = z.infer<typeof disableUserInput>;
export type FreezeOrgInput = z.infer<typeof freezeOrgInput>;
export type AuditSinceInput = z.infer<typeof auditSinceInput>;
export type QueryAuditInput = z.infer<typeof queryAuditInput>;
export type CancelByLinkBody = z.infer<typeof cancelByLinkBody>;
export type OwnerGrantCancelBody = z.infer<typeof ownerGrantCancelBody>;

/**
 * One blocking notice `pendingMemberNotices` lists (docs/batch-c-spec.md "Invites and owner grants"): an invite (the
 * link to the invitee, the notice to every owner, the contacts and the alias) or an owner grant (every owner, the
 * contacts and the alias, with the cancel link). A grant of an owner invite also carries its invite; a promotion
 * carries the promoted `member` (D243), so the admin Worker can say who is becoming an owner without a second call.
 * `owners` are the org's current owners (never a pending one). No token or token hash is ever in a notice: the admin
 * Worker computes the link token from its own key and the id (D240).
 */
export const memberNotice = z
  .object({
    kind: z.enum(['invite', 'owner_grant']),
    invite: inviteView.optional(),
    grant: ownerGrantView.optional(),
    member: z.object({ userId: z.string(), email: z.string() }).strict().optional(),
    owners: z.array(z.object({ email: z.string() }).strict()),
  })
  .strict();
export type MemberNotice = z.infer<typeof memberNotice>;
