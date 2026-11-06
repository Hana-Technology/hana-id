// The staff BFF (docs/batch-c-spec.md "Admin BFF routes"; D278): every route runs after the Access check and the CSRF
// rules (index.ts), with the staff actor, and calls `AdminRpc` (API) or `StaffRpc` (console). Each handler builds its
// RPC input from named fields only (the body can't set the actor, the request id or a field the route doesn't take);
// the RPCs validate every value with console-core's strict schemas, so a malformed one is their `bad_request`. Answers
// are the RPC's fields without `ok`, or `{error: {code, message}}` with the console-core status.
//
// The org methods of AdminRpc take the app's `orgId` (a backstop filter, as for the console), so the app routes carry
// it: in the body of writes, as `?org=` on reads.
//
// C12's reports, statements, rates and exports (report-routes.ts); C14's "Security & monitoring" (the watchdog through
// monitoring.ts, the governance snapshot), the pending-upgrades page and the playbooks (playbooks.ts); C13's retention
// screen (retention-routes.ts); C8b's Users screen (users.ts: `/api/users/search`, `/find`, `/get`, D275); C15's
// Support ID lookup (`POST /api/support/lookup`, support.ts).
import { ACCESS_JWT_HEADER } from '@hana-id/oidc';
import { type AppChange, type AuditRow, DIRECTORY_AUDIT_ACTIONS, type DirectoryAuditRow, type MemberView } from '@hana-id/console-core';
import type { Env } from './env.ts';
import { auditCsv } from './export.ts';
import { errorResponse, json, readJson } from './http.ts';
import { errorName, log } from './log.ts';
import { exportFileRoute, exportRoute, issueRoute, rateOverrideRoute, ratesRoute, reportsRoute, statementRoute, statementsListRoute } from './report-routes.ts';
import { ackRoute, actionsRoute, alertsRoute, monitoringRoute, pendingUpgradesRoute } from './monitoring.ts';
import { getPlaybookRoute, listPlaybooksRoute } from './playbooks.ts';
import { retentionRoute } from './retention-routes.ts';
import { securityView } from './security.ts';
import { statusRoute } from './status.ts';
import { usersFindRoute, usersGetRoute, usersSearchRoute } from './users.ts';
import { supportLookupRoute } from './support.ts';
import { type StaffRequest, staffCtx } from './rpc.ts';

export interface RouteCtx {
  request: Request;
  env: Env;
  staff: StaffRequest;
  url: URL;
  params: Record<string, string>;
  /** The JSON body as an object (`{}` when empty); a non-object body is refused before the handler runs. */
  body: Record<string, unknown>;
}

type Handler = (c: RouteCtx) => Promise<Response>;

interface Route {
  method: 'GET' | 'POST' | 'PUT';
  pattern: string;
  handler: Handler;
}

type RpcAnswer = { ok: true; [k: string]: unknown } | { ok: false; code: string; error?: string };

/** The RPC's answer as HTTP. A call that throws (the other Worker unreachable) is 503 `upstream_unavailable`. */
export async function answer(route: string, staff: StaffRequest, call: () => Promise<RpcAnswer>, shape?: (r: Record<string, unknown>) => unknown): Promise<Response> {
  let a: RpcAnswer;
  try {
    a = await call();
  } catch (err) {
    log({ event: 'bff', route, requestId: staff.requestId, outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'error');
    return errorResponse('upstream_unavailable');
  }
  if (!a.ok) {
    log({ event: 'bff', route, requestId: staff.requestId, outcome: 'rejected', code: a.code });
    return errorResponse(a.code as Parameters<typeof errorResponse>[0], a.error);
  }
  log({ event: 'bff', route, requestId: staff.requestId, outcome: 'ok' });
  const { ok: _ok, ...rest } = a;
  return json(200, shape ? shape(rest) : rest);
}

const pick = (b: Record<string, unknown>, ...keys: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (b[k] !== undefined) out[k] = b[k];
  return out;
};

/** A query parameter as an integer when it is one (else the raw string, which the RPC's schema refuses). */
const intParam = (v: string | null): number | string | undefined => (v === null || v === '' ? undefined : /^\d{1,16}$/u.test(v) ? Number(v) : v);

/** The owners' subs of an org (members in force as owners, not disabled): `createApp` and `assignScopeOrg` need them. */
async function ownerSubs(c: RouteCtx, orgId: unknown): Promise<{ ok: true; subs: string[] } | { ok: false; res: Response }> {
  let r;
  try {
    r = await c.env.CONSOLE.listMembers({ ...staffCtx(c.staff), orgId });
  } catch (err) {
    log({ event: 'bff', route: 'owner_subs', requestId: c.staff.requestId, outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'error');
    return { ok: false, res: errorResponse('upstream_unavailable') };
  }
  if (!r.ok) return { ok: false, res: errorResponse(r.code, r.error) };
  return { ok: true, subs: ownersOf(r.members).map((m) => m.sub!) };
}

export const ownersOf = (members: MemberView[]): MemberView[] => members.filter((m) => m.role === 'owner' && !m.disabled && typeof m.sub === 'string' && m.sub.length > 0);

/** The audit filters from the query string (all optional; the RPC's schema checks each). */
export function auditFilters(url: URL): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  for (const k of ['orgId', 'appId', 'actorKind', 'actorId', 'action']) {
    const v = url.searchParams.get(k);
    if (v) f[k] = v;
  }
  for (const k of ['from', 'to']) {
    const v = intParam(url.searchParams.get(k));
    if (v !== undefined) f[k] = v;
  }
  return f;
}

/**
 * The audit view's third source (D275): the email issuer's staff audit (`DirectoryRpc.auditSince`, newest first): every
 * Users-screen read and the issuer's own staff actions, filterable by staff email (`dirStaff`) and action (`dirAction`).
 * A failure of this source doesn't fail the page: it answers `{error}` in its place; null without an issuer.
 */
async function directoryAudit(c: RouteCtx): Promise<{ rows: DirectoryAuditRow[]; next?: number } | { error: string } | null> {
  if (!c.env.ISSUER) return null;
  const before = intParam(c.url.searchParams.get('dirBefore'));
  const staff = c.url.searchParams.get('dirStaff')?.trim().toLowerCase();
  const action = c.url.searchParams.get('dirAction');
  const limit = 100;
  try {
    const r = await c.env.ISSUER.auditSince({
      requestId: c.staff.requestId,
      accessJwt: c.request.headers.get(ACCESS_JWT_HEADER) ?? '',
      before: typeof before === 'number' ? before : Number.MAX_SAFE_INTEGER,
      limit,
      ...(staff ? { staff } : {}),
      ...(action && (DIRECTORY_AUDIT_ACTIONS as readonly string[]).includes(action) ? { action } : {}),
    });
    if (!r.ok) {
      log({ event: 'bff', route: 'GET /api/audit', requestId: c.staff.requestId, outcome: 'rejected', code: r.code });
      return { error: r.code };
    }
    const last = r.rows[r.rows.length - 1];
    return { rows: r.rows, ...(r.rows.length === limit && last ? { next: last.id } : {}) };
  } catch (err) {
    log({ event: 'bff', route: 'GET /api/audit', requestId: c.staff.requestId, outcome: 'error', code: 'directory_unavailable', error: errorName(err) }, 'error');
    return { error: 'directory_unavailable' };
  }
}

const ROUTES: Route[] = [
  { method: 'GET', pattern: '/api/me', handler: async (c) => json(200, { email: c.staff.actor.email, sub: c.staff.actor.id, env: c.env.ENV_NAME, consoleOrigin: c.env.CONSOLE_ORIGIN, accessExp: c.staff.accessExp, ...renewField(c.env) }) },
  // ---- the System status page (D425): read-only, cached 30 s in the isolate ----
  { method: 'GET', pattern: '/api/status', handler: (c) => statusRoute(c.env, c.staff, c.request) },

  // ---- orgs ----
  {
    method: 'GET',
    pattern: '/api/orgs',
    handler: (c) => answer('GET /api/orgs', c.staff, () => c.env.CONSOLE.listOrgs({ ...staffCtx(c.staff), limit: 100, ...(c.url.searchParams.get('cursor') ? { cursor: c.url.searchParams.get('cursor') } : {}) })),
  },
  {
    method: 'GET',
    pattern: '/api/orgs/:org',
    handler: async (c) => {
      const ctx = staffCtx(c.staff);
      let org, contacts, apps;
      try {
        [org, contacts, apps] = await Promise.all([
          c.env.CONSOLE.getOrg({ ...ctx, orgId: c.params.org }),
          c.env.API.getSecurityContacts({ ...ctx, orgId: c.params.org }),
          c.env.API.listApps({ ...ctx, orgId: c.params.org }),
        ]);
      } catch (err) {
        log({ event: 'bff', route: 'GET /api/orgs/:org', requestId: c.staff.requestId, outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'error');
        return errorResponse('upstream_unavailable');
      }
      if (!org.ok) return errorResponse(org.code, org.error);
      if (!contacts.ok) return errorResponse(contacts.code, contacts.error);
      if (!apps.ok) return errorResponse(apps.code, apps.error);
      // The owner/contact mismatch flag (D285): an owner who isn't a security contact, or no contact at all.
      const owners = ownersOf(org.members).map((m) => m.email.toLowerCase());
      const flags = { noSecurityContacts: contacts.emails.length === 0, ownersNotContacts: owners.filter((e) => !contacts.emails.includes(e)) };
      return json(200, { org: org.org, members: org.members, invites: org.invites, grants: org.grants ?? [], securityContacts: contacts.emails, apps: apps.apps, flags });
    },
  },
  { method: 'POST', pattern: '/api/orgs/:org/freeze', handler: (c) => answer('POST /api/orgs/:org/freeze', c.staff, () => c.env.CONSOLE.freezeOrg({ ...staffCtx(c.staff), orgId: c.params.org, ...pick(c.body, 'frozen') })) },
  { method: 'POST', pattern: '/api/orgs/:org/suspend', handler: (c) => answer('POST /api/orgs/:org/suspend', c.staff, () => c.env.API.suspendOrg({ ...staffCtx(c.staff), orgId: c.params.org, ...pick(c.body, 'suspended') })) },
  {
    method: 'PUT',
    pattern: '/api/orgs/:org/security-contacts',
    handler: (c) => {
      // Lowercased here (the RPC refuses an uppercase address rather than guess).
      const emails = Array.isArray(c.body.emails) ? c.body.emails.map((e) => (typeof e === 'string' ? e.trim().toLowerCase() : e)) : c.body.emails;
      return answer('PUT /api/orgs/:org/security-contacts', c.staff, () => c.env.API.setSecurityContacts({ ...staffCtx(c.staff), orgId: c.params.org, emails }));
    },
  },
  {
    method: 'GET',
    pattern: '/api/orgs/:org/members',
    handler: (c) => answer('GET /api/orgs/:org/members', c.staff, () => c.env.CONSOLE.getOrg({ ...staffCtx(c.staff), orgId: c.params.org }), (r) => ({ members: r.members, invites: r.invites, grants: r.grants ?? [] })),
  },
  { method: 'POST', pattern: '/api/orgs/:org/members/:user', handler: (c) => answer('POST /api/orgs/:org/members/:user', c.staff, () => c.env.CONSOLE.setMember({ ...staffCtx(c.staff), orgId: c.params.org, userId: c.params.user, role: c.body.role === undefined ? undefined : c.body.role })) },
  {
    method: 'GET',
    pattern: '/api/orgs/:org/changes',
    handler: (c) => answer('GET /api/orgs/:org/changes', c.staff, () => c.env.API.listChanges({ ...staffCtx(c.staff), orgId: c.params.org, limit: 100, ...(intParam(c.url.searchParams.get('beforeSeq')) !== undefined ? { beforeSeq: intParam(c.url.searchParams.get('beforeSeq')) } : {}) })),
  },

  // ---- invites, members, owner grants ----
  { method: 'POST', pattern: '/api/invites', handler: (c) => answer('POST /api/invites', c.staff, () => c.env.CONSOLE.issueInvite({ ...staffCtx(c.staff), ...pick(c.body, 'email', 'role', 'orgId', 'newOrgName', 'kind') })) },
  { method: 'POST', pattern: '/api/invites/:id/revoke', handler: (c) => answer('POST /api/invites/:id/revoke', c.staff, () => c.env.CONSOLE.revokeInvite({ ...staffCtx(c.staff), inviteId: c.params.id })) },
  { method: 'POST', pattern: '/api/users/:user/disable', handler: (c) => answer('POST /api/users/:user/disable', c.staff, () => c.env.CONSOLE.disableUser({ ...staffCtx(c.staff), userId: c.params.user, ...pick(c.body, 'disabled') })) },
  { method: 'POST', pattern: '/api/owner-grants/:id/cancel', handler: (c) => answer('POST /api/owner-grants/:id/cancel', c.staff, () => c.env.CONSOLE.cancelOwnerGrant({ ...staffCtx(c.staff), grantId: c.params.id })) },

  // ---- apps and scopes ----
  {
    method: 'POST',
    pattern: '/api/apps',
    handler: async (c) => {
      const subs = await ownerSubs(c, c.body.orgId);
      if (!subs.ok) return subs.res;
      return answer('POST /api/apps', c.staff, () => c.env.API.createApp({ ...staffCtx(c.staff), ...pick(c.body, 'orgId', 'scopeId', 'environment', 'name'), origins: c.body.origins ?? [], orgOwnerSubs: subs.subs }));
    },
  },
  {
    method: 'POST',
    pattern: '/api/scopes/:scope/assign',
    handler: async (c) => {
      const subs = await ownerSubs(c, c.body.orgId);
      if (!subs.ok) return subs.res;
      return answer('POST /api/scopes/:scope/assign', c.staff, () => c.env.API.assignScopeOrg({ ...staffCtx(c.staff), scopeId: c.params.scope, orgId: c.body.orgId, orgOwnerSubs: subs.subs }));
    },
  },
  { method: 'GET', pattern: '/api/apps/:app', handler: (c) => answer('GET /api/apps/:app', c.staff, () => c.env.API.getApp({ ...staffCtx(c.staff), orgId: c.url.searchParams.get('org') ?? undefined, appId: c.params.app })) },
  { method: 'POST', pattern: '/api/apps/:app/suspend', handler: (c) => answer('POST /api/apps/:app/suspend', c.staff, () => c.env.API.setSuspended({ ...staffCtx(c.staff), appId: c.params.app, bit: c.body.bit ?? 1, suspended: true })) },
  { method: 'POST', pattern: '/api/apps/:app/resume', handler: (c) => answer('POST /api/apps/:app/resume', c.staff, () => c.env.API.setSuspended({ ...staffCtx(c.staff), appId: c.params.app, bit: c.body.bit, suspended: false })) },
  { method: 'POST', pattern: '/api/apps/:app/delete', handler: (c) => answer('POST /api/apps/:app/delete', c.staff, () => c.env.API.deleteApp({ ...staffCtx(c.staff), appId: c.params.app })) },
  { method: 'POST', pattern: '/api/apps/:app/origins', handler: (c) => answer('POST /api/apps/:app/origins', c.staff, () => c.env.API.addOrigins({ ...staffCtx(c.staff), appId: c.params.app, ...pick(c.body, 'orgId', 'add', 'expectedVersion') })) },
  { method: 'POST', pattern: '/api/apps/:app/origins/remove', handler: (c) => answer('POST /api/apps/:app/origins/remove', c.staff, () => c.env.API.removeOrigins({ ...staffCtx(c.staff), appId: c.params.app, ...pick(c.body, 'orgId', 'remove', 'expectedVersion') })) },
  { method: 'POST', pattern: '/api/apps/:app/changes', handler: (c) => answer('POST /api/apps/:app/changes', c.staff, () => c.env.API.proposeChange({ ...staffCtx(c.staff), appId: c.params.app, ...pick(c.body, 'orgId', 'kind', 'policy', 'expectedVersion') })) },
  { method: 'POST', pattern: '/api/apps/:app/off', handler: (c) => answer('POST /api/apps/:app/off', c.staff, () => c.env.API.turnOff({ ...staffCtx(c.staff), appId: c.params.app, ...pick(c.body, 'orgId', 'what', 'expectedVersion') })) },
  // The mainnet demo exception to D39 (D428): the API refuses it outside a dev testnet env and for a live app.
  { method: 'POST', pattern: '/api/apps/:app/mainnet-demo', handler: (c) => answer('POST /api/apps/:app/mainnet-demo', c.staff, () => c.env.API.setMainnetDemo({ ...staffCtx(c.staff), appId: c.params.app, ...pick(c.body, 'orgId', 'on', 'expectedVersion') })) },
  { method: 'POST', pattern: '/api/apps/:app/keys/:key/revoke', handler: (c) => answer('POST /api/apps/:app/keys/:key/revoke', c.staff, () => c.env.API.revokeKey({ ...staffCtx(c.staff), appId: c.params.app, keyId: c.params.key, ...pick(c.body, 'orgId') })) },

  // ---- guarded changes ----
  { method: 'POST', pattern: '/api/changes/:id/cancel', handler: (c) => answer('POST /api/changes/:id/cancel', c.staff, () => c.env.API.cancelChange({ ...staffCtx(c.staff), changeId: c.params.id, ...pick(c.body, 'orgId') })) },
  { method: 'POST', pattern: '/api/changes/:id/expedite', handler: (c) => answer('POST /api/changes/:id/expedite', c.staff, () => c.env.API.expediteChange({ ...staffCtx(c.staff), changeId: c.params.id, ...pick(c.body, 'reason') })) },

  // ---- audit ----
  {
    method: 'GET',
    pattern: '/api/audit',
    handler: async (c) => {
      const ctx = staffCtx(c.staff);
      const filters = auditFilters(c.url);
      const cursor = c.url.searchParams.get('cursor');
      const changesBefore = intParam(c.url.searchParams.get('changesBefore'));
      let audit, changes: { ok: true; changes: AppChange[] } | { ok: false; code: string; error?: string } | null = null;
      try {
        [audit, changes] = await Promise.all([
          c.env.CONSOLE.queryAudit({ ...ctx, filters, limit: 100, ...(cursor ? { cursor } : {}) }),
          typeof filters.orgId === 'string' ? c.env.API.listChanges({ ...ctx, orgId: filters.orgId, limit: 100, ...(changesBefore !== undefined ? { beforeSeq: changesBefore } : {}) }) : Promise.resolve(null),
        ]);
      } catch (err) {
        log({ event: 'bff', route: 'GET /api/audit', requestId: c.staff.requestId, outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'error');
        return errorResponse('upstream_unavailable');
      }
      if (!audit.ok) return errorResponse(audit.code, audit.error);
      if (changes && !changes.ok) return errorResponse(changes.code as Parameters<typeof errorResponse>[0], changes.error);
      return json(200, { rows: audit.rows as AuditRow[], ...(audit.next ? { next: audit.next } : {}), changes: changes?.changes ?? null, directory: await directoryAudit(c) });
    },
  },
  { method: 'GET', pattern: '/api/audit.csv', handler: (c) => auditCsv(c.env, c.staff, auditFilters(c.url)) },

  // ---- the feed's and the notices' state ----
  { method: 'GET', pattern: '/api/security', handler: (c) => securityView(c.env, c.staff) },

  // ---- Security & monitoring, pending upgrades, playbooks (C14) ----
  { method: 'GET', pattern: '/api/monitoring', handler: (c) => monitoringRoute(c.env, c.staff) },
  { method: 'GET', pattern: '/api/monitoring/alerts', handler: (c) => alertsRoute(c.env, c.staff, c.url) },
  { method: 'GET', pattern: '/api/monitoring/actions', handler: (c) => actionsRoute(c.env, c.staff, c.url) },
  { method: 'POST', pattern: '/api/monitoring/alerts/:id/ack', handler: (c) => ackRoute(c.env, c.staff, c.params.id!) },
  { method: 'GET', pattern: '/api/governance/pending-upgrades', handler: (c) => pendingUpgradesRoute(c.env, c.staff) },
  { method: 'GET', pattern: '/api/playbooks', handler: async (c) => listPlaybooksRoute(c.url) },
  { method: 'GET', pattern: '/api/playbooks/:id', handler: async (c) => getPlaybookRoute(c.params.id!) },
  // ---- reports, statements, rates, exports (C12) ----
  { method: 'GET', pattern: '/api/reports', handler: reportsRoute },
  { method: 'GET', pattern: '/api/statements', handler: statementsListRoute },
  { method: 'GET', pattern: '/api/statements/:org/:month', handler: statementRoute },
  { method: 'POST', pattern: '/api/statements/:org/:month/issue', handler: issueRoute },
  { method: 'POST', pattern: '/api/exports/:org/:month', handler: exportRoute },
  { method: 'GET', pattern: '/api/exports/:org/:month/:file', handler: exportFileRoute },
  { method: 'GET', pattern: '/api/rates', handler: ratesRoute },
  { method: 'PUT', pattern: '/api/rates/:day', handler: rateOverrideRoute },
  // ---- retention (C13): the monthly job's runs, read only ----
  { method: 'GET', pattern: '/api/retention', handler: retentionRoute },
  // ---- the Users screen (C8b, D275): POST, so no address, sub or code is in a URL ----
  { method: 'POST', pattern: '/api/users/search', handler: usersSearchRoute },
  { method: 'POST', pattern: '/api/users/find', handler: usersFindRoute },
  { method: 'POST', pattern: '/api/users/get', handler: usersGetRoute },
  // ---- C15: the Support ID lookup (support.ts) ----
  { method: 'POST', pattern: '/api/support/lookup', handler: supportLookupRoute },
];

function matchRoute(path: string): { routes: { route: Route; params: Record<string, string> }[] } {
  const parts = path.split('/');
  const out: { route: Route; params: Record<string, string> }[] = [];
  for (const route of ROUTES) {
    const pat = route.pattern.split('/');
    if (pat.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pat.length; i++) {
      const p = pat[i]!;
      if (p.startsWith(':')) {
        let v: string;
        try {
          v = decodeURIComponent(parts[i]!);
        } catch {
          ok = false;
          break;
        }
        if (!v || v.length > 128) {
          ok = false;
          break;
        }
        params[p.slice(1)] = v;
      } else if (p !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push({ route, params });
  }
  return { routes: out };
}

/** The route table's method-and-pattern list (the BFF route snapshot test). */
export const ROUTE_TABLE: readonly string[] = ROUTES.map((r) => `${r.method} ${r.pattern}`);

export async function handleApi(request: Request, env: Env, staff: StaffRequest): Promise<Response> {
  const url = new URL(request.url);
  const { routes } = matchRoute(url.pathname);
  if (routes.length === 0) return errorResponse('not_found');
  const hit = routes.find((r) => r.route.method === request.method || (request.method === 'HEAD' && r.route.method === 'GET'));
  if (!hit) return errorResponse('method_not_allowed', undefined, { allow: [...new Set(routes.map((r) => r.route.method))].join(', ') });
  let body: Record<string, unknown> = {};
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const read = await readJson(request);
    if (!read.ok) return errorResponse(read.code);
    if (!read.value || typeof read.value !== 'object' || Array.isArray(read.value)) return errorResponse('bad_request', 'Expected a JSON object');
    body = read.value as Record<string, unknown>;
  }
  return hit.route.handler({ request, env, staff, url, params: hit.params, body });
}

/**
 * The SPA's Renew link (D424 amended): the Access team's login for this application, which issues a fresh token while
 * the team session lasts and returns to `/signed-in` (a plain visit of the console doesn't: Access keeps an unexpired
 * application token). Public values only (the team domain and the AUD are in every Access JWT). Omitted when either is
 * malformed; the SPA then falls back to `/signed-in`.
 */
export function renewField(env: { ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string; ADMIN_ORIGIN: string }): { renewUrl?: string } {
  const team = env.ACCESS_TEAM_DOMAIN ?? '';
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u.test(team) || !/^[0-9a-f]{64}$/u.test(env.ACCESS_AUD ?? '')) return {};
  let host: string;
  try {
    host = new URL(env.ADMIN_ORIGIN).host;
  } catch {
    return {};
  }
  return { renewUrl: `https://${team}/cdn-cgi/access/login/${host}?kid=${env.ACCESS_AUD}&redirect_url=${encodeURIComponent('/signed-in')}` };
}
