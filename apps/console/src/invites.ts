// Invites (docs/batch-c-spec.md "Invites and owner grants", D89): issue, revoke, the blocking notice's list and ack,
// and acceptance (the data path batch C9's sign-in calls). Invite-only: an invite is email-bound, single use, 7 days
// from creation, and stored as sha256 of its link token.
//
// Notice first (fails closed): an invite is created with `token_hash` NULL, so no link works yet. The admin Worker's
// cron lists it (`pendingMemberNotices`), computes the link token T = HMAC(INVITE_LINK_KEY, "hana-console/invite/v1" ‖
// borsh(id)) with a key the console never holds, emails the invitee and notifies every owner, the org's security
// contacts and the alias, and only after every send is accepted acks it with sha256(T) (`ackMemberNotice`). The
// console never sees T: no answer of the console carries a token or a token hash (D240).
//
// An owner invite to an existing org also creates an owner grant (D241): the new owner is a viewer until
// `ownerGrantDelayMs` after acceptance, cancellable by any owner, staff or the grant notice's link. The grant's own notice
// (with that cancel link) must be accepted before the invite can be accepted. If the org has no usable owner at
// acceptance (the first-owner exception), the grant is applied at once.
import { type InviteView, LEGACY_ORG_ID, type MemberNotice, type OwnerGrantView, type Role, INVITE_TTL_MS, MAX_OPEN_INVITES, fromB64url, hex, newId, normaliseAppName } from '@hana-id/console-core';
import { type Writer, auditInsert, entry, replayOf } from './audit.ts';
import { PASSKEYS_SHIPPED } from './config.ts';
import { refuse } from './errors.ts';
import { applied, frag, gate, gated, isReplay, lit, orgHasOwner, ownerNow, runBatch } from './sql.ts';
import { GRANT_COLUMNS, type GrantRow, INVITE_COLUMNS, type InviteRow, grantView, inviteView } from './views.ts';

/** An invite is open while unaccepted, unrevoked and unexpired. */
const openInvite = (i: string, now: number) => `${i}.accepted_at IS NULL AND ${i}.revoked_at IS NULL AND ${i}.expires_at > ${lit(now)}`;

/** The org (a SQL expression) is active: a frozen org's notices wait, and its acks are refused (D343). */
const orgActive = (orgExpr: string) => `EXISTS (SELECT 1 FROM orgs ao WHERE ao.id = ${orgExpr} AND ao.status = 'active')`;

/**
 * A live grant whose notice can be sent or acked: unannounced, uncancelled, unapplied, in an active org, and either a
 * promotion, an accepted owner invite's (its notice undone by a freeze, D343) or an open invite's.
 */
const grantNoticeDue = (g: string, i: string, now: number) =>
  `${g}.notified_at IS NULL AND ${g}.cancelled_at IS NULL AND ${g}.applied_at IS NULL AND ${orgActive(`${g}.org_id`)}
     AND (${g}.invite_id IS NULL OR ${g}.user_id IS NOT NULL OR (${openInvite(i, now)}))`;

export interface IssueInvite {
  email: string;
  role: Role;
  orgId?: string | undefined;
  newOrgName?: string | undefined;
  kind?: 'partner' | 'internal' | undefined;
  /** `hana` (StaffRpc) or `member` (an owner's `member.invite` step-up, batch C10, with its pending action id). */
  createdByKind: 'hana' | 'member';
  stepUpId?: string | null;
}

/**
 * Issues an invite (unusable until its notice is acked). Refusals: `forbidden` for `org_legacy`; `not_found` for an
 * unknown org; `conflict` for a frozen org, the 11th open invite of an org, or a second open invite of the same address
 * to it; `passkeys_required` for a second partner org while passkeys haven't shipped (an open new-partner-org invite
 * counts); `bad_request` for an unusable org name.
 */
export async function issueInvite(db: D1Database, w: Writer, i: IssueInvite): Promise<InviteView> {
  if ((i.orgId === undefined) === (i.newOrgName === undefined)) refuse('bad_request', 'Exactly one of orgId and newOrgName');
  if (i.createdByKind === 'member' && (!i.stepUpId || i.newOrgName !== undefined)) refuse('forbidden', 'A member invites to their own org, with a fresh sign-in');
  if (i.orgId === LEGACY_ORG_ID) refuse('forbidden', `${LEGACY_ORG_ID} has no members`);
  let newOrgName: string | null = null;
  if (i.newOrgName !== undefined) {
    if (i.role !== 'owner') refuse('bad_request', "A new org's first member is its owner");
    const n = normaliseAppName(i.newOrgName);
    if (!n.ok) refuse('bad_request', `newOrgName: ${n.problem.replace('The name', 'The org name')}`);
    newOrgName = (n as { name: string }).name;
  }
  const kind = newOrgName !== null ? (i.kind ?? 'partner') : null;
  const now = w.now;
  const id = newId('invite');
  const grantId = i.role === 'owner' && i.orgId !== undefined ? newId('ownerGrant') : null;

  const guards: string[] = [];
  const binds: unknown[] = [];
  if (i.orgId !== undefined) {
    guards.push(
      "EXISTS (SELECT 1 FROM orgs WHERE id = ? AND status = 'active')",
      `(SELECT COUNT(*) FROM invites i WHERE i.org_id = ? AND ${openInvite('i', now)}) < ${MAX_OPEN_INVITES}`,
      `NOT EXISTS (SELECT 1 FROM invites i WHERE i.org_id = ? AND i.email_norm = ? AND ${openInvite('i', now)})`,
    );
    binds.push(i.orgId, i.orgId, i.orgId, i.email);
  }
  if (kind === 'partner' && !PASSKEYS_SHIPPED) {
    guards.push(
      `NOT EXISTS (SELECT 1 FROM orgs WHERE kind = 'partner' AND id <> '${LEGACY_ORG_ID}')`,
      `NOT EXISTS (SELECT 1 FROM invites i WHERE i.new_org_kind = 'partner' AND ${openInvite('i', now)})`,
    );
  }
  const action = 'invite.issued';
  const g = gate(w.requestId, action);
  const stmts = [
    auditInsert(
      db,
      entry(w, action, { orgId: i.orgId ?? null, target: id, stepUpId: i.stepUpId ?? null, details: { role: i.role, newOrg: newOrgName !== null, ...(kind ? { kind } : {}), ...(grantId ? { grantId } : {}) } }),
      guards.length ? frag(guards.join(' AND '), ...binds) : frag('1'),
    ),
    gated(
      db,
      `INSERT INTO invites (id, email_norm, org_id, new_org_name, new_org_kind, role, created_by_kind, created_by, step_up_id, created_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE 1`,
      [id, i.email, i.orgId ?? null, newOrgName, kind, i.role, i.createdByKind, w.actor.id, i.stepUpId ?? null, now, now + INVITE_TTL_MS],
      g,
    ),
  ];
  if (grantId) {
    stmts.push(
      gated(
        db,
        'INSERT INTO owner_grants (id, org_id, invite_id, granted_by_kind, granted_by, step_up_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE 1',
        [grantId, i.orgId, id, i.createdByKind, w.actor.id, i.stepUpId ?? null, now],
        g,
      ),
    );
  }
  // A replay can't compare the target: each call draws a fresh invite id.
  const results = await runBatch(db, stmts, replayOf(w, action, null));
  if (!applied(results)) await whyNotIssued(db, i, kind, now);
  const row = await db.prepare(`SELECT ${INVITE_COLUMNS} FROM invites WHERE id = ?`).bind(id).first<InviteRow>();
  return inviteView(row!);
}

async function whyNotIssued(db: D1Database, i: IssueInvite, kind: string | null, now: number): Promise<never> {
  if (i.orgId !== undefined) {
    const org = await db.prepare('SELECT status FROM orgs WHERE id = ?').bind(i.orgId).first<{ status: string }>();
    if (!org) refuse('not_found', 'No such org');
    if (org!.status !== 'active') refuse('conflict', 'The org is frozen');
    const open = await db
      .prepare(`SELECT COUNT(*) AS n, SUM(email_norm = ?) AS same FROM invites i WHERE i.org_id = ? AND ${openInvite('i', now)}`)
      .bind(i.email, i.orgId)
      .first<{ n: number; same: number | null }>();
    if ((open?.same ?? 0) > 0) refuse('conflict', 'This address already has an open invite to the org');
    if ((open?.n ?? 0) >= MAX_OPEN_INVITES) refuse('conflict', `The org has ${MAX_OPEN_INVITES} open invites`);
  }
  if (kind === 'partner') refuse('passkeys_required', 'A second partner org needs member passkeys first');
  return refuse('conflict', 'The invite was not issued; retry');
}

/**
 * Revokes an open invite and cancels its owner grant. `orgId` scopes it to one org (an owner's revoke, batch C10);
 * staff revoke any. Refusals: `not_found` (unknown, or another org's), `not_pending` (accepted, revoked or expired).
 */
export async function revokeInvite(db: D1Database, w: Writer, inviteId: string, orgId?: string): Promise<void> {
  const inv = await db.prepare('SELECT org_id FROM invites WHERE id = ?').bind(inviteId).first<{ org_id: string | null }>();
  if (!inv || (orgId !== undefined && inv.org_id !== orgId)) refuse('not_found', 'No such invite');
  const now = w.now;
  const grant = await db.prepare('SELECT id FROM owner_grants WHERE invite_id = ? AND cancelled_at IS NULL AND applied_at IS NULL').bind(inviteId).first<{ id: string }>();
  const action = 'invite.revoked';
  const g = gate(w.requestId, action);
  const results = await runBatch(
    db,
    [
      auditInsert(db, entry(w, action, { orgId: inv!.org_id, target: inviteId, details: grant ? { grantCancelled: grant.id } : {} }), frag(`EXISTS (SELECT 1 FROM invites i WHERE i.id = ? AND ${openInvite('i', now)})`, inviteId)),
      gated(db, 'UPDATE invites SET revoked_at = ? WHERE id = ?', [now, inviteId], g),
      gated(db, 'UPDATE owner_grants SET cancelled_at = ?, cancelled_by = ? WHERE invite_id = ? AND cancelled_at IS NULL AND applied_at IS NULL', [now, w.actor.id, inviteId], g),
    ],
    replayOf(w, action, inviteId),
  );
  if (!applied(results)) refuse('not_pending', 'The invite was already accepted, revoked or expired');
}

/** An org's invites for the staff screen, newest first (the cron purges them 90 days after they end). */
export async function invitesOf(db: D1Database, orgId: string): Promise<InviteView[]> {
  const { results } = await db.prepare(`SELECT ${INVITE_COLUMNS} FROM invites WHERE org_id = ? ORDER BY created_at DESC LIMIT 100`).bind(orgId).all<InviteRow>();
  return results.map(inviteView);
}

/**
 * The blocking notices still to send, oldest first: open invites whose notice isn't acked, and live grants whose
 * notice isn't acked (an invite's grant only while its invite is open, or once it was accepted and a freeze undid the
 * notice). A frozen org's are held back until it is active again (D343). Each lists the org's current owners.
 */
export async function pendingMemberNotices(db: D1Database, now: number, limit: number): Promise<MemberNotice[]> {
  const invites = (await db.prepare(`SELECT ${INVITE_COLUMNS} FROM invites i WHERE i.notified_at IS NULL AND ${openInvite('i', now)} AND (i.org_id IS NULL OR ${orgActive('i.org_id')}) ORDER BY i.created_at, i.id LIMIT ?`).bind(limit).all<InviteRow>()).results;
  const grants = (
    await db
      .prepare(
        `SELECT ${GRANT_COLUMNS.split(', ').map((c) => `g.${c}`).join(', ')} FROM owner_grants g LEFT JOIN invites i ON i.id = g.invite_id
          WHERE ${grantNoticeDue('g', 'i', now)}
          ORDER BY g.created_at, g.id LIMIT ?`,
      )
      .bind(limit)
      .all<GrantRow>()
  ).results;
  const grantInvites = new Map<string, InviteRow>();
  const ids = grants.map((g) => g.invite_id).filter((x): x is string => x !== null);
  if (ids.length) {
    const rows = (await db.prepare(`SELECT ${INVITE_COLUMNS} FROM invites WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all<InviteRow>()).results;
    for (const r of rows) grantInvites.set(r.id, r);
  }
  const orgIds = [...new Set([...invites.map((i) => i.org_id), ...grants.map((g) => g.org_id)].filter((x): x is string => x !== null))];
  const owners = new Map<string, { email: string }[]>();
  if (orgIds.length) {
    const rows = (
      await db
        .prepare(
          `SELECT m.org_id, u.email FROM members m JOIN console_users u ON u.id = m.user_id
            WHERE m.org_id IN (SELECT value FROM json_each(?)) AND u.disabled_at IS NULL AND ${ownerNow('m', now)} ORDER BY m.org_id, u.email`,
        )
        .bind(JSON.stringify(orgIds))
        .all<{ org_id: string; email: string }>()
    ).results;
    for (const r of rows) owners.set(r.org_id, [...(owners.get(r.org_id) ?? []), { email: r.email }]);
  }
  const promoted = new Map<string, string>();
  const userIds = grants.filter((g) => g.invite_id === null && g.user_id !== null).map((g) => g.user_id!);
  if (userIds.length) {
    const rows = (await db.prepare('SELECT id, email FROM console_users WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(userIds)).all<{ id: string; email: string }>()).results;
    for (const r of rows) promoted.set(r.id, r.email);
  }
  const out: (MemberNotice & { at: number })[] = [
    ...invites.map((r) => ({ at: r.created_at, kind: 'invite' as const, invite: inviteView(r), owners: r.org_id ? (owners.get(r.org_id) ?? []) : [] })),
    ...grants.map((r) => {
      const inv = r.invite_id ? grantInvites.get(r.invite_id) : undefined;
      const email = r.user_id ? promoted.get(r.user_id) : undefined;
      return {
        at: r.created_at,
        kind: 'owner_grant' as const,
        grant: grantView(r),
        ...(inv ? { invite: inviteView(inv) } : {}),
        ...(email !== undefined ? { member: { userId: r.user_id!, email } } : {}),
        owners: owners.get(r.org_id) ?? [],
      };
    }),
  ];
  out.sort((a, b) => a.at - b.at);
  return out.slice(0, limit).map(({ at: _at, ...n }) => n);
}

/**
 * The admin Worker's ack after every send of a notice was accepted: an invite's `token_hash` (its link starts working)
 * or a grant's `cancel_token_hash` (and a promotion's `owner_from = notified_at + ownerGrantDelayMs`). A repeated ack
 * with the same hash is a no-op (a retry after a lost answer); another hash is `conflict`; an invite or grant that
 * ended (revoked, expired, accepted, cancelled, applied) is `not_pending`; unknown is `not_found`.
 */
export async function ackMemberNotice(db: D1Database, w: Writer, a: { inviteId?: string | undefined; grantId?: string | undefined; tokenHash: string }, delayMs: () => number): Promise<void> {
  let hash: Uint8Array;
  try {
    hash = fromB64url(a.tokenHash);
  } catch {
    return refuse('bad_request', 'tokenHash is not b64url');
  }
  if (hash.length !== 32) refuse('bad_request', 'tokenHash is not 32 bytes');
  const now = w.now;
  if (a.inviteId !== undefined) {
    const row = await db.prepare('SELECT org_id, hex(token_hash) AS h FROM invites WHERE id = ?').bind(a.inviteId).first<{ org_id: string | null; h: string | null }>();
    if (!row) return refuse('not_found', 'No such invite');
    if (row.h) return sameHash(row.h, hash);
    const action = 'invite.notified';
    const g = gate(w.requestId, action);
    const results = await runBatch(
      db,
      [
        auditInsert(
          db,
          entry(w, action, { orgId: row.org_id, target: a.inviteId }),
          frag(`EXISTS (SELECT 1 FROM invites i WHERE i.id = ? AND i.notified_at IS NULL AND ${openInvite('i', now)} AND (i.org_id IS NULL OR ${orgActive('i.org_id')}))`, a.inviteId),
        ),
        gated(db, 'UPDATE invites SET token_hash = ?, notified_at = ? WHERE id = ? AND notified_at IS NULL', [hash, now, a.inviteId], g),
      ],
      replayOf(w, action, a.inviteId),
    );
    if (!applied(results)) {
      const again = await db.prepare('SELECT hex(token_hash) AS h FROM invites WHERE id = ?').bind(a.inviteId).first<{ h: string | null }>();
      if (again?.h) return sameHash(again.h, hash);
      refuse('not_pending', 'The invite was revoked, accepted or expired, or its org is frozen');
    }
    return;
  }
  const grantId = a.grantId!;
  const row = await db.prepare('SELECT org_id, invite_id, user_id, hex(cancel_token_hash) AS h FROM owner_grants WHERE id = ?').bind(grantId).first<{ org_id: string; invite_id: string | null; user_id: string | null; h: string | null }>();
  if (!row) return refuse('not_found', 'No such owner grant');
  if (row.h) return sameHash(row.h, hash);
  // A promotion's wait starts at its notice; an owner invite's at acceptance (owner_from stays NULL until then), except
  // an accepted one whose notice and clock a freeze undid (D343): its full wait starts again at this new notice.
  const ownerFrom = row.invite_id === null || row.user_id !== null ? now + delayMs() : null;
  const action = 'owner_grant.notified';
  const g = gate(w.requestId, action);
  const results = await runBatch(
    db,
    [
      auditInsert(
        db,
        entry(w, action, { orgId: row.org_id, target: grantId, details: ownerFrom !== null ? { ownerFrom } : {} }),
        frag(
          `EXISTS (SELECT 1 FROM owner_grants g LEFT JOIN invites i ON i.id = g.invite_id WHERE g.id = ? AND ${grantNoticeDue('g', 'i', now)})`,
          grantId,
        ),
      ),
      gated(db, 'UPDATE owner_grants SET cancel_token_hash = ?, notified_at = ?, owner_from = COALESCE(?, owner_from) WHERE id = ? AND notified_at IS NULL', [hash, now, ownerFrom, grantId], g),
    ],
    replayOf(w, action, grantId),
  );
  if (!applied(results)) {
    const again = await db.prepare('SELECT hex(cancel_token_hash) AS h FROM owner_grants WHERE id = ?').bind(grantId).first<{ h: string | null }>();
    if (again?.h) return sameHash(again.h, hash);
    refuse('not_pending', 'The grant was cancelled or applied, its invite ended, or its org is frozen');
  }
}

/** A repeated ack: fine with the stored hash (SQLite `hex()`, uppercase), `conflict` with another. */
function sameHash(storedHex: string, presented: Uint8Array): void {
  if (storedHex !== hex(presented).toUpperCase()) refuse('conflict', 'The notice was already acked with another token');
}

// ---- acceptance (the data path of batch C9's sign-in) ----

export interface Acceptance {
  /** sha256 of the presented invite token. */
  tokenHash: Uint8Array;
  /** The verified Google email, lowercased. */
  email: string;
  provider: string;
  sub: string;
  /** The ID token's `hd`, or null. */
  hd: string | null;
  requestId: string;
  now: number;
  ipPrefix: string | null;
  country: string | null;
}

export type AcceptanceOutcome =
  | { ok: true; userId: string; orgId: string; role: Role; newUser: boolean }
  | { ok: false; code: 'invite_invalid' | 'already_member' | 'user_disabled' };

/**
 * Accepts an invite in one D1 batch (docs/batch-c-spec.md "Membership rules at sign-in"): every id is resolved from
 * (provider, sub) inside it, so an existing user row is reused and a new one is created only when none exists; D1 runs
 * the batch as one serialised transaction. After a replay probe, its first statement is the `invite.accepted` audit row, inserted only while
 * the invite is acceptable (V below): the commit row the other statements are gated on (sql.ts), so a concurrent second
 * acceptance, even by the same person in the same millisecond, inserts nothing. A refused acceptance writes no user,
 * org, member, grant or audit row and leaves the invite unconsumed. The caller (C9) has already checked the token's
 * email claims; a disabled user is refused here too.
 */
export async function acceptInvite(db: D1Database, a: Acceptance, delayMs: () => number): Promise<AcceptanceOutcome> {
  const t = a.now;
  const newUserId = newId('user');
  const newOrgId = newId('org');
  const delay = delayMs();
  // V(i): the invite is acceptable by this person now: the spec's, plus not already a member of its org, and its
  // owner grant's notice (with the cancel link) accepted.
  const V = `i.token_hash = ? AND i.email_norm = ? AND ${openInvite('i', t)}
      AND (i.org_id IS NULL OR EXISTS (SELECT 1 FROM orgs o WHERE o.id = i.org_id AND o.status = 'active' AND (o.required_hd IS NULL OR o.required_hd = ?)))
      AND NOT EXISTS (SELECT 1 FROM console_users u WHERE u.provider = ? AND u.sub = ? AND u.disabled_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM members mm JOIN console_users uu ON uu.id = mm.user_id WHERE uu.provider = ? AND uu.sub = ? AND mm.org_id = i.org_id)
      AND NOT EXISTS (SELECT 1 FROM owner_grants vg WHERE vg.invite_id = i.id AND vg.cancelled_at IS NULL AND vg.notified_at IS NULL)`;
  const vBinds = [a.tokenHash, a.email, a.hd, a.provider, a.sub, a.provider, a.sub];
  // The role the member gets, decided before any row changes: an owner invite to an existing org waits behind its grant
  // unless the org has no usable owner (the first-owner exception); a cancelled grant leaves a viewer.
  const role = `CASE WHEN i.role = 'viewer' THEN 'viewer' WHEN i.org_id IS NULL THEN 'owner'
      WHEN EXISTS (SELECT 1 FROM owner_grants rg WHERE rg.invite_id = i.id AND rg.cancelled_at IS NULL) AND NOT ${orgHasOwner('i.org_id', t)} THEN 'owner'
      ELSE 'viewer' END`;
  const g = gate(a.requestId, 'invite.accepted');
  const hasOwner = orgHasOwner('og2.org_id', t);
  const stmts = [
    // Replay probe (fails closed): if this request id already committed an acceptance, insert a second row with it, which
    // violates `audit_log_request_action` and aborts the whole batch. Without it, the gate below would find the earlier
    // row and let the later statements run for whatever token this call presents.
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_kind, actor_id, action, details_json, request_id, outcome)
         SELECT ?, 'system', 'replay-probe', 'invite.accepted', '{}', ?, 'failed'
          WHERE EXISTS (SELECT 1 FROM audit_log WHERE request_id = ? AND action = 'invite.accepted')`,
      )
      .bind(t, a.requestId, a.requestId),
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_kind, actor_id, actor_email, actor_sub, org_id, action, target, details_json, request_id, ip_prefix, country, outcome)
         SELECT ?, 'member', COALESCE((SELECT id FROM console_users WHERE provider = ? AND sub = ?), ?), ?, ?, COALESCE(i.org_id, ?), 'invite.accepted', i.id,
                json_object('role', ${role}, 'newOrg', json(CASE WHEN i.org_id IS NULL THEN 'true' ELSE 'false' END)), ?, ?, ?, 'ok'
           FROM invites i WHERE ${V}`,
      )
      .bind(t, a.provider, a.sub, newUserId, a.email, a.sub, newOrgId, a.requestId, a.ipPrefix, a.country, ...vBinds),
    // An existing (provider, sub) keeps its row (and id): the conflict clause after the gate.
    db
      .prepare(`INSERT INTO console_users (id, provider, sub, email, created_at) SELECT ?, ?, ?, ?, ? WHERE ${g.sql} ON CONFLICT (provider, sub) DO NOTHING`)
      .bind(newUserId, a.provider, a.sub, a.email, t, ...g.binds),
    gated(
      db,
      // The open-invite conditions again (defence in depth: the commit row already required them in this transaction).
      `UPDATE invites SET accepted_at = ?, accepted_by_sub = ?, accepted_user_id = (SELECT id FROM console_users WHERE provider = ? AND sub = ?)
        WHERE token_hash = ? AND email_norm = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ${lit(t)}`,
      [t, a.sub, a.provider, a.sub, a.tokenHash, a.email],
      g,
    ),
    gated(db, 'INSERT INTO orgs (id, name, kind, created_at) SELECT ?, new_org_name, new_org_kind, ? FROM invites WHERE token_hash = ? AND new_org_name IS NOT NULL', [newOrgId, t, a.tokenHash], g),
    // Before the member row: whether the org already has an owner decides the wait or the first-owner exception.
    gated(
      db,
      `UPDATE owner_grants AS og2 SET user_id = (SELECT accepted_user_id FROM invites WHERE token_hash = ?),
              owner_from = CASE WHEN ${hasOwner} THEN ${lit(t + delay)} ELSE ${lit(t)} END,
              applied_at = CASE WHEN ${hasOwner} THEN NULL ELSE ${lit(t)} END
        WHERE og2.invite_id = (SELECT id FROM invites WHERE token_hash = ?) AND og2.cancelled_at IS NULL`,
      [a.tokenHash, a.tokenHash],
      g,
    ),
    gated(
      db,
      `INSERT INTO members (org_id, user_id, role, role_since, added_by, added_at)
       SELECT COALESCE(i.org_id, ?), i.accepted_user_id,
              CASE WHEN i.role = 'viewer' THEN 'viewer' WHEN i.org_id IS NULL THEN 'owner'
                   WHEN EXISTS (SELECT 1 FROM owner_grants mg WHERE mg.invite_id = i.id AND mg.applied_at = ${lit(t)}) THEN 'owner'
                   ELSE 'viewer' END,
              ?, i.created_by, ? FROM invites i WHERE i.token_hash = ?`,
      [newOrgId, t, t, a.tokenHash],
      g,
    ),
  ];
  let results: D1Result[];
  try {
    results = await db.batch(stmts);
  } catch (err) {
    // A reused request id: the probe aborted the batch, nothing was written.
    if (isReplay(err)) return { ok: false, code: 'invite_invalid' };
    throw err;
  }
  // results[0] is the replay probe; results[1] the commit row.
  if (applied(results.slice(1))) {
    const row = (await db.prepare('SELECT org_id, accepted_user_id FROM invites WHERE token_hash = ?').bind(a.tokenHash).first<{ org_id: string | null; accepted_user_id: string }>())!;
    const orgId = row.org_id ?? newOrgId;
    const m = (await db.prepare('SELECT role FROM members WHERE org_id = ? AND user_id = ?').bind(orgId, row.accepted_user_id).first<{ role: Role }>())!;
    return { ok: true, userId: row.accepted_user_id, orgId, role: m.role, newUser: row.accepted_user_id === newUserId };
  }
  const user = await db.prepare('SELECT id, disabled_at FROM console_users WHERE provider = ? AND sub = ?').bind(a.provider, a.sub).first<{ id: string; disabled_at: number | null }>();
  if (user?.disabled_at != null) return { ok: false, code: 'user_disabled' };
  const inv = await db.prepare('SELECT org_id, accepted_at FROM invites WHERE token_hash = ?').bind(a.tokenHash).first<{ org_id: string | null; accepted_at: number | null }>();
  if (user && inv?.org_id && inv.accepted_at === null) {
    const member = await db.prepare('SELECT 1 AS x FROM members WHERE org_id = ? AND user_id = ?').bind(inv.org_id, user.id).first();
    if (member) return { ok: false, code: 'already_member' };
  }
  return { ok: false, code: 'invite_invalid' };
}

/** The grant views of an org (staff screen), newest first. */
export async function grantsOf(db: D1Database, orgId: string): Promise<OwnerGrantView[]> {
  const { results } = await db.prepare(`SELECT ${GRANT_COLUMNS} FROM owner_grants WHERE org_id = ? ORDER BY created_at DESC LIMIT 100`).bind(orgId).all<GrantRow>();
  return results.map(grantView);
}

