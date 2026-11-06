// The inputs of ConsoleRpc and AdminRpc (docs/batch-c-spec.md "RPC interfaces"), as zod schemas: the API validates
// every call with them before it reads anything, and the console and the admin Worker build their calls from the same
// types. Each schema is the call's `Ctx` (actor, requestId, clientIp) plus its own fields, strict (an unknown field is
// `bad_request`, so a caller can't think it set something the API ignores).
import { z } from 'zod';
import { ctx, environment, ownerActionBody } from './types.ts';
import { APP_NAME_MAX } from './names.ts';
import { MAX_APP_ORIGINS } from './origins.ts';

// ---- ids at the RPC boundary ----
//
// Lookup keys only (always bound as parameters). Generated ids are a prefix + base58 (ids.ts); the patterns here also
// take the ids older rows carry (`org_legacy`, `key_legacy_<app id>`, apps' `app_<base58>`) and stay alphanumeric.

export const orgIdInput = z.string().regex(/^org_[A-Za-z0-9]{1,64}$/u);
export const appIdInput = z.string().regex(/^app_[A-Za-z0-9]{1,64}$/u);
export const changeIdInput = z.string().regex(/^gc_[A-Za-z0-9]{1,64}$/u);
export const keyIdInput = z.string().regex(/^key_[A-Za-z0-9_]{1,96}$/u);
export const securityEventIdInput = z.string().regex(/^se_[A-Za-z0-9]{1,64}$/u);
/** Scope ids: "global" or the contract's "s" + base36. */
export const scopeIdInput = z.string().regex(/^(global|s[0-9a-z]{1,32})$/u);
/** A Google `sub` (on-chain `Owner::Oidc`). */
export const subInput = z.string().min(1).max(255);
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** An app name as typed (the API applies normaliseAppName). */
const appNameRaw = z.string().min(1).max(4 * APP_NAME_MAX);
/** An origin as typed: the API normalises it (console-core normaliseOrigin) and applies the origin rules. */
const originInput = z.string().min(1).max(2048);
const origins = z.array(originInput).min(1).max(MAX_APP_ORIGINS);
const limit = (max: number) => z.number().int().min(1).max(max);
/** b64url, no padding, of exactly 32 bytes (a link token or a sha256). */
const b64url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
/** A logo object key in LOGOS: `logos/<app id>/<sha256 hex>.png` (docs/batch-c-spec.md "Other app settings"). */
export const LOGO_KEY_RE = /^logos\/(app_[A-Za-z0-9]{1,64})\/[0-9a-f]{64}\.png$/u;

const appName = appNameRaw;
/**
 * A compact JWS (a Google ID token: the step-up token of a guarded change). The contract's limit is 7168 bytes; the
 * API verifies it (signature, audience, age, nonce, owner) and never logs or stores it.
 */
export const JWT_MAX = 7168;
const jwt = z.string().max(JWT_MAX).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

const org = { orgId: orgIdInput };
const app = { orgId: orgIdInput, appId: appIdInput };

// ---- ConsoleRpc (also the org methods AdminRpc has for any org) ----

export const listAppsInput = ctx.extend(org).strict();
export const getAppInput = ctx.extend(app).strict();
export const removeOriginsInput = ctx.extend({ ...app, remove: origins, expectedVersion: version }).strict();
export const turnOffInput = ctx.extend({ ...app, what: z.enum(['policy', 'raw_sign']), expectedVersion: version }).strict();
/** AdminRpc.setMainnetDemo (D428): Hana staff only; ConsoleRpc has no such method. */
export const setMainnetDemoInput = ctx.extend({ ...app, on: z.boolean(), expectedVersion: version }).strict();
export const updateSettingsInput = ctx
  .extend({
    ...app,
    expectedVersion: version,
    persistence: z.enum(['session', 'none']).optional(),
    sessionTtlMs: z.number().int().optional(),
    idleTtlMs: z.number().int().optional(),
    googleWebClientId: z.string().min(1).max(255).nullable().optional(),
    name: appName.optional(),
  })
  .strict();
export const setLogoInput = ctx.extend({ ...app, logoKey: z.string().regex(LOGO_KEY_RE).nullable(), expectedVersion: version }).strict();
export const cancelChangeInput = ctx.extend({ ...org, changeId: changeIdInput }).strict();
export const cancelChangeByLinkInput = ctx.extend({ changeId: changeIdInput, token: b64url32 }).strict();
export const consoleSetSuspendedInput = ctx.extend({ ...app, suspended: z.boolean() }).strict();
export const createKeyInput = ctx.extend(app).strict();
export const rotateKeyInput = ctx.extend({ ...app, keyId: keyIdInput }).strict();
export const revokeKeyInput = ctx.extend({ ...app, keyId: keyIdInput }).strict();
export const listChangesInput = ctx.extend({ ...org, beforeSeq: z.number().int().positive().optional(), limit: limit(200) }).strict();
/** A member's origin add (with any removes sent with it), bound to its step-up token (spec "API verification"). */
export const changeOriginsInput = ctx
  .extend({ ...app, add: origins, remove: z.array(originInput).max(MAX_APP_ORIGINS), expectedVersion: version, stepUpJwt: jwt })
  .strict();
/** A member's policy set or raw-signing enable, bound to its step-up token. */
export const consoleProposeChangeInput = ctx
  .extend({ ...app, kind: z.enum(['policy_set', 'raw_sign_on']), policy: z.unknown().optional(), expectedVersion: version, stepUpJwt: jwt })
  .strict();
/** An on-chain owner action, relayed byte-identical through the owner pool (the API checks it as /v1/owner-actions does). */
export const ownerActionInput = ctx.extend({ ...org, body: ownerActionBody }).strict();

// ---- AdminRpc ----

export const createAppInput = ctx
  .extend({
    ...org,
    scopeId: scopeIdInput,
    environment,
    name: appName,
    origins: z.array(originInput).max(MAX_APP_ORIGINS),
    orgOwnerSubs: z.array(subInput).max(100),
  })
  .strict();
export const assignScopeOrgInput = ctx.extend({ scopeId: scopeIdInput, ...org, orgOwnerSubs: z.array(subInput).max(100) }).strict();
export const deleteAppInput = ctx.extend({ appId: appIdInput }).strict();
export const adminSetSuspendedInput = ctx.extend({ appId: appIdInput, bit: z.union([z.literal(1), z.literal(2), z.literal(4)]), suspended: z.boolean() }).strict();
export const suspendOrgInput = ctx.extend({ ...org, suspended: z.boolean() }).strict();
export const addOriginsInput = ctx.extend({ ...app, add: origins, expectedVersion: version }).strict();
export const adminProposeChangeInput = ctx
  .extend({ ...app, kind: z.enum(['policy_set', 'raw_sign_on']), policy: z.unknown().optional(), expectedVersion: version })
  .strict();
/** The reason names the security contact, other than the proposer, who confirmed the change out of band, and how. */
export const EXPEDITE_REASON_MIN = 20;
export const expediteChangeInput = ctx.extend({ changeId: changeIdInput, reason: z.string().trim().min(EXPEDITE_REASON_MIN).max(1000) }).strict();
export const pendingNoticesInput = ctx.extend({ limit: limit(100) }).strict();
export const ackNoticeInput = ctx.extend({ changeId: changeIdInput, cancelTokenHash: b64url32 }).strict();
export const SECURITY_CONTACTS_MAX = 10;
export const setSecurityContactsInput = ctx
  .extend({ ...org, emails: z.array(z.string().email().max(254).refine((e) => e === e.toLowerCase(), 'lowercase')).min(1).max(SECURITY_CONTACTS_MAX) })
  .strict();
export const getSecurityContactsInput = ctx.extend(org).strict();
export const listScopesInput = ctx.extend({ cursor: scopeIdInput.optional(), limit: limit(500) }).strict();
export const changesSinceInput = ctx.extend({ seq: z.number().int().nonnegative(), limit: limit(500) }).strict();
export const securityEventsInput = ctx.extend({ unnotifiedOnly: z.boolean(), limit: limit(500) }).strict();
export const markSecurityEventNotifiedInput = ctx.extend({ ids: z.array(securityEventIdInput).min(1).max(500) }).strict();
export const relayerKeysInput = ctx.strict();

export type ListAppsInput = z.infer<typeof listAppsInput>;
export type GetAppInput = z.infer<typeof getAppInput>;
export type RemoveOriginsInput = z.infer<typeof removeOriginsInput>;
export type TurnOffInput = z.infer<typeof turnOffInput>;
export type SetMainnetDemoInput = z.infer<typeof setMainnetDemoInput>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsInput>;
export type SetLogoInput = z.infer<typeof setLogoInput>;
export type CancelChangeInput = z.infer<typeof cancelChangeInput>;
export type CancelChangeByLinkInput = z.infer<typeof cancelChangeByLinkInput>;
export type ConsoleSetSuspendedInput = z.infer<typeof consoleSetSuspendedInput>;
export type CreateKeyInput = z.infer<typeof createKeyInput>;
export type RotateKeyInput = z.infer<typeof rotateKeyInput>;
export type RevokeKeyInput = z.infer<typeof revokeKeyInput>;
export type ListChangesInput = z.infer<typeof listChangesInput>;
export type ChangeOriginsInput = z.infer<typeof changeOriginsInput>;
export type ConsoleProposeChangeInput = z.infer<typeof consoleProposeChangeInput>;
export type OwnerActionInput = z.infer<typeof ownerActionInput>;
export type CreateAppInput = z.infer<typeof createAppInput>;
export type AssignScopeOrgInput = z.infer<typeof assignScopeOrgInput>;
export type DeleteAppInput = z.infer<typeof deleteAppInput>;
export type AdminSetSuspendedInput = z.infer<typeof adminSetSuspendedInput>;
export type SuspendOrgInput = z.infer<typeof suspendOrgInput>;
export type AddOriginsInput = z.infer<typeof addOriginsInput>;
export type AdminProposeChangeInput = z.infer<typeof adminProposeChangeInput>;
export type ExpediteChangeInput = z.infer<typeof expediteChangeInput>;
export type PendingNoticesInput = z.infer<typeof pendingNoticesInput>;
export type AckNoticeInput = z.infer<typeof ackNoticeInput>;
export type SetSecurityContactsInput = z.infer<typeof setSecurityContactsInput>;
export type GetSecurityContactsInput = z.infer<typeof getSecurityContactsInput>;
export type ListScopesInput = z.infer<typeof listScopesInput>;
export type ChangesSinceInput = z.infer<typeof changesSinceInput>;
export type SecurityEventsInput = z.infer<typeof securityEventsInput>;
export type MarkSecurityEventNotifiedInput = z.infer<typeof markSecurityEventNotifiedInput>;
export type RelayerKeysInput = z.infer<typeof relayerKeysInput>;
