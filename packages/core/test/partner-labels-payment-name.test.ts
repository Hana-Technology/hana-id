// D907: a matching classic payment's sentence ends with Journear's joining word for the verb and the address book's
// name of the destination ("pay the fare to Coffee Club till"), only for an exact match of the destination's base
// account; never for a payment that doesn't match. The plain form and the preview say the same; the parser holds the
// phrase and the longest name to the sentence's 40 characters; and what the text rules do with misleading names.
import { Account, Asset, Memo, MuxedAccount } from '@stellar/stellar-base';
import { describe, expect, it } from 'vitest';
import { decodeApprovalRequest } from '../src/decode/request.ts';
import { type LabelMatch, type LabelRequest, labelLinePlainText, labelRequestOf, matchLabel, previewLabelDocument, sentencePlainText } from '../src/partner-labels/match.ts';
import { SENTENCE_PARTNER_CHARS, parseLabelDocument } from '../src/partner-labels/schema.ts';
import { partnerTextProblem } from '../src/partner-labels/text-rules.ts';
import { PARTNER_CONNECTORS, PARTNER_VERBS, PAYMENT_DESTINATION_WORDS, type PartnerVerb, SOFT_VERBS, paymentDestinationWord } from '../src/partner-labels/words.ts';
import { PAYMENT_DOC_JSON, STAMPS_DOC_JSON, parsed, paymentTx } from './partner-labels-fixtures.ts';
import { ISSUER, OTHER, PASSPHRASE, USER } from './stellar-fixtures.ts';

const stellarReq = (bytes: Uint8Array): LabelRequest => labelRequestOf(decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes }), USER)!;
const muxedOf = (g: string, id = '7') => new MuxedAccount(new Account(g, '0'), id).accountId();

/** A payment document with `verb`, an optional phrase, and the memo in the sentence or not. */
function doc(o: { verb?: string; object?: string; name?: string; memo?: boolean; book?: { account: string; name: string }[] } = {}) {
  const memo = o.memo ?? false;
  return {
    ...PAYMENT_DOC_JSON,
    metadata: { addressBook: o.book ?? [{ account: OTHER, name: o.name ?? 'Coffee Club till' }] },
    display: {
      formats: {
        payment: {
          call: { memo: 'text', assets: ['native', `USDC:${ISSUER}`] },
          intent: { verb: o.verb ?? 'pay', ...(o.object !== undefined ? { object: o.object } : {}) },
          sentence: ['verb', ...(o.object !== undefined ? ['object'] : []), ...(memo ? [{ word: 'for' }, { field: 'memo' }] : [])],
          fields: [{ path: 'memo', label: 'Order', format: 'orderNumber' }],
        },
      },
    },
  };
}

const matchOf = (json: unknown, destination = OTHER): LabelMatch => {
  const r = matchLabel(parsed(json), stellarReq(paymentTx({ destination })), {});
  if (!r.ok) throw new Error(r.reason);
  return r;
};

/** The sentence as the window writes it: the parts' texts, an address book name bare (as the window's span holds it). */
const windowText = (m: LabelMatch): string => m.parts.map((p) => (p.kind === 'value' ? (p.value.format === 'account' ? p.value.text : p.value.format === 'orderNumber' ? p.value.text : '?') : p.text)).join(' ');

/** Every verb a payment may use: the list less the soft verbs, which the parser refuses for a payment. */
const PAYMENT_VERBS = PARTNER_VERBS.filter((v) => !SOFT_VERBS.has(v));

describe('the joining word, by verb (Journear’s word, from the joining-word list)', () => {
  it('every verb a payment may use has its word; the soft verbs are refused for a payment, so they need none', () => {
    for (const v of PAYMENT_VERBS) {
      expect(PAYMENT_DESTINATION_WORDS[v], v).toBeDefined();
      expect(PARTNER_CONNECTORS).toContain(PAYMENT_DESTINATION_WORDS[v]);
    }
    for (const v of SOFT_VERBS) {
      expect(PAYMENT_DESTINATION_WORDS[v], v).toBeUndefined();
      const r = parseLabelDocument(JSON.stringify(doc({ verb: v })));
      expect(r.ok, v).toBe(false);
      if (!r.ok) expect(r.errors.map((e) => e.code)).toContain('bad_verb');
    }
    expect(Object.keys(PAYMENT_DESTINATION_WORDS).sort()).toEqual([...PAYMENT_VERBS].sort());
    expect(paymentDestinationWord('collect' as PartnerVerb)).toBe('to');
  });

  it('the exact sentences, with an empty phrase and a filled one, for each verb', () => {
    const want: Record<string, [string, string]> = {
      pay: ['pay to Coffee Club till', 'pay the fare to Coffee Club till'],
      send: ['send to Coffee Club till', 'send the fare to Coffee Club till'],
      donate: ['donate to Coffee Club till', 'donate the fare to Coffee Club till'],
      deposit: ['deposit to Coffee Club till', 'deposit the fare to Coffee Club till'],
      sell: ['sell to Coffee Club till', 'sell the fare to Coffee Club till'],
      lend: ['lend to Coffee Club till', 'lend the fare to Coffee Club till'],
      repay: ['repay to Coffee Club till', 'repay the fare to Coffee Club till'],
      withdraw: ['withdraw to Coffee Club till', 'withdraw the fare to Coffee Club till'],
      unstake: ['unstake to Coffee Club till', 'unstake the fare to Coffee Club till'],
      buy: ['buy from Coffee Club till', 'buy the fare from Coffee Club till'],
      borrow: ['borrow from Coffee Club till', 'borrow the fare from Coffee Club till'],
      bid: ['bid with Coffee Club till', 'bid the fare with Coffee Club till'],
      stake: ['stake with Coffee Club till', 'stake the fare with Coffee Club till'],
      swap: ['swap with Coffee Club till', 'swap the fare with Coffee Club till'],
    };
    expect(Object.keys(want).sort()).toEqual([...PAYMENT_VERBS].sort());
    for (const v of PAYMENT_VERBS) {
      const [empty, filled] = want[v]!;
      expect(windowText(matchOf(doc({ verb: v }))), v).toBe(empty);
      expect(windowText(matchOf(doc({ verb: v, object: 'the fare' }))), v).toBe(filled);
    }
  });

  it('after the memo too: the name always ends the sentence, after the partner’s own parts', () => {
    const m = matchOf(doc({ object: 'the fare', memo: true }));
    expect(windowText(m)).toBe('pay the fare for 1042 to Coffee Club till');
    expect(sentencePlainText(m.parts)).toBe(`pay the fare for “1042” to “Coffee Club till” (${OTHER})`);
    expect(labelLinePlainText('Stamp Rally', m)).toBe(`Stamp Rally says: pay the fare for “1042” to “Coffee Club till” (${OTHER})`);
  });
});

describe('only for an exact match of the destination’s base account', () => {
  it('the M… form of a listed account: its name, the destination kept as the request has it', () => {
    const mux = muxedOf(OTHER);
    const m = matchOf(doc({ object: 'the fare' }), mux);
    expect(m.parts.at(-1)).toEqual({ kind: 'value', path: 'destination', value: { format: 'account', value: mux, text: 'Coffee Club till', source: 'partner_address_book' } });
    expect(sentencePlainText(m.parts)).toBe(`pay the fare to “Coffee Club till” (${mux})`);
  });

  it('with two listed accounts, the name of the one paid, never the other’s', () => {
    const json = doc({ object: 'the fare', book: [{ account: ISSUER, name: 'Bakery till' }, { account: OTHER, name: 'Coffee Club till' }] });
    expect(windowText(matchOf(json))).toBe('pay the fare to Coffee Club till');
    expect(windowText(matchOf(json, ISSUER))).toBe('pay the fare to Bakery till');
    expect(windowText(matchOf(json, muxedOf(ISSUER)))).toBe('pay the fare to Bakery till');
  });

  it('never for a payment that doesn’t match: an unlisted account (red), another memo (amber)', () => {
    const d = parsed(doc({ object: 'the fare' }));
    const unlisted = matchLabel(d, stellarReq(paymentTx({ destination: ISSUER })), {});
    expect(unlisted.ok).toBe(false);
    if (!unlisted.ok) expect(unlisted.reason).toBe('not_in_address_book');
    const amber = matchLabel(d, stellarReq(paymentTx({ memo: Memo.id('1042') })), {});
    expect(amber.ok).toBe(false);
    if (!amber.ok) expect(amber.reason).toBe('memo_mismatch');
    // A no-match carries no sentence and no value at all (the window shows Journear's line alone).
    expect(Object.keys(amber).sort()).toEqual(['at', 'ok', 'reason']);
  });

  it('an asset or amount refused is also no match, so no name', () => {
    const d = parsed(doc());
    expect(matchLabel(d, stellarReq(paymentTx({ asset: new Asset('EURC', ISSUER) })), {}).ok).toBe(false);
  });

  it('NEAR and Soroban sentences are unchanged: nothing is added to a sentence that isn’t a payment’s', () => {
    const [p] = previewLabelDocument(parsed(STAMPS_DOC_JSON), 'Stamp Trail');
    expect(p!.line).toBe('Stamp Trail says: collect the stamp “Arrival”');
  });
});

describe('one source: the preview says what a match says', () => {
  it('the preview’s line equals the plain form of a real match to the first listed account', () => {
    for (const o of [{}, { object: 'the fare' }, { object: 'the fare', memo: true }, { verb: 'buy', object: 'a ticket' }]) {
      const json = doc(o);
      const [p] = previewLabelDocument(parsed(json), 'Stamp Rally');
      // The preview's example memo is "1042", as the fixture's request carries.
      expect(p!.line).toBe(labelLinePlainText('Stamp Rally', matchOf(json)));
      expect(p!.parts.at(-2)).toEqual({ kind: 'word', text: paymentDestinationWord((o as { verb?: PartnerVerb }).verb ?? 'pay') });
      expect(p!.parts.at(-1)).toEqual({ kind: 'value', text: `“Coffee Club till” (${OTHER})` });
    }
  });

  it('the preview names the first listed G… account, skipping a contract (a classic payment can’t go to one)', () => {
    const contract = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
    const r = parseLabelDocument(JSON.stringify(doc({ book: [{ account: contract, name: 'Pool' }, { account: OTHER, name: 'Coffee Club till' }] })));
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(previewLabelDocument(r.document, 'Shop')[0]!.line).toBe(`Shop says: pay to “Coffee Club till” (${OTHER})`);
  });
});

describe('the sentence’s 40 characters of partner words count the name (D892 item 3, as D907 applies it)', () => {
  const name32 = 'Riverside Kiosk Coffee Club Till';
  it('the phrase and the longest name together at most 40', () => {
    expect([...name32].length).toBe(32);
    expect(SENTENCE_PARTNER_CHARS).toBe(40);
    expect(parseLabelDocument(JSON.stringify(doc({ name: name32 }))).ok).toBe(true);
    expect(parseLabelDocument(JSON.stringify(doc({ name: name32, object: 'the fare' }))).ok).toBe(true);
    const over = parseLabelDocument(JSON.stringify(doc({ name: name32, object: 'the fares' })));
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.errors).toEqual([expect.objectContaining({ code: 'sentence_text', path: 'display.formats.payment.intent.object' })]);
      expect(over.errors[0]!.message).toContain('address book');
    }
    // The longest of several names counts.
    const two = parseLabelDocument(JSON.stringify(doc({ object: 'the large breakfast', book: [{ account: OTHER, name: 'Till' }, { account: ISSUER, name: 'Coffee Club till two' }] })));
    expect(two.ok).toBe(false);
  });
});

describe('misleading names: what the text rules do (the same rules as the phrase, role addressName)', () => {
  it('refused, each with its rule', () => {
    const cases: [string, string][] = [
      ['your own account', 'text_you'],
      ['Your till', 'text_you'],
      ['My account', 'text_ownership'],
      ['Own till', 'text_ownership'],
      ['Journear', 'text_brand'],
      ['Journear fees', 'text_brand'],
      ['Passport top up', 'text_brand'],
      ['Hana desk', 'text_brand'],
      ['refund', 'text_claim'],
      ['Refund desk', 'text_claim'],
      ['Verified till', 'text_claim'],
      ['Safe account', 'text_claim'],
      ['Official till', 'text_claim'],
      ['GBX3KQ2MABCDEFGH', 'text_looks_like_address'],
      ['GBX3 KQ2M', 'text_looks_like_address'],
      ['0xabc', 'text_looks_like_address'],
      ['GD6R...QRSL', 'text_character'],
      ['till 12345', 'text_number'],
      ['USDC till', 'text_reviewed_name'],
      ['Coinbase', 'text_other_name'],
      ['Wallet', 'text_phishing'],
      ['Support desk', 'text_phishing'],
      ['Tap here', 'text_ui_word'],
      ['Rewards till', 'text_money_word'],
      ['Nobody', 'text_negation'],
      ['Coffee Club till by the river gate', 'text_too_long'],
    ];
    for (const [name, code] of cases) expect(partnerTextProblem(name, 'addressName')?.code, name).toBe(code);
  });

  it('allowed: ordinary names, and some that could still mislead (the attribution and Journear’s To row are what bound them)', () => {
    for (const name of ['Coffee Club till', 'Stamp Rally', 'a friend', 'the user', 'Escrow', 'Return to sender', 'Club treasury', 'Bakery till', 'GABC']) {
      expect(partnerTextProblem(name, 'addressName'), name).toBeNull();
    }
  });

  it('another listed account’s name: the same name twice is refused (compared folded); a look-alike spelling isn’t', () => {
    const dup = (a: string, b: string) => parseLabelDocument(JSON.stringify(doc({ book: [{ account: OTHER, name: a }, { account: ISSUER, name: b }] })));
    for (const [a, b] of [['Coffee Club till', 'Coffee Club till'], ['Coffee Club till', 'coffee club TILL'], ['Café till', 'Cafe till']] as const) {
      const r = dup(a, b);
      expect(r.ok, `${a} / ${b}`).toBe(false);
      if (!r.ok) expect(r.errors.map((e) => e.code)).toContain('duplicate');
    }
    expect(dup('Coffee Club till', 'Coffee Club tiIl').ok).toBe(true);
  });
});
