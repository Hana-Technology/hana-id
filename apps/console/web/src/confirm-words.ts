// D931: the plain words of an owner's confirmation of web addresses, as the console's pages say them. A copy of
// console-core's `CONFIRM_WORDS` (packages/console-core/src/origin-confirm.ts), which the emails and the server's
// reasons use: the SPA imports only types from console-core (that module carries zod, which must not be bundled), so
// web/test/confirm.test.tsx holds this copy equal to the original, word for word.
export const CONFIRM_WORDS = {
  pageTitle: 'Confirm web addresses',
  intro: (app: string) => `Only confirm web addresses you know belong to ${app}. Once you confirm, ${app} can use this wallet there straight away.`,
  notYours: 'Not yours? Cancel it.',
  waitLine: (date: string) => `Starts working on ${date} if nobody confirms it.`,
  waitingLine: (date: string) => `Waiting for an owner to confirm, or starts working on ${date}`,
  secondPersonLine: (date: string) => `Waiting for a second person to confirm, or starts working on ${date}`,
  notAnnounced: 'Its email hasn’t gone out yet, so it can’t be confirmed yet. Try again in a few minutes.',
  onlyOwner: 'Only an owner of this wallet’s settings can confirm.',
  sameAsProposer: 'You added these web addresses, so a second person must confirm them.',
  confirmButton: 'Confirm',
  noneTicked: 'Tick each web address you know belongs to this app first.',
  removeButton: 'Remove this web address',
  removed: 'Removed. It stopped working straight away.',
  emailOrSooner: 'or sooner if an owner of your organisation confirms it',
} as const;

/** "Coffee Club, Stamp Rally and Rewards beta", or "A, B, C, D, E and 3 more" past the names the answer carries. */
export function appNames(names: readonly string[], total: number): string {
  const more = Math.max(0, total - names.length);
  if (more > 0) return `${names.join(', ')} and ${more} more`;
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The success line after the fresh sign-in. */
export const confirmedLine = (n: number, app: string): string => (n === 1 ? `Done: 1 web address works for ${app} now.` : `Done: ${n} web addresses work for ${app} now.`);
