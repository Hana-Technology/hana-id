// The RPC and view types of docs/batch-c-spec.md "RPC interfaces" and "Types", as zod schemas (the RPC boundaries
// validate with them) with their TS types. The enum lists are the single source for the databases' CHECK lists: the
// migration tests compare them.
import { z } from 'zod';

// ---- enums shared with the migrations ----

export const ENVIRONMENTS = ['test', 'live'] as const;
export const ROLES = ['owner', 'viewer'] as const;
export const ACTOR_KINDS = ['member', 'hana', 'system', 'link'] as const;
export const PROPOSER_KINDS = ['member', 'hana', 'system'] as const;
export const GUARDED_CHANGE_KINDS = ['origin_add', 'policy_set', 'raw_sign_on'] as const;
export const GUARDED_CHANGE_STATUSES = ['pending', 'active', 'cancelled', 'ended'] as const;
export const WAIVERS = ['loopback', 'no_session'] as const;
export const SECURITY_EVENT_KINDS = ['drift', 'breaker', 'owner_cap', 'owner_allowance_low'] as const;
export const ORG_KINDS = ['partner', 'internal'] as const;
export const ORG_STATUSES = ['active', 'frozen'] as const;
export const GRANTOR_KINDS = ['member', 'hana'] as const;
export const AUTH_FLOW_PURPOSES = ['login', 'step_up'] as const;
export const AUTH_FLOW_SCOPES = ['openid email', 'openid'] as const;
export const AUDIT_OUTCOMES = ['ok', 'failed'] as const;
/** Fresh sign-in kinds (docs/batch-c-spec.md "Fresh sign-in"). */
export const STEP_UP_KINDS = [
  'origin.add',
  'policy.set',
  'raw_sign.on',
  'app.resume',
  'app.settings',
  'owner_action',
  'member.invite',
  'member.role',
  'member.remove',
  'org.policy',
] as const;
export const OWNER_ACTION_METHODS = ['propose_change', 'execute_change', 'cancel_change', 'remove_client', 'disable_shared_login'] as const;

/** `apps.suspended_by` bits: Hana per app, Hana for the whole org, the partner. Active iff 0. */
export const SUSPENSION_BITS = { hana: 1, org: 2, partner: 4 } as const;

// ---- result envelope and codes ----

export const RPC_CODES = [
  'bad_request',
  'not_found',
  'forbidden',
  'version_conflict',
  'already_applied',
  'not_owner',
  'origin_refused',
  'policy_invalid',
  'token_used',
  'near_unavailable',
  'rate_limited',
  'key_limit',
  'env_mismatch',
  'scope_conflict',
  'not_pending',
  'conflict',
  'no_security_contact',
  'invalid_client_proof',
  'owner_nonce_mismatch',
  'passkeys_required',
  'internal',
] as const;
export type RpcCode = (typeof RPC_CODES)[number];
export const rpcCode = z.enum(RPC_CODES);

/** RpcCode → HTTP status in the console and admin BFFs. */
export const RPC_HTTP_STATUS: Record<RpcCode, number> = {
  bad_request: 400,
  origin_refused: 400,
  policy_invalid: 400,
  env_mismatch: 400,
  invalid_client_proof: 400,
  forbidden: 403,
  not_owner: 403,
  not_found: 404,
  version_conflict: 409,
  already_applied: 409,
  token_used: 409,
  scope_conflict: 409,
  not_pending: 409,
  conflict: 409,
  key_limit: 409,
  no_security_contact: 409,
  owner_nonce_mismatch: 409,
  passkeys_required: 403,
  rate_limited: 429,
  internal: 500,
  near_unavailable: 503,
};

/** Codes only the console BFF answers, with their status. */
export const CONSOLE_ERROR_STATUS = {
  unauthenticated: 401,
  csrf: 403,
  not_invited: 403,
  invite_invalid: 403,
  user_disabled: 403,
  org_frozen: 403,
  step_up_required: 403,
  already_member: 409,
  step_up_expired: 409,
  logo_type: 400,
  logo_too_large: 413,
  rate_limited: 429,
} as const;
export type ConsoleErrorCode = keyof typeof CONSOLE_ERROR_STATUS;

/** Every RPC answers `{ok: true, …}` or `{ok: false, code, error?}`. */
export type RpcOk<T extends object> = { ok: true } & T;
export type RpcFail = { ok: false; code: RpcCode; error?: string };
export type Rpc<T extends object> = Promise<RpcOk<T> | RpcFail>;

export const rpcFail = z.object({ ok: z.literal(false), code: rpcCode, error: z.string().max(500).optional() }).strict();
export const rpcResult = <T extends z.ZodRawShape>(shape: T) => z.union([z.object({ ok: z.literal(true), ...shape }).strict(), rpcFail]);

/** The BFFs' error body: `{error: {code, message}}`. */
export const errorBody = z.object({ error: z.object({ code: z.string().min(1), message: z.string() }).strict() }).strict();

// ---- primitives ----

/** UTC day, YYYY-MM-DD, a real calendar date. */
export const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Not a calendar date');
export type Day = z.infer<typeof day>;
/** A month, YYYY-MM. */
export const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
export const role = z.enum(ROLES);
export type Role = z.infer<typeof role>;
export const environment = z.enum(ENVIRONMENTS);
export const ms = z.number().int().nonnegative();
const id = z.string().min(1).max(128);
const email = z.string().email().max(254);
/** A request id: the idempotency key of every write (`app_changes.request_id`, the ledger's `request_id`). */
export const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u);
/** b64url of 32 bytes (sha256 values passed over RPC). */
export const b64url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const decimal = z.string().regex(/^(0|[1-9]\d*)$/u);

// ---- actors and context ----

export const actor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), id, sub: z.string().min(1).max(255), email, sessionHash: b64url32 }).strict(),
  z.object({ kind: z.literal('hana'), id: z.string().min(1).max(255), email }).strict(),
  z.object({ kind: z.literal('system'), id }).strict(),
  z.object({ kind: z.literal('link'), id }).strict(),
]);
export type Actor = z.infer<typeof actor>;

export const ctx = z.object({ actor, requestId, clientIp: z.string().min(1).max(64) });
export type Ctx = z.infer<typeof ctx>;

// ---- views (docs/batch-c-spec.md "Types") ----

export const keyView = z
  .object({ id, prefix: z.enum(['pk_test_', 'pk_live_']), key: z.string(), createdBy: z.string(), createdAt: ms, revokedAt: ms.optional() })
  .strict();
export type KeyView = z.infer<typeof keyView>;

export const guardedChange = z
  .object({
    id,
    appId: id,
    kind: z.enum(GUARDED_CHANGE_KINDS),
    origin: z.string().optional(),
    display: z.string().optional(),
    idn: z.boolean().optional(),
    policyId: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
    status: z.enum(GUARDED_CHANGE_STATUSES),
    proposedByKind: z.enum(PROPOSER_KINDS),
    proposedBy: z.string(),
    proposedAt: ms,
    requestCountry: z.string().optional(),
    waiver: z.enum(WAIVERS).optional(),
    notifiedAt: ms.optional(),
    activeFrom: ms.nullable().optional(),
    expeditedBy: z.string().optional(),
    cancelledBy: z.string().optional(),
    cancelledAt: ms.optional(),
  })
  .strict();
export type GuardedChange = z.infer<typeof guardedChange>;

export const appSummary = z
  .object({
    id,
    name: z.string(),
    scopeId: z.string(),
    environment,
    suspendedBy: z.number().int().min(0).max(7),
    deleted: z.boolean(),
    activeOrigins: z.number().int().nonnegative(),
    pendingChanges: z.number().int().nonnegative(),
    logoUrl: z.string().url().optional(),
    createdAt: ms,
  })
  .strict();
export type AppSummary = z.infer<typeof appSummary>;

export const appDetail = appSummary
  .extend({
    orgId: id,
    originsVersion: z.number().int().nonnegative(),
    settingsVersion: z.number().int().nonnegative(),
    origins: z.array(z.object({ origin: z.string(), display: z.string(), idn: z.boolean(), activeFrom: ms.nullable(), changeId: id.optional() }).strict()),
    settings: z
      .object({
        persistence: z.enum(['session', 'none']),
        sessionTtlMs: ms,
        idleTtlMs: ms,
        googleWebClientId: z.string().nullable(),
        rawSign: z.enum(['off', 'approval']),
        policy: z.object({ policyId: z.string().regex(/^[0-9a-f]{64}$/u), label: z.string(), json: z.unknown() }).strict().nullable(),
      })
      .strict(),
    changes: z.array(guardedChange),
    keys: z.array(keyView),
  })
  .strict();
export type AppDetail = z.infer<typeof appDetail>;

export const usageRow = z
  .object({
    orgId: id,
    appId: id.optional(),
    scopeId: z.string().optional(),
    period: z.union([day, month]),
    logins: z.number().int().nonnegative(),
    derives: z.number().int().nonnegative(),
    revokes: z.number().int().nonnegative(),
    unlocks: z.number().int().nonnegative(),
    ownerActions: z.number().int().nonnegative(),
    activeUsers: z.number().int().nonnegative().optional(),
    newUsers: z.number().int().nonnegative(),
    failuresByCode: z.record(z.string(), z.number().int().nonnegative()),
    tgas: z.string(),
    relayedRejectedTgas: z.string(),
    errorTgas: z.string(),
    burntYocto: decimal,
    usdMicros: decimal.optional(),
    p50: z.object({ login: z.number().optional(), derive: z.number().optional() }).strict(),
    p95: z.object({ login: z.number().optional(), derive: z.number().optional() }).strict(),
    unsettled: z.number().int().nonnegative(),
  })
  .strict();
export type UsageRow = z.infer<typeof usageRow>;

export const statementMeta = z
  .object({ orgId: id, month, asOf: ms, csvSha256: z.string().regex(/^[0-9a-f]{64}$/u), pdfSha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(), issuedBy: z.string(), issuedAt: ms })
  .strict();
export type StatementMeta = z.infer<typeof statementMeta>;

export const appChange = z
  .object({
    seq: z.number().int().positive(),
    at: ms,
    orgId: id,
    appId: id.optional(),
    scopeId: z.string().optional(),
    kind: z.string().min(1),
    detail: z.record(z.string(), z.unknown()),
    actorKind: z.enum(ACTOR_KINDS),
    actorId: z.string(),
    actorSub: z.string().optional(),
    requestId: z.string(),
  })
  .strict();
export type AppChange = z.infer<typeof appChange>;

export const securityEvent = z
  .object({
    id,
    detectedAt: ms,
    kind: z.enum(SECURITY_EVENT_KINDS),
    orgId: id.optional(),
    appId: id.optional(),
    scopeId: z.string().optional(),
    detail: z.record(z.string(), z.unknown()),
    notifiedAt: ms.optional(),
  })
  .strict();
export type SecurityEvent = z.infer<typeof securityEvent>;

export const scopeRow = z.object({ scopeId: z.string(), orgId: id, environment, assignedAt: ms }).strict();
export type ScopeRow = z.infer<typeof scopeRow>;

export const ownerActionBody = z.object({ method: z.enum(OWNER_ACTION_METHODS), args: z.record(z.string(), z.unknown()) }).strict();
export type OwnerActionBody = z.infer<typeof ownerActionBody>;

// StaffRpc views mirror their CONSOLE_DB rows with allowlisted columns only: never token_hash, cancel_token_hash or
// cookies (docs/batch-c-spec.md "Types").

export const orgView = z
  .object({ id, name: z.string(), kind: z.enum(ORG_KINDS), status: z.enum(ORG_STATUSES), requiredHd: z.string().optional(), createdAt: ms, contractRef: z.string().optional(), billingEmail: email.optional() })
  .strict();
export type OrgView = z.infer<typeof orgView>;

export const memberView = z
  .object({ orgId: id, userId: id, email, sub: z.string().optional(), role, roleSince: ms, addedBy: z.string(), addedAt: ms, disabled: z.boolean(), pendingOwnerFrom: ms.optional() })
  .strict();
export type MemberView = z.infer<typeof memberView>;

export const inviteView = z
  .object({
    id,
    email,
    orgId: id.optional(),
    newOrgName: z.string().optional(),
    role,
    createdByKind: z.enum(GRANTOR_KINDS),
    createdBy: z.string(),
    notifiedAt: ms.optional(),
    createdAt: ms,
    expiresAt: ms,
    acceptedAt: ms.optional(),
    acceptedUserId: id.optional(),
    revokedAt: ms.optional(),
  })
  .strict();
export type InviteView = z.infer<typeof inviteView>;

export const ownerGrantView = z
  .object({
    id,
    orgId: id,
    userId: id.optional(),
    inviteId: id.optional(),
    grantedByKind: z.enum(GRANTOR_KINDS),
    grantedBy: z.string(),
    createdAt: ms,
    notifiedAt: ms.optional(),
    ownerFrom: ms.optional(),
    cancelledAt: ms.optional(),
    appliedAt: ms.optional(),
  })
  .strict();
export type OwnerGrantView = z.infer<typeof ownerGrantView>;

export const auditRow = z
  .object({
    seq: z.number().int().positive(),
    at: ms,
    actorKind: z.enum(ACTOR_KINDS),
    actorId: z.string(),
    actorEmail: z.string().optional(),
    actorSub: z.string().optional(),
    orgId: id.optional(),
    appId: id.optional(),
    action: z.string().min(1),
    target: z.string().optional(),
    details: z.record(z.string(), z.unknown()),
    stepUpId: id.optional(),
    requestId: z.string(),
    nearTx: z.string().optional(),
    country: z.string().optional(),
    outcome: z.enum(AUDIT_OUTCOMES),
  })
  .strict();
export type AuditRow = z.infer<typeof auditRow>;
