// Fresh sign-in (step-up; docs/batch-c-spec.md "Fresh sign-in", "On-chain owner actions"): every write the spec marks
// "fresh sign-in" is a Google code flow whose nonce commits to that one action, so the proof is good for it alone.
//
// 1. `POST /api/orgs/:org/actions {kind, params}` (an owner of an active org): the console builds the canonical action,
//    its digest and the Google nonce (the origin-change or settings-change layout for a guarded change, which the API
//    recomputes; the contract's owner-action layout for an owner action, at the scope's `action_nonce` read uncached;
//    the generic step-up layout, bound to this session, otherwise), stores a `pending_actions` row (5 min) and answers
//    `{id, kind, decoded, expiresAt, returnTo}`: the screen shows exactly what will be applied; `returnTo` is the page
//    that started it (an allowlisted page, built here from ids: D711), where its back link goes after the callback.
// 2. `POST /api/actions/:id/google`: an `auth_flows` row (`purpose = 'step_up'`, `scope = 'openid'`, the session's
//    `sub` as `login_hint`, the action's nonce) and `{startUrl}`; the SPA navigates there top-level.
// 3. The callback (auth origin; auth-flow.ts) verifies the token, then `runStepUp` here: the token's `sub` must be the
//    session user's, the action unused and unexpired, its session still live, the member still an owner of the active
//    org. The action is executed inside the callback, so the token is used once and never stored: guarded changes and
//    owner actions take the JWT to the API (`ConsoleRpc.changeOrigins` / `proposeChange` / `ownerAction`), which
//    verifies it itself; console-only kinds (`member.*`, `org.policy`) consume the action, apply the change and write
//    the audit row in one guarded batch. The outcome is stored on the action (`GET /api/actions/:id`).
//
// Single use: an action is consumed once, by `used_at`, whatever the outcome (a refused or failed execution leaves it
// used: the member builds a new one). Every executed step-up writes an audit row with its id as `step_up_id`.
//
// SECURITY: the ID token is never stored, logged or returned. `pending_actions.action_json` holds the canonical action
// and what the screen showed (no token, no cookie, no `sub`).
import {
  type Actor,
  type AppDetail,
  type OwnerActionBody,
  STEP_UP_KINDS,
  appIdInput,
  b64url,
  canonicalize,
  clientProofNonce,
  emailClientAudOf,
  hex,
  inviteEmail,
  newId,
  nonceOf,
  normaliseOrigin,
  originChangeDigest,
  originDisplay,
  originProblem,
  ownerActionArgsBorsh,
  randomBytes,
  sha256,
  ownerActionDigest,
  role,
  scopeIdInput,
  settingsChangeDigest,
  stepUpDigest,
  userIdInput,
  utf8,
} from '@hana-id/console-core';
import { issuesAsZod3, z } from '@hana-id/env/zod';
import { type Writer, auditInsert, entry } from './audit.ts';
import { flowState } from './auth-flow.ts';
import { verifyClientProof } from './auth-token.ts';
import { AUTH_FLOW_TTL_MS, SESSION_IDLE_MS } from './config.ts';
import type { Env } from './env.ts';
import { RpcRefusal } from './errors.ts';
import { type ErrorCode, errorResponse, json, readJson } from './http.ts';
import { issueInvite } from './invites.ts';
import { ipPrefix } from './ip.ts';
import type { RequestInfo } from './links.ts';
import { log } from './log.ts';
import { setMember, setOrgPolicy } from './members.ts';
import { NearUnavailable, type ScopeView, oidcOwners, viewScope } from './near.ts';
import { type OwnerSet, decodeChange, orgOwnerSet, scopeOfOrg } from './scopes.ts';
import { type Session } from './sessions.ts';
import { lit, ownerNow } from './sql.ts';
import { validatePolicy } from './policy.ts';

export type StepUpKind = (typeof STEP_UP_KINDS)[number];

/** A pending action lives 5 minutes (spec). */
export const ACTION_TTL_MS = 5 * 60_000;
/** The biggest `{kind, params}` body (a policy is the largest part: the validator caps it far below this). */
export const MAX_ACTION_BODY = 48 * 1024;
/** Batch B's session ranges (apps/api/src/vault/settings.ts), checked before the sign-in; the API checks them again. */
export const SESSION_TTL_MIN_MS = 60 * 60_000;
export const SESSION_TTL_MAX_MS = 23 * 60 * 60_000 + 50 * 60_000;
export const IDLE_TTL_MIN_MS = 15 * 60_000;

/** What an action does to the hot DB through ConsoleRpc, or only to CONSOLE_DB. */
const CONSOLE_ONLY: ReadonlySet<StepUpKind> = new Set(['member.invite', 'member.role', 'member.remove', 'org.policy']);

/** The step-up's own refusal codes (stored as the outcome and shown on the action page). */
export type StepUpCode = ErrorCode | 'sub_mismatch' | 'session_ended' | 'step_up_expired' | 'nonce_moved';

const originList = z.array(z.string().min(1).max(2048)).max(20);
const params = {
  'origin.add': z.object({ appId: appIdInput, add: originList.min(1), remove: originList.default([]) }).strict(),
  'policy.set': z.object({ appId: appIdInput, policy: z.unknown().optional() }).strict(),
  'raw_sign.on': z.object({ appId: appIdInput }).strict(),
  'app.resume': z.object({ appId: appIdInput }).strict(),
  'app.settings': z
    .object({
      appId: appIdInput,
      persistence: z.enum(['session', 'none']).optional(),
      sessionTtlMs: z.number().int().optional(),
      idleTtlMs: z.number().int().optional(),
      googleWebClientId: z.string().min(1).max(255).nullable().optional(),
      /** D411: when Hana asks users to share their email with the app. */
      identityEmail: z.enum(['off', 'on_request', 'at_login']).optional(),
      /** Batch 9 (D444): turn email login on for this app (`google,email`). Turning it off is `/off`, immediate. */
      loginMethods: z.enum(['google', 'google,email']).optional(),
    })
    .strict(),
  owner_action: z
    .object({
      scopeId: scopeIdInput,
      method: z.enum(['propose_change', 'cancel_change', 'remove_client', 'disable_shared_login']),
      /** propose_change: AddClient (with the pasted client proof), SetAllowShared, or SetOwners built from the org's owners. */
      change: z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('AddClient'), aud: z.string().min(1).max(255), clientProof: z.string().min(1).max(7168), piiWarningAccepted: z.literal(true) }).strict(),
          // Batch 9 (D447): the scope's email client; the console asks the issuer for the proof, none is pasted.
          z.object({ kind: z.literal('AddEmailClient') }).strict(),
          z.object({ kind: z.literal('SetAllowShared') }).strict(),
          z.object({ kind: z.literal('SetOwners') }).strict(),
        ])
        .optional(),
      changeId: z.number().int().nonnegative().optional(),
      aud: z.string().min(1).max(255).optional(),
    })
    .strict(),
  'member.invite': z.object({ email: inviteEmail, role }).strict(),
  'member.role': z.object({ userId: userIdInput, role }).strict(),
  'member.remove': z.object({ userId: userIdInput }).strict(),
  'org.policy': z
    .object({
      requiredHd: z
        .string()
        .trim()
        .toLowerCase()
        .max(253)
        .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u)
        .nullable(),
    })
    .strict(),
} as const satisfies Record<StepUpKind, z.ZodType>;

const actionBody = z.object({ kind: z.enum(STEP_UP_KINDS), params: z.unknown().optional(), returnTo: z.unknown().optional() }).strict();

/**
 * Where the action page's "back" goes (D711): the page that started the action, from this allowlist per kind (the
 * first is the default, for a body without `returnTo`). The path is built here from the org, the action's own app or
 * scope and a page name, never taken from the request: no URL, and no id the action didn't check, reaches the link.
 */
export const RETURN_PAGES = {
  'origin.add': ['origins'],
  'policy.set': ['signing'],
  'raw_sign.on': ['signing'],
  'app.resume': ['suspend'],
  'app.settings': ['sessions', 'email'],
  owner_action: ['scope', 'email'],
  'member.invite': ['members'],
  'member.role': ['members'],
  'member.remove': ['members'],
  'org.policy': ['members'],
} as const satisfies Record<StepUpKind, readonly string[]>;
type ReturnPage = (typeof RETURN_PAGES)[StepUpKind][number];
const APP_PAGES: ReadonlySet<string> = new Set(['origins', 'signing', 'suspend', 'sessions', 'email']);
/** `returnTo`: a page name and, for an app's page reached from a scope action (the Email login tab), the app. */
const returnInput = z.object({ page: z.enum(['origins', 'signing', 'suspend', 'sessions', 'email', 'scope', 'members']), appId: appIdInput.optional() }).strict();

/** The org and role a session route resolved. */
export interface OrgCaller {
  orgId: string;
  orgStatus: 'active' | 'frozen';
  role: 'owner' | 'viewer';
  session: Session;
}

/** The member actor ConsoleRpc gets. */
export const actorOf = (s: Session): Extract<Actor, { kind: 'member' }> => ({ kind: 'member', id: s.userId, sub: s.sub, email: s.email, sessionHash: b64url(s.idHash) });

class BuildRefusal extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BuildRefusal';
  }
}
const no = (code: ErrorCode, message: string): never => {
  throw new BuildRefusal(code, message);
};

interface Built {
  /** The canonical action the server applies (the generic layout hashes exactly this). */
  action: Record<string, unknown>;
  /** What the screen shows (and the member approves). */
  decoded: Record<string, unknown>;
  digest: Uint8Array;
  owner?: { scopeId: string; actionNonce: number; argsJson: string };
}

async function appOf(env: Env, ctx: RpcCtx, orgId: string, appId: string): Promise<AppDetail> {
  const r = await env.API.getApp({ ...ctx, orgId, appId });
  if (!r.ok) return no(r.code, r.code === 'not_found' ? 'No such app in this organisation' : (r.error ?? r.code));
  if (r.app.deleted) return no('not_found', 'The app was deleted');
  return r.app;
}

interface RpcCtx {
  actor: Actor;
  requestId: string;
  clientIp: string;
}

function originRules(env: Env, environment: 'test' | 'live') {
  if (!env.NETWORK || !env.REFUSED_ORIGINS) return null;
  let refused: unknown;
  try {
    refused = JSON.parse(env.REFUSED_ORIGINS);
  } catch {
    return null;
  }
  return Array.isArray(refused) && refused.every((x) => typeof x === 'string') ? { envName: env.ENV_NAME, network: env.NETWORK, environment, refusedOrigins: refused as string[] } : null;
}

/** Normalised (ASCII form), distinct, byte-sorted (the layouts' order). */
function normalised(list: readonly string[], what: string): string[] {
  const out = new Set<string>();
  for (const o of list) {
    try {
      out.add(normaliseOrigin(o));
    } catch (err) {
      no('origin_refused', `${what}: ${o.slice(0, 200)} is not an origin (${err instanceof Error ? err.message : 'invalid'})`);
    }
  }
  const enc = (s: string) => utf8(s);
  return [...out].sort((a, b) => {
    const x = enc(a);
    const y = enc(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
    return x.length - y.length;
  });
}

async function scopeNow(env: Env, scopeId: string): Promise<ScopeView> {
  let s: ScopeView | null;
  try {
    s = await viewScope(env, scopeId);
  } catch (err) {
    if (err instanceof NearUnavailable) return no('near_unavailable', 'NEAR RPC is unavailable: try again');
    throw err;
  }
  return s ?? no('not_found', `Scope ${scopeId} is not registered on chain`);
}

/** Builds one action (no write). Throws BuildRefusal. */
async function build(env: Env, c: OrgCaller, ctx: RpcCtx, kind: StepUpKind, raw: unknown, now: number): Promise<Built> {
  const parsed = params[kind].safeParse(raw);
  if (!parsed.success) return no('bad_request', `Bad params for ${kind}: ${issuesAsZod3(parsed.error.issues).map((i: z.core.$ZodIssue) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ').slice(0, 300)}`);
  const p = parsed.data as Record<string, unknown>;
  const base = { v: 1 as const, env: env.ENV_NAME, org_id: c.orgId, kind };
  const generic = async (fields: Record<string, unknown>, decoded: Record<string, unknown>): Promise<Built> => {
    const action = { ...base, ...fields };
    return { action, decoded, digest: await stepUpDigest({ sessionHash: c.session.idHash, action }) };
  };
  switch (kind) {
    case 'origin.add': {
      const app = await appOf(env, ctx, c.orgId, p.appId as string);
      const add = normalised(p.add as string[], 'add');
      const remove = normalised(p.remove as string[], 'remove');
      if (add.some((o) => remove.includes(o))) no('bad_request', 'An origin is both added and removed');
      const have = new Set(app.origins.map((o) => o.origin));
      const fresh = add.filter((o) => !have.has(o));
      if (fresh.length === 0) no('bad_request', 'Every origin to add is already active or pending');
      for (const o of remove) if (!have.has(o)) no('bad_request', `${o} is not an origin of this app`);
      const rules = originRules(env, app.environment);
      if (rules) {
        for (const o of fresh) {
          const problem = originProblem(o, rules);
          if (problem) no('origin_refused', `${originDisplay(o).display}: ${problem.message}`);
        }
      }
      if (app.origins.length - remove.length + fresh.length > 20) no('conflict', 'An app has at most 20 active or pending origins');
      const digest = await originChangeDigest({ signer: env.SIGNER_ACCOUNT, appId: app.id, add: fresh, remove, originsVersion: app.originsVersion });
      return {
        action: { ...base, app_id: app.id, add: fresh, remove, origins_version: app.originsVersion },
        decoded: { appId: app.id, appName: app.name, environment: app.environment, add: fresh.map(originDisplay), remove: remove.map(originDisplay), originsVersion: app.originsVersion },
        digest,
      };
    }
    case 'policy.set': {
      const app = await appOf(env, ctx, c.orgId, p.appId as string);
      const v = await validatePolicy(p.policy, app.settings.sessionTtlMs);
      if (!v.ok) return no('policy_invalid', v.problems.join('; ').slice(0, 1000));
      if (app.changes.some((x) => x.kind === 'policy_set' && x.status === 'pending')) no('conflict', 'A policy change is already pending: cancel it first');
      const digest = await settingsChangeDigest({ signer: env.SIGNER_ACCOUNT, appId: app.id, kind: 'policy_set', policyId: v.policyId, settingsVersion: app.settingsVersion });
      const parentOrigin = app.origins.find((o) => o.activeFrom !== null && o.activeFrom <= now)?.display ?? null;
      return {
        action: { ...base, app_id: app.id, policy: v.policy, policy_id: v.policyId, settings_version: app.settingsVersion },
        decoded: { appId: app.id, appName: app.name, policyId: v.policyId, label: v.label, policy: v.policy, parentOrigin, sessionTtlMs: app.settings.sessionTtlMs, settingsVersion: app.settingsVersion },
        digest,
      };
    }
    case 'raw_sign.on': {
      const app = await appOf(env, ctx, c.orgId, p.appId as string);
      if (app.environment === 'test') no('bad_request', 'Test apps never sign raw (D39)');
      if (app.settings.rawSign === 'approval') no('conflict', 'Raw signing is already on');
      if (app.changes.some((x) => x.kind === 'raw_sign_on' && x.status === 'pending')) no('conflict', 'Turning raw signing on is already pending: cancel it first');
      const digest = await settingsChangeDigest({ signer: env.SIGNER_ACCOUNT, appId: app.id, kind: 'raw_sign_on', settingsVersion: app.settingsVersion });
      return { action: { ...base, app_id: app.id, settings_version: app.settingsVersion }, decoded: { appId: app.id, appName: app.name, settingsVersion: app.settingsVersion }, digest };
    }
    case 'app.resume': {
      const app = await appOf(env, ctx, c.orgId, p.appId as string);
      if ((app.suspendedBy & 4) === 0) no('conflict', 'Your organisation hasn’t suspended this app');
      return generic({ app_id: app.id }, { appId: app.id, appName: app.name, otherSuspensions: (app.suspendedBy & 3) !== 0 });
    }
    case 'app.settings': {
      const app = await appOf(env, ctx, c.orgId, p.appId as string);
      const changes: Record<string, unknown> = {};
      for (const k of ['persistence', 'sessionTtlMs', 'idleTtlMs', 'googleWebClientId', 'identityEmail', 'loginMethods'] as const) if (p[k] !== undefined) changes[k] = p[k];
      if (Object.keys(changes).length === 0) no('bad_request', 'Nothing to change');
      if (changes.loginMethods === 'google,email' && !env.ISSUER) no('bad_request', 'Email login isn’t offered in this environment');
      const ttl = (changes.sessionTtlMs as number | undefined) ?? app.settings.sessionTtlMs;
      const idle = (changes.idleTtlMs as number | undefined) ?? app.settings.idleTtlMs;
      if (ttl < SESSION_TTL_MIN_MS || ttl > SESSION_TTL_MAX_MS) no('bad_request', 'The session length must be between 1 h and 23 h 50 min');
      if (idle < IDLE_TTL_MIN_MS || idle > ttl) no('bad_request', 'The idle timeout must be at least 15 min and at most the session length');
      const fields = { app_id: app.id, settings_version: app.settingsVersion, changes };
      return generic(fields, { appId: app.id, appName: app.name, from: app.settings, changes, settingsVersion: app.settingsVersion });
    }
    case 'owner_action':
      return buildOwnerAction(env, c, ctx, p as z.infer<(typeof params)['owner_action']>, now);
    case 'member.invite': {
      const open = await env.CONSOLE_DB.prepare(`SELECT COUNT(*) AS n FROM invites WHERE org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ${lit(now)}`).bind(c.orgId).first<number>('n');
      if ((open ?? 0) >= 10) no('conflict', 'The organisation has 10 open invites: revoke one first');
      return generic({ email: p.email, role: p.role }, { email: p.email, role: p.role, ownerWait: p.role === 'owner' });
    }
    case 'member.role':
    case 'member.remove': {
      const m = await env.CONSOLE_DB.prepare('SELECT u.email FROM members m JOIN console_users u ON u.id = m.user_id WHERE m.org_id = ? AND m.user_id = ?').bind(c.orgId, p.userId).first<{ email: string }>();
      if (!m) return no('not_found', 'Not a member of this organisation');
      return kind === 'member.role' ? generic({ user_id: p.userId, role: p.role }, { userId: p.userId, email: m.email, role: p.role }) : generic({ user_id: p.userId }, { userId: p.userId, email: m.email });
    }
    case 'org.policy': {
      const hd = p.requiredHd as string | null;
      if (hd !== null && hd !== c.session.hd) no('conflict', 'Your own sign-in isn’t from that Google Workspace domain: you would lose access to the organisation');
      return generic({ required_hd: hd }, { requiredHd: hd });
    }
  }
}

/** The pending changes' and owner-action views share scopes.ts; here the owner action itself. */
async function buildOwnerAction(env: Env, c: OrgCaller, ctx: RpcCtx, p: z.infer<(typeof params)['owner_action']>, now: number): Promise<Built> {
  if (!(await scopeOfOrg(env, ctx, c.orgId, p.scopeId))) return no('not_found', 'No such scope in this organisation');
  const scope = await scopeNow(env, p.scopeId);
  if (!oidcOwners(scope).some((o) => o.provider === 'google' && o.sub === c.session.sub)) {
    no('not_owner', 'Your Google account isn’t an on-chain owner of this scope: ask Hana for a staff proposal, or have an on-chain owner add you (SetOwners)');
  }
  const owners: OwnerSet = await orgOwnerSet(env, c.orgId, now);
  const args: Record<string, unknown> = { scope_id: p.scopeId };
  let decoded: Record<string, unknown> = {};
  switch (p.method) {
    case 'propose_change': {
      const ch = p.change ?? no('bad_request', 'propose_change needs a change');
      if (ch.kind === 'AddClient') {
        if (scope.clients.some(([pr, a]) => pr === 'google' && a === ch.aud)) no('conflict', 'That client is already one of the scope’s');
        const nonce = await clientProofNonce({ signer: env.SIGNER_ACCOUNT, scopeId: p.scopeId, actionNonce: scope.action_nonce });
        const proof = await verifyClientProof(ch.clientProof, { provider: 'google', aud: ch.aud, nonce, now });
        if (!proof.ok) {
          if (proof.code === 'jwks_unavailable') no('near_unavailable', 'Google’s signing keys could not be read: try again');
          no('invalid_client_proof', proof.code === 'claim_not_allowed' ? `The proof carries ${proof.claim}: sign in on the helper page with scope=openid only` : `The client proof doesn't check out (${proof.code}); download a fresh helper and sign in again`);
        }
        args.change = { AddClient: { provider: 'google', aud: ch.aud } };
        args.client_proof = ch.clientProof;
      } else if (ch.kind === 'AddEmailClient') {
        const aud = emailClientAudOf(p.scopeId);
        if (!env.ISSUER) no('bad_request', 'Email login isn’t offered in this environment');
        if (scope.clients.some(([pr, a]) => pr === 'email' && a === aud)) no('conflict', 'This scope already has its email client');
        const waiting = scope.pending.find((x) => {
          const add = (x.change as { AddClient?: { provider?: unknown; aud?: unknown } }).AddClient;
          return add?.provider === 'email' && add.aud === aud;
        });
        if (waiting) no('conflict', 'Adding the email client is already pending on chain');
        const answer = await env.ISSUER!.clientProof({ requestId: ctx.requestId, actorId: c.session.userId, orgId: c.orgId, scopeId: p.scopeId, actionNonce: scope.action_nonce });
        if (!answer.ok) {
          if (answer.code === 'email_not_enabled') no('conflict', 'Turn email login on for an app of this scope first');
          if (answer.code === 'rate_limited') no('rate_limited', 'Too many email client proofs today for this scope: try again tomorrow');
          no('near_unavailable', 'Hana’s email issuer could not make the client proof: try again');
        }
        args.change = { AddClient: { provider: 'email', aud } };
        args.client_proof = (answer as { token: string }).token;
      } else if (ch.kind === 'SetAllowShared') {
        if (scope.allow_shared) no('conflict', 'Shared login is already on for this scope');
        args.change = { SetAllowShared: { allow: true } };
        args.client_proof = null;
      } else {
        // SetOwners: the org's usable owners as `Oidc{google, sub}`, plus every `Near` owner the scope has (D353).
        const list = [...scope.owners.filter((o) => 'Near' in o), ...owners.subs.map((sub) => ({ Oidc: { provider: 'google', sub } }))];
        if (list.length === 0) no('conflict', 'The organisation has no owner to set');
        if (list.length > 5) no('conflict', 'A scope has at most 5 owners: remove owners in the organisation first');
        args.change = { SetOwners: { owners: list } };
        args.client_proof = null;
      }
      decoded = { method: p.method, change: decodeChange(args.change, owners) };
      break;
    }
    case 'cancel_change': {
      const id = p.changeId ?? no('bad_request', 'cancel_change needs changeId');
      const pending = scope.pending.find((x) => x.id === id) ?? no('not_found', 'No such pending change');
      args.change_id = id;
      decoded = { method: p.method, changeId: id, change: decodeChange(pending.change, owners), unlockAt: pending.unlock_at_ms };
      break;
    }
    case 'remove_client': {
      const aud = p.aud ?? no('bad_request', 'remove_client needs aud');
      // The scope's email client is removed the same way (spec: "removal immediate through remove_client"; D447).
      const provider = aud === emailClientAudOf(p.scopeId) ? 'email' : 'google';
      if (!scope.clients.some(([pr, a]) => pr === provider && a === aud)) no('not_found', 'That client isn’t one of the scope’s');
      if (scope.clients.length <= 1 && !scope.allow_shared) no('conflict', 'The last client can’t be removed while shared login is off');
      args.provider = provider;
      args.aud = aud;
      decoded = { method: p.method, provider, aud, immediate: true };
      break;
    }
    case 'disable_shared_login': {
      if (!scope.allow_shared) no('conflict', 'Shared login is already off');
      if (scope.clients.length === 0) no('conflict', 'A scope without its own client must keep shared login');
      decoded = { method: p.method, immediate: true };
      break;
    }
  }
  const argsBorsh = ownerActionArgsBorsh(p.method, args);
  const digest = await ownerActionDigest({ signer: env.SIGNER_ACCOUNT, scopeId: p.scopeId, method: p.method, argsBorsh, actionNonce: scope.action_nonce });
  const argsJson = canonicalize(args);
  return {
    action: { v: 1, env: env.ENV_NAME, org_id: c.orgId, kind: 'owner_action', scope_id: p.scopeId, method: p.method, args, action_nonce: scope.action_nonce },
    decoded: { scopeId: p.scopeId, actionNonce: scope.action_nonce, ...decoded },
    digest,
    owner: { scopeId: p.scopeId, actionNonce: scope.action_nonce, argsJson },
  };
}

const writer = (s: Session, info: RequestInfo, now: number): Writer => ({ actor: actorOf(s), requestId: info.requestId, now, ipPrefix: ipPrefix(info.clientIp), country: info.country });

/** `POST /api/orgs/:org/actions {kind, params, returnTo?}` → `{id, kind, decoded, expiresAt, returnTo}`. The caller checked owner and active. */
export async function createAction(request: Request, env: Env, info: RequestInfo, c: OrgCaller): Promise<Response> {
  const body = await readJson(request, MAX_ACTION_BODY);
  if (!body.ok) return errorResponse(body.code);
  const parsed = actionBody.safeParse(body.value);
  if (!parsed.success) return errorResponse('bad_request', 'Expected {kind, params}');
  const { kind } = parsed.data;
  const ret = parsed.data.returnTo === undefined ? undefined : returnInput.safeParse(parsed.data.returnTo);
  if (ret && !ret.success) return errorResponse('bad_request', 'returnTo must be {page, appId?}, a page of the console');
  const now = Date.now();
  const ctx: RpcCtx = { actor: actorOf(c.session), requestId: info.requestId, clientIp: info.clientIp };
  let built: Built;
  let returnTo: string;
  try {
    built = await build(env, c, ctx, kind, parsed.data.params, now);
    returnTo = await returnPath(env, c, ctx, kind, built.decoded, ret?.data);
  } catch (err) {
    if (err instanceof BuildRefusal) {
      log({ event: 'step_up_create', requestId: info.requestId, orgId: c.orgId, method: kind, outcome: 'rejected', code: err.code });
      return errorResponse(err.code, err.message);
    }
    throw err;
  }
  const id = newId('action');
  const expiresAt = now + ACTION_TTL_MS;
  await env.CONSOLE_DB.prepare(
    `INSERT INTO pending_actions (id, user_id, session_hash, org_id, kind, action_json, digest, google_nonce, scope_id, near_action_nonce, near_args, created_at, expires_at, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      c.session.userId,
      c.session.idHash,
      c.orgId,
      kind,
      canonicalize({ action: built.action, decoded: built.decoded, returnTo }),
      built.digest,
      nonceOf(built.digest),
      built.owner?.scopeId ?? null,
      built.owner?.actionNonce ?? null,
      built.owner ? utf8(built.owner.argsJson) : null,
      now,
      expiresAt,
      info.requestId,
    )
    .run();
  log({ event: 'step_up_create', requestId: info.requestId, orgId: c.orgId, method: kind, outcome: 'ok' });
  return json(200, { id, kind, decoded: built.decoded, expiresAt, returnTo });
}

/** The path of an allowlisted page: `/orgs/:org/members`, `/orgs/:org/scopes/:scope` or `/orgs/:org/apps/:app/:page`. */
function pagePath(orgId: string, page: ReturnPage, ids: { appId?: string | undefined; scopeId?: string | undefined }): string | null {
  const org = `/orgs/${orgId}`;
  if (page === 'members') return `${org}/members`;
  if (page === 'scope') return ids.scopeId ? `${org}/scopes/${ids.scopeId}` : null;
  return ids.appId && APP_PAGES.has(page) ? `${org}/apps/${ids.appId}/${page}` : null;
}

const idOf = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * `returnTo` checked against the kind's allowlist; an app page names the action's own app, or (a scope action from the
 * Email login tab) an app of this org on that scope, read from the API. Throws BuildRefusal.
 */
async function returnPath(env: Env, c: OrgCaller, ctx: RpcCtx, kind: StepUpKind, decoded: Record<string, unknown>, r: z.infer<typeof returnInput> | undefined): Promise<string> {
  const pages: readonly ReturnPage[] = RETURN_PAGES[kind];
  const page = (r?.page ?? pages[0]!) as ReturnPage;
  if (!pages.includes(page)) return no('bad_request', `A ${kind} action can't return to ${page}`);
  const own = idOf(decoded.appId);
  let appId = own;
  if (APP_PAGES.has(page)) {
    if (own !== undefined && r?.appId !== undefined && r.appId !== own) no('bad_request', 'returnTo.appId is not the action’s app');
    if (own === undefined) {
      if (r?.appId === undefined) return no('bad_request', 'returnTo needs the app whose page started the action');
      const app = await appOf(env, ctx, c.orgId, r.appId);
      if (app.scopeId !== decoded.scopeId) no('bad_request', 'returnTo.appId is not an app of the action’s scope');
      appId = app.id;
    }
  }
  return pagePath(c.orgId, page, { appId, scopeId: idOf(decoded.scopeId) }) ?? no('bad_request', `A ${kind} action can't return to ${page}`);
}

/** An action stored before `returnTo` was kept: the kind's default page, from its ids. */
function defaultReturn(orgId: string, kind: StepUpKind, decoded: Record<string, unknown>): string {
  return pagePath(orgId, RETURN_PAGES[kind][0] as ReturnPage, { appId: idOf(decoded.appId), scopeId: idOf(decoded.scopeId) }) ?? `/orgs/${orgId}`;
}

const ACTION_ID_RE = /^act_[1-9A-HJ-NP-Za-km-z]{12,17}$/u;

interface ActionRow {
  id: string;
  user_id: string;
  session_hash: Uint8Array | ArrayBuffer;
  org_id: string;
  kind: StepUpKind;
  action_json: string;
  google_nonce: string;
  scope_id: string | null;
  near_action_nonce: number | null;
  near_args: Uint8Array | ArrayBuffer | null;
  used_at: number | null;
  outcome: string | null;
  created_at: number;
  expires_at: number;
}

const sameBytes = (a: Uint8Array | ArrayBuffer, b: Uint8Array): boolean => {
  const x = a instanceof Uint8Array ? a : new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

/**
 * `POST /api/actions/:id/google` → `{startUrl}` (and the auth flow): only for the action's own session, while it is
 * unused and unexpired. The flow's nonce is the action's; its `login_hint` the session's `sub`.
 */
export async function startStepUp(env: Env, info: RequestInfo, s: Session, actionId: string): Promise<Response> {
  if (!ACTION_ID_RE.test(actionId)) return errorResponse('not_found');
  const now = Date.now();
  const row = await env.CONSOLE_DB.prepare('SELECT id, user_id, session_hash, google_nonce, used_at, expires_at FROM pending_actions WHERE id = ?').bind(actionId).first<ActionRow>();
  if (!row || row.user_id !== s.userId || !sameBytes(row.session_hash, s.idHash)) return errorResponse('not_found');
  if (row.used_at !== null || row.expires_at <= now) return errorResponse('step_up_expired', 'This confirmation has expired or was used: start again');
  const enc = b64url;
  const f = randomBytes(32);
  const state = await flowState(f);
  // Never past the action's own expiry.
  const expires = Math.min(now + AUTH_FLOW_TTL_MS, row.expires_at);
  await env.CONSOLE_DB.prepare(
    `INSERT INTO auth_flows (state_hash, start_hash, purpose, pkce_verifier, nonce, scope, pending_action_id, login_hint, created_at, expires_at)
     VALUES (?, ?, 'step_up', ?, ?, 'openid', ?, ?, ?, ?)`,
  )
    .bind(await sha256(state), await sha256(f), enc(randomBytes(32)), row.google_nonce, actionId, s.sub, now, expires)
    .run();
  log({ event: 'step_up_start', requestId: info.requestId, outcome: 'ok' });
  return json(200, { startUrl: `${env.CONSOLE_AUTH_ORIGIN}/start?f=${enc(f)}` });
}

export interface ActionAnswer {
  id: string;
  kind: StepUpKind;
  status: 'pending' | 'ok' | 'failed' | 'expired';
  decoded: Record<string, unknown>;
  expiresAt: number;
  /** Where the page's back link goes (D711): a console path built when the action was created. */
  returnTo: string;
  outcome?: Record<string, unknown>;
}

/** `GET /api/actions/:id`: the action's own user only (any of their sessions: the callback may end in a new one). */
export async function actionStatus(env: Env, s: Session, actionId: string): Promise<Response> {
  if (!ACTION_ID_RE.test(actionId)) return errorResponse('not_found');
  const row = await env.CONSOLE_DB.prepare('SELECT id, user_id, org_id, kind, action_json, used_at, outcome, expires_at FROM pending_actions WHERE id = ?').bind(actionId).first<ActionRow>();
  if (!row || row.user_id !== s.userId) return errorResponse('not_found');
  const stored = JSON.parse(row.action_json) as { decoded: Record<string, unknown>; returnTo?: unknown };
  const outcome = row.outcome ? (JSON.parse(row.outcome) as Record<string, unknown>) : undefined;
  const status: ActionAnswer['status'] = row.used_at === null ? (row.expires_at <= Date.now() ? 'expired' : 'pending') : outcome?.status === 'ok' ? 'ok' : 'failed';
  const returnTo = typeof stored.returnTo === 'string' ? stored.returnTo : defaultReturn(row.org_id, row.kind, stored.decoded);
  const body: ActionAnswer = { id: row.id, kind: row.kind, status, decoded: stored.decoded, expiresAt: row.expires_at, returnTo, ...(outcome ? { outcome } : {}) };
  return json(200, body);
}

// ---- 3. the callback's part ----

interface LiveAction extends ActionRow {
  sub: string;
  email: string;
  hd: string | null;
}

/** An outcome as stored: `{status, code?, message?, …}` (no token, no secret). */
type Outcome = { status: 'ok' | 'failed'; code?: string; message?: string; [k: string]: unknown };

async function finish(env: Env, w: Writer, a: LiveAction, outcome: Outcome, consumeNow: boolean): Promise<void> {
  const db = env.CONSOLE_DB;
  const text = JSON.stringify(outcome).slice(0, 4000);
  if (consumeNow) await db.prepare('UPDATE pending_actions SET used_at = ?, outcome = ? WHERE id = ? AND used_at IS NULL').bind(w.now, text, a.id).run();
  else await db.prepare('UPDATE pending_actions SET outcome = ? WHERE id = ?').bind(text, a.id).run();
  if (outcome.status === 'failed') {
    try {
      await auditInsert(db, entry(w, 'step_up.failed', { orgId: a.org_id, target: a.id, stepUpId: a.id, outcome: 'failed', details: { kind: a.kind, code: String(outcome.code ?? 'internal').slice(0, 64) } })).run();
    } catch (err) {
      log({ event: 'audit_write_failed', requestId: w.requestId, error: err instanceof Error ? err.name : 'unknown' }, 'warn');
    }
  }
}

/** Consumes an API-kind action before it runs (single use whatever follows). False: already used or expired. */
async function consume(env: Env, id: string, now: number): Promise<boolean> {
  const r = await env.CONSOLE_DB.prepare(`UPDATE pending_actions SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ${lit(now)}`).bind(now, id).run();
  return r.meta.changes === 1;
}

/** Whether the user is an owner now of the active org (role read fresh, as on every request). */
async function stillOwner(env: Env, a: LiveAction, now: number): Promise<boolean> {
  const r = await env.CONSOLE_DB.prepare(
    `SELECT ${ownerNow('m', now)} AS is_owner FROM members m JOIN orgs o ON o.id = m.org_id WHERE m.org_id = ? AND m.user_id = ? AND o.status = 'active' AND (o.required_hd IS NULL OR o.required_hd = ?)`,
  )
    .bind(a.org_id, a.user_id, a.hd)
    .first<{ is_owner: number }>();
  return !!r?.is_owner;
}

const auditOutcome = async (env: Env, w: Writer, a: LiveAction, action: Parameters<typeof entry>[1], o: { appId?: string | null; ok: boolean; details: Record<string, string | number | boolean | null>; nearTx?: string | null }) => {
  try {
    await auditInsert(env.CONSOLE_DB, entry(w, action, { orgId: a.org_id, appId: o.appId ?? null, target: o.appId ?? a.org_id, stepUpId: a.id, nearTx: o.nearTx ?? null, outcome: o.ok ? 'ok' : 'failed', details: o.details })).run();
  } catch (err) {
    log({ event: 'audit_write_failed', requestId: w.requestId, error: err instanceof Error ? err.name : 'unknown' }, 'warn');
  }
};

/**
 * The step-up's part of the callback, after the flow and the token checked out (auth-flow.ts): `sub` and nonce
 * verified by the caller for `flowNonce`. Returns where to send the browser (`<console.origin>/actions/:id#`).
 */
export async function runStepUp(env: Env, info: RequestInfo, i: { actionId: string; sub: string; jwt: string }): Promise<string> {
  const db = env.CONSOLE_DB;
  const now = Date.now();
  // The action, its user (not disabled) and whether the session that created it is still live (unrevoked, inside both
  // limits): the cookie isn't sent to the auth origin, so the session is found by the hash the action stored.
  const a = await db
    .prepare(
      `SELECT pa.id, pa.user_id, pa.session_hash, pa.org_id, pa.kind, pa.action_json, pa.google_nonce, pa.scope_id, pa.near_action_nonce, pa.near_args,
              pa.used_at, pa.outcome, pa.created_at, pa.expires_at, u.sub, u.email, s.hd,
              (s.id_hash IS NOT NULL AND s.revoked_at IS NULL AND s.absolute_expires_at > ${lit(now)} AND s.last_seen_at > ${lit(now - SESSION_IDLE_MS)}) AS live
         FROM pending_actions pa JOIN console_users u ON u.id = pa.user_id AND u.disabled_at IS NULL
         LEFT JOIN console_sessions s ON s.id_hash = pa.session_hash AND s.user_id = pa.user_id
        WHERE pa.id = ?`,
    )
    .bind(i.actionId)
    .first<LiveAction & { live: number }>();
  const to = `${env.CONSOLE_ORIGIN}/actions/${i.actionId}#`;
  if (!a) return to;
  const live = a.live === 1;
  const actor: Extract<Actor, { kind: 'member' }> = { kind: 'member', id: a.user_id, sub: a.sub, email: a.email, sessionHash: b64url(a.session_hash instanceof Uint8Array ? a.session_hash : new Uint8Array(a.session_hash)) };
  const w: Writer = { actor, requestId: info.requestId, now, ipPrefix: ipPrefix(info.clientIp), country: info.country };
  const fail = async (code: StepUpCode, message: string) => {
    log({ event: 'step_up_run', requestId: info.requestId, orgId: a.org_id, method: a.kind, outcome: 'rejected', code });
    await finish(env, w, a, { status: 'failed', code, message }, true);
    return to;
  };
  if (a.used_at !== null) return to; // already ran: the page shows its outcome
  if (a.expires_at <= now) return fail('step_up_expired', 'This confirmation expired: start again');
  if (!live) return fail('session_ended', 'The console session that started this ended: sign in and start again');
  if (i.sub !== a.sub) return fail('sub_mismatch', 'You confirmed with another Google account than the one signed in to the console');
  if (!(await stillOwner(env, a, now))) return fail('forbidden', 'You aren’t an owner of an active organisation any more');
  const stored = JSON.parse(a.action_json) as { action: Record<string, unknown>; decoded: Record<string, unknown> };
  const act = stored.action;
  const ctx = { actor, requestId: info.requestId, clientIp: info.clientIp };
  try {
    if (CONSOLE_ONLY.has(a.kind)) return await runConsoleKind(env, w, a, act, to);
    if (!(await consume(env, a.id, now))) return to;
    const outcome = await runApiKind(env, w, a, act, ctx, i.jwt);
    await finish(env, w, a, outcome, false);
    log({ event: 'step_up_run', requestId: info.requestId, orgId: a.org_id, method: a.kind, outcome: outcome.status === 'ok' ? 'ok' : 'rejected', ...(outcome.code ? { code: String(outcome.code) } : {}) });
    return to;
  } catch (err) {
    if (err instanceof RpcRefusal) return fail(err.code, err.message);
    log({ event: 'step_up_run', requestId: info.requestId, orgId: a.org_id, method: a.kind, outcome: 'error', error: err instanceof Error ? err.name : 'unknown' }, 'error');
    await finish(env, w, a, { status: 'failed', code: 'internal', message: 'Something went wrong' }, true);
    return to;
  }
}

/** member.invite, member.role, member.remove, org.policy: consumed, applied and audited in one batch. */
async function runConsoleKind(env: Env, w: Writer, a: LiveAction, act: Record<string, unknown>, to: string): Promise<string> {
  const db = env.CONSOLE_DB;
  const consumeIt = { actionId: a.id };
  let outcome: Outcome = { status: 'ok' };
  let noop = false;
  if (a.kind === 'member.invite') {
    const inv = await issueInvite(db, w, { email: act.email as string, role: act.role as 'owner' | 'viewer', orgId: a.org_id, createdByKind: 'member', stepUpId: a.id, consume: consumeIt, network: env.NETWORK });
    outcome = { status: 'ok', inviteId: inv.id };
  } else if (a.kind === 'member.role' || a.kind === 'member.remove') {
    const r = await setMember(db, w, { orgId: a.org_id, userId: act.user_id as string, role: a.kind === 'member.remove' ? null : (act.role as 'owner' | 'viewer'), stepUpId: a.id, consume: consumeIt });
    noop = r.noop === true;
    outcome = { status: 'ok', ...(r.grantId ? { grantId: r.grantId } : {}), ...(noop ? { noChange: true } : {}) };
  } else {
    const r = await setOrgPolicy(db, w, { orgId: a.org_id, requiredHd: act.required_hd as string | null, sessionHd: a.hd, consume: consumeIt });
    noop = r.noop === true;
    outcome = { status: 'ok', ...(noop ? { noChange: true } : {}) };
  }
  // A change already in force writes nothing; the action is used all the same.
  await finish(env, w, a, outcome, noop);
  log({ event: 'step_up_run', requestId: w.requestId, orgId: a.org_id, method: a.kind, outcome: 'ok' });
  return to;
}

/** The guarded changes, settings, resume and owner actions: through ConsoleRpc with the step-up token. */
async function runApiKind(env: Env, w: Writer, a: LiveAction, act: Record<string, unknown>, ctx: { actor: Actor; requestId: string; clientIp: string }, jwt: string): Promise<Outcome> {
  const orgId = a.org_id;
  const appId = act.app_id as string | undefined;
  const failed = (code: string, error?: string): Outcome => ({ status: 'failed', code, ...(error ? { message: error.slice(0, 500) } : {}) });
  switch (a.kind) {
    case 'origin.add': {
      const r = await env.API.changeOrigins({ ...ctx, orgId, appId: appId!, add: act.add as string[], remove: act.remove as string[], expectedVersion: act.origins_version as number, stepUpJwt: jwt });
      await auditOutcome(env, w, a, 'origin.proposed', { appId, ok: r.ok, details: r.ok ? { version: r.version, added: (act.add as string[]).length, removed: (act.remove as string[]).length } : { code: r.code } });
      return r.ok ? { status: 'ok', version: r.version, changeIds: r.changes.map((x) => x.id).join(',') } : failed(r.code, r.error);
    }
    case 'policy.set':
    case 'raw_sign.on': {
      const kind = a.kind === 'policy.set' ? 'policy_set' : 'raw_sign_on';
      const r = await env.API.proposeChange({ ...ctx, orgId, appId: appId!, kind, ...(kind === 'policy_set' ? { policy: act.policy } : {}), expectedVersion: act.settings_version as number, stepUpJwt: jwt });
      await auditOutcome(env, w, a, a.kind === 'policy.set' ? 'policy.proposed' : 'raw_sign.proposed', {
        appId,
        ok: r.ok,
        details: r.ok ? { version: r.version, changeId: r.change.id, ...(kind === 'policy_set' ? { policyId: act.policy_id as string } : {}) } : { code: r.code },
      });
      return r.ok ? { status: 'ok', version: r.version, changeId: r.change.id } : failed(r.code, r.error);
    }
    case 'app.resume': {
      const r = await env.API.setSuspended({ ...ctx, orgId, appId: appId!, suspended: false });
      await auditOutcome(env, w, a, 'app.resumed', { appId, ok: r.ok, details: r.ok ? { suspendedBy: r.suspendedBy } : { code: r.code } });
      return r.ok ? { status: 'ok', suspendedBy: r.suspendedBy } : failed(r.code, r.error);
    }
    case 'app.settings': {
      const changes = act.changes as Record<string, unknown>;
      const r = await env.API.updateSettings({ ...ctx, orgId, appId: appId!, expectedVersion: act.settings_version as number, ...changes });
      await auditOutcome(env, w, a, 'app.settings_changed', { appId, ok: r.ok, details: r.ok ? { version: r.version, fields: Object.keys(changes).sort().join(',') } : { code: r.code } });
      return r.ok ? { status: 'ok', version: r.version } : failed(r.code, r.error);
    }
    case 'owner_action': {
      // Step 5: re-read the scope; a moved action_nonce fails the action (never a silent rebuild with another action).
      const scopeId = a.scope_id!;
      let scope: ScopeView | null;
      try {
        scope = await viewScope(env, scopeId);
      } catch {
        return failed('near_unavailable', 'NEAR RPC is unavailable: start again');
      }
      if (!scope || scope.action_nonce !== a.near_action_nonce) return failed('nonce_moved', 'The scope changed since this action was built (another owner action ran): build it again');
      const argsText = new TextDecoder().decode(a.near_args instanceof Uint8Array ? a.near_args : new Uint8Array(a.near_args!));
      const args = JSON.parse(argsText) as Record<string, unknown>;
      const body: OwnerActionBody = { method: act.method as OwnerActionBody['method'], args: { ...args, auth: { Oidc: { jwt } } } };
      const r = await env.API.ownerAction({ ...ctx, orgId, body });
      const ok = r.ok && r.status < 400;
      await auditOutcome(env, w, a, 'owner_action.relayed', { ok, nearTx: r.ok ? (r.nearTx ?? null) : null, details: r.ok ? { method: body.method, status: r.status, ...(r.code ? { code: r.code } : {}) } : { method: body.method, code: r.code } });
      if (!r.ok) return failed(r.code, r.error);
      return ok ? { status: 'ok', ...(r.nearTx ? { nearTx: r.nearTx } : {}), relayStatus: r.status } : { ...failed(r.code ?? 'contract_rejected', r.error), relayStatus: r.status, ...(r.nearTx ? { nearTx: r.nearTx } : {}) };
    }
    default:
      return failed('internal');
  }
}

/** For the tests: the hex of an action's stored digest. */
export const digestHex = (d: Uint8Array): string => hex(d);
