// The partner console's sign-in and read-only views (docs/batch-c-spec.md "Partner sign-in", "Console BFF routes"):
// what the console's `/api/*` backend answers a signed-in member, and the sign-in request bodies. The SPA imports the
// types; the console builds every answer through these shapes, so a field a partner must not see (a staff Access
// `sub`, a member's Google `sub`, an IP prefix, a token or a hash) can't slip into one. Partners never see end-user
// email addresses (D269): nothing here, or in the console, reads the email issuer's directory. The addresses below are
// the org's own members and invitees (partner staff), which the spec shows them.
import { z } from 'zod';
import { ACTOR_KINDS, AUDIT_OUTCOMES, GRANTOR_KINDS, ORG_STATUSES, role } from './types.ts';

const ms = z.number().int().nonnegative();
const id = z.string().min(1).max(128);
/** b64url, no padding, of exactly 32 bytes. */
const b64url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

// ---- sign-in (docs/batch-c-spec.md "Code flow") ----

/** `POST /api/auth/start`: a login, with the invite token from `/invite#t=` when there is one. */
export const authStartBody = z.object({ purpose: z.literal('login'), invite: b64url32.optional() }).strict();
export type AuthStartBody = z.infer<typeof authStartBody>;
export interface AuthStartAnswer {
  /** `<console.authOrigin>/start?f=<handle>`: the SPA navigates the top-level window there. */
  startUrl: string;
}

/**
 * The codes a failed sign-in ends with. `/api/auth/complete` is a top-level navigation, so it answers them as a 303 to
 * `/signin#error=<code>` (D292), never as a page with the identity in it.
 */
export const SIGN_IN_ERRORS = ['not_invited', 'invite_invalid', 'already_member', 'user_disabled', 'expired', 'rate_limited', 'internal'] as const;
export type SignInError = (typeof SIGN_IN_ERRORS)[number];

// ---- the signed-in member ----

export const membership = z.object({ orgId: id, orgName: z.string(), status: z.enum(ORG_STATUSES), role }).strict();
export type Membership = z.infer<typeof membership>;

/** `GET /api/me`: the member's own account and the memberships usable with this session's Workspace domain. */
export const meAnswer = z
  .object({
    user: z.object({ id, email: z.string() }).strict(),
    memberships: z.array(membership),
    /** Screens the server has on (C10: the Users screen, D310, behind USERS_SCREEN). */
    features: z.object({ users: z.boolean() }).strict().optional(),
  })
  .strict();
export type MeAnswer = z.infer<typeof meAnswer>;

/** `GET /api/orgs/:org`. */
export const partnerOrg = z.object({ id, name: z.string(), status: z.enum(ORG_STATUSES), requiredHd: z.string().optional() }).strict();
export type PartnerOrg = z.infer<typeof partnerOrg>;
export const orgAnswer = z.object({ org: partnerOrg, role }).strict();
export type OrgAnswer = z.infer<typeof orgAnswer>;

// ---- members (`GET /api/orgs/:org/members`) ----

/**
 * Who added or invited someone, as a partner sees it: a member's user id, or `hana` for Hana staff (a staffer's Access
 * subject is staff-only).
 */
export const partnerActorId = z.string().regex(/^(usr_[A-Za-z0-9]{1,64}|hana|system)$/u);

export const partnerMember = z
  .object({
    userId: id,
    email: z.string(),
    role,
    roleSince: ms,
    addedBy: partnerActorId,
    addedAt: ms,
    disabled: z.boolean(),
    /** A pending owner: the time its grant makes them an owner (unset while the grant's notice is unsent). */
    pendingOwnerFrom: ms.optional(),
  })
  .strict();
export type PartnerMember = z.infer<typeof partnerMember>;

/** An open invite to the org (accepted, revoked and expired ones are history in the audit). */
export const partnerInvite = z
  .object({
    id,
    email: z.string(),
    role,
    createdByKind: z.enum(GRANTOR_KINDS),
    createdBy: partnerActorId,
    /** Whether the notice was sent, so the link works (D89: notice first). */
    notified: z.boolean(),
    createdAt: ms,
    expiresAt: ms,
  })
  .strict();
export type PartnerInvite = z.infer<typeof partnerInvite>;

/** A live owner grant (not cancelled, not yet applied). */
export const partnerGrant = z
  .object({ id, userId: id.optional(), inviteId: id.optional(), grantedByKind: z.enum(GRANTOR_KINDS), createdAt: ms, notifiedAt: ms.optional(), ownerFrom: ms.optional() })
  .strict();
export type PartnerGrant = z.infer<typeof partnerGrant>;

export const membersAnswer = z.object({ members: z.array(partnerMember), invites: z.array(partnerInvite), grants: z.array(partnerGrant) }).strict();
export type MembersAnswer = z.infer<typeof membersAnswer>;

// ---- audit (`GET /api/orgs/:org/audit?cursor=`: audit_log merged with ConsoleRpc.listChanges) ----

/** A console-side event (`audit_log`), as a partner sees it: no IP prefix, no Google `sub`, staff shown as `hana`. */
export const partnerConsoleEvent = z
  .object({
    source: z.literal('console'),
    seq: z.number().int().positive(),
    at: ms,
    actorKind: z.enum(ACTOR_KINDS),
    actorId: z.string(),
    /** The acting member's own address (a member of this org); never a staffer's. */
    actorEmail: z.string().optional(),
    appId: z.string().optional(),
    action: z.string(),
    target: z.string().optional(),
    details: z.record(z.string(), z.unknown()),
    requestId: z.string(),
    nearTx: z.string().optional(),
    country: z.string().optional(),
    outcome: z.enum(AUDIT_OUTCOMES),
  })
  .strict();
export type PartnerConsoleEvent = z.infer<typeof partnerConsoleEvent>;

/** An applied app change (the hot DB's `app_changes`, authoritative for apps), as a partner sees it. */
export const partnerAppChange = z
  .object({
    source: z.literal('api'),
    seq: z.number().int().positive(),
    at: ms,
    appId: z.string().optional(),
    scopeId: z.string().optional(),
    kind: z.string(),
    detail: z.record(z.string(), z.unknown()),
    actorKind: z.enum(ACTOR_KINDS),
    actorId: z.string(),
    requestId: z.string(),
  })
  .strict();
export type PartnerAppChange = z.infer<typeof partnerAppChange>;

export const partnerAuditEntry = z.discriminatedUnion('source', [partnerConsoleEvent, partnerAppChange]);
export type PartnerAuditEntry = z.infer<typeof partnerAuditEntry>;

/** Newest first; `next` is the cursor of the following page (`<audit seq>.<change seq>`, each an exclusive bound). */
export const auditAnswer = z.object({ entries: z.array(partnerAuditEntry), next: z.string().optional() }).strict();
export type AuditAnswer = z.infer<typeof auditAnswer>;
/** The audit cursor: two exclusive upper bounds, the console's `audit_log.seq` and the API's `app_changes.seq`. */
export const AUDIT_CURSOR_RE = /^([1-9]\d{0,14})\.([1-9]\d{0,14})$/u;
export const AUDIT_PAGE = 50;
