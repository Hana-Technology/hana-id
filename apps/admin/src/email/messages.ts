// What every email says (docs/batch-c-spec.md "Email", "Notice and cancel", "Invites and owner grants", "On-chain
// owner actions"). Builders only: who gets each message and when it is sent is notices.ts, feed.ts and watcher.ts.
// The link tokens are passed in as finished URLs; nothing here sees a key.
import type { AppChange, AuditRow, InviteView, MemberNotice, SecurityEvent } from '@hana-id/console-core';
import type { ChangeNotice } from '../env.ts';
import { log } from '../log.ts';
import { type Block, type Design, type LogRow, type Rendered, cut, duration, oneLine, readableTime, render, rowTime } from './render.ts';

export interface MailContext {
  env: string;
  consoleOrigin: string;
  /** A non-production env's label (`[SANDBOX]`, D419), first in every subject; absent or empty on production. */
  label?: string;
  /** The env's files origin: the designed mails' logo is served there (D685); absent, the text wordmark. */
  filesOrigin?: string;
}

/**
 * The designed layout for a security notice partners receive (D700, asked for by the user; amends D674): a fixed
 * heading and preview line, never an app's, organisation's or person's name (D687's rule), and the env's hosted logo.
 */
const notice = (c: MailContext, heading: string, preheader: string): Design => ({ heading, preheader, ...(c.filesOrigin ? { filesOrigin: c.filesOrigin } : {}) });

const KIND_LABEL: Record<string, string> = { origin_add: 'a new allowed origin', policy_set: 'an auto-approve policy', raw_sign_on: 'raw signing (with approval)' };
/** Each guarded change kind in plain words (D699): the notice's subject and its "Change" row (the id kept after it for support). */
const KIND_SUBJECT: Record<string, string> = { origin_add: 'New allowed origin proposed', policy_set: 'Auto-approve policy proposed', raw_sign_on: 'Raw signing proposed' };
const KIND_ACTION: Record<string, string> = { origin_add: 'Add an allowed origin', policy_set: 'Set an auto-approve policy', raw_sign_on: 'Turn on raw signing (with approval)' };

/** Every path in a policy where `addressArgs` is `'any'` (any address may be passed: the notice calls each out). */
export function anyAddressPaths(v: unknown, path = 'policy'): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => anyAddressPaths(x, `${path}[${i}]`));
  if (!v || typeof v !== 'object') return [];
  const out: string[] = [];
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === 'addressArgs' && (x === 'any' || (Array.isArray(x) && x.includes('any')) || (x && typeof x === 'object' && Object.values(x).includes('any')))) out.push(`${path}.${k}`);
    else out.push(...anyAddressPaths(x, `${path}.${k}`));
  }
  return out;
}

/** `change_pending` (blocking): the change as the API stored it, the delay, and the cancel link. */
export function changePending(c: MailContext, n: ChangeNotice, o: { cancelUrl: string; delayMs: number }): Rendered {
  const ch = n.change;
  const what = KIND_LABEL[ch.kind] ?? ch.kind;
  const rows: [string, string][] = [
    ['App', `${n.app.name} (${n.app.id})`],
    ['Organisation', n.app.orgId],
    ['Scope', `${n.app.scopeId} (${n.app.environment})`],
    ['Change', `${KIND_ACTION[ch.kind] ?? ch.kind} (${ch.id})`],
  ];
  const blocks: Block[] = [{ kind: 'p', text: `Someone proposed ${what} for ${oneLine(n.app.name, 80)}. It is not in force yet.` }];
  if (ch.kind === 'origin_add' && ch.origin) {
    rows.push(['Origin', ch.origin]);
    if (ch.display && ch.display !== ch.origin) rows.push(['Shown as', ch.display]);
  }
  if (ch.kind === 'policy_set' && ch.policyId) rows.push(['Policy id', ch.policyId]);
  rows.push(['Proposed by', `${ch.proposedByKind === 'hana' ? 'Hana staff' : ch.proposedByKind === 'member' ? 'a console member' : 'the system'} (${ch.proposedBy})`]);
  rows.push(['Proposed at', readableTime(ch.proposedAt)]);
  if (ch.requestCountry) rows.push(['Request country', ch.requestCountry]);
  blocks.push({ kind: 'kv', rows });
  if (ch.idn) blocks.push({ kind: 'warn', text: `This origin is an internationalised domain name. Its ASCII form is ${ch.origin ?? ''}; check that it is the domain you expect and not a lookalike.` });
  if (ch.kind === 'policy_set' && n.policy !== undefined) {
    const p = n.policy as { label?: unknown; maxConsentMs?: unknown; limits?: unknown };
    const prow: [string, string][] = [];
    if (typeof p.label === 'string') prow.push(['Label', p.label]);
    if (typeof p.maxConsentMs === 'number') prow.push(['Consent lasts up to', duration(p.maxConsentMs)]);
    if (p.limits && typeof p.limits === 'object') prow.push(['Limits', JSON.stringify(p.limits)]);
    if (prow.length) blocks.push({ kind: 'kv', rows: prow });
    const any = anyAddressPaths(n.policy);
    if (any.length) blocks.push({ kind: 'warn', text: `The policy lets any address be passed at: ${any.join(', ')}.` });
    blocks.push({ kind: 'p', text: 'The full policy (contracts, functions and limits):' }, { kind: 'pre', text: cut(JSON.stringify(n.policy, null, 2), 20_000) });
  }
  if (ch.kind === 'raw_sign_on') blocks.push({ kind: 'warn', text: 'Raw signing lets the app ask users to sign arbitrary bytes (each with the user’s approval).' });
  blocks.push(
    { kind: 'p', text: `It takes effect about ${duration(o.delayMs)} after this notice. It may take effect at once if it qualifies for a waiver: a loopback origin on a test app, or a scope that no user has used yet.` },
    { kind: 'p', text: 'If you did not expect this change, cancel it now. The page asks you to confirm; opening the link alone changes nothing.' },
    { kind: 'link', label: 'Cancel this change', url: o.cancelUrl },
    { kind: 'p', text: 'An owner can also cancel it in the console, and Hana security can cancel it from the admin console.' },
  );
  const title = KIND_SUBJECT[ch.kind] ?? 'Change proposed';
  return render(c.env, `${title} for ${oneLine(n.app.name, 60)}`, blocks, c.consoleOrigin, c.label, notice(c, title, 'A change to one of your apps is waiting. It is not in force yet, and you can cancel it.'));
}

const orgLabel = (invite: InviteView, orgName: string | undefined): string => (invite.newOrgName ? `${invite.newOrgName} (new organisation)` : orgName ? `${orgName} (${invite.orgId})` : (invite.orgId ?? 'an organisation'));

const byLabel = (kind: string, id: string): string => (kind === 'hana' ? `Hana staff (${id})` : `an owner (${id})`);

/** `member_invite`, to the invitee: the link (its token in the fragment, so it never reaches a server log). */
export function inviteLink(c: MailContext, invite: InviteView, o: { orgName?: string; inviteUrl: string }): Rendered {
  const subject = `You're invited to ${oneLine(invite.newOrgName ?? o.orgName ?? 'an organisation', 60)} on Hana ID`;
  const org = orgLabel(invite, o.orgName);
  // Who invited, by role only (D672): the invitee learns no staff address or member id.
  const by = invite.createdByKind === 'hana' ? 'Hana staff' : 'an owner of the organisation';
  // What accepting does (docs/integration.md "Members"): an owner invited to an existing organisation is a viewer
  // until its owner grant matures; a new organisation's first owner is its owner at once.
  const does = invite.newOrgName
    ? 'Accepting creates the organisation in the console, with you as its first owner. Owners change apps, keys and members.'
    : invite.role === 'owner'
      ? 'Accepting adds you to the organisation. Owners change apps, keys and members; if it already has an owner, you are a viewer (who sees everything and changes nothing) until a waiting period ends, and its owners are told and can cancel it.'
      : 'Accepting adds you to the organisation as a viewer: viewers see its apps and settings and change nothing.';
  return render(
    c.env,
    subject,
    [
      { kind: 'p', text: `You have been invited to join ${org} in the Hana ID partner console as ${invite.role === 'owner' ? 'an owner' : 'a viewer'}, by ${by}.` },
      { kind: 'p', text: does },
      { kind: 'p', text: `Sign in with the Google account of this address. The invitation expires on ${readableTime(invite.expiresAt)}.` },
      { kind: 'link', label: 'Accept the invitation', url: o.inviteUrl },
      { kind: 'p', text: 'The link works once, for this address only. If you were not expecting this, ignore this email.' },
    ],
    c.consoleOrigin,
    c.label,
    { heading: subject, ...(c.filesOrigin ? { filesOrigin: c.filesOrigin } : {}), preheader: `Join ${oneLine(invite.newOrgName ?? o.orgName ?? 'an organisation', 60)} in the Hana ID partner console. The invitation expires on ${readableTime(invite.expiresAt)}.` },
  );
}

/** `member_invite`, the notice to every owner, the security contacts and the alias. */
export function inviteNotice(c: MailContext, invite: InviteView, o: { orgName?: string }): Rendered {
  return render(
    c.env,
    `New ${invite.role} invited to ${oneLine(invite.newOrgName ?? o.orgName ?? invite.orgId ?? 'an organisation', 60)}`,
    [
      { kind: 'p', text: `A ${invite.role} was invited to ${orgLabel(invite, o.orgName)} in the Hana ID partner console.` },
      {
        kind: 'kv',
        rows: [
          ['Invited', invite.email],
          ['Role', invite.role],
          ['Invited by', byLabel(invite.createdByKind, invite.createdBy)],
          ['Invited at', readableTime(invite.createdAt)],
          ['Expires', readableTime(invite.expiresAt)],
          ['Invite', invite.id],
        ],
      },
      { kind: 'p', text: 'If this is unexpected, an owner can revoke the invite in the console (Members), or ask Hana security to revoke it.' },
    ],
    c.consoleOrigin,
    c.label,
    notice(c, `A new ${invite.role === 'owner' ? 'owner' : 'viewer'} was invited`, 'Someone was invited to your organisation in the Hana ID partner console.'),
  );
}

/** `owner_grant`: to every owner, the contacts and the alias, with the cancel link. */
export function ownerGrantNotice(c: MailContext, n: MemberNotice, o: { orgName?: string; cancelUrl: string; delayMs: number }): Rendered {
  const g = n.grant!;
  const who = n.invite?.email ?? n.member?.email ?? g.userId ?? 'a member';
  const when = n.invite ? `${duration(o.delayMs)} after they accept the invitation` : `${duration(o.delayMs)} after this notice`;
  return render(
    c.env,
    `Owner rights requested in ${oneLine(o.orgName ?? g.orgId, 60)}`,
    [
      { kind: 'p', text: `${who} is to become an owner of ${o.orgName ? `${o.orgName} (${g.orgId})` : g.orgId}. Until then they are a viewer.` },
      {
        kind: 'kv',
        rows: [
          ['Becomes owner', when],
          ['Granted by', byLabel(g.grantedByKind, g.grantedBy)],
          ['Requested at', readableTime(g.createdAt)],
          ['Grant', g.id],
        ],
      },
      { kind: 'p', text: 'If this is unexpected, cancel it. The page asks you to confirm; opening the link alone changes nothing. Cancelling leaves the person a viewer.' },
      { kind: 'link', label: 'Cancel the owner grant', url: o.cancelUrl },
      { kind: 'p', text: 'Any owner can also cancel it in the console, and Hana security from the admin console.' },
    ],
    c.consoleOrigin,
    c.label,
    notice(c, 'Owner rights requested', 'Someone is to become an owner of your organisation. You can cancel it.'),
  );
}

/**
 * The notice that an app's login methods changed (D444 as amended): already in force, so it says what changed, on which
 * app, and how to undo it. To the alias and the org's security contacts, from the feed's walk of `app_changes`.
 */
export function loginMethodsChanged(c: MailContext, r: AppChange, o: { appName?: string; undoUrl: string }): Rendered {
  const on = String(r.detail.loginMethods).split(',').includes('email');
  const app = o.appName ? `${oneLine(o.appName, 80)} (${r.appId ?? ''})` : (r.appId ?? 'an app');
  return render(
    c.env,
    `Email login turned ${on ? 'on' : 'off'} for ${o.appName ? oneLine(o.appName, 60) : (r.appId ?? 'an app')}`,
    [
      { kind: 'p', text: `Email login was turned ${on ? 'on' : 'off'} for ${app}. This is already in force: this setting has no waiting period.` },
      {
        kind: 'kv',
        rows: [
          ['App', app],
          ['Organisation', r.orgId],
          ...(r.scopeId ? ([['Scope', r.scopeId]] as [string, string][]) : []),
          ['Login methods now', String(r.detail.loginMethods)],
          ['Changed by', `${r.actorKind === 'hana' ? 'Hana staff' : r.actorKind === 'member' ? 'a console member' : 'the system'} (${r.actorId})`],
          ['Changed at', readableTime(r.at)],
        ],
      },
      ...(on
        ? ([
            { kind: 'p', text: 'Users of this app can sign in with email once the scope’s email client is on chain. If the scope already has that client, they can do so now.' },
            { kind: 'p', text: 'If you did not expect this, turn it off now: any owner can do so on the app’s Email login page in the console. It takes effect at once and needs no fresh sign-in. Hana security can also turn it off.' },
          ] as Block[])
        : ([{ kind: 'p', text: 'New sign-ins with email for this app stop at once. If you did not expect this, an owner can turn it on again on the app’s Email login page in the console, or ask Hana security.' }] as Block[])),
      { kind: 'link', label: 'Open the app’s Email login page', url: o.undoUrl },
    ],
    c.consoleOrigin,
    c.label,
    notice(c, `Email login turned ${on ? 'on' : 'off'}`, 'An app’s sign-in methods changed. This is already in force.'),
  );
}

// ---- the feed (best effort, after the fact) ----

const detailText = (d: Record<string, unknown>): string => {
  const s = JSON.stringify(d);
  return s === '{}' ? '' : cut(s, 400);
};

/** Who did it, in words, the id kept for support (D704; the text part keeps the code, as before). */
const actorWords = (kind: string, id: string): string =>
  `${kind === 'hana' ? 'Hana staff' : kind === 'member' ? 'a console member' : kind === 'system' ? 'the system' : kind === 'link' ? 'an emailed link' : kind} (${id})`;

/**
 * Each row's time (D704): the exact ISO time (D697: a digest is a log, its times copied into tickets and compared with
 * the console's Audit page and logs). One that isn't a valid time is shown raw and flagged in both parts, and logged
 * at error level (the source, the org and a count; never the value), so it can't hold back the rest of the digest or
 * its source's cursor.
 */
function rowTimes(source: string, orgId: string | null, ms: unknown[]): string[] {
  const out = ms.map(rowTime);
  const bad = out.filter((t) => !t.valid).length;
  if (bad) log({ event: 'digest_bad_time', step: source, ...(orgId ? { orgId } : {}), count: bad }, 'error');
  return out.map((t) => t.text);
}

/**
 * The designed layout for a feed digest (D704, asked for by the user; amends D700): a fixed heading and preview line,
 * never an organisation's or app's name, the hosted logo; no button (the digests link nowhere).
 */
const digestDesign = (c: MailContext, heading: string, preheader: string): Design => notice(c, heading, preheader);

/** Where a digest's app changes and console rows can also be read (for rows its HTML part leaves out, D704). */
const AUDIT_PAGE = "the console's Audit page";

// How each digest row reads (D704): its one line for the text part (unchanged) and its title, labelled lines and details
// for the HTML part. The titles are the codes for now; changing how a row reads is changing these three functions.
const changeRow = (r: AppChange, time: string): LogRow => ({
  line: `${time} ${r.kind}${r.appId ? ` on ${r.appId}` : ''} by ${r.actorKind} ${r.actorId}${detailText(r.detail) ? ` ${detailText(r.detail)}` : ''}`,
  title: r.appId ? `${r.kind} on ${r.appId}` : r.kind,
  fields: [
    ['When', time],
    ['By', actorWords(r.actorKind, r.actorId)],
  ],
  ...(detailText(r.detail) ? { detail: detailText(r.detail) } : {}),
});

const auditLogRow = (r: AuditRow, time: string): LogRow => ({
  line: `${time} ${r.action}${r.target ? ` ${r.target}` : ''} by ${r.actorKind} ${r.actorId} (${r.outcome})${detailText(r.details) ? ` ${detailText(r.details)}` : ''}`,
  title: r.target ? `${r.action} ${r.target}` : r.action,
  fields: [
    ['When', time],
    ['By', actorWords(r.actorKind, r.actorId)],
    ['Outcome', r.outcome],
  ],
  ...(detailText(r.details) ? { detail: detailText(r.details) } : {}),
});

const eventRow = (e: SecurityEvent, time: string): LogRow => ({
  line: `${time} ${e.kind} (${e.id})${e.appId ? ` app ${e.appId}` : ''}${e.scopeId ? ` scope ${e.scopeId}` : ''} ${detailText(e.detail)}`,
  title: `${e.kind} (${e.id})`,
  fields: [['When', time], ...(e.appId ? ([['App', e.appId]] as [string, string][]) : []), ...(e.scopeId ? ([['Scope', e.scopeId]] as [string, string][]) : [])],
  ...(detailText(e.detail) ? { detail: detailText(e.detail) } : {}),
});

/** One digest per org and source: the rows, oldest first. */
export function changesDigest(c: MailContext, orgId: string, rows: AppChange[]): Rendered {
  const times = rowTimes('app_changes', orgId, rows.map((r) => r.at));
  return render(
    c.env,
    `${rows.length} app change${rows.length === 1 ? '' : 's'} in ${orgId}`,
    [
      { kind: 'p', text: `${rows.length === 1 ? '1 change was' : `${rows.length} changes were`} made to the apps of ${orgId}. ${rows.length === 1 ? 'It is' : 'They are'} already in force or done; nothing here needs an answer unless you didn't expect it.` },
      { kind: 'rows', items: rows.map((r, i) => changeRow(r, times[i]!)), elsewhere: AUDIT_PAGE },
      { kind: 'p', text: 'If one is unexpected, an owner can undo it in the console, or ask Hana security.' },
    ],
    c.consoleOrigin,
    c.label,
    digestDesign(c, rows.length === 1 ? 'A change to your apps' : 'Changes to your apps', 'Changes made to your apps in the Hana ID partner console. They are already in force or done.'),
  );
}

export function auditDigest(c: MailContext, orgId: string | null, rows: AuditRow[]): Rendered {
  const times = rowTimes('audit_log', orgId, rows.map((r) => r.at));
  return render(
    c.env,
    `${rows.length} console event${rows.length === 1 ? '' : 's'}${orgId ? ` in ${orgId}` : ''}`,
    [
      { kind: 'p', text: `${rows.length} console event${rows.length === 1 ? '' : 's'}: members, invites and organisation settings changed${orgId ? ` in ${orgId}` : ''}:` },
      { kind: 'rows', items: rows.map((r, i) => auditLogRow(r, times[i]!)), elsewhere: AUDIT_PAGE },
    ],
    c.consoleOrigin,
    c.label,
    digestDesign(c, 'Console activity', 'Members, invites and organisation settings changed in the Hana ID partner console.'),
  );
}

export function securityDigest(c: MailContext, orgId: string | null, events: SecurityEvent[]): Rendered {
  const times = rowTimes('security_events', orgId, events.map((e) => e.detectedAt));
  return render(
    c.env,
    `Security event${events.length === 1 ? '' : 's'}: ${[...new Set(events.map((e) => e.kind))].join(', ')}${orgId ? ` in ${orgId}` : ''}`,
    [
      { kind: 'p', text: `The API recorded ${events.length === 1 ? 'this security event' : `these ${events.length} security events`}:` },
      // Security events aren't on the console's Audit page: Hana security has them.
      { kind: 'rows', items: events.map((e, i) => eventRow(e, times[i]!)), elsewhere: 'ask Hana security (reply to this email)' },
      // To the org's contacts and the alias (the alias alone without an org): words for both, no internal path (D704).
      { kind: 'p', text: 'Hana security receives every security event too and has a recovery playbook for each kind. To ask about one, reply to this email or write to your Hana contact.' },
    ],
    c.consoleOrigin,
    c.label,
    digestDesign(c, events.length === 1 ? 'A security event was recorded' : 'Security events were recorded', 'The Hana ID API recorded security events.'),
  );
}

// ---- the on-chain watcher ----

export const ownerText = (o: unknown): string => {
  const v = o as { Near?: { account_id?: unknown }; Oidc?: { provider?: unknown; sub?: unknown } } | null;
  if (v?.Near && typeof v.Near.account_id === 'string') return `NEAR account ${v.Near.account_id}`;
  if (v?.Oidc && typeof v.Oidc.provider === 'string' && typeof v.Oidc.sub === 'string') return `${v.Oidc.provider} sign-in ${v.Oidc.sub}`;
  return cut(JSON.stringify(o), 200);
};

export interface PendingOnChain {
  scopeId: string;
  orgId: string;
  changeId: number;
  change: unknown;
  unlockAtMs: number;
  /** The scope's owners now, to show which owners a SetOwners adds. */
  currentOwners: unknown[];
  /** SetAllowShared: the scope's apps' active origins (every one of them could then take shared-client logins). */
  activeOrigins?: string[];
}

export function onChainPending(c: MailContext, p: PendingOnChain): Rendered {
  const ch = p.change as { SetOwners?: { owners?: unknown[] }; AddClient?: { provider?: unknown; aud?: unknown }; SetAllowShared?: { allow?: unknown } } | null;
  const blocks: Block[] = [];
  let what = 'a change';
  if (ch?.SetOwners && Array.isArray(ch.SetOwners.owners)) {
    what = 'new owners';
    const now = new Set(p.currentOwners.map((o) => JSON.stringify(o)));
    const added = ch.SetOwners.owners.filter((o) => !now.has(JSON.stringify(o)));
    blocks.push({ kind: 'p', text: `A proposal on chain replaces the owners of scope ${p.scopeId} with:` }, { kind: 'list', items: ch.SetOwners.owners.map((o) => `${ownerText(o)}${now.has(JSON.stringify(o)) ? '' : ' (NEW)'}`) });
    if (added.some((o) => (o as { Oidc?: unknown }).Oidc)) blocks.push({ kind: 'warn', text: `It adds a sign-in owner: ${added.filter((o) => (o as { Oidc?: unknown }).Oidc).map(ownerText).join(', ')}. That identity could then propose changes for this scope.` });
  } else if (ch?.AddClient) {
    what = 'a new client';
    blocks.push({ kind: 'p', text: `A proposal on chain adds a login client to scope ${p.scopeId}:` }, { kind: 'kv', rows: [['Provider', String(ch.AddClient.provider)], ['Client id', String(ch.AddClient.aud)]] });
  } else if (ch?.SetAllowShared) {
    what = 'shared login';
    blocks.push({ kind: 'p', text: `A proposal on chain turns on shared login (Hana's shared Google client) for scope ${p.scopeId}.` });
    if (p.activeOrigins) blocks.push({ kind: 'p', text: p.activeOrigins.length ? 'These origins are active on the scope’s apps and would accept shared-client logins:' : 'No origin is active on the scope’s apps.' }, ...(p.activeOrigins.length ? [{ kind: 'list' as const, items: p.activeOrigins }] : []));
  } else {
    blocks.push({ kind: 'pre', text: cut(JSON.stringify(p.change, null, 2), 5000) });
  }
  blocks.unshift({ kind: 'kv', rows: [['Scope', `${p.scopeId} (${p.orgId})`], ['Change', String(p.changeId)], ['Can execute from', readableTime(p.unlockAtMs)]] });
  blocks.push({ kind: 'p', text: `Any owner of the scope can cancel it before then (cancel_change, in the console's scope page), or ask Hana security. If you made this proposal, no action is needed.` });
  return render(c.env, `On-chain proposal for ${p.scopeId}: ${what}`, blocks, c.consoleOrigin, c.label, notice(c, 'A change to your scope was proposed on chain', 'An on-chain proposal for your scope is waiting. It can be cancelled before it executes.'));
}

export interface ScopeState {
  owners: unknown[];
  clients: [string, string][];
  allowShared: boolean;
}

export function onChainChanged(c: MailContext, scopeId: string, orgId: string, before: ScopeState, after: ScopeState): Rendered {
  const set = (l: unknown[]) => new Set(l.map((x) => JSON.stringify(x)));
  const diff = (a: unknown[], b: unknown[]) => {
    const sa = set(a);
    const sb = set(b);
    return { added: b.filter((x) => !sa.has(JSON.stringify(x))), removed: a.filter((x) => !sb.has(JSON.stringify(x))) };
  };
  const o = diff(before.owners, after.owners);
  const cl = diff(before.clients, after.clients);
  const items: string[] = [
    ...o.added.map((x) => `owner added: ${ownerText(x)}`),
    ...o.removed.map((x) => `owner removed: ${ownerText(x)}`),
    ...cl.added.map((x) => `client added: ${(x as string[]).join(' ')}`),
    ...cl.removed.map((x) => `client removed: ${(x as string[]).join(' ')}`),
  ];
  if (before.allowShared !== after.allowShared) items.push(`shared login ${after.allowShared ? 'turned on' : 'turned off'}`);
  return render(
    c.env,
    `Scope ${scopeId} changed on chain`,
    [
      { kind: 'p', text: `The on-chain state of scope ${scopeId} (${orgId}) changed since the last check:` },
      { kind: 'list', items },
      { kind: 'p', text: 'This covers executed proposals and immediate owner actions (remove_client, disable_shared_login), whether or not they were sent through the console. If one is unexpected, contact Hana security.' },
    ],
    c.consoleOrigin,
    c.label,
    notice(c, 'Your scope changed on chain', 'The on-chain state of your scope changed since the last check.'),
  );
}
