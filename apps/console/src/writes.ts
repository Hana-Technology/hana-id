// The partner console's signed-in org routes beyond C9's reads (docs/batch-c-spec.md "Console BFF routes", "Roles and
// permissions"; batch C10): the step-up creation, the immediate owner writes, the on-chain scope view and helper, the
// logo routes (C11's backend) and the Users screen (D310). Every route reads the session and the member's role from
// CONSOLE_DB on the request (bff.ts), then applies the role matrix:
//
// - `viewer` routes need any usable membership; `owner` routes an owner now (a pending owner is a viewer);
// - a frozen org refuses every write except cancels and the kill switches (origin removal, turning the policy or raw
//   signing off, suspending, revoking a key), which stay open so an owner can always stop something (403 `org_frozen`);
// - an org the member can't use is 404, like one that doesn't exist (D296).
//
// The writes that go to the hot DB are ConsoleRpc calls with the member actor (the API checks them, counts the
// destructive ones in its breaker and writes `app_changes`); the console writes an outcome audit row after each, as for
// the logo (C11). No route here takes a Google token: the guarded changes, settings, resume, member changes and owner
// actions go through `POST …/actions` and a fresh sign-in (actions.ts).
import { type Actor, type RpcFail, changeIdInput, inviteIdInput, keyIdInput, ownerGrantIdInput, scopeIdInput } from '@hana-id/console-core';
import { z } from 'zod';
import { type AuditAction, type Writer, auditInsert, entry } from './audit.ts';
import { type OrgCaller, actorOf, createAction } from './actions.ts';
import type { Env } from './env.ts';
import { RpcRefusal } from './errors.ts';
import { cancelOwnerGrant } from './grants.ts';
import { errorResponse, json, readJson } from './http.ts';
import { revokeInvite } from './invites.ts';
import { ipPrefix } from './ip.ts';
import type { RequestInfo } from './links.ts';
import { log } from './log.ts';
import { logoRemoveRoute, logoUploadRoute } from './logo.ts';
import { policyCheckRoute } from './policy.ts';
import { helperRoute, scopeOfOrg, scopeRoute } from './scopes.ts';
import { usersRoute, usersScreenOn } from './users.ts';

export interface RouteCall {
  request: Request;
  url: URL;
  env: Env;
  info: RequestInfo;
  caller: OrgCaller;
  /** The path's captures after the org: app, key, change, … */
  m: RegExpExecArray;
}

interface OrgRouteDef {
  method: 'GET' | 'POST';
  /** Matches the path after `/api/orgs/:org`. */
  re: RegExp;
  role: 'viewer' | 'owner';
  /** Allowed while the org is frozen: reads, cancels and the kill switches. */
  frozenOk: boolean;
  /** Off routes are 404 (the Users screen behind its flag). */
  enabled?: (env: Env) => boolean;
  run: (c: RouteCall) => Promise<Response>;
}

const APP = 'app_[A-Za-z0-9]{1,64}';
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const ctxOf = (c: RouteCall) => ({ actor: actorOf(c.caller.session) as Actor, requestId: c.info.requestId, clientIp: c.info.clientIp });
const writerOf = (c: RouteCall): Writer => ({ actor: actorOf(c.caller.session), requestId: c.info.requestId, now: Date.now(), ipPrefix: ipPrefix(c.info.clientIp), country: c.info.country });

async function body<S extends z.ZodTypeAny>(c: RouteCall, schema: S, hint: string): Promise<{ ok: true; value: z.infer<S> } | { ok: false; res: Response }> {
  return bodyOf(c, schema, hint);
}

async function bodyOf<T>(c: RouteCall, schema: z.ZodType<T, z.ZodTypeDef, unknown>, hint: string): Promise<{ ok: true; value: T } | { ok: false; res: Response }> {
  const b = await readJson(c.request);
  if (!b.ok) return { ok: false, res: errorResponse(b.code) };
  const p = schema.safeParse(b.value);
  return p.success ? { ok: true, value: p.data } : { ok: false, res: errorResponse('bad_request', hint) };
}

/** An RPC's answer, with its outcome audit row (after the RPC: app_changes is authoritative). */
async function answered<T extends object>(c: RouteCall, method: string, action: AuditAction, appId: string | null, r: ({ ok: true } & T) | RpcFail, details: (r: { ok: true } & T) => Record<string, string | number | boolean | null>, out: (r: { ok: true } & T) => unknown): Promise<Response> {
  log({ event: 'console_rpc', method, requestId: c.info.requestId, orgId: c.caller.orgId, outcome: r.ok ? 'ok' : 'rejected', ...(r.ok ? {} : { code: r.code }) });
  try {
    await auditInsert(c.env.CONSOLE_DB, entry(writerOf(c), action, { orgId: c.caller.orgId, appId, target: appId ?? c.caller.orgId, outcome: r.ok ? 'ok' : 'failed', details: r.ok ? details(r) : { code: r.code } })).run();
  } catch (err) {
    log({ event: 'audit_write_failed', requestId: c.info.requestId, error: err instanceof Error ? err.name : 'unknown' }, 'warn');
  }
  return r.ok ? json(200, out(r)) : errorResponse(r.code, r.error);
}

const appOf = (c: RouteCall): string => c.m[1]!;

const ROUTES: OrgRouteDef[] = [
  // ---- fresh sign-in ----
  { method: 'POST', re: /^\/actions$/u, role: 'owner', frozenOk: false, run: (c) => createAction(c.request, c.env, c.info, c.caller) },

  // ---- immediate owner writes (spec "Roles": no fresh sign-in) ----
  {
    method: 'POST',
    re: new RegExp(`^/apps/(${APP})/origins/remove$`, 'u'),
    role: 'owner',
    frozenOk: true,
    run: async (c) => {
      const b = await body(c, z.object({ remove: z.array(z.string().min(1).max(2048)).min(1).max(20), expectedVersion: version }).strict(), 'Expected {remove, expectedVersion}');
      if (!b.ok) return b.res;
      const r = await c.env.API.removeOrigins({ ...ctxOf(c), orgId: c.caller.orgId, appId: appOf(c), ...b.value });
      return answered(c, 'removeOrigins', 'origins.removed', appOf(c), r, (x) => ({ version: x.version, removed: b.value.remove.length }), (x) => ({ version: x.version }));
    },
  },
  {
    method: 'POST',
    re: new RegExp(`^/apps/(${APP})/off$`, 'u'),
    role: 'owner',
    frozenOk: true,
    run: async (c) => {
      const b = await body(c, z.object({ what: z.enum(['policy', 'raw_sign']), expectedVersion: version }).strict(), 'Expected {what: "policy" | "raw_sign", expectedVersion}');
      if (!b.ok) return b.res;
      const r = await c.env.API.turnOff({ ...ctxOf(c), orgId: c.caller.orgId, appId: appOf(c), ...b.value });
      return answered(c, 'turnOff', 'app.turned_off', appOf(c), r, (x) => ({ version: x.version, what: b.value.what }), (x) => ({ version: x.version }));
    },
  },
  {
    method: 'POST',
    re: /^\/changes\/(gc_[A-Za-z0-9]{1,64})\/cancel$/u,
    role: 'owner',
    frozenOk: true,
    run: async (c) => {
      const b = await body(c, z.object({}).strict(), 'Expected {}');
      if (!b.ok) return b.res;
      const changeId = changeIdInput.parse(c.m[1]);
      const r = await c.env.API.cancelChange({ ...ctxOf(c), orgId: c.caller.orgId, changeId });
      return answered(c, 'cancelChange', 'change.cancelled', r.ok ? r.change.appId : null, r, () => ({}), (x) => x.change);
    },
  },
  {
    method: 'POST',
    re: new RegExp(`^/apps/(${APP})/suspend$`, 'u'),
    role: 'owner',
    frozenOk: true,
    run: async (c) => {
      const b = await body(c, z.object({}).strict(), 'Expected {} (resuming is a fresh sign-in: the app.resume action)');
      if (!b.ok) return b.res;
      const r = await c.env.API.setSuspended({ ...ctxOf(c), orgId: c.caller.orgId, appId: appOf(c), suspended: true });
      return answered(c, 'setSuspended', 'app.suspended', appOf(c), r, (x) => ({ suspendedBy: x.suspendedBy }), (x) => ({ suspendedBy: x.suspendedBy }));
    },
  },
  {
    method: 'POST',
    re: new RegExp(`^/apps/(${APP})/profile$`, 'u'),
    role: 'owner',
    frozenOk: false,
    run: async (c) => {
      const b = await body(c, z.object({ name: z.string().min(1).max(256), expectedVersion: version }).strict(), 'Expected {name, expectedVersion}');
      if (!b.ok) return b.res;
      const r = await c.env.API.updateSettings({ ...ctxOf(c), orgId: c.caller.orgId, appId: appOf(c), name: b.value.name, expectedVersion: b.value.expectedVersion });
      return answered(c, 'updateSettings', 'app.renamed', appOf(c), r, (x) => ({ version: x.version }), (x) => ({ version: x.version }));
    },
  },
  {
    method: 'POST',
    re: new RegExp(`^/apps/(${APP})/logo$`, 'u'),
    role: 'owner',
    frozenOk: false,
    run: (c) => logoUploadRoute(c.request, c.env, c.info, { orgId: c.caller.orgId, appId: appOf(c), actor: actorOf(c.caller.session) }),
  },
  {
    method: 'POST',
    re: new RegExp(`^/apps/(${APP})/logo/remove$`, 'u'),
    role: 'owner',
    frozenOk: false,
    run: async (c) => {
      const b = await body(c, z.object({ expectedVersion: version }).strict(), 'Expected {expectedVersion}');
      if (!b.ok) return b.res;
      return logoRemoveRoute(c.env, c.info, { orgId: c.caller.orgId, appId: appOf(c), actor: actorOf(c.caller.session) }, b.value.expectedVersion);
    },
  },
  {
    method: 'POST',
    re: new RegExp(`^/apps/(${APP})/policy/check$`, 'u'),
    role: 'owner',
    frozenOk: false,
    run: async (c) => {
      const r = await c.env.API.getApp({ ...ctxOf(c), orgId: c.caller.orgId, appId: appOf(c) });
      if (!r.ok) return errorResponse(r.code);
      return policyCheckRoute(c.request, r.app.settings.sessionTtlMs);
    },
  },
  {
    method: 'POST',
    re: new RegExp(`^/apps/(${APP})/keys$`, 'u'),
    role: 'owner',
    frozenOk: false,
    run: async (c) => {
      const b = await body(c, z.object({}).strict(), 'Expected {}');
      if (!b.ok) return b.res;
      const r = await c.env.API.createKey({ ...ctxOf(c), orgId: c.caller.orgId, appId: appOf(c) });
      return answered(c, 'createKey', 'key.created', appOf(c), r, (x) => ({ keyId: x.key.id }), (x) => x.key);
    },
  },
  {
    method: 'POST',
    re: new RegExp(`^/apps/(${APP})/keys/(key_[A-Za-z0-9_]{1,96})/rotate$`, 'u'),
    role: 'owner',
    frozenOk: false,
    run: async (c) => {
      const b = await body(c, z.object({}).strict(), 'Expected {}');
      if (!b.ok) return b.res;
      const keyId = keyIdInput.parse(c.m[2]);
      const r = await c.env.API.rotateKey({ ...ctxOf(c), orgId: c.caller.orgId, appId: appOf(c), keyId });
      return answered(c, 'rotateKey', 'key.rotated', appOf(c), r, (x) => ({ keyId, newKeyId: x.key.id }), (x) => ({ ...x.key, oldKeyRevokedAt: x.oldKeyRevokedAt }));
    },
  },
  {
    method: 'POST',
    re: new RegExp(`^/apps/(${APP})/keys/(key_[A-Za-z0-9_]{1,96})/revoke$`, 'u'),
    role: 'owner',
    frozenOk: true,
    run: async (c) => {
      const b = await body(c, z.object({}).strict(), 'Expected {}');
      if (!b.ok) return b.res;
      const keyId = keyIdInput.parse(c.m[2]);
      const r = await c.env.API.revokeKey({ ...ctxOf(c), orgId: c.caller.orgId, appId: appOf(c), keyId });
      return answered(c, 'revokeKey', 'key.revoked', appOf(c), r, () => ({ keyId }), () => ({}));
    },
  },

  // ---- members: cancels (issuing, role changes and removals are step-ups) ----
  {
    method: 'POST',
    re: /^\/invites\/(inv_[A-Za-z0-9]{1,64})\/revoke$/u,
    role: 'owner',
    frozenOk: true,
    run: async (c) => {
      const b = await body(c, z.object({}).strict(), 'Expected {}');
      if (!b.ok) return b.res;
      await revokeInvite(c.env.CONSOLE_DB, writerOf(c), inviteIdInput.parse(c.m[1]), c.caller.orgId);
      return json(200, {});
    },
  },
  {
    method: 'POST',
    re: /^\/owner-grants\/(og_[A-Za-z0-9]{1,64})\/cancel$/u,
    role: 'owner',
    frozenOk: true,
    run: async (c) => {
      const b = await body(c, z.object({}).strict(), 'Expected {}');
      if (!b.ok) return b.res;
      await cancelOwnerGrant(c.env.CONSOLE_DB, writerOf(c), ownerGrantIdInput.parse(c.m[1]), c.caller.orgId);
      return json(200, {});
    },
  },

  // ---- on chain ----
  { method: 'GET', re: /^\/scopes\/(global|s[0-9a-z]{1,32})$/u, role: 'viewer', frozenOk: true, run: (c) => scopeRoute(c.env, ctxOf(c), c.caller.orgId, c.m[1]!, c.caller.session.sub) },
  { method: 'GET', re: /^\/scopes\/(global|s[0-9a-z]{1,32})\/client-proof-helper$/u, role: 'owner', frozenOk: true, run: (c) => helperRoute(c.env, ctxOf(c), c.caller.orgId, c.m[1]!, c.url) },
  {
    method: 'POST',
    re: /^\/scopes\/(global|s[0-9a-z]{1,32})\/execute$/u,
    role: 'owner',
    frozenOk: false,
    run: async (c) => {
      const b = await body(c, z.object({ changeId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(), 'Expected {changeId}');
      if (!b.ok) return b.res;
      const scopeId = scopeIdInput.parse(c.m[1]);
      if (!(await scopeOfOrg(c.env, ctxOf(c), c.caller.orgId, scopeId))) return errorResponse('not_found');
      // `execute_change` takes no owner token: anyone may call it once the timelock has passed (spec "Roles").
      const r = await c.env.API.ownerAction({ ...ctxOf(c), orgId: c.caller.orgId, body: { method: 'execute_change', args: { scope_id: scopeId, change_id: b.value.changeId } } });
      log({ event: 'console_rpc', method: 'ownerAction', requestId: c.info.requestId, orgId: c.caller.orgId, outcome: r.ok && r.status < 400 ? 'ok' : 'rejected', ...(r.ok ? { status: r.status } : { code: r.code }) });
      const ok = r.ok && r.status < 400;
      try {
        await auditInsert(
          c.env.CONSOLE_DB,
          entry(writerOf(c), 'owner_action.executed', {
            orgId: c.caller.orgId,
            target: scopeId,
            nearTx: r.ok ? (r.nearTx ?? null) : null,
            outcome: ok ? 'ok' : 'failed',
            details: r.ok ? { status: r.status, changeId: b.value.changeId, ...(r.code ? { code: r.code } : {}) } : { code: r.code, changeId: b.value.changeId },
          }),
        ).run();
      } catch (err) {
        log({ event: 'audit_write_failed', requestId: c.info.requestId, error: err instanceof Error ? err.name : 'unknown' }, 'warn');
      }
      if (!r.ok) return errorResponse(r.code, r.error);
      return json(ok ? 200 : 422, { status: r.status, ...(r.nearTx ? { nearTx: r.nearTx } : {}), ...(r.code ? { code: r.code } : {}), ...(r.error ? { error: r.error } : {}) });
    },
  },

  // ---- end users (D310, behind USERS_SCREEN) ----
  { method: 'GET', re: /^\/users$/u, role: 'viewer', frozenOk: true, enabled: usersScreenOn, run: (c) => usersRoute(c.env, c.url, c.info, { ...ctxOf(c), orgId: c.caller.orgId }, undefined) },
  { method: 'GET', re: /^\/users\/([^/]{1,64})$/u, role: 'viewer', frozenOk: true, enabled: usersScreenOn, run: (c) => usersRoute(c.env, c.url, c.info, { ...ctxOf(c), orgId: c.caller.orgId }, c.m[1]) },
];

const ORG_PREFIX = /^\/api\/orgs\/(org_[A-Za-z0-9]{1,64})(\/.*)$/u;

/** The routes a path names (every method), for the 404 / 405 answers; empty when none. */
export function writeRoutesFor(pathname: string, env: Env): { orgId: string; rest: string; defs: OrgRouteDef[] } | null {
  const m = ORG_PREFIX.exec(pathname);
  if (!m) return null;
  const defs = ROUTES.filter((r) => r.re.test(m[2]!) && (r.enabled?.(env) ?? true));
  return defs.length ? { orgId: m[1]!, rest: m[2]!, defs } : null;
}

/** Runs the matched route for a resolved caller, applying the role and frozen rules. */
export async function runOrgRoute(def: OrgRouteDef, rest: string, request: Request, env: Env, info: RequestInfo, caller: OrgCaller): Promise<Response> {
  if (def.role === 'owner' && caller.role !== 'owner') return errorResponse('forbidden', 'Only an owner of the organisation can do this');
  if (!def.frozenOk && caller.orgStatus !== 'active') return errorResponse('org_frozen', 'Hana has frozen this organisation: only cancels and kill switches work until it is unfrozen');
  const m = def.re.exec(rest)!;
  try {
    return await def.run({ request, url: new URL(request.url), env, info, caller, m });
  } catch (err) {
    if (err instanceof RpcRefusal) {
      log({ event: 'console_write', requestId: info.requestId, orgId: caller.orgId, outcome: 'rejected', code: err.code });
      return errorResponse(err.code, err.message);
    }
    throw err;
  }
}

/** For the role-matrix test: every route's method, pattern, role and frozen rule. */
export const ROUTE_TABLE = ROUTES.map((r) => ({ method: r.method, pattern: r.re.source, role: r.role, frozenOk: r.frozenOk }));
/** The app id pattern of the routes (a test checks it accepts exactly what console-core's appIdInput accepts). */
export const APP_PATTERN = APP;
