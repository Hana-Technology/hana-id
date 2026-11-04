// Orgs, members and users as staff manage them (docs/batch-c-spec.md "Roles and permissions", "Invites and owner
// grants", "Sessions"): `StaffRpc.setMember`, `disableUser`, `freezeOrg` and the reads. Roles are read from `members`
// on every request, and removing a member, changing a role, disabling a user or freezing their only org revokes the
// user's sessions at once. The last owner of an org can't be removed or demoted; a pending owner (inside the grant's
// wait) counts as a viewer, and a disabled owner doesn't count (D243).
import { LEGACY_ORG_ID, type OrgView, type Role, newId } from '@hana-id/console-core';
import { type AuditAction, type Writer, auditInsert, entry, replayOf } from './audit.ts';
import { refuse } from './errors.ts';
import { type Frag, applied, frag, gate, gated, lit, orgHasOwner, ownerNow, runBatch } from './sql.ts';
import { ORG_COLUMNS, type OrgRow, orgView } from './views.ts';

/** Revokes every live session of a user (gated on the write's commit row). */
export const revokeSessions = (db: D1Database, userId: string, now: number, g: Frag): D1PreparedStatement =>
  gated(db, 'UPDATE console_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now, userId], g);

/** Cancels every live (unapplied, uncancelled) grant of a member (gated). */
const cancelGrants = (db: D1Database, w: Writer, orgId: string, userId: string, g: Frag): D1PreparedStatement =>
  gated(db, 'UPDATE owner_grants SET cancelled_at = ?, cancelled_by = ? WHERE org_id = ? AND user_id = ? AND cancelled_at IS NULL AND applied_at IS NULL', [w.now, `${w.actor.kind}:${w.actor.id}`, orgId, userId], g);

interface MemberState {
  orgStatus: string | null;
  userExists: boolean;
  disabled: boolean;
  /** The stored role, or null when not a member. */
  role: Role | null;
  /** Owner now (stored, or by a matured grant). */
  isOwner: boolean;
  /** Live grants (unapplied, uncancelled): a pending owner, or a matured grant the cron hasn't recorded. */
  liveGrants: number;
  /** The org has another usable owner. */
  otherOwner: boolean;
}

const stateSql = (now: number) => `SELECT
    (SELECT status FROM orgs WHERE id = ?1) AS org_status,
    (SELECT COUNT(*) FROM console_users WHERE id = ?2) AS user_exists,
    (SELECT disabled_at IS NOT NULL FROM console_users WHERE id = ?2) AS disabled,
    (SELECT role FROM members WHERE org_id = ?1 AND user_id = ?2) AS role,
    (SELECT ${ownerNow('m', now)} FROM members m WHERE m.org_id = ?1 AND m.user_id = ?2) AS is_owner,
    (SELECT COUNT(*) FROM owner_grants WHERE org_id = ?1 AND user_id = ?2 AND cancelled_at IS NULL AND applied_at IS NULL) AS live_grants,
    ${orgHasOwner('?1', now, '?2')} AS other_owner`;

async function memberState(db: D1Database, orgId: string, userId: string, now: number): Promise<MemberState> {
  const r = await db.prepare(stateSql(now)).bind(orgId, userId).first<{ org_status: string | null; user_exists: number; disabled: number | null; role: Role | null; is_owner: number | null; live_grants: number; other_owner: number }>();
  return { orgStatus: r!.org_status, userExists: r!.user_exists > 0, disabled: !!r!.disabled, role: r!.role, isOwner: !!r!.is_owner, liveGrants: r!.live_grants, otherOwner: !!r!.other_owner };
}

/** The state the write was planned on, re-asserted inside its batch (a concurrent change makes it `conflict`). */
function stateGuard(orgId: string, userId: string, s: MemberState, now: number, extra?: string): Frag {
  return frag(
    `(SELECT role FROM members WHERE org_id = ? AND user_id = ?) IS ?
     AND COALESCE((SELECT ${ownerNow('m', now)} FROM members m WHERE m.org_id = ? AND m.user_id = ?), 0) = ?
     AND (SELECT COUNT(*) FROM owner_grants WHERE org_id = ? AND user_id = ? AND cancelled_at IS NULL AND applied_at IS NULL) = ?
     AND (SELECT disabled_at IS NULL FROM console_users WHERE id = ?) = ?${extra ? ` AND ${extra}` : ''}`,
    orgId, userId, s.role, orgId, userId, s.isOwner ? 1 : 0, orgId, userId, s.liveGrants, userId, s.disabled ? 0 : 1,
  );
}

/**
 * Staff membership changes (`StaffRpc.setMember`; an owner's `member.role`/`member.remove` step-ups reuse it in C10):
 * - `null` removes the member at once (with their live grants and sessions);
 * - `viewer` adds a viewer, demotes an owner (sessions revoked) or cancels a pending grant;
 * - `owner` adds or promotes: through a grant (a viewer until its notice is acked and `ownerGrantDelayMs` passes)
 *   when the org has another owner, at once when it has none (the first-owner exception).
 * Refusals: `forbidden` (`org_legacy`), `not_found` (org, user, or removing a non-member), `conflict` (the last
 * owner, a pending grant, a disabled user added or promoted, or the membership changed meanwhile). A change to the role
 * already in force writes nothing.
 */
export interface SetMemberInput {
  orgId: string;
  userId: string;
  role: Role | null;
  stepUpId?: string | null;
  /**
   * An owner's step-up (C10, `member.role` / `member.remove`): the pending action is consumed in the same batch as the
   * change and its audit row, only while unused and unexpired (spec "Fresh sign-in": console-only kinds consume, change
   * and audit atomically), and only an existing member of an active org is changed (an owner adds people by invite).
   */
  consume?: { actionId: string };
}

/** The guard of a step-up's consumption, and its gated statement (sql.ts). */
export const consumeGuard = (actionId: string, now: number): Frag => frag(`EXISTS (SELECT 1 FROM pending_actions pa WHERE pa.id = ? AND pa.used_at IS NULL AND pa.expires_at > ${lit(now)})`, actionId);
export const consumeStmt = (db: D1Database, actionId: string, now: number, g: Frag): D1PreparedStatement =>
  gated(db, `UPDATE pending_actions SET used_at = ?, outcome = '{"status":"ok"}' WHERE id = ? AND used_at IS NULL`, [now, actionId], g);

export async function setMember(db: D1Database, w: Writer, i: SetMemberInput): Promise<{ grantId?: string; noop?: true }> {
  if (i.orgId === LEGACY_ORG_ID) return refuse('forbidden', `${LEGACY_ORG_ID} has no members`);
  const now = w.now;
  const s = await memberState(db, i.orgId, i.userId, now);
  if (s.orgStatus === null) return refuse('not_found', 'No such org');
  if (!s.userExists) return refuse('not_found', 'No such user');
  if (i.consume) {
    if (s.role === null) return refuse('not_found', 'Not a member of this org');
    if (s.orgStatus !== 'active') return refuse('forbidden', 'The org is frozen');
  }
  const lastOwner = s.isOwner && !s.otherOwner;
  const keepsOwner = orgHasOwner('?', now, '?');
  const base = { orgId: i.orgId, target: i.userId, stepUpId: i.stepUpId ?? null };
  const plan = (action: AuditAction, details: Record<string, string | number | boolean>, extra?: { sql: string; binds: unknown[] }) => {
    const parts = [extra, i.consume ? consumeGuard(i.consume.actionId, now) : undefined, i.consume ? frag("EXISTS (SELECT 1 FROM orgs WHERE id = ? AND status = 'active')", i.orgId) : undefined].filter(
      (x): x is Frag => x !== undefined,
    );
    const guard = stateGuard(i.orgId, i.userId, s, now, parts.length ? parts.map((x) => x.sql).join(' AND ') : undefined);
    for (const x of parts) guard.binds.push(...x.binds);
    const g = gate(w.requestId, action);
    return { action, first: auditInsert(db, entry(w, action, { ...base, details }), guard), g, consume: i.consume ? [consumeStmt(db, i.consume.actionId, now, g)] : [] };
  };
  const insertMember = (role: Role, g: Frag) =>
    gated(db, 'INSERT INTO members (org_id, user_id, role, role_since, added_by, added_at) SELECT ?, ?, ?, ?, ?, ? WHERE 1', [i.orgId, i.userId, role, now, w.actor.id, now], g);
  const setRole = (role: Role, g: Frag) => gated(db, 'UPDATE members SET role = ?, role_since = ? WHERE org_id = ? AND user_id = ?', [role, now, i.orgId, i.userId], g);
  const grantedByKind = w.actor.kind === 'member' ? 'member' : 'hana';
  const insertGrant = (grantId: string, g: Frag) =>
    gated(db, 'INSERT INTO owner_grants (id, org_id, user_id, granted_by_kind, granted_by, step_up_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE 1', [grantId, i.orgId, i.userId, grantedByKind, w.actor.id, i.stepUpId ?? null, now], g);

  let p: ReturnType<typeof plan>;
  const stmts: D1PreparedStatement[] = [];
  let grantId: string | undefined;
  if (i.role === null) {
    if (s.role === null) return refuse('not_found', 'Not a member of this org');
    if (lastOwner) return refuse('conflict', "The org's last owner can't be removed");
    p = plan('member.removed', { role: s.isOwner ? 'owner' : 'viewer', ...(s.liveGrants ? { grantCancelled: s.liveGrants } : {}) }, s.isOwner ? frag(keepsOwner, i.orgId, i.userId) : undefined);
    stmts.push(p.first, gated(db, 'DELETE FROM members WHERE org_id = ? AND user_id = ?', [i.orgId, i.userId], p.g), cancelGrants(db, w, i.orgId, i.userId, p.g), revokeSessions(db, i.userId, now, p.g));
  } else if (i.role === 'viewer') {
    if (s.role === null) {
      if (s.disabled) return refuse('conflict', 'The user is disabled');
      p = plan('member.added', { role: 'viewer' });
      stmts.push(p.first, insertMember('viewer', p.g));
    } else if (s.isOwner) {
      if (lastOwner) return refuse('conflict', "The org's last owner can't be demoted");
      p = plan('member.role', { from: 'owner', to: 'viewer', ...(s.liveGrants ? { grantCancelled: s.liveGrants } : {}) }, frag(keepsOwner, i.orgId, i.userId));
      stmts.push(p.first, setRole('viewer', p.g), cancelGrants(db, w, i.orgId, i.userId, p.g), revokeSessions(db, i.userId, now, p.g));
    } else if (s.liveGrants > 0) {
      p = plan('owner_grant.cancelled', { via: w.actor.kind });
      stmts.push(p.first, cancelGrants(db, w, i.orgId, i.userId, p.g));
    } else {
      return { noop: true };
    }
  } else {
    if (s.isOwner) return { noop: true };
    if (s.role !== null && s.liveGrants > 0) return refuse('conflict', 'An owner grant for this member is already pending');
    // Adding or promoting: a disabled user can't sign in and doesn't count as an owner, so making one an owner would
    // leave an ownerless org looking owned (and give the first-owner exception to the next invite).
    if (s.disabled) return refuse('conflict', 'The user is disabled');
    if (s.otherOwner) {
      grantId = newId('ownerGrant');
      if (s.role === null) {
        p = plan('member.added', { role: 'viewer', grantId }, frag(keepsOwner, i.orgId, i.userId));
        stmts.push(p.first, insertMember('viewer', p.g), insertGrant(grantId, p.g));
      } else {
        p = plan('owner_grant.created', { userId: i.userId }, frag(keepsOwner, i.orgId, i.userId));
        stmts.push(p.first, insertGrant(grantId, p.g));
      }
    } else if (s.role === null) {
      p = plan('member.added', { role: 'owner' }, frag(`NOT ${keepsOwner}`, i.orgId, i.userId));
      stmts.push(p.first, insertMember('owner', p.g));
    } else {
      p = plan('member.role', { from: 'viewer', to: 'owner' }, frag(`NOT ${keepsOwner}`, i.orgId, i.userId));
      stmts.push(p.first, setRole('owner', p.g), revokeSessions(db, i.userId, now, p.g));
    }
  }
  stmts.push(...p.consume);
  const results = await runBatch(db, stmts, replayOf(w, p.action, i.userId));
  if (!applied(results)) refuse('conflict', 'The membership changed meanwhile, or this confirmation was already used; read it again and retry');
  return grantId ? { grantId } : {};
}

/** `StaffRpc.disableUser`: a disabled user can't sign in or accept an invite, and their sessions end at once. */
export async function disableUser(db: D1Database, w: Writer, userId: string, disabled: boolean): Promise<void> {
  const row = await db.prepare('SELECT disabled_at FROM console_users WHERE id = ?').bind(userId).first<{ disabled_at: number | null }>();
  if (!row) return refuse('not_found', 'No such user');
  if ((row.disabled_at !== null) === disabled) return;
  const action = disabled ? 'user.disabled' : 'user.enabled';
  const g = gate(w.requestId, action);
  const stmts = [
    auditInsert(db, entry(w, action, { target: userId }), frag(`EXISTS (SELECT 1 FROM console_users WHERE id = ? AND disabled_at IS ${disabled ? '' : 'NOT '}NULL)`, userId)),
    gated(db, 'UPDATE console_users SET disabled_at = ? WHERE id = ?', [disabled ? w.now : null, userId], g),
  ];
  if (disabled) stmts.push(revokeSessions(db, userId, w.now, g));
  const results = await runBatch(db, stmts, replayOf(w, action, userId));
  if (!applied(results)) refuse('conflict', 'The user changed meanwhile; retry');
}

/**
 * `StaffRpc.freezeOrg`: a frozen org refuses every console write except cancels and the kill switches (enforced by the
 * BFF from C9), and can't accept invites. Freezing ends the sessions of members with no other active org.
 *
 * Freezing also pauses the org's pending memberships (D343), in the same batch:
 * - every open invite's notice is undone (`token_hash`, `notified_at` cleared): its link stops working, the notice
 *   isn't sent again while the org is frozen (invites.ts pendingMemberNotices), and after an unfreeze it must be
 *   announced again (the invitee, every owner, the contacts and the alias) before it works. Its 7 days keep running;
 * - every live owner grant still inside its wait (or not announced yet) loses its notice and its clock
 *   (`notified_at`, `cancel_token_hash`, `owner_from` cleared): it can't mature while frozen, and after an unfreeze it
 *   is announced again and waits the full `ownerGrantDelayMs` from that new notice (re-confirmed, not resumed). A grant
 *   whose `owner_from` had already passed before the freeze has matured: its member is an owner by predicate, and the
 *   hourly cron records it once the org is active again.
 */
export async function freezeOrg(db: D1Database, w: Writer, orgId: string, frozen: boolean): Promise<void> {
  if (orgId === LEGACY_ORG_ID) return refuse('forbidden', `${LEGACY_ORG_ID} can't be frozen`);
  const row = await db.prepare('SELECT status FROM orgs WHERE id = ?').bind(orgId).first<{ status: string }>();
  if (!row) return refuse('not_found', 'No such org');
  if ((row.status === 'frozen') === frozen) return;
  const action = frozen ? 'org.frozen' : 'org.unfrozen';
  const g = gate(w.requestId, action);
  const stmts = [
    auditInsert(db, entry(w, action, { orgId, target: orgId }), frag('EXISTS (SELECT 1 FROM orgs WHERE id = ? AND status = ?)', orgId, frozen ? 'active' : 'frozen')),
    gated(db, 'UPDATE orgs SET status = ? WHERE id = ?', [frozen ? 'frozen' : 'active', orgId], g),
  ];
  if (frozen) {
    stmts.push(
      gated(
        db,
        `UPDATE invites SET token_hash = NULL, notified_at = NULL WHERE org_id = ? AND notified_at IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ${lit(w.now)}`,
        [orgId],
        g,
      ),
      gated(
        db,
        `UPDATE owner_grants SET notified_at = NULL, cancel_token_hash = NULL, owner_from = NULL
          WHERE org_id = ? AND cancelled_at IS NULL AND applied_at IS NULL AND (owner_from IS NULL OR owner_from > ${lit(w.now)})`,
        [orgId],
        g,
      ),
      gated(
        db,
        `UPDATE console_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND user_id IN (
           SELECT m.user_id FROM members m WHERE m.org_id = ? AND NOT EXISTS (
             SELECT 1 FROM members m2 JOIN orgs o ON o.id = m2.org_id WHERE m2.user_id = m.user_id AND m2.org_id <> ? AND o.status = 'active'))`,
        [w.now, orgId, orgId],
        g,
      ),
    );
  }
  const results = await runBatch(db, stmts, replayOf(w, action, orgId));
  if (!applied(results)) refuse('conflict', 'The org changed meanwhile; retry');
}

/**
 * An owner's `org.policy` step-up (C10): the org's `required_hd` (a Google Workspace domain every member's sign-in
 * must carry, or null for none), consumed, changed and audited in one batch. A domain other than the acting session's
 * own is refused (`conflict`): the owner would lock themself out with their next request (D355). Members whose session
 * domain doesn't match lose the org at their next request (memberships are read per request), and their sessions are
 * revoked when it was their only active org.
 */
export async function setOrgPolicy(db: D1Database, w: Writer, i: { orgId: string; requiredHd: string | null; sessionHd: string | null; consume: { actionId: string } }): Promise<{ noop?: true }> {
  if (i.orgId === LEGACY_ORG_ID) return refuse('forbidden', `${LEGACY_ORG_ID} has no members`);
  if (i.requiredHd !== null && i.requiredHd !== i.sessionHd) return refuse('conflict', 'Your own sign-in isn’t from that Google Workspace domain: you would lose access to the organisation');
  const row = await db.prepare('SELECT status, required_hd FROM orgs WHERE id = ?').bind(i.orgId).first<{ status: string; required_hd: string | null }>();
  if (!row) return refuse('not_found', 'No such org');
  if (row.status !== 'active') return refuse('forbidden', 'The org is frozen');
  if (row.required_hd === i.requiredHd) return { noop: true };
  const action = 'org.policy';
  const g = gate(w.requestId, action);
  const guard = frag(`EXISTS (SELECT 1 FROM orgs WHERE id = ? AND status = 'active' AND required_hd IS ?) AND ${consumeGuard(i.consume.actionId, w.now).sql}`, i.orgId, row.required_hd, i.consume.actionId);
  const stmts = [
    auditInsert(db, entry(w, action, { orgId: i.orgId, target: i.orgId, stepUpId: i.consume.actionId, details: { requiredHd: i.requiredHd } }), guard),
    gated(db, 'UPDATE orgs SET required_hd = ? WHERE id = ?', [i.requiredHd, i.orgId], g),
    consumeStmt(db, i.consume.actionId, w.now, g),
  ];
  if (i.requiredHd !== null) {
    stmts.push(
      gated(
        db,
        `UPDATE console_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND hd IS NOT ? AND user_id IN (
           SELECT m.user_id FROM members m WHERE m.org_id = ? AND NOT EXISTS (
             SELECT 1 FROM members m2 JOIN orgs o ON o.id = m2.org_id WHERE m2.user_id = m.user_id AND m2.org_id <> ? AND o.status = 'active'
               AND (o.required_hd IS NULL OR o.required_hd = console_sessions.hd)))`,
        [w.now, i.requiredHd, i.orgId, i.orgId],
        g,
      ),
    );
  }
  const results = await runBatch(db, stmts, replayOf(w, action, i.orgId));
  if (!applied(results)) refuse('conflict', 'The org changed meanwhile, or this confirmation was already used; retry');
  return {};
}

export async function listOrgs(db: D1Database, cursor: string | undefined, limit: number): Promise<{ orgs: OrgView[]; next?: string }> {
  const { results } = await db.prepare(`SELECT ${ORG_COLUMNS} FROM orgs WHERE id > ? ORDER BY id LIMIT ?`).bind(cursor ?? '', limit + 1).all<OrgRow>();
  const orgs = results.slice(0, limit).map(orgView);
  return results.length > limit ? { orgs, next: orgs[orgs.length - 1]!.id } : { orgs };
}

export async function getOrgRow(db: D1Database, orgId: string): Promise<OrgView> {
  const row = await db.prepare(`SELECT ${ORG_COLUMNS} FROM orgs WHERE id = ?`).bind(orgId).first<OrgRow>();
  return row ? orgView(row) : refuse('not_found', 'No such org');
}

