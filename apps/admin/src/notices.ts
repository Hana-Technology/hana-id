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
//   label_pending   AdminRpc.labelNotices → the security alias and every security contact → AdminRpc.ackLabelNotice
//                   (D894: a request labels version's clock starts at the ack). Token: as change_pending's, of its `lc_` id.
//   platform_key    AdminRpc.platformKeyNotices (D918) → the alias, every security contact and every owner of the org
//                   (StaffRpc.listMembers), naming who registered, accepted and confirmed the key → the ack of its kind:
//                   the announcement (ackPlatformKeyNotice: the key's wait starts, or an accepted staff key works now),
//                   an owner's confirmation (ackPlatformKeyConfirmNotice), a stop or expiry, an expiry warning. Tokens:
//                   HMAC(CANCEL_LINK_KEY, "hana-id/platform-key-cancel/v1" ‖ id) and "…/platform-key-revoke/v1" ‖ id.
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
import { mailLabel } from './env.ts';
import { changePending, inviteLink, inviteNotice, labelsProposed, ownerGrantNotice, type MailContext } from './email/messages.ts';
import { type KeyPeople, platformKeyConfirmed, platformKeyExpiring, platformKeyRegistered, platformKeyStopped } from './email/platform-messages.ts';
import type { MemberView, PlatformKeyNotice } from '@hana-id/console-core';
import { consoleLink } from './email/render.ts';
import type { EmailSender } from './email/sender.ts';
import { errorName, log } from './log.ts';
import { type Budget, linkKey, meteredEnv, recipients, sendToAll } from './mail.ts';
import { systemCtx } from './rpc.ts';

/** Notices read per run and kind (the budget usually ends a run first). */
export const NOTICE_PAGE = 20;
/** A platform key notice failing this many times in a row is reported at error level as stuck. */
export const STUCK_AFTER = 12;

export interface StepResult {
  acked: number;
  failed: number;
  skipped: number;
}

const delay = (raw: string | undefined, fallback: number): number => {
  const v = Number(raw);
  return Number.isSafeInteger(v) && v > 0 ? v : fallback;
};

const mailContext = (env: Env): MailContext => ({ env: env.ENV_NAME, consoleOrigin: env.CONSOLE_ORIGIN, label: mailLabel(env), filesOrigin: env.FILES_ORIGIN });

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

/**
 * `label_pending` (D894): AdminRpc.labelNotices → the security alias and the org's security contacts, one message each
 * (what users would see, what changes, the wait, the cancel link) → AdminRpc.ackLabelNotice with sha256 of the link's
 * token, only after every send was accepted (the version's clock starts at the ack). The link is the console's cancel
 * page for the version's `lc_` id; its token is HMAC(CANCEL_LINK_KEY, "hana-id/cancel-link/v1" ‖ id), as a guarded
 * change's. The same budget rules as `runChangeNotices`: a notice is started only with room for every email and its ack.
 */
export async function runLabelNotices(rawEnv: Env, sender: EmailSender, budget: Budget): Promise<StepResult> {
  const out: StepResult = { acked: 0, failed: 0, skipped: 0 };
  const env = meteredEnv(rawEnv, budget);
  const key = linkKey(env.CANCEL_LINK_KEY);
  if (!key) {
    log({ event: 'notice', step: 'label_pending', outcome: 'skipped', code: 'cancel_link_key_missing' }, 'error');
    return out;
  }
  if (!budget.fits(PAGE_AND_ONE, 2)) {
    noRoom('label_pending');
    return out;
  }
  const page = await env.API.labelNotices({ ...systemCtx(), limit: NOTICE_PAGE });
  if (!page.ok) {
    log({ event: 'notice', step: 'label_pending', outcome: 'error', code: page.code }, 'error');
    return out;
  }
  const delayMs = delay(env.APP_CHANGE_DELAY_MS, 86_400_000);
  const orgs = new OrgLookups(env);
  for (const n of page.notices) {
    const id = n.change.id;
    const orgId = n.change.orgId;
    const token = await linkToken('cancelLink', key, id);
    const to = recipients(env.SECURITY_ALIAS, n.contacts);
    // The org's name (one RPC, once a run), every recipient's email and the ack, or the notice waits whole for the
    // next run (D280, D380).
    const lookup = orgs.nameUncached(orgId) ? 1 : 0;
    if (!budget.fits(lookup + to.length + 1, lookup + 1)) {
      out.skipped++;
      break;
    }
    const orgName = await orgs.name(orgId);
    let message;
    try {
      message = labelsProposed(mailContext(env), n, { cancelUrl: consoleLink(env.CONSOLE_ORIGIN, `/cancel/${encodeURIComponent(id)}#t=${b64url(token)}`), delayMs, orgName });
    } catch (err) {
      // A view this Worker can't put in words (a bad time, say): nothing sent, nothing acked; the next run tries again.
      out.failed++;
      log({ event: 'notice', step: 'label_pending', target: id, orgId, outcome: 'error', code: 'render_failed', error: errorName(err) }, 'error');
      continue;
    }
    const sent = await sendToAll(sender, budget, to, message, `label_pending:${id}`);
    if (sent.outOfBudget) {
      out.skipped++;
      break;
    }
    if (!sent.allAccepted) {
      out.failed++;
      log({ event: 'notice', step: 'label_pending', target: id, orgId, outcome: 'rejected', code: 'send_failed', sent: sent.sent, failed: sent.failed }, 'warn');
      continue;
    }
    const ack = await env.API.ackLabelNotice({ ...systemCtx(), changeId: id, cancelTokenHash: b64url(await linkTokenHash(token)) });
    if (ack.ok) {
      out.acked++;
      log({ event: 'notice', step: 'label_pending', target: id, orgId, outcome: 'ok', sent: sent.sent });
    } else {
      out.failed++;
      log({ event: 'notice', step: 'label_pending', target: id, orgId, outcome: 'rejected', code: ack.code }, 'warn');
    }
  }
  return out;
}

/** Per-run lookups the member notices need: an org's name and security contacts (read once per run and org). */
class OrgLookups {
  private readonly names = new Map<string, string | undefined>();
  private readonly contacts = new Map<string, string[] | null>();
  constructor(private readonly env: Env) {}

  /** Whether `name` would still make its RPC for the org (it is read once a run). */
  nameUncached(orgId: string | undefined): boolean {
    return !!orgId && !this.names.has(orgId);
  }

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

/**
 * Who a key's notice names, from the org's own current members only (StaffRpc.listMembers of that org): a member by
 * their address, staff by theirs, and anyone no longer a member as "a former member" (their address isn't looked up).
 */
function peopleFor(n: PlatformKeyNotice, members: MemberView[], orgName: string | undefined): KeyPeople {
  const email = (id: string | undefined): string | undefined => (id === undefined ? undefined : members.find((m) => m.userId === id)?.email);
  const k = n.key;
  const staffWords = (e: string | undefined, id: string) => `Journear staff (${e ?? id})`;
  return {
    orgName,
    registeredBy: k.proposedByKind === 'hana' ? staffWords(k.proposedByEmail, k.proposedBy) : (email(k.proposedBy) ?? 'a former member'),
    ...(k.acceptedByKind ? { acceptedBy: k.acceptedByKind === 'hana' ? staffWords(k.acceptedByEmail, k.acceptedBy!) : (email(k.acceptedBy) ?? 'a former member') } : {}),
    ...(k.confirmedBy ? { confirmedBy: email(k.confirmedBy) ?? 'a former member' } : {}),
  };
}

/**
 * `platform_key` (D918): AdminRpc.platformKeyNotices → for each, the org's name and members (owners' addresses and the
 * people the key names: two console RPCs, once a run and org), one message to the alias, every security contact and
 * every owner, then its ack only after every send was accepted. The budget rules of the other steps: a notice starts
 * only with room for its lookups, every email and its ack.
 */
export async function runPlatformKeyNotices(rawEnv: Env, sender: EmailSender, budget: Budget): Promise<StepResult> {
  const out: StepResult = { acked: 0, failed: 0, skipped: 0 };
  const env = meteredEnv(rawEnv, budget);
  const key = linkKey(env.CANCEL_LINK_KEY);
  if (!key) {
    log({ event: 'notice', step: 'platform_key', outcome: 'skipped', code: 'cancel_link_key_missing' }, 'error');
    return out;
  }
  if (!budget.fits(PAGE_AND_ONE, 2)) {
    noRoom('platform_key');
    return out;
  }
  const page = await env.API.platformKeyNotices({ ...systemCtx(), limit: NOTICE_PAGE });
  if (!page.ok) {
    // An API before D918 has no such method: the step does nothing (the other steps are unaffected).
    log({ event: 'notice', step: 'platform_key', outcome: 'error', code: page.code }, page.code === 'not_found' ? 'warn' : 'error');
    return out;
  }
  const orgs = new OrgLookups(env);
  const members = new Map<string, MemberView[] | null>();
  const ctx = mailContext(env);
  /**
   * A notice that couldn't go out this run (its owners unreadable, its email not rendered, a recipient refused): recorded,
   * so the page retries it later and after every other notice (none can hold the page back); from the 12th failure in
   * a row it is reported at error level as stuck (D918 after PR 149's review and the second review).
   */
  const noteFailure = async (n: PlatformKeyNotice, code: string, f: Record<string, unknown> = {}, level: 'warn' | 'error' = 'warn') => {
    out.failed++;
    const { id, orgId } = n.key;
    const noted = budget.fits(1, 1) ? await env.API.notePlatformKeyNoticeFailure({ ...systemCtx(), keyId: id }).catch(() => null) : null;
    const failures = noted?.ok ? noted.failures : (n.failures ?? 0) + 1;
    const stuck = failures >= STUCK_AFTER;
    log({ event: 'notice', step: 'platform_key', target: id, orgId, outcome: 'rejected', code: stuck ? 'notice_stuck' : code, count: failures, ...f, ...(stuck ? { error: code } : {}) }, stuck ? 'error' : level);
  };
  for (const n of page.notices) {
    const id = n.key.id;
    const orgId = n.key.orgId;
    const lookups = (orgs.nameUncached(orgId) ? 1 : 0) + (members.has(orgId) ? 0 : 1);
    if (!budget.fits(lookups + 2, lookups + 1)) {
      out.skipped++;
      break;
    }
    if (!members.has(orgId)) {
      const r = await env.CONSOLE.listMembers({ ...systemCtx(), orgId }).catch(() => null);
      members.set(orgId, r?.ok ? r.members : null);
    }
    const list = members.get(orgId);
    if (!list) {
      // Without the owners the notice would miss people it must reach (N9): it waits, recorded as a failure.
      await noteFailure(n, 'owners_unavailable');
      continue;
    }
    const orgName = await orgs.name(orgId);
    const owners = list.filter((m) => m.role === 'owner' && !m.disabled).map((m) => m.email);
    const to = recipients(env.SECURITY_ALIAS, n.contacts, owners);
    if (!budget.fits(to.length + 1, 1)) {
      out.skipped++;
      break;
    }
    const people = peopleFor(n, list, orgName);
    // The stop notice names the org's other waiting keys; each announced one with its own cancel link (deterministic,
    // as its announcement's: HMAC(CANCEL_LINK_KEY, "hana-id/platform-key-cancel/v1" ‖ id)), so a security contact who
    // isn't a console member can cancel it too.
    const waitingLinks: Record<string, string> = {};
    for (const wk of n.waitingKeys ?? []) {
      if (wk.announced) waitingLinks[wk.id] = consoleLink(env.CONSOLE_ORIGIN, `/cancel-platform-key/${encodeURIComponent(wk.id)}#t=${b64url(await linkToken('platformKeyCancel', key, wk.id))}`);
    }
    const cancelToken = await linkToken('platformKeyCancel', key, id);
    const revokeToken = await linkToken('platformKeyRevoke', key, id);
    const cancelUrl = consoleLink(env.CONSOLE_ORIGIN, `/cancel-platform-key/${encodeURIComponent(id)}#t=${b64url(cancelToken)}`);
    const revokeUrl = consoleLink(env.CONSOLE_ORIGIN, `/revoke-platform-key/${encodeURIComponent(id)}#t=${b64url(revokeToken)}`);
    const confirmUrl = consoleLink(env.CONSOLE_ORIGIN, `/confirm-platform-key/${encodeURIComponent(id)}`);
    let message;
    try {
      message =
        n.kind === 'announce'
          ? platformKeyRegistered(ctx, n, people, { now: Date.now(), cancelUrl, confirmUrl, ...(n.inForceAtOnce ? { revokeUrl } : {}) })
          : n.kind === 'confirmed'
            ? platformKeyConfirmed(ctx, n, people, { revokeUrl })
            : n.kind === 'ended'
              ? platformKeyStopped(ctx, n, people, { waitingLinks })
              : platformKeyExpiring(ctx, n, people);
    } catch (err) {
      await noteFailure(n, 'render_failed', { error: errorName(err) }, 'error');
      continue;
    }
    const sent = await sendToAll(sender, budget, to, message, `platform_key_${n.kind}:${id}${n.kind === 'expiring' ? `:${n.stage}` : ''}`);
    if (sent.outOfBudget) {
      out.skipped++;
      break;
    }
    if (!sent.allAccepted) {
      await noteFailure(n, 'send_failed', { sent: sent.sent, failed: sent.failed });
      continue;
    }
    const base = { ...systemCtx(), keyId: id };
    const ack =
      n.kind === 'announce'
        ? await env.API.ackPlatformKeyNotice({ ...base, cancelTokenHash: b64url(await linkTokenHash(cancelToken)), ...(n.inForceAtOnce ? { revokeTokenHash: b64url(await linkTokenHash(revokeToken)) } : {}) })
        : n.kind === 'confirmed'
          ? await env.API.ackPlatformKeyConfirmNotice({ ...base, revokeTokenHash: b64url(await linkTokenHash(revokeToken)) })
          : n.kind === 'ended'
            ? await env.API.ackPlatformKeyEndNotice(base)
            : await env.API.ackPlatformKeyExpiryNotice({ ...base, stage: n.stage ?? 30 });
    if (ack.ok) {
      out.acked++;
      log({ event: 'notice', step: 'platform_key', target: id, orgId, outcome: 'ok', sent: sent.sent });
    } else {
      out.failed++;
      log({ event: 'notice', step: 'platform_key', target: id, orgId, outcome: 'rejected', code: ack.code }, 'warn');
    }
  }
  return out;
}

/**
 * The blocking steps, each on its own (a console outage doesn't hold back the guarded changes' notices; an API older
 * than the request labels, D894, fails only their step).
 */
export async function runNotices(env: Env, sender: EmailSender, budget: Budget): Promise<{ changes: StepResult | null; labels: StepResult | null; members: StepResult | null; platformKeys: StepResult | null }> {
  let changes: StepResult | null = null;
  let labels: StepResult | null = null;
  let members: StepResult | null = null;
  let platformKeys: StepResult | null = null;
  try {
    changes = await runChangeNotices(env, sender, budget);
  } catch (err) {
    log({ event: 'notice', step: 'change_pending', outcome: 'error', error: errorName(err) }, 'error');
  }
  try {
    labels = await runLabelNotices(env, sender, budget);
  } catch (err) {
    log({ event: 'notice', step: 'label_pending', outcome: 'error', error: errorName(err) }, 'error');
  }
  try {
    members = await runMemberNotices(env, sender, budget);
  } catch (err) {
    log({ event: 'notice', step: 'member', outcome: 'error', error: errorName(err) }, 'error');
  }
  try {
    platformKeys = await runPlatformKeyNotices(env, sender, budget);
  } catch (err) {
    log({ event: 'notice', step: 'platform_key', outcome: 'error', error: errorName(err) }, 'error');
  }
  return { changes, labels, members, platformKeys };
}
