// The blocking notices (docs/batch-c-spec.md "Email", "Notice and cancel", "Invites and owner grants"; D279): the
// 5-minute cron reads what is pending, computes each link token from this Worker's keys, emails every recipient one
// message each, and only after the provider accepted every one of them acks the notice with sha256(token):
//
//   change_pending  AdminRpc.pendingNotices → the security alias and every security contact → AdminRpc.ackNotice
//                   (the change's clock starts at the ack). Token: HMAC(CANCEL_LINK_KEY, "hana-id/cancel-link/v1" ‖ id).
//   member_invite   StaffRpc.pendingMemberNotices (kind invite) → every owner, the contacts and the alias, then the
//                   invitee's link → StaffRpc.ackMemberNotice (the link works from the ack). Token: INVITE_LINK_KEY.
//   owner_grant     (kind owner_grant) → every owner, the contacts and the alias, with the cancel link → ack (a
//                   promotion's 24 h starts at the ack). Token: HMAC(CANCEL_LINK_KEY, "hana-console/owner-grant-cancel/v1" ‖ id).
//
// Fails closed: a missing key or sender, a failed or skipped send, or an unreadable recipient list means no ack; the
// next run tries again with the same token (it is deterministic, so a link from an earlier attempt works once acked).
// A token is never logged or stored here; the console and the API store only its sha256.
//
// Budget (D280, D380): every RPC (the page, an org's name and contacts, the ack) and every email is one call of the
// run's budget. A notice is started only when its lookups, every email and its ack fit what is left; otherwise it and
// the rest of the page wait whole for the next run, so a notice is never sent without the room to ack it.
import { b64url, linkToken, linkTokenHash } from '@hana-id/console-core';
import type { MemberNotice } from '@hana-id/console-core';
import type { ChangeNotice, Env } from './env.ts';
import { changePending, inviteLink, inviteNotice, ownerGrantNotice, type MailContext } from './email/messages.ts';
import { consoleLink } from './email/render.ts';
import type { EmailSender } from './email/sender.ts';
import { errorName, log } from './log.ts';
import { type Budget, linkKey, meteredEnv, recipients, sendToAll } from './mail.ts';
import { systemCtx } from './rpc.ts';

/** Notices read per run and kind (the budget usually ends a run first). */
export const NOTICE_PAGE = 20;

export interface StepResult {
  acked: number;
  failed: number;
  skipped: number;
}

const delay = (raw: string | undefined, fallback: number): number => {
  const v = Number(raw);
  return Number.isSafeInteger(v) && v > 0 ? v : fallback;
};

const mailContext = (env: Env): MailContext => ({ env: env.ENV_NAME, consoleOrigin: env.CONSOLE_ORIGIN });

/** A page read is worth it only with room for one notice after it: the page (RPC), one email and the ack (RPC). */
const PAGE_AND_ONE = 3;

/** The step's page read didn't fit the budget: nothing done, the whole step waits for the next run. */
const noRoom = (step: string): void => log({ event: 'notice', step, outcome: 'skipped', code: 'out_of_budget' }, 'warn');

export async function runChangeNotices(rawEnv: Env, sender: EmailSender, budget: Budget): Promise<StepResult> {
  const out: StepResult = { acked: 0, failed: 0, skipped: 0 };
  const env = meteredEnv(rawEnv, budget);
  const key = linkKey(env.CANCEL_LINK_KEY);
  if (!key) {
    log({ event: 'notice', step: 'change_pending', outcome: 'skipped', code: 'cancel_link_key_missing' }, 'error');
    return out;
  }
  if (!budget.fits(PAGE_AND_ONE, 2)) {
    noRoom('change_pending');
    return out;
  }
  const page = await env.API.pendingNotices({ ...systemCtx(), limit: NOTICE_PAGE });
  if (!page.ok) {
    log({ event: 'notice', step: 'change_pending', outcome: 'error', code: page.code }, 'error');
    return out;
  }
  const delayMs = delay(env.APP_CHANGE_DELAY_MS, 86_400_000);
  for (const n of page.notices as ChangeNotice[]) {
    const id = n.change.id;
    const token = await linkToken('cancelLink', key, id);
    const to = recipients(env.SECURITY_ALIAS, n.contacts);
    // Every recipient's email and the ack, or the notice waits whole for the next run (D280, D380).
    if (!budget.fits(to.length + 1, 1)) {
      out.skipped++;
      break;
    }
    const message = changePending(mailContext(env), n, { cancelUrl: consoleLink(env.CONSOLE_ORIGIN, `/cancel/${encodeURIComponent(id)}#t=${b64url(token)}`), delayMs });
    const sent = await sendToAll(sender, budget, to, message, `change_pending:${id}`);
    if (sent.outOfBudget) {
      out.skipped++;
      break;
    }
    if (!sent.allAccepted) {
      out.failed++;
      log({ event: 'notice', step: 'change_pending', target: id, orgId: n.app.orgId, outcome: 'rejected', code: 'send_failed', sent: sent.sent, failed: sent.failed }, 'warn');
      continue;
    }
    const ack = await env.API.ackNotice({ ...systemCtx(), changeId: id, cancelTokenHash: b64url(await linkTokenHash(token)) });
    if (ack.ok) {
      out.acked++;
      log({ event: 'notice', step: 'change_pending', target: id, orgId: n.app.orgId, outcome: 'ok', sent: sent.sent });
    } else {
      out.failed++;
      log({ event: 'notice', step: 'change_pending', target: id, orgId: n.app.orgId, outcome: 'rejected', code: ack.code }, 'warn');
    }
  }
  return out;
}

/** Per-run lookups the member notices need: an org's name and security contacts (read once per run and org). */
class OrgLookups {
  private readonly names = new Map<string, string | undefined>();
  private readonly contacts = new Map<string, string[] | null>();
  constructor(private readonly env: Env) {}

  /** The RPCs `name` and `securityContacts` would still make for the org (0 to 2: each is read once a run). */
  uncached(orgId: string | undefined): number {
    if (!orgId) return 0;
    return (this.names.has(orgId) ? 0 : 1) + (this.contacts.has(orgId) ? 0 : 1);
  }

  async name(orgId: string | undefined): Promise<string | undefined> {
    if (!orgId) return undefined;
    if (!this.names.has(orgId)) {
      const r = await this.env.CONSOLE.getOrg({ ...systemCtx(), orgId }).catch(() => null);
      this.names.set(orgId, r?.ok ? r.org.name : undefined);
    }
    return this.names.get(orgId);
  }

  /** The org's security contacts; null when they can't be read (then no notice of the org is sent this run). */
  async securityContacts(orgId: string | undefined): Promise<string[] | null> {
    if (!orgId) return [];
    if (!this.contacts.has(orgId)) {
      const r = await this.env.API.getSecurityContacts({ ...systemCtx(), orgId }).catch(() => null);
      this.contacts.set(orgId, r?.ok ? r.emails : r && r.code === 'not_found' ? [] : null);
    }
    return this.contacts.get(orgId)!;
  }
}

export async function runMemberNotices(rawEnv: Env, sender: EmailSender, budget: Budget): Promise<StepResult> {
  const out: StepResult = { acked: 0, failed: 0, skipped: 0 };
  const env = meteredEnv(rawEnv, budget);
  const inviteKey = linkKey(env.INVITE_LINK_KEY);
  const cancelKey = linkKey(env.CANCEL_LINK_KEY);
  if (!inviteKey || !cancelKey) {
    const missing = inviteKey ? 'cancel_link_key_missing' : 'invite_link_key_missing';
    log({ event: 'notice', step: 'member', outcome: 'skipped', code: missing }, 'error');
    return out;
  }
  if (!budget.fits(PAGE_AND_ONE, 2)) {
    noRoom('member');
    return out;
  }
  const page = await env.CONSOLE.pendingMemberNotices({ ...systemCtx(), limit: NOTICE_PAGE });
  if (!page.ok) {
    log({ event: 'notice', step: 'member', outcome: 'error', code: page.code }, 'error');
    return out;
  }
  const orgs = new OrgLookups(env);
  const ctx = mailContext(env);
  const grantDelay = delay(env.OWNER_GRANT_DELAY_MS, 86_400_000);
  for (const n of page.notices as MemberNotice[]) {
    const orgId = n.kind === 'invite' ? n.invite?.orgId : n.grant?.orgId;
    const target = n.kind === 'invite' ? n.invite?.id : n.grant?.id;
    if (!target) continue;
    // The org's lookups, at least one email and the ack; then (below) every email and the ack. A notice that doesn't
    // fit waits whole for the next run, with the rest of the page (D280, D380).
    const lookups = orgs.uncached(orgId);
    if (!budget.fits(lookups + 2, lookups + 1)) {
      out.skipped++;
      break;
    }
    const contacts = await orgs.securityContacts(orgId);
    if (contacts === null) {
      out.failed++;
      log({ event: 'notice', step: n.kind, target, ...(orgId ? { orgId } : {}), outcome: 'rejected', code: 'contacts_unavailable' }, 'warn');
      continue;
    }
    const orgName = await orgs.name(orgId);
    const to = recipients(n.owners.map((o) => o.email), contacts, env.SECURITY_ALIAS);
    if (!budget.fits(to.length + (n.kind === 'invite' ? 1 : 0) + 1, 1)) {
      out.skipped++;
      break;
    }
    let token: Uint8Array;
    let ok: boolean;
    let outOfBudget = false;
    if (n.kind === 'invite') {
      const invite = n.invite!;
      token = await linkToken('invite', inviteKey, invite.id);
      // The notice first; the invitee's link only once every notice send was accepted (a link that went out while a
      // notice failed would stay unusable anyway, since the ack waits for both).
      const notice = await sendToAll(sender, budget, to, inviteNotice(ctx, invite, { orgName }), `invite_notice:${invite.id}`);
      outOfBudget = notice.outOfBudget;
      ok = notice.allAccepted;
      if (ok) {
        const link = await sendToAll(sender, budget, [invite.email], inviteLink(ctx, invite, { orgName, inviteUrl: consoleLink(env.CONSOLE_ORIGIN, `/invite#t=${b64url(token)}`) }), `invite_link:${invite.id}`);
        outOfBudget = link.outOfBudget;
        ok = link.allAccepted;
      }
    } else {
      const grant = n.grant!;
      token = await linkToken('ownerGrantCancel', cancelKey, grant.id);
      const sent = await sendToAll(sender, budget, to, ownerGrantNotice(ctx, n, { orgName, cancelUrl: consoleLink(env.CONSOLE_ORIGIN, `/cancel-owner/${encodeURIComponent(grant.id)}#t=${b64url(token)}`), delayMs: grantDelay }), `owner_grant:${grant.id}`);
      outOfBudget = sent.outOfBudget;
      ok = sent.allAccepted;
    }
    if (outOfBudget) {
      out.skipped++;
      break;
    }
    if (!ok) {
      out.failed++;
      log({ event: 'notice', step: n.kind, target, ...(orgId ? { orgId } : {}), outcome: 'rejected', code: 'send_failed' }, 'warn');
      continue;
    }
    const tokenHash = b64url(await linkTokenHash(token));
    const ack = await env.CONSOLE.ackMemberNotice({ ...systemCtx(), ...(n.kind === 'invite' ? { inviteId: target } : { grantId: target }), tokenHash });
    if (ack.ok) {
      out.acked++;
      log({ event: 'notice', step: n.kind, target, ...(orgId ? { orgId } : {}), outcome: 'ok' });
    } else {
      out.failed++;
      log({ event: 'notice', step: n.kind, target, ...(orgId ? { orgId } : {}), outcome: 'rejected', code: ack.code }, 'warn');
    }
  }
  return out;
}

/** Both blocking steps, each on its own (a console outage doesn't hold back the guarded changes' notices). */
export async function runNotices(env: Env, sender: EmailSender, budget: Budget): Promise<{ changes: StepResult | null; members: StepResult | null }> {
  let changes: StepResult | null = null;
  let members: StepResult | null = null;
  try {
    changes = await runChangeNotices(env, sender, budget);
  } catch (err) {
    log({ event: 'notice', step: 'change_pending', outcome: 'error', error: errorName(err) }, 'error');
  }
  try {
    members = await runMemberNotices(env, sender, budget);
  } catch (err) {
    log({ event: 'notice', step: 'member', outcome: 'error', error: errorName(err) }, 'error');
  }
  return { changes, members };
}
