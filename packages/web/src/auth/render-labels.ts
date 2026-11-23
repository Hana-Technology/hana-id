// A partner's label in the approval window (D896, piece 3 of D892). The window decodes the request itself, then asks
// core's matcher whether it is exactly a call one of the app's label documents describes. Only then does it show the
// partner's sentence, in a box of its own, always headed "{App} says:" and followed by "These are {App}’s words.
// Journear hasn’t checked them.". Journear's verb and joining words are plain text; the partner's object phrase and
// every value are set apart (D885's box decision), so partner words never sit in the flow of Journear's sentences. The
// box comes after every warning box of the request (render-approval.ts), so no label sits above a warning or pushes
// one down, and nothing Journear says is removed, reworded or moved: a label only adds.
//
// A request a document describes but that doesn't meet its description adds one line in Journear's voice instead, and
// never the partner's words: amber ("{App} describes this kind of request, but this one doesn’t match…"), or red for
// a classic payment to an account the app hasn't listed. A request no document describes, or one Journear couldn't
// check (a NEAR or Soroban contract's code hash is read by a later piece, so today those never match), is the plain
// window, exactly as without labels.
//
// Where the documents come from: the vault's own fresh `GET /v1/app` read (vault.ts `labelsForWindow`), checked there,
// sent with the request (hana:approve-request `partnerLabels`), and parsed here again with this page's own parser.
import { BRAND } from '@hana-id/brand';
import type { DecodedApproval } from '@hana-id/core/decode';
import {
  type LabelChainFacts,
  type LabelDocument,
  type LabelMatch,
  type RenderedValue,
  type SentencePart,
  labelOnNetwork,
  labelRequestOf,
  matchLabel,
  noMatchKind,
  parseLabelDocument,
  valuePlainText,
  withoutSharedContracts,
} from '@hana-id/core/partner-labels';
import type { SummaryText } from '@hana-id/core/decode';
import { type Child, type Dom, row, rows } from './dom.ts';
import { fullId } from './render-approval.ts';

/**
 * The documents the vault sent for this request, as this page reads them: each parsed by its own parser (a text it
 * refuses is dropped), on this build's network, its contract described by no other. Pure.
 */
export function windowLabelDocuments(texts: readonly string[] | undefined, network: 'testnet' | 'mainnet'): LabelDocument[] {
  if (!texts) return [];
  const docs: { document: LabelDocument }[] = [];
  for (const t of texts) {
    let r: ReturnType<typeof parseLabelDocument>;
    try {
      r = parseLabelDocument(t);
    } catch {
      continue;
    }
    if (r.ok && labelOnNetwork(r.document, network)) docs.push({ document: r.document });
  }
  return withoutSharedContracts(docs).map((d) => d.document);
}

/** What the window does with a request and the app's labels. */
export type LabelOutcome =
  /** No document describes it, or Journear couldn't check it: the plain window, exactly as without labels. */
  | { readonly kind: 'none' }
  /** Exactly a described call: the partner's sentence in its box. */
  | { readonly kind: 'match'; readonly match: LabelMatch }
  /** A described kind of request that doesn't meet its description: the amber line, no partner words. */
  | { readonly kind: 'mismatch' }
  /** A classic payment to an account not in the app's address book: the red lines, no partner words. */
  | { readonly kind: 'not_listed' };

const NONE: LabelOutcome = Object.freeze({ kind: 'none' });

/** What only the chain can tell, read by a later piece (D892's piece 5): none is passed today. */
export type WindowLabelFacts = Pick<LabelChainFacts, 'codeHash' | 'sorobanParams'>;

/**
 * The outcome for `decoded` (the page's own decode) against `docs`. `user` is the vault's address on the request's
 * chain; `networkChecked` whether the vault checked a NEAR request's network itself (D726, D729); `reviewedNear` the
 * build's reviewed NEAR accounts, which a label never describes. A warning wins over a match: should one document
 * match and another flag the request (two documents can't describe one contract, so this can't happen), no partner
 * words are shown. Pure.
 */
export function labelOutcome(decoded: DecodedApproval, docs: readonly LabelDocument[], o: { user: string; networkChecked: boolean; reviewedNear: readonly string[]; facts?: WindowLabelFacts }): LabelOutcome {
  if (docs.length === 0) return NONE;
  const req = labelRequestOf(decoded, o.user);
  if (!req) return NONE;
  const facts: LabelChainFacts = { ...(o.facts ?? {}), networkChecked: o.networkChecked, reviewedNear: o.reviewedNear };
  let match: LabelMatch | null = null;
  let mismatch = false;
  let notListed = false;
  for (const doc of docs) {
    const r = matchLabel(doc, req, facts);
    if (r.ok) {
      match ??= r;
      continue;
    }
    // A classic payment's destination outside the address book: the partner's own list says this isn't its account.
    if (r.reason === 'not_in_address_book' && r.at === 'destination') notListed = true;
    else if (noMatchKind(r.reason) === 'described_mismatch') mismatch = true;
  }
  if (notListed) return Object.freeze({ kind: 'not_listed' });
  if (mismatch) return Object.freeze({ kind: 'mismatch' });
  return match ? Object.freeze({ kind: 'match', match }) : NONE;
}

// ---- the sentences (Journear's voice) ----

const APP = { kind: 'app' } as const;

/** The amber line for a request that doesn't match its app's description (proposal A4), and its bullet. */
export const LABEL_MISMATCH: { readonly full: SummaryText; readonly short: SummaryText } = Object.freeze({
  full: Object.freeze([APP, ` describes this kind of request, but this one doesn’t match its description, so ${BRAND.company} isn’t showing it. Check it in `, APP, ' first.']) as SummaryText,
  short: Object.freeze(['Doesn’t match how ', APP, ' describes this kind of request']) as SummaryText,
});

/** The red lines for a classic payment to an account its app hasn't listed (proposal C3), and its bullet. */
export const LABEL_NOT_LISTED: { readonly full: SummaryText; readonly short: SummaryText } = Object.freeze({
  full: Object.freeze(['This isn’t one of the accounts ', APP, ' has listed for payments. If you expected to pay ', APP, ', don’t approve.']) as SummaryText,
  short: Object.freeze(['Not one of the accounts ', APP, ' has listed for payments']) as SummaryText,
});

/** The headline's words after the app's name. */
export const LABEL_SAYS = ' says: ';
/** The row naming a classic payment's destination by the app's address book (its label is Journear's word). */
export const LABEL_DESTINATION_ROW = 'To';

// ---- the box ----

/** The app's name as every sentence of the window names it: bold, its direction isolated (approval.css). */
const appName = (d: Dom, name: string) => d.h('strong', { class: 'app-name' }, name);

/** A value as the window sets it apart: the text in its own span; an id, an amount or an account in mono. */
function valueNode(d: Dom, v: RenderedValue, app: string, inRow: boolean): HTMLElement {
  switch (v.format) {
    case 'enum':
      // The partner's word for the request's exact value.
      return d.h('span', { class: 'partner-value partner-words' }, v.text);
    case 'itemId':
    case 'orderNumber':
      return d.h('code', { class: 'partner-value mono' }, v.text);
    case 'account':
      if (v.source === 'computed_self') return d.h('span', { class: 'partner-value' }, v.text);
      if (v.source === 'partner_address_book') {
        // The app's name for the account, set apart; in a row, the account itself whole under it.
        const name = d.h('span', { class: 'partner-value partner-words' }, v.text);
        return inRow ? d.h('span', { class: 'partner-account' }, name, fullId(d, v.value)) : name;
      }
      // The account whole (D876), in one piece.
      return d.h('span', { class: 'partner-value' }, fullId(d, v.value));
    case 'tokenAmount':
      // Which token a call moves, and that this is its amount, is the app's description (D892 item 6).
      return d.h('span', { class: 'partner-value' }, valuePlainText(v, app));
    default:
      return d.h('span', { class: 'partner-value' }, v.text);
  }
}

/** The sentence's parts as nodes: the verb and joining words plain, the object phrase and each value set apart. */
function sentenceNodes(d: Dom, parts: readonly SentencePart[], app: string): Child[] {
  return parts.flatMap((p, i): Child[] => {
    const sep = i > 0 ? ' ' : '';
    switch (p.kind) {
      case 'verb':
      case 'word':
        return [`${sep}${p.text}`];
      case 'object':
        return [sep, d.h('span', { class: 'partner-words' }, p.text)];
      case 'value':
        return [sep, valueNode(d, p.value, app, false)];
    }
  });
}

/**
 * The partner's box: "{App} says: {sentence}", the attribution under it, then a row for each of the format's fields
 * (the partner's row label, the request's own value) and, for a classic payment, the destination as the app's address
 * book names it, with the account whole. Normal text colour, no mark of any kind (approval.css `div.partner-label`).
 */
export function labelBox(d: Dom, m: LabelMatch, app: string): HTMLElement {
  const name = app.trim() === '' ? 'The app' : app;
  const says = d.h('p', { class: 'partner-says' }, appName(d, name), LABEL_SAYS, ...sentenceNodes(d, m.parts, name));
  // core's partnerAttribution, word for word (a test holds them equal), with the name as everywhere else in the window.
  const attribution = d.h('p', { class: 'partner-attribution' }, 'These are ', appName(d, name), `’s words. ${BRAND.company} hasn’t checked them.`);
  const fieldRows = m.fields.map((f) => row(d, f.label, valueNode(d, f.value, name, true)));
  const destination = m.destination ? row(d, LABEL_DESTINATION_ROW, valueNode(d, m.destination, name, true)) : null;
  return d.h(
    'div',
    { class: 'partner-label', attrs: { 'data-format': m.format } },
    says,
    attribution,
    fieldRows.length > 0 || destination ? rows(d, [...fieldRows, destination], 'jp-kv partner-fields') : null,
  );
}
