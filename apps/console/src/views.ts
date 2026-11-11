// CONSOLE_DB rows and the views StaffRpc returns (docs/batch-c-spec.md "Types": allowlisted columns only, never
// `token_hash`, `cancel_token_hash` or a cookie). The SELECT column lists below are the only way rows are read for a
// view, so a hash column can't leak through a `SELECT *`.
import type { InviteView, MemberView, OrgView, OwnerGrantView, Role } from '@hana-id/console-core';
import { lit, ownerNow } from './sql.ts';

export interface OrgRow {
  id: string;
  name: string;
  kind: OrgView['kind'];
  status: OrgView['status'];
  required_hd: string | null;
  created_at: number;
  contract_ref: string | null;
  billing_email: string | null;
}
export const ORG_COLUMNS = 'id, name, kind, status, required_hd, created_at, contract_ref, billing_email';

export const orgView = (r: OrgRow): OrgView => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  status: r.status,
  ...(r.required_hd !== null ? { requiredHd: r.required_hd } : {}),
  createdAt: r.created_at,
  ...(r.contract_ref !== null ? { contractRef: r.contract_ref } : {}),
  ...(r.billing_email !== null ? { billingEmail: r.billing_email } : {}),
});

export interface InviteRow {
  id: string;
  email_norm: string;
  org_id: string | null;
  new_org_name: string | null;
  new_org_kind: 'partner' | 'internal' | null;
  role: Role;
  created_by_kind: InviteView['createdByKind'];
  created_by: string;
  notified_at: number | null;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  accepted_user_id: string | null;
  revoked_at: number | null;
}
/** Every invite column a view needs; never `token_hash`. */
export const INVITE_COLUMNS = 'id, email_norm, org_id, new_org_name, new_org_kind, role, created_by_kind, created_by, notified_at, created_at, expires_at, accepted_at, accepted_user_id, revoked_at';

export const inviteView = (r: InviteRow): InviteView => ({
  id: r.id,
  email: r.email_norm,
  ...(r.org_id !== null ? { orgId: r.org_id } : {}),
  ...(r.new_org_name !== null ? { newOrgName: r.new_org_name } : {}),
  ...(r.new_org_kind !== null ? { newOrgKind: r.new_org_kind } : {}),
  role: r.role,
  createdByKind: r.created_by_kind,
  createdBy: r.created_by,
  ...(r.notified_at !== null ? { notifiedAt: r.notified_at } : {}),
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  ...(r.accepted_at !== null ? { acceptedAt: r.accepted_at } : {}),
  ...(r.accepted_user_id !== null ? { acceptedUserId: r.accepted_user_id } : {}),
  ...(r.revoked_at !== null ? { revokedAt: r.revoked_at } : {}),
});

export interface GrantRow {
  id: string;
  org_id: string;
  user_id: string | null;
  invite_id: string | null;
  granted_by_kind: OwnerGrantView['grantedByKind'];
  granted_by: string;
  created_at: number;
  notified_at: number | null;
  owner_from: number | null;
  cancelled_at: number | null;
  applied_at: number | null;
}
/** Every grant column a view needs; never `cancel_token_hash`. */
export const GRANT_COLUMNS = 'id, org_id, user_id, invite_id, granted_by_kind, granted_by, created_at, notified_at, owner_from, cancelled_at, applied_at';

export const grantView = (r: GrantRow): OwnerGrantView => ({
  id: r.id,
  orgId: r.org_id,
  ...(r.user_id !== null ? { userId: r.user_id } : {}),
  ...(r.invite_id !== null ? { inviteId: r.invite_id } : {}),
  grantedByKind: r.granted_by_kind,
  grantedBy: r.granted_by,
  createdAt: r.created_at,
  ...(r.notified_at !== null ? { notifiedAt: r.notified_at } : {}),
  ...(r.owner_from !== null ? { ownerFrom: r.owner_from } : {}),
  ...(r.cancelled_at !== null ? { cancelledAt: r.cancelled_at } : {}),
  ...(r.applied_at !== null ? { appliedAt: r.applied_at } : {}),
});

interface MemberDbRow {
  org_id: string;
  user_id: string;
  email: string;
  sub: string;
  role: Role;
  role_since: number;
  added_by: string;
  added_at: number;
  disabled_at: number | null;
  is_owner: number;
  pending_owner_from: number | null;
}

/**
 * An org's members as staff see them, with the role in force now (a matured grant the cron hasn't recorded yet is
 * already `owner`) and, for a pending owner, when the grant matures (`pendingOwnerFrom`; unset while its notice is
 * still unsent). `sub` is included: the admin Worker passes owners' subs to `createApp`/`assignScopeOrg`.
 */
export async function membersOf(db: D1Database, orgId: string, now: number): Promise<MemberView[]> {
  const { results } = await db
    .prepare(
      `SELECT m.org_id, m.user_id, u.email, u.sub, m.role, m.role_since, m.added_by, m.added_at, u.disabled_at,
              ${ownerNow('m', now)} AS is_owner,
              (SELECT g.owner_from FROM owner_grants g WHERE g.org_id = m.org_id AND g.user_id = m.user_id AND g.cancelled_at IS NULL
                 AND g.applied_at IS NULL AND (g.owner_from IS NULL OR g.owner_from > ${lit(now)}) ORDER BY g.created_at DESC LIMIT 1) AS pending_owner_from
         FROM members m JOIN console_users u ON u.id = m.user_id
        WHERE m.org_id = ? ORDER BY m.added_at, m.user_id`,
    )
    .bind(orgId)
    .all<MemberDbRow>();
  return results.map((r) => ({
    orgId: r.org_id,
    userId: r.user_id,
    email: r.email,
    sub: r.sub,
    role: r.is_owner ? 'owner' : 'viewer',
    roleSince: r.role_since,
    addedBy: r.added_by,
    addedAt: r.added_at,
    disabled: r.disabled_at !== null,
    ...(r.pending_owner_from !== null && !r.is_owner ? { pendingOwnerFrom: r.pending_owner_from } : {}),
  }));
}

/**
 * An org's live owner grants (not cancelled, not yet recorded as applied), newest first, for the admin console's
 * members screen: staff cancel a pending grant by its id (D283, an additive field of `StaffRpc.getOrg`). Allowlisted
 * columns only: never `cancel_token_hash`.
 */
export async function grantsOf(db: D1Database, orgId: string): Promise<OwnerGrantView[]> {
  const { results } = await db
    .prepare(`SELECT ${GRANT_COLUMNS} FROM owner_grants WHERE org_id = ? AND cancelled_at IS NULL AND applied_at IS NULL ORDER BY created_at DESC, id LIMIT 100`)
    .bind(orgId)
    .all<GrantRow>();
  return results.map(grantView);
}
