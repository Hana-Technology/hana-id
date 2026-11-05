// StaffRpc (docs/batch-c-spec.md "RPC interfaces"): the console's entrypoint for the admin Worker, bound only by it
// (batch C8; `CONSOLE` → `StaffRpc`) and reachable through no route: the console's `fetch` never dispatches to it.
// Staff calls take a Hana actor (the Access `sub` and email the admin Worker verified, D88); the admin Worker's crons
// call the notice and feed methods with a `system` actor, and only a `system` actor may ack a notice, so a staffer can't
// make an invite link work by hand without the emails having gone out (D243, as D229 for `ackNotice`).
//
// Every method validates its input with console-core's zod schema (`bad_request`), checks the actor kind
// (`forbidden`), and answers `{ok: true, …}` or `{ok: false, code, error?}`; nothing it throws escapes. An unexpected
// error is logged (method, request id, actor kind, org: never an email, sub or token) and answered `internal`.
//
// Built in C7; `recordStaffAction` added in C12 (D327); `purgeAudit` in C13 (the admin's monthly retention job only, a
// `system` actor, D360).
import {
  type Actor,
  type RpcCode,
  type RpcFail,
  ackMemberNoticeInput,
  auditSinceInput,
  cancelOwnerGrantInput,
  disableUserInput,
  freezeOrgInput,
  getOrgInput,
  issueInviteInput,
  listMembersInput,
  listOrgsInput,
  pendingMemberNoticesInput,
  purgeAuditInput,
  queryAuditInput,
  recordStaffActionInput,
  revokeInviteInput,
  setMemberInput,
} from '@hana-id/console-core';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { AUDIT_DETAIL_KEYS, type Writer, auditInsert, auditSince, entry, queryAudit } from './audit.ts';
import { ownerGrantDelayMs } from './config.ts';
import type { Env } from './env.ts';
import { RpcRefusal } from './errors.ts';
import { cancelOwnerGrant } from './grants.ts';
import { ackMemberNotice, invitesOf, issueInvite, pendingMemberNotices, revokeInvite } from './invites.ts';
import { ipPrefix } from './ip.ts';
import { log } from './log.ts';
import { disableUser, freezeOrg, getOrgRow, listOrgs, setMember } from './members.ts';
import { purgeAudit } from './retention.ts';
import { grantsOf, membersOf } from './views.ts';

type Answer<T extends object> = ({ ok: true } & T) | RpcFail;

interface Schema<I> {
  safeParse(v: unknown): { success: true; data: I } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } };
}

const HANA = ['hana'] as const;
const HANA_OR_SYSTEM = ['hana', 'system'] as const;
const SYSTEM = ['system'] as const;

export async function runStaff<I extends { actor: Actor; requestId: string; clientIp: string }, T extends object>(
  method: string,
  schema: Schema<I>,
  raw: unknown,
  actors: readonly Actor['kind'][],
  work: (input: I, w: Writer) => Promise<T>,
): Promise<Answer<T>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, code: 'bad_request', error: issue ? `${issue.path.join('.') || 'input'}: ${issue.message}`.slice(0, 500) : 'Invalid input' };
  }
  const input = parsed.data;
  const orgId = (input as { orgId?: string }).orgId;
  const fields = { event: 'staff_rpc', method, requestId: input.requestId, actorKind: input.actor.kind, ...(orgId ? { orgId } : {}) };
  if (!actors.includes(input.actor.kind)) return { ok: false, code: 'forbidden', error: `This method doesn't take a ${input.actor.kind} actor` };
  const w: Writer = { actor: input.actor, requestId: input.requestId, now: Date.now(), ipPrefix: ipPrefix(input.clientIp) };
  try {
    const result = await work(input, w);
    log({ ...fields, outcome: 'ok' });
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof RpcRefusal) {
      log({ ...fields, outcome: 'rejected', code: err.code });
      return { ok: false, code: err.code as RpcCode, error: err.message.slice(0, 500) };
    }
    log({ ...fields, outcome: 'error', code: 'internal', error: err instanceof Error ? err.name : 'unknown' }, 'error');
    return { ok: false, code: 'internal' };
  }
}

export class StaffRpc extends WorkerEntrypoint<Env> {
  private get db(): D1Database {
    return this.env.CONSOLE_DB;
  }

  listOrgs(c: unknown) {
    return runStaff('staff.listOrgs', listOrgsInput, c, HANA_OR_SYSTEM, (i) => listOrgs(this.db, i.cursor, i.limit));
  }

  getOrg(c: unknown) {
    return runStaff('staff.getOrg', getOrgInput, c, HANA_OR_SYSTEM, async (i, w) => ({
      org: await getOrgRow(this.db, i.orgId),
      members: await membersOf(this.db, i.orgId, w.now),
      invites: await invitesOf(this.db, i.orgId),
      // Additive (D283): the live owner grants, so staff can cancel one by id from the admin console.
      grants: await grantsOf(this.db, i.orgId),
    }));
  }

  /**
   * Creates an org's first owner invite (`newOrgName`) or invites to any org. The invite is unusable until the admin
   * Worker's notice is acked (`ackMemberNotice`); the admin Worker computes and emails its token. The answer carries
   * no token and no token hash, now or later (D240).
   */
  issueInvite(c: unknown) {
    return runStaff('staff.issueInvite', issueInviteInput, c, HANA, async (i, w) => ({
      invite: await issueInvite(this.db, w, { email: i.email, role: i.role, orgId: i.orgId, newOrgName: i.newOrgName, kind: i.kind, createdByKind: 'hana' }),
    }));
  }

  revokeInvite(c: unknown) {
    return runStaff('staff.revokeInvite', revokeInviteInput, c, HANA, async (i, w) => {
      await revokeInvite(this.db, w, i.inviteId);
      return {};
    });
  }

  pendingMemberNotices(c: unknown) {
    return runStaff('staff.pendingMemberNotices', pendingMemberNoticesInput, c, HANA_OR_SYSTEM, async (i, w) => ({ notices: await pendingMemberNotices(this.db, w.now, i.limit) }));
  }

  /** Only the admin Worker's notice cron, after the email provider accepted every send of the notice. */
  ackMemberNotice(c: unknown) {
    return runStaff('staff.ackMemberNotice', ackMemberNoticeInput, c, SYSTEM, async (i, w) => {
      await ackMemberNotice(this.db, w, i, () => ownerGrantDelayMs(this.env));
      return {};
    });
  }

  cancelOwnerGrant(c: unknown) {
    return runStaff('staff.cancelOwnerGrant', cancelOwnerGrantInput, c, HANA, async (i, w) => {
      await cancelOwnerGrant(this.db, w, i.grantId);
      return {};
    });
  }

  listMembers(c: unknown) {
    return runStaff('staff.listMembers', listMembersInput, c, HANA_OR_SYSTEM, async (i, w) => {
      await getOrgRow(this.db, i.orgId);
      return { members: await membersOf(this.db, i.orgId, w.now) };
    });
  }

  setMember(c: unknown) {
    return runStaff('staff.setMember', setMemberInput, c, HANA, async (i, w) => {
      await setMember(this.db, w, { orgId: i.orgId, userId: i.userId, role: i.role });
      return {};
    });
  }

  disableUser(c: unknown) {
    return runStaff('staff.disableUser', disableUserInput, c, HANA, async (i, w) => {
      await disableUser(this.db, w, i.userId, i.disabled);
      return {};
    });
  }

  freezeOrg(c: unknown) {
    return runStaff('staff.freezeOrg', freezeOrgInput, c, HANA, async (i, w) => {
      await freezeOrg(this.db, w, i.orgId, i.frozen);
      return {};
    });
  }

  /** The admin Worker's security feed (5-minute cron): rows after `seq`, oldest first. */
  auditSince(c: unknown) {
    return runStaff('staff.auditSince', auditSinceInput, c, HANA_OR_SYSTEM, async (i) => ({ rows: await auditSince(this.db, i.seq, i.limit) }));
  }

  queryAudit(c: unknown) {
    return runStaff('staff.queryAudit', queryAuditInput, c, HANA, (i) => queryAudit(this.db, i.filters, i.cursor, i.limit));
  }

  /**
   * Retention (D90): `audit_log` rows and closed owner grants older than min(before, 60 months ago), `limit` of each at
   * most. Only the admin Worker's monthly job (a `system` actor): staff never purge by hand.
   */
  purgeAudit(c: unknown) {
    return runStaff('staff.purgeAudit', purgeAuditInput, c, SYSTEM, (i) => purgeAudit(this.db, i));
  }

  /**
   * The audit row of a staff act the admin Worker did on its own (a statement issued, a ledger export, a rate
   * override; D327; a Support ID lookup, org-less, C15). Idempotent on (request id, action): a repeat is
   * `already_applied` and writes nothing.
   */
  recordStaffAction(c: unknown) {
    return runStaff('staff.recordStaffAction', recordStaffActionInput, c, HANA, async (i, w) => {
      const allowed: readonly string[] = AUDIT_DETAIL_KEYS[i.action];
      const extra = Object.keys(i.details).find((k) => !allowed.includes(k));
      if (extra) throw new RpcRefusal('bad_request', `details.${extra} is not recorded for ${i.action}`);
      // A Support ID lookup is about an end user, not an org's act: never an org's row, so no partner's audit view or
      // feed group can show it (C15, D386).
      if (i.action === 'support.lookup' && i.orgId !== undefined) throw new RpcRefusal('bad_request', 'support.lookup is recorded without an org');
      try {
        await auditInsert(this.db, entry(w, i.action, { orgId: i.orgId ?? null, target: i.target ?? null, details: i.details })).run();
      } catch (err) {
        if (/UNIQUE/u.test(err instanceof Error ? err.message : String(err))) throw new RpcRefusal('already_applied', 'This act is already recorded');
        throw err;
      }
      return {};
    });
  }
}
