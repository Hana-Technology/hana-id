// The plain-wording rule's check (D853): no chain jargon in what the approval window says in Journear's own words.
// The words are the one shared list (`@hana-id/brand/plain-words`, which holds the plain-wording brief's "instead of"
// column); a summary may use them only in the folded details, which the summary never holds but for one text: a free
// fee ("Free. Sponsored by {App}.", the founder's words, D884), which the page shows only in the details. Shared by
// every test file that builds summaries (core and web) and by the e2e checks.
import type { ApprovalSummary, SummaryText } from './entries.ts';

import { jargonIn as brandJargonIn } from '../../brand/src/plain-words.ts';

/** Network names that hold a banned word as part of the name (BNB Smart Chain): names, not jargon. */
const NETWORK_NAMES = /BNB Smart Chain|Avalanche C-Chain/gu;

/**
 * The banned words in `text`: the one shared list (`@hana-id/brand/plain-words`, every surface's check), network names
 * aside.
 */
export const jargonWords = (text: string): string[] => brandJargonIn(text.replace(NETWORK_NAMES, ' '));

/** A summary text's own words: the app's name and code values (addresses, account ids, methods) left out. */
export const plainWords = (t: SummaryText): string => t.map((p) => (typeof p === 'string' ? p : p.kind === 'strong' ? p.text : ' ')).join('');

/**
 * A claim that a request costs the user nothing, or moves none of their money (D858 as corrected 2026-11-18): only a
 * request whose effect Journear fully knows may say so. Today that is Journear's pinned demo check-in alone (D854).
 */
export const ZERO_COST = /\b(costs? (you )?nothing|cost to you|nothing (of yours )?leaves|free of charge|doesn’t (move|cost) any|won’t cost|no cost)\b/iu;
export const ZERO_COST_ALLOWED: readonly string[] = [
  'This is Journear’s demo check-in. It doesn’t move any money or tokens.',
  'This is Journear’s demo check-in. The check-in itself doesn’t move any money or tokens.',
];

/** Every text of a summary that claims zero cost outside the allowlist (an allowed sentence may sit inside a longer line). */
export const zeroCostIn = (s: ApprovalSummary): string[] =>
  [s.headline, ...s.lines, ...(s.fee ? [s.fee] : []), ...s.warnings.flatMap((w) => [w.text, ...(w.short ? [w.short] : [])])].map(plainWords).filter((w) => ZERO_COST.test(ZERO_COST_ALLOWED.reduce((t, a) => t.split(a).join(' '), w)));

/**
 * Every text of a summary a user reads above the fold (headline, lines, a fee the user pays, network, warnings and
 * their bullets) that uses jargon. A free fee is shown only in the folded details (D884).
 */
export const jargonIn = (s: ApprovalSummary): string[] =>
  [s.headline, ...s.lines, ...(s.fee && !s.freeFee ? [s.fee] : []), ...(s.network ? [s.network] : []), ...s.warnings.flatMap((w) => [w.text, ...(w.short ? [w.short] : [])])].map(plainWords).filter((w) => jargonWords(w).length > 0);
