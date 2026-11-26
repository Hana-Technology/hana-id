// What a platform key's emails say (D918; docs/partner-platform-spec.md A3): the announcement of a new key (to the
// security alias, every security contact and every owner, naming who registered it and who accepted it), the notice
// that an owner confirmed it (with its one-click stop link), the notice that it stopped (revoked or expired, with what
// it cancelled), and the expiry warnings. Builders only (notices.ts sends them); the link tokens come in as finished
// URLs. Plain words for a partner's developers: "platform key" is the agreed term. Never the public key itself: its
// fingerprint (the RFC 7638 thumbprint) identifies it.
import { type ConfirmationNotice, type PlatformKeyNotice, CONFIRM_WORDS, ORIGIN_REMOVAL_LINK_MS } from '@hana-id/console-core';
import { durationWords } from '@hana-id/console-core/duration-words';
import { FRAME_ONLY_ROW, type MailContext } from './messages.ts';
import { type Block, type Design, type Rendered, oneLine, readableTime, render } from './render.ts';

/** A wait in words, in hours up to 3 days ("24 hours", as the spec's line says), else as the other notices word it. */
const waitWords = (ms: number): string => (ms % 3_600_000 === 0 && ms <= 72 * 3_600_000 ? `${ms / 3_600_000} ${ms === 3_600_000 ? 'hour' : 'hours'}` : durationWords(ms));

const design = (c: MailContext, heading: string, preheader: string): Design => ({ heading, preheader, ...(c.filesOrigin ? { filesOrigin: c.filesOrigin } : {}) });

/** The people a notice names, resolved by the admin Worker (members' addresses from the console; staff from the key). */
export interface KeyPeople {
  orgName?: string | undefined;
  /** The member who registered it, or the staff member, in words: "owner@partner.example" or "Journear staff (staff@…)". */
  registeredBy: string;
  acceptedBy?: string | undefined;
  confirmedBy?: string | undefined;
}

const orgWords = (n: PlatformKeyNotice, p: KeyPeople): string => (p.orgName ? `${oneLine(p.orgName, 80)} (${n.key.orgId})` : n.key.orgId);

function keyRows(n: PlatformKeyNotice, p: KeyPeople): [string, string][] {
  const k = n.key;
  const rows: [string, string][] = [
    ['Key', `${oneLine(k.label, 40)} (${k.id})`],
    ['Fingerprint', k.thumbprint],
    ['Organisation', orgWords(n, p)],
    [k.scopes.length > 1 ? 'Wallet settings (scopes)' : 'Wallet settings (scope)', k.scopes.join(', ')],
    ['Registered by', p.registeredBy],
    ['Registered at', readableTime(k.proposedAt)],
  ];
  if (p.acceptedBy) rows.push([k.acceptedByKind === 'hana' ? 'Approved by' : 'Accepted by', p.acceptedBy]);
  return rows;
}

const WHAT_IT_IS = 'A platform key lets your organisation’s backend create and manage its test apps on Journear Passport. Only its public half is held by Journear.';

/**
 * A new key's announcement. In force at once (an owner accepted a staff-registered key: that counts as the
 * confirmation): the email says it works now and carries the stop link. Otherwise it waits `waitMs` (24 h outside
 * `local*` test envs) unless an owner confirms it, and carries the Confirm link (it only opens the page) and the cancel
 * link. On a real-money setup the registrant can't confirm it: another owner must.
 */
export function platformKeyRegistered(c: MailContext, n: PlatformKeyNotice, p: KeyPeople, o: { now: number; cancelUrl: string; confirmUrl: string; revokeUrl?: string | undefined }): Rendered {
  const k = n.key;
  const blocks: Block[] = [{ kind: 'p', text: `${p.registeredBy} registered a new platform key for ${orgWords(n, p)}. ${WHAT_IT_IS}` }, { kind: 'kv', rows: keyRows(n, p) }];
  if (n.inForceAtOnce) {
    if (!o.revokeUrl) throw new Error('a key in force at once needs its stop link');
    blocks.push(
      { kind: 'p', text: `It works now: ${p.acceptedBy ?? 'an owner of your organisation'} accepted it, which counts as its confirmation.` },
      { kind: 'p', text: 'If this wasn’t meant to happen, stop the key here. It stops at once. The page asks you to confirm; opening the link alone changes nothing. The link works for 7 days; after that an owner can stop the key in the partner portal.' },
      { kind: 'link', label: 'Stop this key', url: o.revokeUrl },
    );
  } else {
    const wait = waitWords(n.waitMs ?? 86_400_000);
    const when = readableTime(o.now + (n.waitMs ?? 86_400_000));
    blocks.push(
      {
        kind: 'p',
        text: k.fourEyes
          ? `It isn’t working yet. It starts working on ${when}, ${wait} from now, or sooner if another owner of your organisation confirms it. The owner who registered it can’t confirm it.`
          : `It isn’t working yet. It starts working on ${when}, ${wait} from now, or sooner if an owner of your organisation confirms it.`,
      },
      { kind: 'link', label: 'Review the key in the partner portal', url: o.confirmUrl },
      { kind: 'p', text: 'That link only opens the key’s page. An owner confirms it there, after signing in again with Google.' },
      { kind: 'p', text: 'If you don’t recognise this key, cancel it now. The page asks you to confirm; opening the link alone changes nothing.' },
      { kind: 'link', label: 'Cancel this key', url: o.cancelUrl },
    );
  }
  blocks.push({ kind: 'p', text: 'An owner can also cancel or stop the key in the partner portal, and Journear security can from the admin portal.' });
  const title = 'New platform key registered';
  return render(c.env, `${title} for ${oneLine(p.orgName ?? k.orgId, 60)}`, blocks, c.consoleOrigin, c.label, design(c, title, n.inForceAtOnce ? 'A new key for your organisation’s backend works now. You can stop it at once.' : 'A new key for your organisation’s backend is waiting. It isn’t working yet, and you can cancel it.'));
}

/** An owner confirmed a waiting key: it works now. The stop link works 7 days (the announcement's cancel link no longer does). */
export function platformKeyConfirmed(c: MailContext, n: PlatformKeyNotice, p: KeyPeople, o: { revokeUrl: string }): Rendered {
  const k = n.key;
  const blocks: Block[] = [
    { kind: 'p', text: `${p.confirmedBy ?? 'An owner of your organisation'} confirmed the platform key "${oneLine(k.label, 40)}" for ${orgWords(n, p)}. It works now.` },
    { kind: 'kv', rows: [...keyRows(n, p), ['Confirmed by', p.confirmedBy ?? 'an owner'], ['Confirmed at', readableTime(k.confirmedAt ?? k.activeFrom ?? 0)]] },
    { kind: 'p', text: 'If this wasn’t meant to happen, stop the key here. It stops at once. The page asks you to confirm; opening the link alone changes nothing. The link works for 7 days; after that an owner can stop the key in the partner portal.' },
    { kind: 'link', label: 'Stop this key', url: o.revokeUrl },
  ];
  const title = 'Platform key confirmed';
  return render(c.env, `${title} for ${oneLine(p.orgName ?? k.orgId, 60)}`, blocks, c.consoleOrigin, c.label, design(c, title, 'A key for your organisation’s backend works now. You can stop it at once.'));
}

const STOPPED_BY: Readonly<Record<string, string>> = { member: 'an owner of your organisation', hana: 'Journear staff', link: 'the emailed link', platform: 'the key itself (your backend)' };

/** A key stopped: revoked (by whom) or expired; the waiting web addresses it proposed that were cancelled with it; the org's other waiting keys. */
export function platformKeyStopped(c: MailContext, n: PlatformKeyNotice, p: KeyPeople, o: { waitingLinks?: Record<string, string> } = {}): Rendered {
  const k = n.key;
  const expired = k.status === 'expired';
  const by = expired ? 'it reached the end of its year' : (STOPPED_BY[k.revokedByKind ?? ''] ?? 'someone');
  const blocks: Block[] = [
    { kind: 'p', text: expired ? `The platform key "${oneLine(k.label, 40)}" for ${orgWords(n, p)} expired: it reached the end of its year. It doesn’t work any more.` : `The platform key "${oneLine(k.label, 40)}" for ${orgWords(n, p)} was stopped by ${by}. It doesn’t work any more.` },
    { kind: 'kv', rows: [...keyRows(n, p), [expired ? 'Expired at' : 'Stopped at', readableTime(expired ? (k.expiresAt ?? 0) : (k.revokedAt ?? 0))], ...(k.revokeReason ? ([['Reason', oneLine(k.revokeReason, 200)]] as [string, string][]) : [])] },
  ];
  const cancelled = n.cancelledOrigins ?? [];
  blocks.push(
    cancelled.length
      ? { kind: 'p', text: 'These web addresses it had asked for were still waiting, so they were cancelled with it. Web addresses already working stay; an owner can remove them in the partner portal.' }
      : { kind: 'p', text: 'It had no web address waiting. Web addresses already working stay; an owner can remove them in the partner portal.' },
  );
  if (cancelled.length) blocks.push({ kind: 'list', items: cancelled.map((x) => `${oneLine(x.origin, 200)} (${oneLine(x.appName, 60)})`) });
  const waiting = n.waitingKeys ?? [];
  if (waiting.length) {
    blocks.push({ kind: 'p', text: 'Your organisation also has these keys waiting to start working. If you don’t recognise one, cancel it. The page asks you to confirm; opening a link alone changes nothing.' });
    for (const w of waiting) {
      const url = o.waitingLinks?.[w.id];
      if (url) blocks.push({ kind: 'link', label: `Cancel the key “${oneLine(w.label, 40)}”`, url });
      else blocks.push({ kind: 'p', text: `${oneLine(w.label, 40)} (${w.id}): not announced yet, so it has no link. An owner can cancel it in the partner portal.` });
    }
  }
  const title = expired ? 'Platform key expired' : 'Platform key stopped';
  return render(c.env, `${title} for ${oneLine(p.orgName ?? k.orgId, 60)}`, blocks, c.consoleOrigin, c.label, design(c, title, 'A key for your organisation’s backend no longer works.'));
}

/** The 30- and 7-day warnings before a key expires. */
export function platformKeyExpiring(c: MailContext, n: PlatformKeyNotice, p: KeyPeople): Rendered {
  const k = n.key;
  const blocks: Block[] = [
    { kind: 'p', text: `The platform key "${oneLine(k.label, 40)}" for ${orgWords(n, p)} stops working on ${readableTime(k.expiresAt ?? 0)}, ${n.stage ?? 30} days from now or less. Keys work for one year.` },
    { kind: 'kv', rows: keyRows(n, p) },
    { kind: 'p', text: 'To keep your backend working, register its next key now in the partner portal, switch your backend to it once it works, then stop this one. Keeping a second key registered and working as a standby makes a change of keys quick.' },
  ];
  const title = 'Platform key expires soon';
  return render(c.env, `${title}: ${oneLine(k.label, 40)}`, blocks, c.consoleOrigin, c.label, design(c, title, 'A key for your organisation’s backend stops working soon. Register its next key now.'));
}


/** One web address of a platform request's email (D930): the change, how it shows, and its own cancel link. */
export interface PlatformOriginLine {
  changeId: string;
  origin: string;
  display?: string | undefined;
  idn?: boolean | undefined;
  /** D934: the app may use it only inside its other web addresses (the email says where it works). */
  frameOnly?: boolean | undefined;
  cancelUrl: string;
}

/**
 * One web address's blocks in an email: its plain form, how it shows when that differs, the warning for international
 * letters, and its button. The button names the plain (ASCII) form, never the decoded one an attacker chose to look like
 * another site.
 */
function originBlocks(l: { origin: string; display?: string | undefined; idn?: boolean | undefined; frameOnly?: boolean | undefined }, button: { one: string; many: (origin: string) => string; url: string }, many: boolean): Block[] {
  const r: [string, string][] = [['Web address', l.origin]];
  if (l.display && l.display !== l.origin) r.push(['Shown as', l.display]);
  // D934: only for a frame-only one; every other line is exactly the one before.
  if (l.frameOnly === true) r.push([...FRAME_ONLY_ROW]);
  const out: Block[] = [{ kind: 'kv', rows: r }];
  if (l.idn) out.push({ kind: 'warn', text: `This web address uses international letters. Its plain form is ${l.origin}; check that it is the site you expect and not a lookalike.` });
  out.push({ kind: 'link', label: many ? button.many(oneLine(l.origin, 120)) : button.one, url: button.url });
  return out;
}

/** "it" or "them", from the shared words (console-core CONFIRM_WORDS), so the email says what the portal says. */
const orSooner = (many: boolean): string => (many ? CONFIRM_WORDS.emailOrSooner.replace(/ it$/u, ' them') : CONFIRM_WORDS.emailOrSooner);

/** The Confirm button (D931): it only opens the partner portal's page; an owner confirms there, signed in. */
const CONFIRM_LABEL = 'Check and confirm in the partner portal';
const confirmBlocks = (url: string, many: boolean): Block[] => [
  { kind: 'link', label: CONFIRM_LABEL, url },
  { kind: 'p', text: `That link only opens the partner portal. An owner of your organisation checks and confirms ${many ? 'them' : 'it'} there, after signing in again with Google. Opening the link alone changes nothing.` },
];

const cancelBlocks = (many: boolean): Block[] => [
  { kind: 'p', text: `If you didn’t expect this, cancel ${many ? 'each one you don’t recognise' : 'it'} now. ${many ? 'Each link cancels one web address. ' : ''}The page asks you to confirm; opening the link alone changes nothing.` },
  { kind: 'p', text: `An owner can also cancel ${many ? 'them' : 'it'} in the partner portal, and Journear security can cancel ${many ? 'them' : 'it'} from the admin portal.` },
];

/**
 * The web addresses one request of a platform key asked for (D930; docs/partner-platform-spec.md A6, finding L14): one
 * email for the whole request, every address with its own cancel link, to the security alias, every security contact
 * and every owner of the organisation (D931). The wait is the one the ack gives (`waitMs`, from
 * AdminRpc.pendingNotices: at least 24 h outside `local*` test envs), stated as a lower bound with its earliest date
 * (the ack comes after the sends), or sooner if an owner confirms them (D931: the Confirm link only opens the partner
 * portal's page); no waiver sentence, since none applies to a platform proposal.
 */
export function platformOriginsProposed(
  c: MailContext,
  n: { app: { id: string; name: string; orgId: string; scopeId: string }; keyId: string; keyLabel: string | null; proposedAt: number; requestCountry?: string | undefined; waitMs: number },
  lines: readonly PlatformOriginLine[],
  o: { now: number; confirmUrl: string; orgName?: string | undefined },
): Rendered {
  if (lines.length === 0) throw new Error('a platform request’s email needs at least one web address');
  const many = lines.length > 1;
  const app = oneLine(n.app.name, 80);
  const key = n.keyLabel ? `your platform key “${oneLine(n.keyLabel, 40)}” (${n.keyId})` : `your platform key (${n.keyId})`;
  const rows: [string, string][] = [
    ['App', `${app} (${n.app.id})`],
    ['Organisation', o.orgName ? `${oneLine(o.orgName, 80)} (${n.app.orgId})` : n.app.orgId],
    ['Wallet settings (scope)', n.app.scopeId],
    ['Requested by', key],
    ['Requested at', readableTime(n.proposedAt)],
  ];
  if (n.requestCountry) rows.push(['Request country', n.requestCountry]);
  const blocks: Block[] = [
    { kind: 'p', text: `Your organisation’s backend asked, with ${key}, for ${many ? `${lines.length} new web addresses` : 'a new web address'} for ${app}. ${many ? 'They don’t' : 'It doesn’t'} work yet.` },
    { kind: 'kv', rows },
  ];
  for (const l of lines) blocks.push(...originBlocks(l, { one: 'Cancel this web address', many: (x) => `Cancel ${x}`, url: l.cancelUrl }, many));
  blocks.push(
    {
      kind: 'p',
      // A lower bound (D930 after PR 158's review): the wait is counted from the ack, after every send, and a recipient
      // who got an earlier attempt's copy holds an earlier date, so the email never states an exact time.
      text: `${many ? 'They start' : 'It starts'} working no sooner than ${readableTime(o.now + n.waitMs)}, at least ${waitWords(n.waitMs)} after this email, ${orSooner(many)}, unless someone cancels ${many ? 'them' : 'it'}.`,
    },
    ...confirmBlocks(o.confirmUrl, many),
    ...cancelBlocks(many),
  );
  const title = many ? 'New web addresses requested by your platform key' : 'New web address requested by your platform key';
  return render(c.env, `${title} for ${oneLine(n.app.name, 60)}`, blocks, c.consoleOrigin, c.label, design(c, title, `Your organisation’s backend asked for ${many ? 'new web addresses' : 'a new web address'}. ${many ? 'They don’t' : 'It doesn’t'} work yet, and you can cancel ${many ? 'them' : 'it'}.`));
}

/**
 * Web addresses Journear staff added in one request to a platform-created app or an app on a shared wallet (D931, four
 * eyes): one email for the request, each with its own cancel link, to the alias, every security contact and every
 * owner. Its real wait (`waitMs` from AdminRpc.pendingNotices, at least 24 h outside `local*` test envs) as a lower
 * bound, or sooner if a second person confirms them: another Journear staff member (in the admin portal) or an owner (in
 * the partner portal, the Confirm link). Never the waiver sentence: none applies.
 */
export function secondPersonOriginsProposed(
  c: MailContext,
  n: { app: { id: string; name: string; orgId: string; scopeId: string }; proposedBy: string; proposedAt: number; requestCountry?: string | undefined; waitMs: number },
  lines: readonly PlatformOriginLine[],
  o: { now: number; confirmUrl: string },
): Rendered {
  if (lines.length === 0) throw new Error('a staff request’s email needs at least one web address');
  const many = lines.length > 1;
  const app = oneLine(n.app.name, 80);
  const rows: [string, string][] = [
    ['App', `${app} (${n.app.id})`],
    ['Organisation', n.app.orgId],
    ['Wallet settings (scope)', n.app.scopeId],
    // After PR 159's review: partners read "Journear staff", never a staff member's Access id (the ledger and the admin
    // portal keep who).
    ['Proposed by', 'Journear staff'],
    ['Proposed at', readableTime(n.proposedAt)],
  ];
  if (n.requestCountry) rows.push(['Request country', n.requestCountry]);
  const blocks: Block[] = [
    { kind: 'p', text: `Journear staff added ${many ? `${lines.length} new web addresses` : 'a new web address'} for ${app}. ${many ? 'They don’t' : 'It doesn’t'} work yet.` },
    { kind: 'kv', rows },
  ];
  for (const l of lines) blocks.push(...originBlocks(l, { one: 'Cancel this web address', many: (x) => `Cancel ${x}`, url: l.cancelUrl }, many));
  const them = many ? 'them' : 'it';
  blocks.push(
    {
      kind: 'p',
      text: `${many ? 'They start' : 'It starts'} working no sooner than ${readableTime(o.now + n.waitMs)}, at least ${waitWords(n.waitMs)} after this email, or sooner if a second person confirms ${them}, unless someone cancels ${them}. The second person is another Journear staff member, or an owner of your organisation in the partner portal.`,
    },
    ...confirmBlocks(o.confirmUrl, many),
    ...cancelBlocks(many),
  );
  const title = many ? 'New web addresses added by Journear staff' : 'New web address added by Journear staff';
  return render(c.env, `${title} for ${oneLine(n.app.name, 60)}`, blocks, c.consoleOrigin, c.label, design(c, title, `Journear staff added ${many ? 'new web addresses' : 'a new web address'} for one of your apps. ${many ? 'They don’t' : 'It doesn’t'} work yet, and you can cancel ${them}.`));
}

/** One web address of a confirmation's notice (D931): the change, how it shows, and its own removal link. */
export interface ConfirmedOriginLine {
  changeId: string;
  origin: string;
  display?: string | undefined;
  idn?: boolean | undefined;
  /** D934: as PlatformOriginLine's (when the confirmation's notice carries it). */
  frameOnly?: boolean | undefined;
  removeUrl: string;
}

/**
 * A second person confirmed web addresses (D931): they work now. One email per confirmation to the alias, every
 * security contact and every owner, naming who confirmed them (a member by their address from the org's current
 * members, else "a former member"; staff as "Journear staff") and, for a staff proposal, the staff member who added
 * them too; one removal link per web address, valid 7 days (`ORIGIN_REMOVAL_LINK_MS`).
 */
export function originsConfirmed(
  c: MailContext,
  n: Pick<ConfirmationNotice, 'app' | 'confirmedByKind' | 'confirmedBy' | 'confirmedAt' | 'proposedByKind' | 'keyId' | 'keyLabel' | 'proposedBy'>,
  lines: readonly ConfirmedOriginLine[],
  o: { confirmedBy: string },
): Rendered {
  if (lines.length === 0) throw new Error('a confirmation’s notice needs at least one web address');
  const many = lines.length > 1;
  const app = oneLine(n.app.name, 80);
  const them = many ? 'them' : 'it';
  const what = many ? `${lines.length} web addresses` : oneLine(lines[0]!.origin, 200);
  // At the start of a sentence: "A former member"; an address stays as it is.
  const who = /^a /u.test(o.confirmedBy) ? `A${o.confirmedBy.slice(1)}` : o.confirmedBy;
  const staffProposal = n.proposedByKind === 'hana';
  const rows: [string, string][] = [
    ['App', `${app} (${n.app.id})`],
    ['Organisation', n.app.orgId],
    ['Wallet settings (scope)', n.app.scopeId],
    staffProposal
      ? ['Added by', 'Journear staff']
      : ['Requested by', n.keyLabel ? `your platform key “${oneLine(n.keyLabel, 40)}” (${n.keyId ?? ''})` : `your platform key (${n.keyId ?? ''})`],
    ['Confirmed by', n.confirmedByKind === 'hana' ? 'a second Journear staff member' : o.confirmedBy],
    ['Confirmed at', readableTime(n.confirmedAt)],
  ];
  const blocks: Block[] = [
    { kind: 'p', text: `${who} confirmed ${what} for ${app}. ${many ? 'They work' : 'It works'} there now. If this wasn’t meant to happen, remove ${them} here: ${many ? 'each stops' : 'it stops'} at once.` },
    {
      kind: 'p',
      text: staffProposal
        ? `A Journear staff member added ${them}. On this app, a web address Journear staff add needs a second person to confirm it${n.confirmedByKind === 'hana' ? ': a second Journear staff member did' : ''}.`
        : `Your organisation’s backend asked for ${them} with its platform key.`,
    },
    { kind: 'kv', rows },
  ];
  for (const l of lines) blocks.push(...originBlocks(l, { one: 'Remove this web address', many: (x) => `Remove ${x}`, url: l.removeUrl }, many));
  blocks.push(
    {
      kind: 'p',
      text: `${many ? 'Each link removes one web address and works' : 'The link works'} for ${durationWords(ORIGIN_REMOVAL_LINK_MS)}. The page asks you to confirm; opening the link alone changes nothing.`,
    },
    { kind: 'p', text: `After that, an owner can remove ${them} in the partner portal, and Journear security can from the admin portal.` },
  );
  const title = many ? 'Web addresses confirmed' : 'Web address confirmed';
  return render(c.env, `${title} for ${oneLine(n.app.name, 60)}`, blocks, c.consoleOrigin, c.label, design(c, title, `${many ? 'New web addresses for one of your apps work' : 'A new web address for one of your apps works'} now. You can remove ${them} at once.`));
}
