// The blocking notices (docs/batch-c-spec.md "Email", "Notice and cancel", "Invites and owner grants"; D279): the
// 5-minute cron reads what is pending, computes each link token from this Worker's keys, emails every recipient one
// message each, and only after the provider accepted every one of them acks the notice with sha256(token):
//
//   change_pending  AdminRpc.pendingNotices → the security alias and every security contact → AdminRpc.ackNotice
//                   (the change's clock starts at the ack). Token: HMAC(CANCEL_LINK_KEY, "hana-id/cancel-link/v1" ‖ id).
//                   A platform request's web addresses (D930, L14) go as one email listing each with its own link, then
//                   one ack each; the email states the wait the ack gives (`platform.waitMs`) and no waiver. D931: that
//                   email, and the one for a staff request under four eyes (`secondPerson`, grouped the same way), also
//                   go to every owner of the org (StaffRpc.listMembers) and carry the Confirm link (it only opens the
//                   partner portal's page: `/confirm/<the request's first change>`).
//   origin_confirmed AdminRpc.confirmationNotices (D931) → AdminRpc.armConfirmationLinks with each removal link's
//                   sha256 (valid 7 days, from before the first send) → the alias, every security contact and every
//                   owner, naming who confirmed (and, for a staff proposal, that staff added them) →
//                   AdminRpc.ackConfirmationNotice once every send was accepted; any failure noted
//                   (noteConfirmationNoticeFailure: retried with a back-off until 7 days after the confirmation;
//                   `notice_stuck` logged from 24 failures, `notice_not_sent` once the 7 days end, on every run). Token: HMAC(CANCEL_LINK_KEY, "hana-id/origin-remove/v1" ‖ id).
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
import { CONFIRM_NOTICE_STUCK_FAILURES, b64url, linkToken, linkTokenHash } from '@hana-id/console-core';
import type { MemberNotice } from '@hana-id/console-core';
import type { ChangeNotice, Env } from './env.ts';
import { mailLabel } from './env.ts';
import { changePending, inviteLink, inviteNotice, labelsProposed, ownerGrantNotice, type MailContext } from './email/messages.ts';
import { type KeyPeople, originsConfirmed, platformKeyConfirmed, platformKeyExpiring, platformKeyRegistered, platformKeyStopped, platformOriginsProposed, secondPersonOriginsProposed } from './email/platform-messages.ts';
import type { ConfirmationNotice, MemberView, PlatformKeyNotice } from '@hana-id/console-core';
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
  const notices = page.notices as ChangeNotice[];
  const orgs = new OrgLookups(env);
  for (let i = 0; i < notices.length; ) {
    const n = notices[i]!;
    if (requestKey(n)) {
      // D930 (L14): one email for every web address one platform request asked for on one app (the page lists them
      // together); D931: a staff request under four eyes the same way. A request that reaches the end of a full page
      // may go on past it: the page is read again, wider by one request's most (MAX_ORIGINS_PER_REQUEST), from the
      // same start, and the request taken whole from there (after PR 158's review: otherwise one stuck older notice
      // ahead of a 20-address request held it back on every run). Only a request still cut off after that, or no room
      // for the read, waits; each such skip is logged.
      let group = requestGroup(notices, i);
      if (i + group.length === notices.length && notices.length >= NOTICE_PAGE && i > 0) {
        const whole = await wholeRequest(env, budget, n);
        if (!whole) {
          out.skipped += group.length;
          log({ event: 'notice', step: 'change_pending', target: groupRequestId(n), orgId: n.app.orgId, outcome: 'skipped', code: 'request_cut', count: group.length }, 'warn');
          break;
        }
        group = whole;
      }
      i += group.length;
      const r = await sendRequestGroup(env, sender, budget, key, orgs, group);
      out.acked += r.acked;
      out.failed += r.failed;
      out.skipped += r.skipped;
      if (r.stop) break;
      continue;
    }
    i++;
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

/** The most web addresses one platform or staff request names (a create or a proposal: at most 20, `MAX_APP_ORIGINS`). */
export const MAX_ORIGINS_PER_REQUEST = 20;

/** The request a notice is emailed with (a platform proposal, or a staff one under four eyes), or null for one alone. */
const requestKey = (n: ChangeNotice): string | null => (n.platform ? `platform:${n.platform.requestId}` : n.secondPerson ? `staff:${n.secondPerson.requestId}` : null);
const groupRequestId = (n: ChangeNotice): string => n.platform?.requestId ?? n.secondPerson?.requestId ?? n.change.id;

/**
 * The whole of `first`'s request, from a page read again wider by one request's most from the same start (the page
 * orders by proposal time, then request: rows ahead of the request can only have left it), or null when there is no
 * room for the read, it fails, or the request still reaches the end of the wider page.
 */
async function wholeRequest(env: Env, budget: Budget, first: ChangeNotice): Promise<ChangeNotice[] | null> {
  if (!budget.fits(1, 1)) return null;
  const limit = NOTICE_PAGE + MAX_ORIGINS_PER_REQUEST;
  const page = await env.API.pendingNotices({ ...systemCtx(), limit }).catch(() => null);
  if (!page?.ok) return null;
  const wide = page.notices as ChangeNotice[];
  const at = wide.findIndex((x) => x.change.id === first.change.id);
  if (at < 0) return null;
  const group = requestGroup(wide, at);
  return at + group.length === wide.length && wide.length >= limit ? null : group;
}

/**
 * The proposals from `i` on that one request made on one app (consecutive on the page: it orders by request): a
 * platform request's (D930), or a staff request's under four eyes (D931), never the two mixed.
 */
export function requestGroup(notices: readonly ChangeNotice[], i: number): ChangeNotice[] {
  const first = notices[i]!;
  const key = requestKey(first);
  const group = [first];
  if (!key) return group;
  for (let j = i + 1; j < notices.length; j++) {
    const n = notices[j]!;
    if (requestKey(n) !== key || n.app.id !== first.app.id) break;
    group.push(n);
  }
  return group;
}

/** The owners' addresses of an org's members (an owner in force, not disabled), as the key notices reach them. */
const ownerEmails = (members: readonly MemberView[]): string[] => members.filter((m) => m.role === 'owner' && !m.disabled).map((m) => m.email);

/**
 * One request's email (D930; D931): every recipient once (the alias, every security contact, every owner), then each
 * change's ack with its own link's hash. Fails closed as the single notice does: no ack unless every send was accepted
 * (and the owners were read); an ack refused leaves that change for the next run (whose email then lists only what is
 * still unannounced). `stop`: the budget ran out, the run ends here.
 */
async function sendRequestGroup(env: Env, sender: EmailSender, budget: Budget, key: Uint8Array, orgs: OrgLookups, group: ChangeNotice[]): Promise<StepResult & { stop: boolean }> {
  const out = { acked: 0, failed: 0, skipped: 0, stop: false };
  const first = group[0]!;
  const target = groupRequestId(first);
  const orgId = first.app.orgId;
  // The org's members (one RPC, once a run and org), at least one email and one ack; then every email and every ack.
  const lookup = orgs.membersUncached(orgId) ? 1 : 0;
  if (!budget.fits(lookup + 2, lookup + 1)) return { ...out, skipped: group.length, stop: true };
  const members = await orgs.members(orgId);
  if (!members) {
    // Without the owners the email would miss people it must reach: nothing is sent or acked; the next run tries again.
    log({ event: 'notice', step: 'change_pending', target, orgId, outcome: 'rejected', code: 'owners_unavailable', count: group.length }, 'warn');
    return { ...out, failed: group.length };
  }
  const to = recipients(env.SECURITY_ALIAS, first.contacts, ownerEmails(members));
  if (!budget.fits(to.length + group.length, group.length)) return { ...out, skipped: group.length, stop: true };
  const tokens = await Promise.all(group.map((n) => linkToken('cancelLink', key, n.change.id)));
  const lines = group.map((n, k) => ({
    changeId: n.change.id,
    origin: n.change.origin ?? '',
    display: n.change.display,
    idn: n.change.idn,
    cancelUrl: consoleLink(env.CONSOLE_ORIGIN, `/cancel/${encodeURIComponent(n.change.id)}#t=${b64url(tokens[k]!)}`),
  }));
  // D931: the Confirm link only opens the partner portal's page for the request (its first change); a GET confirms nothing.
  const confirmUrl = consoleLink(env.CONSOLE_ORIGIN, `/confirm/${encodeURIComponent(first.change.id)}`);
  let message;
  try {
    const p = first.platform;
    message = p
      ? platformOriginsProposed(
          mailContext(env),
          { app: first.app, keyId: p.keyId, keyLabel: p.keyLabel, proposedAt: first.change.proposedAt, requestCountry: first.change.requestCountry, waitMs: Math.max(...group.map((n) => n.platform!.waitMs)) },
          lines,
          { now: Date.now(), confirmUrl },
        )
      : secondPersonOriginsProposed(
          mailContext(env),
          { app: first.app, proposedBy: first.change.proposedBy, proposedAt: first.change.proposedAt, requestCountry: first.change.requestCountry, waitMs: Math.max(...group.map((n) => n.secondPerson!.waitMs)) },
          lines,
          { now: Date.now(), confirmUrl },
        );
  } catch (err) {
    log({ event: 'notice', step: 'change_pending', target, orgId, outcome: 'error', code: 'render_failed', error: errorName(err) }, 'error');
    return { ...out, failed: group.length };
  }
  const sent = await sendToAll(sender, budget, to, message, `change_pending:${target}:${group.map((n) => n.change.id).join(',')}`);
  if (sent.outOfBudget) return { ...out, skipped: group.length, stop: true };
  if (!sent.allAccepted) {
    log({ event: 'notice', step: 'change_pending', target, orgId, outcome: 'rejected', code: 'send_failed', sent: sent.sent, failed: sent.failed, count: group.length }, 'warn');
    return { ...out, failed: group.length };
  }
  for (const [k, n] of group.entries()) {
    const ack = await env.API.ackNotice({ ...systemCtx(), changeId: n.change.id, cancelTokenHash: b64url(await linkTokenHash(tokens[k]!)) }).catch(() => null);
    if (ack?.ok) {
      out.acked++;
      log({ event: 'notice', step: 'change_pending', target: n.change.id, orgId: n.app.orgId, outcome: 'ok', sent: sent.sent });
    } else {
      out.failed++;
      log({ event: 'notice', step: 'change_pending', target: n.change.id, orgId: n.app.orgId, outcome: 'rejected', code: ack?.code ?? 'upstream_unavailable' }, 'warn');
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
  private readonly memberLists = new Map<string, MemberView[] | null>();
  constructor(private readonly env: Env) {}

  /** Whether `members` would still make its RPC for the org (it is read once a run). */
  membersUncached(orgId: string): boolean {
    return !this.memberLists.has(orgId);
  }

  /**
   * The org's current members (StaffRpc.listMembers); [] for an org the console doesn't know (no members, so no owner);
   * null when they can't be read (then the org's notice that reaches its owners waits for the next run).
   */
  async members(orgId: string): Promise<MemberView[] | null> {
    if (!this.memberLists.has(orgId)) {
      const r = await this.env.CONSOLE.listMembers({ ...systemCtx(), orgId }).catch(() => null);
      this.memberLists.set(orgId, r?.ok ? r.members : r && r.code === 'not_found' ? [] : null);
    }
    return this.memberLists.get(orgId)!;
  }

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
 * Who confirmed, in the confirmation's notice (D931): a member by their address from the org's current members only
 * ("a former member" otherwise, never looked up elsewhere), as the key notices name people; staff as "Journear staff".
 */
const confirmerWords = (n: ConfirmationNotice, members: readonly MemberView[]): string =>
  n.confirmedByKind === 'hana' ? 'A second Journear staff member' : (members.find((m) => m.userId === n.confirmedBy)?.email ?? 'a former member');

/**
 * `origin_confirmed` (D931): AdminRpc.confirmationNotices → for each confirmation, the org's members (one console RPC,
 * once a run and org), its removal links armed (AdminRpc.armConfirmationLinks: each link's sha256, 7 days, before the
 * first send, so a link that reached anyone works), one message to the alias, every security contact and every owner,
 * with one removal link per web address → AdminRpc.ackConfirmationNotice once every send was accepted. The token is
 * HMAC(CANCEL_LINK_KEY, "hana-id/origin-remove/v1" ‖ change id): a retry sends the same links. The budget rules of the
 * other steps: a notice starts only with room for its lookup, the arming, every email and its ack. Any failure (its
 * owners unreadable, its email not rendered, the arming refused, a send refused) is noted with the API
 * (noteConfirmationNoticeFailure), which offers it again later (5 minutes more each time, at most an hour) until 7 days
 * after the confirmation (after PR 159's third review). From the API's stored counts, on every run: `notice_stuck`
 * (error) while one has failed 24 times or more and still retries, `notice_not_sent` (error) for one whose 7 days ended.
 */
export async function runConfirmationNotices(rawEnv: Env, sender: EmailSender, budget: Budget): Promise<StepResult> {
  const out: StepResult = { acked: 0, failed: 0, skipped: 0 };
  const env = meteredEnv(rawEnv, budget);
  const key = linkKey(env.CANCEL_LINK_KEY);
  if (!key) {
    log({ event: 'notice', step: 'origin_confirmed', outcome: 'skipped', code: 'cancel_link_key_missing' }, 'error');
    return out;
  }
  if (!budget.fits(PAGE_AND_ONE, 2)) {
    noRoom('origin_confirmed');
    return out;
  }
  const page = await env.API.confirmationNotices({ ...systemCtx(), limit: NOTICE_PAGE });
  if (!page.ok) {
    // An API before D931 has no such method: the step does nothing (the other steps are unaffected).
    log({ event: 'notice', step: 'origin_confirmed', outcome: 'error', code: page.code }, page.code === 'not_found' ? 'warn' : 'error');
    return out;
  }
  // After PR 159's reviews: on every run, the notices still failing after CONFIRM_NOTICE_STUCK_FAILURES runs, and those
  // whose 7 days of retries ended without them (`notSent`, for 7 days more).
  if (page.stuck > 0) log({ event: 'notice', step: 'origin_confirmed', outcome: 'rejected', code: 'notice_stuck', count: page.stuck }, 'error');
  if (page.notSent > 0) log({ event: 'notice', step: 'origin_confirmed', outcome: 'rejected', code: 'notice_not_sent', count: page.notSent }, 'error');
  const orgs = new OrgLookups(env);
  const ctx = mailContext(env);
  /** Notes a failed run with the API (so it backs off), and logs it; `notice_stuck` from CONFIRM_NOTICE_STUCK_FAILURES on. */
  const failed = async (target: string, orgId: string, code: string, extra: Record<string, string | number> = {}) => {
    out.failed++;
    const noted = budget.fits(0, 1) ? await env.API.noteConfirmationNoticeFailure({ ...systemCtx(), requestId: target }).catch(() => null) : null;
    const failures = noted?.ok ? noted.failures : null;
    const stuck = failures !== null && failures >= CONFIRM_NOTICE_STUCK_FAILURES;
    log({ event: 'notice', step: 'origin_confirmed', target, orgId, outcome: 'rejected', code: stuck ? 'notice_stuck' : code, ...extra, ...(failures !== null ? { count: failures } : {}), ...(stuck ? { error: code } : {}) }, stuck ? 'error' : 'warn');
  };
  for (const n of page.notices) {
    const target = n.requestId;
    const orgId = n.app.orgId;
    const lookup = orgs.membersUncached(orgId) ? 1 : 0;
    if (!budget.fits(lookup + 2, lookup + 1)) {
      out.skipped++;
      break;
    }
    const members = await orgs.members(orgId);
    if (!members) {
      await failed(target, orgId, 'owners_unavailable');
      continue;
    }
    const to = recipients(env.SECURITY_ALIAS, n.contacts, ownerEmails(members));
    if (!budget.fits(to.length + 1, 1)) {
      out.skipped++;
      break;
    }
    const tokens = await Promise.all(n.changes.map((ch) => linkToken('originRemove', key, ch.changeId)));
    let message;
    try {
      message = originsConfirmed(
        ctx,
        n,
        n.changes.map((ch, k) => ({ ...ch, removeUrl: consoleLink(env.CONSOLE_ORIGIN, `/remove/${encodeURIComponent(ch.changeId)}#t=${b64url(tokens[k]!)}`) })),
        { confirmedBy: confirmerWords(n, members) },
      );
    } catch (err) {
      log({ event: 'notice', step: 'origin_confirmed', target, orgId, outcome: 'error', code: 'render_failed', error: errorName(err) }, 'error');
      await failed(target, orgId, 'render_failed');
      continue;
    }
    // After PR 159's review: the removal links are armed before the first send (written once; the same deterministic
    // hashes again on a retry change nothing), so a link that reached anyone works even if another recipient refuses.
    const removals = await Promise.all(n.changes.map(async (ch, k) => ({ changeId: ch.changeId, removalTokenHash: b64url(await linkTokenHash(tokens[k]!)) })));
    if (!budget.fits(to.length + 2, 2)) {
      out.skipped++;
      break;
    }
    const armed = await env.API.armConfirmationLinks({ ...systemCtx(), requestId: target, removals }).catch(() => null);
    if (!armed?.ok) {
      await failed(target, orgId, armed?.code ?? 'upstream_unavailable', { method: 'armConfirmationLinks' });
      continue;
    }
    // A recipient already accepted isn't sent it again by this isolate (mail.ts's memo); the durable bound is the API's:
    // a refused run is noted and retried later (5 minutes more each time, at most an hour) until 7 days after the
    // confirmation.
    const sent = await sendToAll(sender, budget, to, message, `origin_confirmed:${target}`);
    if (sent.outOfBudget) {
      out.skipped++;
      break;
    }
    if (!sent.allAccepted) {
      await failed(target, orgId, 'send_failed', { sent: sent.sent, failed: sent.failed });
      continue;
    }
    const ack = await env.API.ackConfirmationNotice({ ...systemCtx(), requestId: target }).catch(() => null);
    if (ack?.ok) {
      out.acked++;
      log({ event: 'notice', step: 'origin_confirmed', target, orgId, outcome: 'ok', sent: sent.sent, count: n.changes.length });
    } else {
      out.failed++;
      log({ event: 'notice', step: 'origin_confirmed', target, orgId, outcome: 'rejected', code: ack?.code ?? 'upstream_unavailable' }, 'warn');
    }
  }
  return out;
}

/**
 * The blocking steps, each on its own (a console outage doesn't hold back the guarded changes' notices; an API older
 * than the request labels, D894, fails only their step).
 */
export async function runNotices(
  env: Env,
  sender: EmailSender,
  budget: Budget,
): Promise<{ changes: StepResult | null; confirmations: StepResult | null; labels: StepResult | null; members: StepResult | null; platformKeys: StepResult | null }> {
  let changes: StepResult | null = null;
  let confirmations: StepResult | null = null;
  let labels: StepResult | null = null;
  let members: StepResult | null = null;
  let platformKeys: StepResult | null = null;
  try {
    changes = await runChangeNotices(env, sender, budget);
  } catch (err) {
    log({ event: 'notice', step: 'change_pending', outcome: 'error', error: errorName(err) }, 'error');
  }
  // D931: second, before the waiting things: these web addresses work already, so this email is the only warning.
  try {
    confirmations = await runConfirmationNotices(env, sender, budget);
  } catch (err) {
    log({ event: 'notice', step: 'origin_confirmed', outcome: 'error', error: errorName(err) }, 'error');
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
  return { changes, confirmations, labels, members, platformKeys };
}
