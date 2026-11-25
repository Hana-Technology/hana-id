// The shared-wallet line (D912): when other apps use the same wallet as the app a window is for (the apps of its scope,
// as Journear's own GET /v1/app counted them for the vault), the sign-in window and the approval window say so in one
// plain line under who is asking, the same sentence in both, with the apps' names one tap away:
//
//   This wallet is also used on 2 other apps. See which
//     · “Stamp Trail”      (each name quoted, marks and name together in the partner-words box: the partner's text)
//     · “Coffee Club”
//     Any of them can ask you to approve payments from this wallet, so check who is asking each time.
//
// It is Journear's voice, not the partner's, so it sits outside the neutral box that holds the app's name and web
// address, in the muted text of a note: never a coloured box, never above or between the window's warnings. An app
// alone on its scope gets no field from the vault, so nothing here is drawn and the window is exactly as before. When
// the vault has no answer at all (`otherAppsUnknown`), the same place says "This wallet may also be used on other apps.".
//
// SECURITY: the names are partners' own words. The vault already cut them (app-name.ts, Passport Home's rule); they are
// cut again here and reach the page only as text nodes (dom.ts). The count and names come only from the vault, over
// the window's authenticated channel (or this window's own sessionStorage); the partner page never sees them.
import { type OtherApps, isOtherApps } from '@hana-id/core';
import { homeAppName } from './app-name.ts';
import type { Dom } from './dom.ts';

/** The line's words (D912, decided while building, to confirm). The count is always a number, as elsewhere. */
export const SHARED_WALLET_TEXT = Object.freeze({
  line: (others: number): string => (others === 1 ? 'This wallet is also used on 1 other app.' : `This wallet is also used on ${others} other apps.`),
  /** When the vault has no answer at all (after PR 141's review): the same place and style, no list. */
  unknown: 'This wallet may also be used on other apps.',
  see: 'See which',
  more: (left: number): string => (left === 1 ? 'and 1 more app' : `and ${left} more apps`),
  note: 'Any of them can ask you to approve payments from this wallet, so check who is asking each time.',
});

/**
 * The line for `otherApps` (a window message's field, checked again here); without it, `unknown` (the message's
 * `otherAppsUnknown`: the vault has no answer) draws the line that says the wallet may be shared; else null: nothing.
 * Each name is the partner's own words, so it is set apart as such (quoted, in the partner-words box the approval
 * window uses for partner text), never in the flow of Journear's sentence.
 */
export function sharedWalletLine(d: Dom, otherApps: unknown, unknown?: unknown): HTMLElement | null {
  if (otherApps === undefined || !isOtherApps(otherApps)) {
    return otherApps === undefined && unknown === true ? d.h('p', { class: 'shared-wallet shared-wallet-unknown', attrs: { id: 'shared-wallet' } }, SHARED_WALLET_TEXT.unknown) : null;
  }
  const { count, names } = otherApps as OtherApps;
  // The quotation marks sit inside the box, in the one text node with the name, so they hug it (no box padding or
  // border between a mark and the name) and a wrapped name keeps them on its first and last line.
  const items = names.map((n) => d.h('li', {}, d.h('span', { class: 'partner-words' }, `“${homeAppName(n)}”`)));
  if (count > names.length) items.push(d.h('li', { class: 'shared-wallet-more' }, SHARED_WALLET_TEXT.more(count - names.length)));
  return d.h(
    'details',
    { class: 'shared-wallet', attrs: { id: 'shared-wallet' } },
    d.h('summary', {}, d.h('span', { class: 'shared-wallet-line' }, SHARED_WALLET_TEXT.line(count)), ' ', d.h('span', { class: 'shared-wallet-see' }, SHARED_WALLET_TEXT.see)),
    d.h('div', { class: 'shared-wallet-body' }, d.h('ul', { class: 'shared-wallet-apps' }, ...items), d.h('p', { class: 'shared-wallet-note' }, SHARED_WALLET_TEXT.note)),
  );
}
