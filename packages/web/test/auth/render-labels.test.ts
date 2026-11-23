// @vitest-environment happy-dom
// D896: a partner's label in the approval window (render-labels.ts, render-approval.ts). A request exactly as the
// app's label describes it gets the partner's box, after every warning box; nothing Journear says changes (the window
// without the box is byte for byte the window without labels). A described request that doesn't meet its description
// gets one line in Journear's voice (amber; red for a payment to an account the app hasn't listed), never the partner's
// words. Anything else, and anything Journear couldn't check (a NEAR or Soroban code hash, unread until a later piece;
// a NEAR network the vault didn't check), is the plain window, byte for byte.
import { type xdr, Asset, Keypair, Memo, Operation } from '@stellar/stellar-base';
import { decodeApprovalRequest } from '@hana-id/core/decode';
import { type LabelDocument, SOFT_VERBS, partnerAttribution } from '@hana-id/core/partner-labels';
import { beforeEach, describe, expect, it } from 'vitest';
import { dom } from '../../src/auth/dom.ts';
import { type ApprovalRenderContext, renderApproval } from '../../src/auth/render-approval.ts';
import { LABEL_DESTINATION_ROW, LABEL_MISMATCH, LABEL_NOT_LISTED, labelOutcome, windowLabelDocuments } from '../../src/auth/render-labels.ts';
import {
  GUESTBOOK_DOC_JSON,
  ISSUER,
  ME,
  OTHER,
  PASSPHRASE,
  PAYMENT_DOC_JSON,
  POOL,
  POOL_WASM,
  SOROBAN_DOC_JSON,
  STAMPS,
  STAMPS_DOC_JSON,
  STAMPS_HASH,
  TEST_USDC_SAC,
  USER,
  fn,
  nearDecoded,
  parsed,
  paymentTx,
} from '../../../core/test/partner-labels-fixtures.ts';
import { addr, i128, invocation, invokeOp, sourceAuth, txBytes } from '../../../core/test/stellar-fixtures.ts';
import { jargonWatch } from './plain-words.ts';

const watch = jargonWatch();
beforeEach(() => document.body.replaceChildren());

const APP = 'Coffee Club';
const CTX: ApprovalRenderContext = { envNetwork: 'testnet', testApp: true, address: USER };
const PAYMENT = parsed(PAYMENT_DOC_JSON);
const STAMPS_DOC = parsed(STAMPS_DOC_JSON);
const SOROBAN = parsed(SOROBAN_DOC_JSON);
const USDC_LOOKALIKE = new Asset('USDC', ISSUER);
const STRANGER = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(21) as never).publicKey();

const payment = (o: Parameters<typeof paymentTx>[0] = {}) => decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: paymentTx(o) });
const soroban = (fnName: string, args: xdr.ScVal[], contract = POOL) =>
  decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: txBytes([invokeOp(contract, fnName, args, [sourceAuth(invocation(contract, fnName, args))])]) });

type Decoded = ReturnType<typeof payment>;
const render = (decoded: Decoded, labels?: readonly LabelDocument[], ctx: Partial<ApprovalRenderContext> = {}, app = APP): HTMLElement =>
  watch(renderApproval(dom(document), decoded, app, { ...CTX, ...ctx, ...(labels ? { partnerLabels: labels } : {}) }));
/** The window as it is with labels, with `remove` taken out: what it would be if the label added nothing else. */
const without = (el: HTMLElement, remove: string): string => {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const n of Array.from(copy.querySelectorAll(remove))) n.remove();
  return copy.outerHTML;
};
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/gu, ' ').trim();
/** The NEAR facts the vault checks itself: a test app's relayed call on the env's network. */
const NEAR_CTX: Partial<ApprovalRenderContext> = { address: ME, labelFacts: { codeHash: STAMPS_HASH } };
const collect = (stamp = 'sponsored', o: { deposit?: bigint; gas?: bigint; extra?: string } = {}) => nearDecoded([fn('collect', `{"stamp":"${stamp}"${o.extra ?? ''}}`, { ...(o.deposit !== undefined ? { deposit: o.deposit } : {}), ...(o.gas !== undefined ? { gas: o.gas } : {}) })]);

describe('a classic payment exactly as described: the partner’s box', () => {
  it('“{App} says: …”, the attribution, the app’s rows; Journear’s verb and joining words plain, the rest set apart', () => {
    const el = render(payment(), [PAYMENT]);
    const box = el.querySelectorAll('div.partner-label');
    expect(box).toHaveLength(1);
    const says = box[0]!.querySelector('p.partner-says')!;
    expect(text(says)).toBe('Coffee Club says: pay for order 1042');
    expect(says.querySelector('strong.app-name')?.textContent).toBe(APP);
    // The verb and the joining word are Journear's, as plain text; the object phrase and the value are set apart.
    expect([...says.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent)).toEqual([' says: ', 'pay', ' for', ' ', ' ']);
    expect(says.querySelector('span.partner-words')?.textContent).toBe('order');
    expect(says.querySelector('code.partner-value')?.textContent).toBe('1042');
    expect(text(box[0]!.querySelector('p.partner-attribution'))).toBe(partnerAttribution(APP));
    expect(box[0]!.querySelector('p.partner-attribution strong.app-name')?.textContent).toBe(APP);
    // The app's rows: its field (the memo, the request's own value), and the destination as its address book names it,
    // with the account whole.
    const dts = [...box[0]!.querySelectorAll('dl.partner-fields dt')].map(text);
    const dds = [...box[0]!.querySelectorAll('dl.partner-fields dd')];
    expect(dts).toEqual(['Order', LABEL_DESTINATION_ROW]);
    expect(text(dds[0])).toBe('1042');
    expect(dds[1]!.querySelector('span.partner-words')?.textContent).toBe('Coffee Club till');
    expect(dds[1]!.querySelector('code.id-full')?.textContent).toBe(OTHER);
  });

  it('only adds: the window without the box is byte for byte the window without labels', () => {
    for (const o of [{}, { asset: USDC_LOOKALIKE }, { amount: '1', memo: Memo.text('A-77_x') }]) {
      const el = render(payment(o), [PAYMENT]);
      expect(el.querySelector('div.partner-label')).not.toBeNull();
      expect(without(el, 'div.partner-label')).toBe(render(payment(o)).outerHTML);
    }
  });

  it('comes after every warning box and Journear’s lines, before the request’s own facts (the memo row)', () => {
    // The look-alike USDC: Journear's amber line about the token stays where it is, above the partner's box.
    const el = render(payment({ asset: USDC_LOOKALIKE }), [PAYMENT]);
    const kids = [...el.children];
    const box = kids.findIndex((c) => c.matches('div.partner-label'));
    const amber = kids.findIndex((c) => c.matches('.risk-box'));
    expect(amber).toBeGreaterThan(-1);
    expect(box).toBeGreaterThan(amber);
    expect(box).toBeGreaterThan(kids.findIndex((c) => c.matches('h2.summary-headline')));
    expect(box).toBeGreaterThan(kids.findIndex((c) => c.matches('dl.summary-facts')));
    expect(kids[box + 1]?.textContent).toBe('Memo1042');
    expect(text(kids[amber])).toMatch(/^This is not the USDC Journear knows/u);
  });

  it('the partner’s words are only inside the box', () => {
    const el = render(payment(), [PAYMENT]);
    const outside = without(el, 'div.partner-label');
    for (const w of ['Coffee Club till', '>order<', 'says:', 'These are']) expect(outside).not.toContain(w);
  });
});

describe('the identity: no labels, or labels that describe nothing here, or that Journear couldn’t check', () => {
  const cases: [string, Decoded, readonly LabelDocument[], Partial<ApprovalRenderContext>][] = [
    ['a payment, a NEAR document (not described: another chain)', payment(), [STAMPS_DOC], {}],
    ['a payment, a Soroban document (not described: not a call)', payment(), [SOROBAN], {}],
    ['an account creation (not described: another operation)', decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: txBytes([Operation.createAccount({ destination: OTHER, startingBalance: '5' })]) }), [PAYMENT], {}],
    ['a NEAR call to the described contract, no code hash (couldn’t check, the only state today)', collect(), [STAMPS_DOC], { address: ME }],
    ['a NEAR call, a malformed code hash (couldn’t check)', collect(), [STAMPS_DOC], { address: ME, labelFacts: { codeHash: 'nope' } }],
    ['a live app’s relayed NEAR call: its network the vault didn’t check (couldn’t check)', collect(), [STAMPS_DOC], { ...NEAR_CTX, testApp: false }],
    ['a NEAR call on another network than the env’s (not described)', nearDecoded([fn('collect', '{"stamp":"sponsored"}')], { network: 'mainnet' }), [STAMPS_DOC], { ...NEAR_CTX, envNetwork: 'mainnet' }],
    ['a NEAR call to another contract (not described)', nearDecoded([fn('collect', '{"stamp":"sponsored"}')], { receiver: 'other.testnet' }), [STAMPS_DOC], NEAR_CTX],
    ['a NEAR call of another method (not described)', nearDecoded([fn('vote', '{}')]), [STAMPS_DOC], NEAR_CTX],
    ['a NEAR call to a reviewed contract (Journear reads it itself)', collect(), [STAMPS_DOC], { ...NEAR_CTX, reviewedNear: { stamps: STAMPS } }],
    ['a Soroban call, no Wasm hash (couldn’t check)', soroban('deposit', [addr(USER), i128(25_000_000n)]), [SOROBAN], {}],
    ['a Soroban call to another contract (not described)', soroban('deposit', [addr(USER), i128(25_000_000n)], TEST_USDC_SAC), [SOROBAN], { labelFacts: { codeHash: POOL_WASM } }],
  ];
  it.each(cases)('%s: the same window as without labels', (_, decoded, labels, ctx) => {
    const plain = render(decoded, undefined, ctx).outerHTML;
    const el = render(decoded, labels, ctx);
    expect(el.querySelector('div.partner-label, .partner-mismatch, .partner-not-listed')).toBeNull();
    expect(el.outerHTML).toBe(plain);
  });

  it('an EVM request, a message, typed data: no label can describe them (the plain window)', () => {
    const evm = decodeApprovalRequest({ kind: 'personal_sign', chain: 'evm', address: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23', context: {}, bytes: new TextEncoder().encode('hello') });
    expect(render(evm, [PAYMENT, STAMPS_DOC]).outerHTML).toBe(render(evm).outerHTML);
    expect(labelOutcome(evm, [PAYMENT], { user: '', networkChecked: false, reviewedNear: [] })).toEqual({ kind: 'none' });
  });
});

describe('a described request that doesn’t meet its description: one line in Journear’s voice, no partner words', () => {
  const MISMATCH = `${APP} describes this kind of request, but this one doesn’t match its description, so Journear isn’t showing it. Check it in ${APP} first.`;
  const NOT_LISTED = `This isn’t one of the accounts ${APP} has listed for payments. If you expected to pay ${APP}, don’t approve.`;
  const kinds: [string, Decoded][] = [
    ['more than the most it describes (out_of_bounds)', payment({ amount: '101' })],
    ['a token it doesn’t list (token_not_allowed)', payment({ asset: new Asset('ABC', ISSUER) })],
    ['another kind of memo (memo_mismatch)', payment({ memo: Memo.id('1042') })],
    ['a memo the window can’t show as an order number (value_not_displayable)', payment({ memo: Memo.text('order 1042') })],
    ['a memo with a hidden direction mark (value_not_displayable)', payment({ memo: Memo.text('‮2401') })],
    ['another operation besides it (more_than_one_action)', payment({ extra: [Operation.bumpSequence({ bumpTo: '99' })] })],
    ['from an account other than the user’s (source_not_user)', payment({ opSource: STRANGER })],
  ];
  it.each(kinds)('%s: the amber line, in full when it is the only one', (_, decoded) => {
    const el = render(decoded, [PAYMENT]);
    expect(el.querySelector('div.partner-label')).toBeNull();
    const line = el.querySelector('.risk-box .partner-mismatch');
    expect(line).not.toBeNull();
    expect(line!.closest('.risk-box')?.classList.contains('warning-box')).toBe(true);
    expect(text(line)).toBe(MISMATCH);
    expect(el.outerHTML).not.toContain('Coffee Club till');
    expect(el.outerHTML).not.toContain('>order<');
    // Everything else is the plain window: without its line (or its box, when it is the only line) it is the same.
    const plain = render(decoded).outerHTML;
    expect([without(el, '.risk-box.warning-box:has(> .body > .partner-mismatch:first-child)'), without(el, 'li.partner-mismatch')]).toContain(plain);
  });

  it('beside another amber line: Journear’s line keeps the lead, the mismatch is its bullet, last', () => {
    const el = render(payment({ asset: USDC_LOOKALIKE, memo: Memo.id('7') }), [PAYMENT]);
    const box = el.querySelector('.risk-box.warning-box')!;
    expect(text(box.querySelector('p.risk-lead'))).toMatch(/^This is not the USDC Journear knows/u);
    expect(text(box.querySelector('ul.risk-more > li:last-child'))).toBe(`Doesn’t match how ${APP} describes this kind of request`);
    expect(without(el, 'ul.risk-more')).toBe(render(payment({ asset: USDC_LOOKALIKE, memo: Memo.id('7') })).outerHTML);
  });

  it('a payment to an account the app hasn’t listed: the red lines, under the headline, announced', () => {
    const el = render(payment({ destination: STRANGER }), [PAYMENT]);
    expect(el.querySelector('div.partner-label')).toBeNull();
    const red = el.querySelector('.risk-box.danger-box');
    expect(red?.getAttribute('role')).toBe('alert');
    expect(text(red!.querySelector('p.risk-lead'))).toBe(NOT_LISTED);
    expect(red!.previousElementSibling?.matches('h2.summary-headline')).toBe(true);
    expect(el.outerHTML).not.toContain('Coffee Club till');
    expect(without(el, '.risk-box.danger-box')).toBe(render(payment({ destination: STRANGER })).outerHTML);
  });

  it('NEAR (with the code hash a later piece reads): every near miss is the amber line, after the acts-as-you line', () => {
    const misses: [string, Decoded][] = [
      ['a deposit', collect('sponsored', { deposit: 1n })],
      ['too much gas', collect('sponsored', { gas: 31n * 1_000_000_000_000n })],
      ['an argument it doesn’t declare', collect('sponsored', { extra: ',"x":1' })],
      ['a stamp it doesn’t list', collect('gold')],
      ['two actions', nearDecoded([fn('collect', '{"stamp":"sponsored"}'), fn('collect', '{"stamp":"arrival"}')])],
    ];
    for (const [what, decoded] of misses) {
      const el = render(decoded, [STAMPS_DOC], NEAR_CTX, 'Stamp Trail');
      expect(el.querySelector('div.partner-label'), what).toBeNull();
      expect(el.querySelector('.partner-mismatch'), what).not.toBeNull();
    }
    const changed = render(collect(), [STAMPS_DOC], { ...NEAR_CTX, labelFacts: { codeHash: GUESTBOOK_HASH() } }, 'Stamp Trail');
    expect(text(changed.querySelector('.risk-box.warning-box p.risk-lead'))).toMatch(/^This acts as you/u);
    expect(text(changed.querySelector('li.partner-mismatch'))).toBe('Doesn’t match how Stamp Trail describes this kind of request');
  });
});

/** Another contract's code hash (the contract changed since the label was written): the guestbook's. */
function GUESTBOOK_HASH(): string {
  return (parsed(GUESTBOOK_DOC_JSON).context as { codeHash: string }).codeHash;
}

describe('NEAR and Soroban rendering, with the facts a later piece reads (code hash) injected', () => {
  it('a relayed NEAR call: “Stamp Trail says: collect the stamp Fare paid” after the amber acts-as-you line', () => {
    const el = render(collect(), [STAMPS_DOC], NEAR_CTX, 'Stamp Trail');
    const box = el.querySelector('div.partner-label')!;
    expect(text(box.querySelector('p.partner-says'))).toBe('Stamp Trail says: collect the stamp Fare paid');
    expect(box.querySelector('span.partner-value.partner-words')?.textContent).toBe('Fare paid');
    expect(text(box.querySelector('dl.partner-fields'))).toBe('StampFare paid');
    const kids = [...el.children];
    expect(kids.indexOf(box)).toBeGreaterThan(kids.findIndex((c) => c.matches('.risk-box')));
    expect(without(el, 'div.partner-label')).toBe(render(collect(), undefined, NEAR_CTX, 'Stamp Trail').outerHTML);
  });

  it('the user’s own NEAR transaction on the env’s network is checked too (its block hash): the same box', () => {
    const el = render(nearDecoded([fn('collect', '{"stamp":"arrival"}')], { relayed: false }), [STAMPS_DOC], { ...NEAR_CTX, testApp: false }, 'Stamp Trail');
    expect(text(el.querySelector('p.partner-says'))).toBe('Stamp Trail says: collect the stamp Arrival');
  });

  it('a Soroban deposit: the amount as the app’s description of the request’s units, the user as “your account”', () => {
    const el = render(soroban('deposit', [addr(USER), i128(25_000_000n)]), [SOROBAN], { labelFacts: { codeHash: POOL_WASM } });
    const says = el.querySelector('p.partner-says')!;
    expect(text(says)).toBe('Coffee Club says: deposit 25,000,000 units, which Coffee Club says are 2.5 USDC from your account');
    expect([...el.querySelectorAll('dl.partner-fields dt')].map(text)).toEqual(['Amount', 'From']);
    expect(without(el, 'div.partner-label')).toBe(render(soroban('deposit', [addr(USER), i128(25_000_000n)])).outerHTML);
  });

  it('a Soroban payment to a listed account: its name set apart in the sentence, and in its row with the account whole', () => {
    const el = render(soroban('pay_to', [addr(TEST_USDC_SAC), addr(OTHER), i128(10_000_000n)]), [SOROBAN], { labelFacts: { codeHash: POOL_WASM } });
    expect(el.querySelector('p.partner-says span.partner-value.partner-words')?.textContent).toBe('Club treasury');
    const to = [...el.querySelectorAll('dl.partner-fields dd')][1]!;
    expect(to.querySelector('code.id-full')?.textContent).toBe(OTHER);
  });
});

describe('soft verbs only where no value moves', () => {
  it('a soft verb renders over a call that moves nothing (the stamps’ collect, no deposit)', () => {
    const el = render(collect(), [STAMPS_DOC], NEAR_CTX, 'Stamp Trail');
    const verb = STAMPS_DOC.formats.collect!.intent.verb;
    expect(SOFT_VERBS.has(verb)).toBe(true);
    expect(text(el.querySelector('p.partner-says'))).toContain(` says: ${verb} `);
  });

  it('a soft verb over a payment, or over a call that can attach NEAR, is refused when the window parses it: plain', () => {
    const softPayment = JSON.stringify({ ...PAYMENT_DOC_JSON, display: { formats: { payment: { ...PAYMENT_DOC_JSON.display.formats.payment, intent: { verb: 'join', object: 'order' } } } } });
    const softDeposit = JSON.stringify(STAMPS_DOC_JSON).replace('"gasAtMost"', '"deposit":{"atMost":"1000"},"gasAtMost"');
    expect(windowLabelDocuments([softPayment], 'testnet')).toEqual([]);
    expect(windowLabelDocuments([softDeposit], 'testnet')).toEqual([]);
    expect(render(payment(), windowLabelDocuments([softPayment], 'testnet')).outerHTML).toBe(render(payment()).outerHTML);
  });
});

describe('what the window takes from the vault (windowLabelDocuments)', () => {
  it('its own parse; the build’s network only; two documents for one contract, neither', () => {
    const t = JSON.stringify(PAYMENT_DOC_JSON);
    expect(windowLabelDocuments([t], 'testnet')).toHaveLength(1);
    expect(windowLabelDocuments([t], 'mainnet')).toEqual([]);
    expect(windowLabelDocuments([t, t.replace('"order"', '"ticket"')], 'testnet')).toEqual([]);
    expect(windowLabelDocuments([t, JSON.stringify(STAMPS_DOC_JSON)], 'testnet')).toHaveLength(2);
    expect(windowLabelDocuments(['not json', '{}', ''], 'testnet')).toEqual([]);
    expect(windowLabelDocuments(undefined, 'testnet')).toEqual([]);
  });
});

describe('hostile text: refused by the parser, or harmless inside the attributed box', () => {
  /** The payment document with one text replaced. */
  const doc = (o: { object?: string; name?: string; label?: string }) =>
    JSON.stringify({
      ...PAYMENT_DOC_JSON,
      metadata: { addressBook: [{ account: OTHER, name: o.name ?? 'Coffee Club till' }] },
      display: { formats: { payment: { ...PAYMENT_DOC_JSON.display.formats.payment, intent: { verb: 'pay', object: o.object ?? 'order' }, fields: [{ path: 'memo', label: o.label ?? 'Order', format: 'orderNumber' }] } } },
    });
  const refused: [string, string][] = [
    ['a bidi override in the object', doc({ object: 'order ‮redro' })],
    ['a bidi isolate in a name', doc({ name: 'Coffee⁧ Club' })],
    ['a zero-width space', doc({ object: 'ord​er' })],
    ['a Cyrillic look-alike letter', doc({ object: 'оrder' })],
    ['a Greek look-alike letter', doc({ name: 'Cοffee Club' })],
    ['full-width letters', doc({ object: 'ｏｒｄｅｒ' })],
    ['Journear’s name (its voice)', doc({ object: 'Journear checked order' })],
    ['Journear’s name in look-alike spelling', doc({ name: 'J0urnear till' })],
    ['the wallet’s name', doc({ name: 'Passport desk' })],
    ['a claim of being checked', doc({ object: 'verified order' })],
    ['a claim of safety', doc({ object: 'safe order' })],
    ['a claim of no cost', doc({ object: 'free coffee' })],
    ['the window’s own words (a fake instruction)', doc({ object: 'order then press Approve' })],
    ['a fake warning', doc({ label: 'Warning' })],
    ['a fake red-box word', doc({ object: 'red alert order' })],
    ['a fake amount with a coin', doc({ object: '25 XLM order' })],
    ['a fake amount with a ticker', doc({ name: 'USDC refund desk' })],
    ['a long number', doc({ object: 'order 100000' })],
    ['an amount in words', doc({ object: 'one thousand coffees' })],
    ['an account written as text', doc({ name: 'GBX3 KQ2M' })],
    ['“your account”', doc({ name: 'your account' })],
    ['a link', doc({ object: 'www order' })],
    ['quotation marks (to close a quote)', doc({ object: 'order” it is safe “' })],
    ['markup', doc({ object: '<b>order</b>' })],
    ['a line break', doc({ object: 'order\nApprove' })],
    ['a negation (“nothing moves”)', doc({ object: 'nothing order' })],
    ['a check mark', doc({ name: '✓ Coffee Club' })],
    ['an emoji', doc({ object: 'order 🔒' })],
    ['too long', doc({ object: 'a very long order phrase that goes on and on' })],
  ];
  it.each(refused)('%s: refused at delivery, so the window is plain', (_, t) => {
    expect(windowLabelDocuments([t], 'testnet')).toEqual([]);
    expect(render(payment(), windowLabelDocuments([t], 'testnet')).outerHTML).toBe(render(payment()).outerHTML);
  });

  it('a phrase the rules let through renders only inside the box, attributed, in the normal style', () => {
    const odd = doc({ object: 'the danger zone order', name: 'Riverside Kiosk Coffee Club Till', label: 'Kiosk order reference' });
    const docs = windowLabelDocuments([odd], 'testnet');
    expect(docs).toHaveLength(1);
    const el = render(payment(), docs);
    const box = el.querySelector('div.partner-label')!;
    expect(text(box)).toContain('the danger zone order');
    expect(text(box)).toContain('Riverside Kiosk Coffee Club Till');
    expect(box.closest('.jp-alert')).toBeNull();
    expect(box.querySelector('.jp-alert, svg, [role="alert"]')).toBeNull();
    expect(without(el, 'div.partner-label')).toBe(render(payment()).outerHTML);
  });

  it('a request’s own memo that reads like Journear’s words is the request’s value: in mono inside the box, and in the Memo row as today', () => {
    const el = render(payment({ memo: Memo.text('Journear-checked') }), [PAYMENT]);
    const box = el.querySelector('div.partner-label')!;
    expect(box.querySelector('p.partner-says code.partner-value')?.textContent).toBe('Journear-checked');
    expect(text(box.querySelector('p.partner-attribution'))).toBe(partnerAttribution(APP));
    expect(without(el, 'div.partner-label')).toBe(render(payment({ memo: Memo.text('Journear-checked') })).outerHTML);
  });
});

describe('the window’s own sentences', () => {
  it('as recorded in D896, with the app’s name', () => {
    const app = { kind: 'app' };
    expect(LABEL_MISMATCH.full).toEqual([app, ' describes this kind of request, but this one doesn’t match its description, so Journear isn’t showing it. Check it in ', app, ' first.']);
    expect(LABEL_MISMATCH.short).toEqual(['Doesn’t match how ', app, ' describes this kind of request']);
    expect(LABEL_NOT_LISTED.full).toEqual(['This isn’t one of the accounts ', app, ' has listed for payments. If you expected to pay ', app, ', don’t approve.']);
    expect(LABEL_NOT_LISTED.short).toEqual(['Not one of the accounts ', app, ' has listed for payments']);
    expect(partnerAttribution(APP)).toBe('These are Coffee Club’s words. Journear hasn’t checked them.');
  });
});

describe('plain words (D853) in the module’s own sentences', () => {
  it('no sentence of render-labels.ts holds a banned word', async () => {
    const { readFileSync } = await import('node:fs');
    const { jargonIn, sentencesIn } = await import('@hana-id/brand/plain-words');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src/auth/render-labels.ts'), 'utf8');
    const sentences = sentencesIn(src);
    expect(sentences.length).toBeGreaterThan(0);
    expect(sentences.filter((s) => jargonIn(s).length > 0)).toEqual([]);
  });
});
