// D907: a matching classic payment's sentence ends with Journear's joining word for the verb and the address book's
// name of the destination ("pay the fare to Coffee Club till"), only for an exact match of the destination's base
// account; never for a payment that doesn't match. The plain form and the preview say the same; the parser holds the
// phrase and the longest name to the sentence's 40 characters, allows only the verbs that say the user sends money, and
// refuses an account whose secret key is public; and what the text rules do with misleading names (after PR 135's
// review).
import { Account, Asset, Memo, MuxedAccount } from '@stellar/stellar-base';
import { describe, expect, it } from 'vitest';
import { decodeApprovalRequest } from '../src/decode/request.ts';
import { type LabelMatch, type LabelRequest, labelLinePlainText, labelRequestOf, matchLabel, previewLabelDocument, sentencePlainText } from '../src/partner-labels/match.ts';
import { SENTENCE_PARTNER_CHARS, parseLabelDocument } from '../src/partner-labels/schema.ts';
import { partnerTextProblem } from '../src/partner-labels/text-rules.ts';
import { PARTNER_CONNECTORS, PARTNER_VERBS, PAYMENT_DESTINATION_WORDS, PAYMENT_VERBS, type PartnerVerb, paymentDestinationWord } from '../src/partner-labels/words.ts';
import { Keypair } from '@stellar/stellar-base';
import { PUBLIC_SEED_PREFIXES, isPublicSeedAccount } from '../src/partner-labels/public-accounts.ts';
import { OTHER, PAYMENT_DOC_JSON, STAMPS_DOC_JSON, parsed, paymentTx } from './partner-labels-fixtures.ts';
import { ISSUER, PASSPHRASE, USER } from './stellar-fixtures.ts';

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

/** A second listed account: a random public key no one has the secret key of. */
const BAKERY = 'GCVFJJYF75734IR7PQB2IOI3C3RDQ66D6OMVMJG2DRO4VBN66ODCE76B';

describe('the joining word, by verb (Journear’s word, from the joining-word list)', () => {
  it('only the verbs that say the user sends money; each has its word; every other verb is refused for a payment', () => {
    expect([...PAYMENT_VERBS].sort()).toEqual(['bid', 'buy', 'deposit', 'donate', 'lend', 'pay', 'repay', 'send', 'stake']);
    expect(Object.keys(PAYMENT_DESTINATION_WORDS).sort()).toEqual([...PAYMENT_VERBS].sort());
    for (const v of PAYMENT_VERBS) expect(PARTNER_CONNECTORS).toContain(PAYMENT_DESTINATION_WORDS[v]);
    for (const v of PARTNER_VERBS.filter((x) => !PAYMENT_VERBS.has(x))) {
      const r = parseLabelDocument(JSON.stringify(doc({ verb: v })));
      expect(r.ok, v).toBe(false);
      if (!r.ok) expect(r.errors.map((e) => `${e.code} ${e.path}`), v).toContain('bad_verb display.formats.payment.intent.verb');
    }
    // The five that would say the money comes the other way, with the plain message.
    for (const v of ['sell', 'borrow', 'withdraw', 'unstake', 'swap']) {
      const r = parseLabelDocument(JSON.stringify(doc({ verb: v })));
      if (r.ok) throw new Error(v);
      expect(r.errors[0]!.message).toBe(`"${v}" doesn’t fit a payment, where your user sends money to your account: use pay, send, donate, deposit, repay, lend, buy, stake or bid.`);
    }
    expect(paymentDestinationWord('collect' as PartnerVerb)).toBe('to');
  });

  it('the exact sentences, with an empty phrase and a filled one, for each verb', () => {
    const want: Record<string, [string, string]> = {
      pay: ['pay to Coffee Club till', 'pay the fare to Coffee Club till'],
      send: ['send to Coffee Club till', 'send the fare to Coffee Club till'],
      donate: ['donate to Coffee Club till', 'donate the fare to Coffee Club till'],
      deposit: ['deposit to Coffee Club till', 'deposit the fare to Coffee Club till'],
      repay: ['repay to Coffee Club till', 'repay the fare to Coffee Club till'],
      lend: ['lend to Coffee Club till', 'lend the fare to Coffee Club till'],
      buy: ['buy from Coffee Club till', 'buy the fare from Coffee Club till'],
      stake: ['stake with Coffee Club till', 'stake the fare with Coffee Club till'],
      bid: ['bid with Coffee Club till', 'bid the fare with Coffee Club till'],
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
    const json = doc({ object: 'the fare', book: [{ account: BAKERY, name: 'Bakery till' }, { account: OTHER, name: 'Coffee Club till' }] });
    expect(windowText(matchOf(json))).toBe('pay the fare to Coffee Club till');
    expect(windowText(matchOf(json, BAKERY))).toBe('pay the fare to Bakery till');
    expect(windowText(matchOf(json, muxedOf(BAKERY)))).toBe('pay the fare to Bakery till');
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
    const two = parseLabelDocument(JSON.stringify(doc({ object: 'the large breakfast', book: [{ account: OTHER, name: 'Till' }, { account: BAKERY, name: 'Coffee Club till two' }] })));
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
      ['Bank', 'text_other_name'],
      ['The bank', 'text_other_name'],
      ['Wallet', 'text_phishing'],
      ['Support desk', 'text_phishing'],
      ['Tap here', 'text_ui_word'],
      ['Nobody', 'text_negation'],
      ['Coffee Club till by the river gate', 'text_too_long'],
      // After PR 135's review: the people in a payment and money coming back.
      ['the user', 'text_self'],
      ['Users', 'text_self'],
      ['Me', 'text_self'],
      ['us', 'text_self'],
      ['We the club', 'text_self'],
      ['Our till', 'text_self'],
      ['this account', 'text_self'],
      ['This till', 'text_self'],
      ['Return to sender', 'text_self'],
      ['Back to sender', 'text_self'],
      ['Sender', 'text_self'],
      ['Account holder', 'text_self'],
      ['Returns desk', 'text_self'],
      ['Reversal', 'text_self'],
      ['Undo', 'text_self'],
      ['Chargeback', 'text_self'],
      // "says" (another speaker inside "{App} says:").
      ['Stamp Rally says', 'text_says'],
      ['Journear says', 'text_brand'],
      // Outcomes and lures, as for an order number.
      ['Paid', 'text_outcome'],
      ['Paid in full', 'text_outcome'],
      ['Done', 'text_outcome'],
      ['Success', 'text_outcome'],
      ['Complete', 'text_outcome'],
      ['Thanks', 'text_outcome'],
      ['Rewards till', 'text_outcome'],
      // Authorities.
      ['Police', 'text_authority'],
      ['Government', 'text_authority'],
      ['Tax office', 'text_authority'],
      ['Inland Revenue', 'text_authority'],
      ['Customs', 'text_authority'],
      ['Court', 'text_authority'],
      ['LHDN', 'text_authority'],
      // Wallets and exchanges added to the names list.
      ['Phantom', 'text_other_name'],
      ['Wend', 'text_other_name'],
      ['Bitget', 'text_other_name'],
    ];
    for (const [name, code] of cases) expect(partnerTextProblem(name, 'addressName')?.code, name).toBe(code);
  });

  it('the same self and "says" words in a phrase; the outcome and authority words only in a name', () => {
    for (const [phrase, code] of [['the order for me', 'text_self'], ['this ticket', 'text_self'], ['the return fare', 'text_self'], ['what the shop says', 'text_says']] as const) {
      expect(partnerTextProblem(phrase, 'object')?.code, phrase).toBe(code);
    }
    // An enumeration's label (the stamps' "Fare paid") and a row's label keep their rules.
    expect(partnerTextProblem('Fare paid', 'enumLabel')).toBeNull();
    expect(partnerTextProblem('Court booking', 'object')).toBeNull();
  });

  it('allowed: ordinary names, and some that could still mislead (the attribution and Journear’s To row are what bound them)', () => {
    for (const name of ['Coffee Club till', 'Stamp Rally', 'a friend', 'Escrow', 'Club treasury', 'Bakery till', 'Backstage bar', 'Theatre till', 'GABC', 'Tennis club', 'Wendy’s till']) {
      expect(partnerTextProblem(name, 'addressName'), name).toBeNull();
    }
  });

  it('another listed account’s name: the same name twice is refused, compared on how it reads (look-alike letters too)', () => {
    const dup = (a: string, b: string) => parseLabelDocument(JSON.stringify(doc({ book: [{ account: OTHER, name: a }, { account: BAKERY, name: b }] })));
    for (const [a, b] of [['Coffee Club till', 'Coffee Club till'], ['Coffee Club till', 'coffee club TILL'], ['Café till', 'Cafe till'], ['Coffee Club till', 'Coffee Club tiIl'], ['Coffee Club till', 'Coffee Club ti11'], ['Coffee Club till', 'CoffeeClub till'], ['Modern till', 'Modem till']] as const) {
      const r = dup(a, b);
      expect(r.ok, `${a} / ${b}`).toBe(false);
      if (!r.ok) expect(r.errors.map((e) => `${e.code} ${e.path}`)).toContain('duplicate metadata.addressBook[1].name');
    }
    expect(dup('Coffee Club till', 'Bakery till').ok).toBe(true);
  });
});

describe('an account whose secret key is public is never listed (after PR 135’s review)', () => {
  it('the list is every one-byte seed’s account and the all-zero key, derived again here', () => {
    const want = new Set<string>(['00000000']);
    for (let b = 0; b < 256; b++) want.add(Buffer.from(Keypair.fromRawEd25519Seed(Buffer.alloc(32, b)).rawPublicKey()).subarray(0, 4).toString('hex'));
    expect(new Set(PUBLIC_SEED_PREFIXES)).toEqual(want);
    for (const b of [0, 7, 9, 11, 21, 31, 0x1f, 255]) expect(isPublicSeedAccount(Keypair.fromRawEd25519Seed(Buffer.alloc(32, b)).publicKey()), String(b)).toBe(true);
    expect(isPublicSeedAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).toBe(true);
    for (const a of [OTHER, BAKERY, 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526', 'not an account', '']) expect(isPublicSeedAccount(a), a).toBe(false);
  });

  it('the parser refuses one in an address book, on a test or a live app, with a plain message; the one the console once suggested too', () => {
    const was = 'GBBQI276ICJLH2KJSTVNUFO4YIGYVKQHWZMP2OKU5OHA564L3SS55TZP';
    expect(Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x1f)).publicKey()).toBe(was);
    for (const passphrase of [PASSPHRASE, 'Public Global Stellar Network ; September 2015']) {
      const r = parseLabelDocument(JSON.stringify({ ...doc({ book: [{ account: was, name: 'Coffee Club till' }] }), context: { stellar: { networkPassphrase: passphrase } } }));
      if (r.ok) throw new Error('accepted');
      expect(r.errors).toEqual(expect.arrayContaining([{ code: 'public_account', path: 'metadata.addressBook[0].account', message: 'This is a test or example account whose secret key is public, so anyone can use it: list one of your own accounts.' }]));
    }
    // A Soroban document's address book too; a NEAR one has no Stellar accounts.
    expect(isPublicSeedAccount(Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey())).toBe(true);
  });
});
