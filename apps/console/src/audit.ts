// audit_log rows (docs/batch-c-spec.md "Audit"): console-side events, append-only, kept 5 years (D90). `details_json`
// holds allowlisted fields only (the list below; anything else throws before a statement is built): no token, token
// hash, secret, cookie, full IP or Google `sub`, and no invitee address: an invite's email lives on the invite row,
// which the hourly cron purges 90 days after it ends, so the 5-year audit trail names the invite id, never the person
// (D243). `actor_email` is the acting member's or staffer's own address, the spec's column.
import type { Actor, AuditFilters, AuditRow } from '@hana-id/console-core';
import { type Frag, lit } from './sql.ts';

/**
 * Every action the console writes and the detail keys each may carry (the snapshot test pins this list). Values are
 * ids, roles, kinds, codes, counts and times only.
 */
export const AUDIT_DETAIL_KEYS = {
  'invite.issued': ['role', 'newOrg', 'kind', 'grantId'],
  'invite.revoked': ['grantCancelled'],
  'invite.notified': [],
  'invite.expired': [],
  'invite.accepted': ['role', 'newOrg'],
  'owner_grant.created': ['userId'],
  'owner_grant.notified': ['ownerFrom'],
  'owner_grant.cancelled': ['via'],
  'member.added': ['role', 'grantId'],
  'member.role': ['from', 'to', 'grantCancelled'],
  'member.removed': ['role', 'grantCancelled'],
  'member.owner_granted': ['grantId'],
  'user.disabled': [],
  'user.enabled': [],
  'org.frozen': [],
  'org.unfrozen': [],
  // D894: a partner label version's link cancel also names its entry (it has no one app).
  'change.link_cancel': ['code', 'labelId'],
  // Batch C11: the outcome of the setLogo RPC after an upload or a removal (app_changes has the change itself).
  'app.logo_set': ['logoKey', 'code'],
  'app.logo_removed': ['code'],
  // Sign-in (batch C9). A refusal names no person: a known user by id (`target`), anyone else by the sha256 of the
  // address Google verified (spec "Membership rules at sign-in"), never the address itself.
  'session.signed_in': ['invite'],
  'session.signed_out': [],
  'signin.refused': ['code', 'emailSha256'],
  // Batch C10: an owner's writes. A step-up's row carries its pending action id (`step_up_id`); the ones that go through
  // ConsoleRpc are outcome rows written after the RPC returns (app_changes, the API's, is authoritative), with the
  // RpcCode of a refusal. `requiredHd` is the org's own Workspace domain (its setting, not a person's).
  'step_up.failed': ['kind', 'code'],
  // D934: `frameOnly`, how many of the adds the app may use only inside its other web addresses.
  'origin.proposed': ['code', 'version', 'added', 'removed', 'frameOnly'],
  // D934: an owner set web addresses to work only inside the app's other web addresses (immediate, like a removal).
  'origin.frame_only': ['code', 'version', 'origins'],
  // D931: an owner's confirmation (a step-up; app_changes' `origin.confirmed`, the API's, is authoritative) and the
  // confirmation notice's removal link (no session): ids, counts and codes only.
  'origin.confirmed': ['code', 'confirmed', 'requestId'],
  'origin.link_remove': ['code', 'changeId'],
  'policy.proposed': ['code', 'version', 'policyId', 'changeId'],
  'raw_sign.proposed': ['code', 'version', 'changeId'],
  // D894: an owner's partner labels proposal and removal (step-ups; app_changes, the API's, is authoritative).
  'labels.proposed': ['code', 'version', 'changeId', 'labelId'],
  'labels.removed': ['code', 'version', 'labelId'],
  // D918: platform keys. An owner's registration, acceptance and confirmation (step-ups), stop and cancel (immediate),
  // and the emailed links' cancel and stop (no session): ids, codes and states only, never a key or its thumbprint.
  'platform_key.proposed': ['code', 'keyId'],
  'platform_key.accepted': ['code', 'keyId'],
  'platform_key.confirmed': ['code', 'keyId'],
  'platform_key.cancelled': ['code', 'keyId'],
  'platform_key.revoked': ['code', 'keyId'],
  'platform_key.link_cancel': ['code', 'keyId'],
  'platform_key.link_revoke': ['code', 'keyId'],
  'app.resumed': ['code', 'suspendedBy'],
  'app.settings_changed': ['code', 'version', 'fields'],
  'owner_action.relayed': ['code', 'method', 'status'],
  'owner_action.executed': ['code', 'status', 'changeId'],
  'org.policy': ['requiredHd'],
  'origins.removed': ['code', 'version', 'removed'],
  'app.turned_off': ['code', 'version', 'what'],
  'change.cancelled': ['code', 'changeId'],
  // D930: `takenOver` when an owner took the backend's (platform's) suspension over.
  'app.suspended': ['code', 'suspendedBy', 'takenOver'],
  'app.renamed': ['code', 'version'],
  'key.created': ['code', 'keyId'],
  'key.rotated': ['code', 'keyId', 'newKeyId'],
  'key.revoked': ['code', 'keyId'],
  // Batch C12 (StaffRpc.recordStaffAction, D327): the admin Worker's statement, export and rate-override acts.
  'statement.issued': ['month', 'csvSha256', 'pdfSha256', 'asOf', 'lines'],
  'ledger.exported': ['month', 'asOf', 'rows', 'sha256'],
  'rate.overridden': ['day', 'usdMicros', 'overrideId'],
  // Batch C15 (D396): a staff Support ID lookup, org-less, recorded before the lookup reads anything; `requestIdList`
  // the escalation's request IDs themselves (D410; `requestIds` their count, as before).
  'support.lookup': ['by', 'ticket', 'requestIds', 'requestIdList', 'days'],
  // D410: the Users screen's wallet-directory find (a wallet, User ID, internal id or Support ID), org-less, recorded
  // before it reads: the query's kind and the ticket.
  'users.find': ['by', 'ticket'],
  // D925: an owner's look-up of one person across the org's apps (the panel or the per-app search), recorded before it
  // answers: what opened it, the kind of code (User ID or Support ID) and whose (the scope's or an app's own), or the
  // refusal's code. `target` is the person's scope-level User ID (none when nothing was found), `app_id` the app whose
  // own code matched; never the code that was typed.
  'users.link_view': ['by', 'kind', 'of', 'code'],
  // D843: the EVM relayer's staff tools from the admin portal, org-less (the relayer is the env's): before the tool runs,
  // which tool, the chain, the slot and the staffer's note; after it, the relayer's answer (`done`, or its reason).
  'evm_relay.staff_action': ['tool', 'chainId', 'slot', 'note', 'keyConfirmed'],
  'evm_relay.staff_result': ['tool', 'chainId', 'slot', 'result'],
  // D894: the partner labels' staff tools from the admin portal, org-less: before the tool runs, which tool, its target
  // (a change, an entry, an org or every org) and the staffer's note; after it, the API's answer.
  'labels.staff_action': ['tool', 'target', 'note'],
  'labels.staff_result': ['tool', 'target', 'result'],
} as const satisfies Record<string, readonly string[]>;

export type AuditAction = keyof typeof AUDIT_DETAIL_KEYS;

export interface AuditEntry {
  at: number;
  actor: Actor;
  orgId?: string | null;
  appId?: string | null;
  action: AuditAction;
  target?: string | null;
  /** Scalars; a list only for the one key staff-rpc allows it on (support.lookup's request IDs). */
  details?: Record<string, string | number | boolean | null | readonly string[]>;
  stepUpId?: string | null;
  requestId: string;
  nearTx?: string | null;
  ipPrefix?: string | null;
  country?: string | null;
  outcome?: 'ok' | 'failed';
}

/** Who writes and when: the caller's actor and request id, the clock, and the caller's coarse network prefix. */
export interface Writer {
  actor: Actor;
  requestId: string;
  now: number;
  ipPrefix: string | null;
  country?: string | null;
}

/** An audit entry of this writer. */
export const entry = (w: Writer, action: AuditAction, fields: Omit<AuditEntry, 'at' | 'actor' | 'action' | 'requestId'> = {}): AuditEntry => ({
  at: w.now,
  actor: w.actor,
  action,
  requestId: w.requestId,
  ipPrefix: w.ipPrefix,
  country: w.country ?? null,
  ...fields,
});

/** The replay identity of a write (sql.ts runBatch). */
export const replayOf = (w: Writer, action: AuditAction, target: string | null) => ({ requestId: w.requestId, action, actorKind: w.actor.kind, actorId: w.actor.id, target });

/** The allowlisted details as JSON; an unlisted key is a programming error, never written. */
export function detailsJson(action: AuditAction, details: AuditEntry['details'] = {}): string {
  const allowed: readonly string[] = AUDIT_DETAIL_KEYS[action];
  for (const k of Object.keys(details)) if (!allowed.includes(k)) throw new TypeError(`audit ${action}: detail ${k} is not allowlisted`);
  return JSON.stringify(details);
}

/** The actor columns: a member's or staffer's own email, never a link token. */
export function actorColumns(actor: Actor): { kind: string; id: string; email: string | null; sub: string | null } {
  switch (actor.kind) {
    case 'member':
      return { kind: 'member', id: actor.id, email: actor.email, sub: actor.sub };
    case 'hana':
      return { kind: 'hana', id: actor.id, email: actor.email, sub: null };
    default:
      return { kind: actor.kind, id: actor.id, email: null, sub: null };
  }
}

const COLUMNS = 'at, actor_kind, actor_id, actor_email, actor_sub, org_id, app_id, action, target, details_json, step_up_id, request_id, near_tx, ip_prefix, country, outcome';

/**
 * The commit row of a write: inserted only while `guard` holds, or (so the batch aborts on the unique index) when this
 * request's row already exists. Without a guard it always inserts.
 */
export function auditInsert(db: D1Database, e: AuditEntry, guard?: Frag): D1PreparedStatement {
  const a = actorColumns(e.actor);
  const values = [e.at, a.kind, a.id, a.email, a.sub, e.orgId ?? null, e.appId ?? null, e.action, e.target ?? null, detailsJson(e.action, e.details), e.stepUpId ?? null, e.requestId, e.nearTx ?? null, e.ipPrefix ?? null, e.country ?? null, e.outcome ?? 'ok'];
  const select = values.map((_, i) => `?${i + 1}`).join(', ');
  // ?12 is the request id and ?8 the action; the guard's bare `?`s number from ?17 on.
  const where = guard ? `WHERE (${guard.sql}) OR EXISTS (SELECT 1 FROM audit_log WHERE request_id = ?12 AND action = ?8)` : '';
  return db.prepare(`INSERT INTO audit_log (${COLUMNS}) SELECT ${select} ${where}`).bind(...values, ...(guard?.binds ?? []));
}

interface AuditDbRow {
  seq: number;
  at: number;
  actor_kind: AuditRow['actorKind'];
  actor_id: string;
  actor_email: string | null;
  actor_sub: string | null;
  org_id: string | null;
  app_id: string | null;
  action: string;
  target: string | null;
  details_json: string;
  step_up_id: string | null;
  request_id: string;
  near_tx: string | null;
  country: string | null;
  outcome: AuditRow['outcome'];
}

/** A row as StaffRpc returns it (no `ip_prefix`: the view the spec types). */
export function auditView(r: AuditDbRow): AuditRow {
  return {
    seq: r.seq,
    at: r.at,
    actorKind: r.actor_kind,
    actorId: r.actor_id,
    ...(r.actor_email !== null ? { actorEmail: r.actor_email } : {}),
    ...(r.actor_sub !== null ? { actorSub: r.actor_sub } : {}),
    ...(r.org_id !== null ? { orgId: r.org_id } : {}),
    ...(r.app_id !== null ? { appId: r.app_id } : {}),
    action: r.action,
    ...(r.target !== null ? { target: r.target } : {}),
    details: JSON.parse(r.details_json) as Record<string, unknown>,
    ...(r.step_up_id !== null ? { stepUpId: r.step_up_id } : {}),
    requestId: r.request_id,
    ...(r.near_tx !== null ? { nearTx: r.near_tx } : {}),
    ...(r.country !== null ? { country: r.country } : {}),
    outcome: r.outcome,
  };
}

const VIEW_COLUMNS = 'seq, at, actor_kind, actor_id, actor_email, actor_sub, org_id, app_id, action, target, details_json, step_up_id, request_id, near_tx, country, outcome';

/** The feed's read (the admin Worker's 5-minute cron): rows after `seq`, oldest first. */
export async function auditSince(db: D1Database, seq: number, limit: number): Promise<AuditRow[]> {
  const { results } = await db.prepare(`SELECT ${VIEW_COLUMNS} FROM audit_log WHERE seq > ? ORDER BY seq LIMIT ?`).bind(seq, limit).all<AuditDbRow>();
  return results.map(auditView);
}

/** The staff screen's read: filtered, newest first, `cursor` the last seq of the previous page. */
export async function queryAudit(db: D1Database, filters: AuditFilters, cursor: string | undefined, limit: number): Promise<{ rows: AuditRow[]; next?: string }> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    where.push(sql);
    binds.push(v);
  };
  if (filters.orgId !== undefined) add('org_id = ?', filters.orgId);
  if (filters.appId !== undefined) add('app_id = ?', filters.appId);
  if (filters.actorKind !== undefined) add('actor_kind = ?', filters.actorKind);
  if (filters.actorId !== undefined) add('actor_id = ?', filters.actorId);
  if (filters.action !== undefined) add('action = ?', filters.action);
  if (filters.target !== undefined) add('target = ?', filters.target);
  if (filters.from !== undefined) where.push(`at >= ${lit(filters.from)}`);
  if (filters.to !== undefined) where.push(`at < ${lit(filters.to)}`);
  if (cursor !== undefined) where.push(`seq < ${lit(Number(cursor))}`);
  const sql = `SELECT ${VIEW_COLUMNS} FROM audit_log${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...binds, limit + 1).all<AuditDbRow>();
  const rows = results.slice(0, limit).map(auditView);
  return results.length > limit ? { rows, next: String(rows[rows.length - 1]!.seq) } : { rows };
}
