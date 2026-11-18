// The plain-wording rule's check (D853): no chain jargon in what the approval window says in Journear's own words.
// The words are the plain-wording brief's "instead of" column (2026-11-18); a summary may use them only in the folded
// details, which the summary never holds. Shared by every test file that builds summaries (core and web).
import type { ApprovalSummary, SummaryText } from './entries.ts';

/**
 * Chain jargon a summary never uses. Network names that contain "Chain" (BNB Smart Chain, Avalanche C-Chain) are
 * names, not jargon.
 */
export const JARGON =
  /\b(gas|relayer|relay(ed)?|sponsor(ed|ship)?|testnet|sandbox|mainnet|public network|EVM|chain ?id|(?<!Smart |C-)chain|contracts?|allowance|spender|operator|revoke[ds]?|unlimited|full-access|function-call|access key|signers?|thresholds?|weights?|burn(t|ed|s)?|trust ?lines?|smallest units|decimals|g?wei|stroops|yocto\w*|NFTs?|block( hash)?|RPC|ledgers?|vault|decoder|API|nonce|(un)?verified|reviewed list|pinned|on chain|faucet|authori[sz]\w*|delegate|declined?|log in|technical details)\b/iu;

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

/** Every text of a summary that claims zero cost outside the allowlist. */
export const zeroCostIn = (s: ApprovalSummary): string[] =>
  [s.headline, ...s.lines, ...(s.fee ? [s.fee] : []), ...s.warnings.flatMap((w) => [w.text, ...(w.short ? [w.short] : [])])].map(plainWords).filter((w) => ZERO_COST.test(w) && !ZERO_COST_ALLOWED.includes(w));

/** Every text of a summary a user reads (headline, lines, fee, network, warnings and their bullets) that uses jargon. */
export const jargonIn = (s: ApprovalSummary): string[] =>
  [s.headline, ...s.lines, ...(s.fee ? [s.fee] : []), ...(s.network ? [s.network] : []), ...s.warnings.flatMap((w) => [w.text, ...(w.short ? [w.short] : [])])].map(plainWords).filter((w) => JARGON.test(w));
