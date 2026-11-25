// What a platform key's emails say (D918; docs/partner-platform-spec.md A3): the announcement of a new key (to the
// security alias, every security contact and every owner, naming who registered it and who accepted it), the notice
// that an owner confirmed it (with its one-click stop link), the notice that it stopped (revoked or expired, with what
// it cancelled), and the expiry warnings. Builders only (notices.ts sends them); the link tokens come in as finished
// URLs. Plain words for a partner's developers: "platform key" is the agreed term. Never the public key itself: its
// fingerprint (the RFC 7638 thumbprint) identifies it.
import type { PlatformKeyNotice } from '@hana-id/console-core';
import { durationWords } from '@hana-id/console-core/duration-words';
import type { MailContext } from './messages.ts';
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
  cancelUrl: string;
}

/**
 * The web addresses one request of a platform key asked for (D930; docs/partner-platform-spec.md A6, finding L14): one
 * email for the whole request, every address with its own cancel link, to the security alias and every security
 * contact. The wait is the one the ack gives (`waitMs`, from AdminRpc.pendingNotices: at least 24 h outside `local*`
 * test envs), stated as a lower bound with its earliest date (the ack comes after the sends); no waiver sentence, since none applies to a platform proposal, and nothing brings
 * one forward yet (the owner's confirmation is piece P10, which adds its line and Confirm link here).
 */
export function platformOriginsProposed(
  c: MailContext,
  n: { app: { id: string; name: string; orgId: string; scopeId: string }; keyId: string; keyLabel: string | null; proposedAt: number; requestCountry?: string | undefined; waitMs: number },
  lines: readonly PlatformOriginLine[],
  o: { now: number; orgName?: string | undefined },
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
  for (const l of lines) {
    const r: [string, string][] = [['Web address', l.origin]];
    if (l.display && l.display !== l.origin) r.push(['Shown as', l.display]);
    blocks.push({ kind: 'kv', rows: r });
    if (l.idn) blocks.push({ kind: 'warn', text: `This web address uses international letters. Its plain form is ${l.origin}; check that it is the site you expect and not a lookalike.` });
    // The button names the plain (ASCII) form, never the decoded one an attacker chose to look like another site.
    blocks.push({ kind: 'link', label: many ? `Cancel ${oneLine(l.origin, 120)}` : 'Cancel this web address', url: l.cancelUrl });
  }
  blocks.push(
    {
      kind: 'p',
      // A lower bound (D930 after PR 158's review): the wait is counted from the ack, after every send, and a recipient
      // who got an earlier attempt's copy holds an earlier date, so the email never states an exact time.
      text: `${many ? 'They start' : 'It starts'} working no sooner than ${readableTime(o.now + n.waitMs)}, at least ${waitWords(n.waitMs)} after this email, unless someone cancels ${many ? 'them' : 'it'}. Web addresses your platform key asks for always wait the full time: nothing makes them start sooner.`,
    },
    { kind: 'p', text: `If you didn’t expect this, cancel ${many ? 'each one you don’t recognise' : 'it'} now. ${many ? 'Each link cancels one web address. ' : ''}The page asks you to confirm; opening the link alone changes nothing.` },
    { kind: 'p', text: `An owner can also cancel ${many ? 'them' : 'it'} in the partner portal, and Journear security can cancel ${many ? 'them' : 'it'} from the admin portal.` },
  );
  const title = many ? 'New web addresses requested by your platform key' : 'New web address requested by your platform key';
  return render(c.env, `${title} for ${oneLine(n.app.name, 60)}`, blocks, c.consoleOrigin, c.label, design(c, title, `Your organisation’s backend asked for ${many ? 'new web addresses' : 'a new web address'}. ${many ? 'They don’t' : 'It doesn’t'} work yet, and you can cancel ${many ? 'them' : 'it'}.`));
}
