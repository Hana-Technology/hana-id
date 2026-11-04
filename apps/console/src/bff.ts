// The console's signed-in read routes (docs/batch-c-spec.md "Console BFF routes", batch C9): `GET /api/me` and the
// read-only org views. Every request reads its session (sessions.ts: unrevoked, inside 2 h idle and 12 h absolute, the
// user not disabled) and the member's role from `members`, never from a cache, so a removal, a role change or a
// disabled user takes effect on the next request. A membership counts only when the org's `required_hd`, if set, is
// the session's Workspace domain. An org the member can't use answers 404, the same as an org that doesn't exist.
//
// What a partner sees is built through console-core's partner views: no staff Access subject (shown as `hana`), no
// Google `sub`, no IP prefix, no token or hash. Partners never see end-user email addresses (D269): nothing here reads
// the email issuer's directory; the addresses shown are the org's own members and invitees.
import {
  type Actor,
  type AppChange,
  AUDIT_CURSOR_RE,
  AUDIT_PAGE,
  type AuditAnswer,
  type MeAnswer,
  type Membership,
  type MembersAnswer,
  type OrgAnswer,
  type PartnerAuditEntry,
  type PartnerConsoleEvent,
  type Role,
  type RpcFail,
  appIdInput,
  b64url,
  orgIdInput,
} from '@hana-id/console-core';
import type { Env } from './env.ts';
import { errorResponse, json } from './http.ts';
import type { RequestInfo } from './links.ts';
import { log } from './log.ts';
import { type Session, readSession } from './sessions.ts';
import { lit, ownerNow } from './sql.ts';
import { GRANT_COLUMNS, type GrantRow, INVITE_COLUMNS, type InviteRow, membersOf } from './views.ts';

/** The signed-in member of a request, or null (401 `unauthenticated`). */
export const sessionOf = (env: Env, request: Request, now: number): Promise<Session | null> => readSession(env.CONSOLE_DB, request.headers.get('cookie'), now);

/** The member actor ConsoleRpc gets (its `sessionHash` binds C10's step-ups to this session). */
export const memberActor = (s: Session): Actor => ({ kind: 'member', id: s.userId, sub: s.sub, email: s.email, sessionHash: b64url(s.idHash) });

/** Who added or invited someone, as a partner sees it: a member's user id, else `hana` (staff Access subjects stay staff-only). */
export const partnerActorId = (id: string): string => (/^usr_[A-Za-z0-9]{1,64}$/u.test(id) ? id : 'hana');

/** The member's usable memberships: hd-matching orgs, frozen ones included (read-only), with the role in force now. */
async function memberships(env: Env, s: Session, now: number, orgId?: string): Promise<Membership[]> {
  const { results } = await env.CONSOLE_DB.prepare(
    `SELECT o.id, o.name, o.status, ${ownerNow('m', now)} AS is_owner FROM members m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? AND (o.required_hd IS NULL OR o.required_hd = ?)${orgId ? ' AND o.id = ?' : ''} ORDER BY o.name, o.id`,
  )
    .bind(s.userId, s.hd, ...(orgId ? [orgId] : []))
    .all<{ id: string; name: string; status: Membership['status']; is_owner: number }>();
  return results.map((r) => ({ orgId: r.id, orgName: r.name, status: r.status, role: (r.is_owner ? 'owner' : 'viewer') as Role }));
}

/** `GET /api/me` → `{user, memberships}`. */
export async function me(env: Env, s: Session, now: number): Promise<Response> {
  const body: MeAnswer = { user: { id: s.userId, email: s.email }, memberships: await memberships(env, s, now) };
  return json(200, body);
}

/** An RPC refusal as the BFF answers it: the code's status and our own message, never the API's text. */
function rpcError(answer: RpcFail, info: RequestInfo, method: string): Response {
  log({ event: 'console_rpc', method, requestId: info.requestId, outcome: 'rejected', code: answer.code });
  return errorResponse(answer.code);
}

const ORG_ROUTE = /^\/api\/orgs\/([^/]+)(?:\/(apps)(?:\/([^/]+))?|\/(members)|\/(audit))?$/u;

/** Whether `pathname` is one of the read routes below (any other path under `/api/orgs/` is 404, whatever the method). */
export const isOrgReadPath = (pathname: string): boolean => ORG_ROUTE.test(pathname);

/** `GET /api/orgs/:org`, `/apps`, `/apps/:app`, `/members`, `/audit?cursor=`; null when the path isn't one of them. */
export async function orgRoute(url: URL, env: Env, info: RequestInfo, s: Session, now: number): Promise<Response | null> {
  const m = ORG_ROUTE.exec(url.pathname);
  if (!m) return null;
  const [, orgId, apps, appId, members, audit] = m;
  if (!orgIdInput.safeParse(orgId).success || (appId !== undefined && !appIdInput.safeParse(appId).success)) return errorResponse('not_found');
  const [membership] = await memberships(env, s, now, orgId);
  if (!membership) return errorResponse('not_found');
  const ctx = { actor: memberActor(s), requestId: info.requestId, clientIp: info.clientIp };
  if (apps && appId) {
    const r = await env.API.getApp({ ...ctx, orgId: orgId!, appId });
    return r.ok ? json(200, { app: r.app }) : rpcError(r, info, 'getApp');
  }
  if (apps) {
    const r = await env.API.listApps({ ...ctx, orgId: orgId! });
    return r.ok ? json(200, { apps: r.apps }) : rpcError(r, info, 'listApps');
  }
  if (members) return json(200, await orgMembers(env, orgId!, now));
  if (audit) return orgAudit(url, env, info, ctx, orgId!);
  const org = await env.CONSOLE_DB.prepare('SELECT id, name, status, required_hd FROM orgs WHERE id = ?').bind(orgId).first<{ id: string; name: string; status: Membership['status']; required_hd: string | null }>();
  const body: OrgAnswer = { org: { id: org!.id, name: org!.name, status: org!.status, ...(org!.required_hd !== null ? { requiredHd: org!.required_hd } : {}) }, role: membership.role };
  return json(200, body);
}

/** Members (with the role in force now), open invites and live owner grants. */
async function orgMembers(env: Env, orgId: string, now: number): Promise<MembersAnswer> {
  const db = env.CONSOLE_DB;
  const members = (await membersOf(db, orgId, now)).map((m) => ({
    userId: m.userId,
    email: m.email,
    role: m.role,
    roleSince: m.roleSince,
    addedBy: partnerActorId(m.addedBy),
    addedAt: m.addedAt,
    disabled: m.disabled,
    ...(m.pendingOwnerFrom !== undefined ? { pendingOwnerFrom: m.pendingOwnerFrom } : {}),
  }));
  const invites = (
    await db
      .prepare(`SELECT ${INVITE_COLUMNS} FROM invites WHERE org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ${lit(now)} ORDER BY created_at DESC LIMIT 100`)
      .bind(orgId)
      .all<InviteRow>()
  ).results.map((r) => ({
    id: r.id,
    email: r.email_norm,
    role: r.role,
    createdByKind: r.created_by_kind,
    createdBy: partnerActorId(r.created_by),
    notified: r.notified_at !== null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
  const grants = (
    await db.prepare(`SELECT ${GRANT_COLUMNS} FROM owner_grants WHERE org_id = ? AND cancelled_at IS NULL AND applied_at IS NULL ORDER BY created_at DESC LIMIT 100`).bind(orgId).all<GrantRow>()
  ).results.map((r) => ({
    id: r.id,
    ...(r.user_id !== null ? { userId: r.user_id } : {}),
    ...(r.invite_id !== null ? { inviteId: r.invite_id } : {}),
    grantedByKind: r.granted_by_kind,
    createdAt: r.created_at,
    ...(r.notified_at !== null ? { notifiedAt: r.notified_at } : {}),
    ...(r.owner_from !== null ? { ownerFrom: r.owner_from } : {}),
  }));
  return { members, invites, grants };
}

interface AuditDbRow {
  seq: number;
  at: number;
  actor_kind: PartnerConsoleEvent['actorKind'];
  actor_id: string;
  actor_email: string | null;
  app_id: string | null;
  action: string;
  target: string | null;
  details_json: string;
  request_id: string;
  near_tx: string | null;
  country: string | null;
  outcome: PartnerConsoleEvent['outcome'];
}

/** A console audit row as a partner sees it: staff as `hana` with no address, no IP prefix, no `sub`. */
function consoleEvent(r: AuditDbRow): PartnerConsoleEvent {
  const staff = r.actor_kind === 'hana';
  return {
    source: 'console',
    seq: r.seq,
    at: r.at,
    actorKind: r.actor_kind,
    actorId: staff ? 'hana' : r.actor_id,
    ...(!staff && r.actor_kind === 'member' && r.actor_email !== null ? { actorEmail: r.actor_email } : {}),
    ...(r.app_id !== null ? { appId: r.app_id } : {}),
    action: r.action,
    ...(r.target !== null ? { target: r.target } : {}),
    details: JSON.parse(r.details_json) as Record<string, unknown>,
    requestId: r.request_id,
    ...(r.near_tx !== null ? { nearTx: r.near_tx } : {}),
    ...(r.country !== null ? { country: r.country } : {}),
    outcome: r.outcome,
  };
}

/** An app change as a partner sees it: no `actorSub`, staff as `hana`. */
function appChange(c: AppChange): PartnerAuditEntry {
  return {
    source: 'api',
    seq: c.seq,
    at: c.at,
    ...(c.appId !== undefined ? { appId: c.appId } : {}),
    ...(c.scopeId !== undefined ? { scopeId: c.scopeId } : {}),
    kind: c.kind,
    detail: c.detail,
    actorKind: c.actorKind,
    actorId: c.actorKind === 'hana' ? 'hana' : c.actorId,
    requestId: c.requestId,
  };
}

/**
 * `GET /api/orgs/:org/audit?cursor=`: the org's console events (`audit_log`) merged, newest first, with its applied app
 * changes (`ConsoleRpc.listChanges`, the hot DB's `app_changes`: authoritative for apps, and there even when the console
 * died before writing its outcome row). Each page takes up to AUDIT_PAGE rows from both, merged by time while each
 * source keeps its own order; the cursor holds each source's exclusive `seq` bound, so no row is skipped or repeated.
 * Rows of one request (the same `requestId`) sit together.
 */
async function orgAudit(url: URL, env: Env, info: RequestInfo, ctx: { actor: Actor; requestId: string; clientIp: string }, orgId: string): Promise<Response> {
  const cursor = url.searchParams.get('cursor');
  let before: [number, number] | null = null;
  if (cursor !== null) {
    const m = AUDIT_CURSOR_RE.exec(cursor);
    if (!m) return errorResponse('bad_request', 'Bad cursor');
    before = [Number(m[1]), Number(m[2])];
  }
  const fetchN = AUDIT_PAGE + 1;
  const consoleRows = (
    await env.CONSOLE_DB.prepare(
      `SELECT seq, at, actor_kind, actor_id, actor_email, app_id, action, target, details_json, request_id, near_tx, country, outcome FROM audit_log
        WHERE org_id = ?${before ? ` AND seq < ${lit(before[0])}` : ''} ORDER BY seq DESC LIMIT ${lit(fetchN)}`,
    )
      .bind(orgId)
      .all<AuditDbRow>()
  ).results.map(consoleEvent);
  const changes = await env.API.listChanges({ ...ctx, orgId, limit: fetchN, ...(before ? { beforeSeq: before[1] } : {}) });
  if (!changes.ok) return rpcError(changes, info, 'listChanges');
  const apiRows = changes.changes.map(appChange);
  const entries: PartnerAuditEntry[] = [];
  let i = 0;
  let j = 0;
  while (entries.length < AUDIT_PAGE && (i < consoleRows.length || j < apiRows.length)) {
    const a = consoleRows[i];
    const c = apiRows[j];
    if (a && (!c || a.at >= c.at)) entries.push(consoleRows[i++]!);
    else entries.push(apiRows[j++]!);
  }
  const body: AuditAnswer = { entries };
  if (i < consoleRows.length || j < apiRows.length) {
    // Each source's bound: below the last row taken from it, else where it stood (or, unbounded, above its newest row).
    const bound = (rows: PartnerAuditEntry[], taken: number, prev: number | undefined) => (taken > 0 ? rows[taken - 1]!.seq : prev ?? (rows.length ? rows[0]!.seq + 1 : 1));
    body.next = `${bound(consoleRows, i, before?.[0])}.${bound(apiRows, j, before?.[1])}`;
  }
  return json(200, body);
}
