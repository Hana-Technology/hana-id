// @vitest-environment happy-dom
// D896 (as amended after PR 123's review): a partner's label in the approval window (render-labels.ts,
// render-approval.ts). A request exactly as the app's label describes it gets the partner's box after everything
// Journear says (its facts, every warning box and every note of any source), with only the folded details below it;
// nothing Journear says changes (the window without the box is byte for byte the window without labels). A described
// request that doesn't meet its description gets one line in Journear's voice (amber; red for any value the user's
// account sends to an account the app hasn't listed), never the partner's words. Anything else, and anything Journear
// couldn't check (D900: a NEAR code hash the vault didn't agree on; a Soroban transaction whose footprint names no one
// code; an authorization entry; a NEAR network the vault didn't check), is the plain window, byte for byte.
import { xdr, Account, Asset, Claimant, Keypair, Memo, MuxedAccount, Operation, TransactionBuilder } from '@stellar/stellar-base';
import { decodeApprovalRequest } from '@hana-id/core/decode';
import { type LabelDocument, SOFT_VERBS, partnerAttribution } from '@hana-id/core/partner-labels';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dom } from '../../src/auth/dom.ts';
import { alert } from '../../src/auth/ui.ts';
import { type ApprovalRenderContext, guardedLabelBox, renderApproval } from '../../src/auth/render-approval.ts';
import { LABEL_MISMATCH, LABEL_NOT_LISTED, labelBoxName, labelOutcome, windowLabelDocuments } from '../../src/auth/render-labels.ts';
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
import { ROUTER, accountKey, addr, authPreimageBytes, callFootprint, dataKeyOf, feeBumpBytes, i128, invocation, invokeOp, sourceAuth, txBytes } from '../../../core/test/stellar-fixtures.ts';
import { jargonWatch } from './plain-words.ts';

const watch = jargonWatch();
beforeEach(() => document.body.replaceChildren());
afterEach(() => vi.restoreAllMocks());

const APP = 'Coffee Club';
const CTX: ApprovalRenderContext = { envNetwork: 'testnet', testApp: true, address: USER };
const PAYMENT = parsed(PAYMENT_DOC_JSON);
const STAMPS_DOC = parsed(STAMPS_DOC_JSON);
const SOROBAN = parsed(SOROBAN_DOC_JSON);
const USDC_LOOKALIKE = new Asset('USDC', ISSUER);
const STRANGER = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(21) as never).publicKey();
const muxedOf = (g: string, id = '7') => new MuxedAccount(new Account(g, '0'), id).accountId();

const stellar = (bytes: Uint8Array) => decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes });
const payment = (o: Parameters<typeof paymentTx>[0] = {}) => stellar(paymentTx(o));
/** A Soroban call; `code` is the one Wasm hash its footprint declares (D900: the transaction's own code), none by default. */
const soroban = (fnName: string, args: xdr.ScVal[], contract = POOL, code: string | readonly string[] | null = null, writes: xdr.LedgerKey[] = []) =>
  stellar(txBytes([invokeOp(contract, fnName, args, [sourceAuth(invocation(contract, fnName, args))])], code === null ? {} : { soroban: callFootprint(contract, code, writes) }));

type Decoded = ReturnType<typeof payment>;
const render = (decoded: Decoded, labels?: readonly LabelDocument[], ctx: Partial<ApprovalRenderContext> = {}, app = APP): HTMLElement =>
  watch(renderApproval(dom(document), decoded, app, { ...CTX, ...ctx, ...(labels ? { partnerLabels: labels } : {}) })) as HTMLElement;
/** The window as it is with labels, with `remove` taken out: what it would be if the label added nothing else. */
const without = (el: HTMLElement, remove: string): string => {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const n of Array.from(copy.querySelectorAll(remove))) n.remove();
  // A box's list of bullets that held only the removed one goes with it.
  for (const ul of Array.from(copy.querySelectorAll('ul.risk-more'))) if (!ul.firstElementChild) ul.remove();
  return copy.outerHTML;
};
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/gu, ' ').trim();
/** The NEAR fact the vault reads (D900: the code hash both providers agreed on), as it sends it. */
const NEAR_CTX: Partial<ApprovalRenderContext> = { address: ME, labelFacts: { near: { account: STAMPS, codeHash: STAMPS_HASH } } };
const collect = (stamp = 'sponsored', o: { deposit?: bigint; gas?: bigint; extra?: string } = {}) => nearDecoded([fn('collect', `{"stamp":"${stamp}"${o.extra ?? ''}}`, { ...(o.deposit !== undefined ? { deposit: o.deposit } : {}), ...(o.gas !== undefined ? { gas: o.gas } : {}) })]);

describe('a classic payment exactly as described: the partner’s box', () => {
  it('“{App} says: …” and the attribution, a group named for screen readers; no row repeats a value the sentence shows', () => {
    const el = render(payment(), [PAYMENT]);
    const box = el.querySelectorAll('div.partner-label');
    expect(box).toHaveLength(1);
    expect(box[0]!.getAttribute('role')).toBe('group');
    expect(box[0]!.getAttribute('aria-label')).toBe(labelBoxName(APP));
    expect(labelBoxName(APP)).toBe('What Coffee Club says');
    const says = box[0]!.querySelector('p.partner-says')!;
    // D907: the sentence ends with Journear's joining word and the address book's name of the destination.
    expect(text(says)).toBe('Coffee Club says: pay for order 1042 to Coffee Club till');
    expect(says.querySelector('strong.app-name')?.textContent).toBe(APP);
    // The verb and the joining words are Journear's, as plain text; the object phrase and each value are set apart.
    expect([...says.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent)).toEqual([' says: ', 'pay', ' for', ' ', ' ', ' to', ' ']);
    expect([...says.querySelectorAll('span.partner-words')].map((n) => n.textContent)).toEqual(['order', 'Coffee Club till']);
    expect(says.querySelector('code.partner-value')?.textContent).toBe('1042');
    // The name is a partner value like every other: its own outlined span (direction isolated by approval.css), text only.
    const name = says.lastElementChild!;
    expect(name.matches('span.partner-value.partner-words')).toBe(true);
    expect(name.childNodes).toHaveLength(1);
    expect(name.firstChild!.nodeType).toBe(3);
    expect(text(box[0]!.querySelector('p.partner-attribution'))).toBe(partnerAttribution(APP));
    // The memo is in the sentence: no "Order" row; and no partner "To" row beside Journear's own: the name is only in
    // the partner's sentence, and the box holds no account.
    expect(box[0]!.querySelector('dl')).toBeNull();
    expect(text(box[0]!)).not.toContain(OTHER);
    expect(el.querySelectorAll('div.partner-label ~ * span.partner-words, dl.id-rows span.partner-words')).toHaveLength(0);
    // Journear's own "To" row, above the box, is the account whole, as without labels.
    const rowsAbove = el.querySelector('dl.id-rows')!;
    expect(text(rowsAbove)).toContain(OTHER);
    expect(text(rowsAbove)).not.toContain('Coffee Club till');
    expect(rowsAbove.compareDocumentPosition(box[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(el.outerHTML.split('Coffee Club till')).toHaveLength(2);
  });

  it('D907: every verb a payment may use, with no phrase and with one: Journear’s joining word, then the name', () => {
    // After PR 135's review a payment may use only these verbs (sell, borrow, withdraw, unstake and swap are refused).
    const want: Record<string, string> = { pay: 'to', send: 'to', donate: 'to', deposit: 'to', lend: 'to', repay: 'to', buy: 'from', bid: 'with', stake: 'with' };
    for (const [verb, word] of Object.entries(want)) {
      for (const object of [undefined, 'the fare']) {
        const docOf = parsed({ ...PAYMENT_DOC_JSON, display: { formats: { payment: { call: { memo: 'text', assets: ['native'] }, intent: { verb, ...(object ? { object } : {}) }, sentence: object ? ['verb', 'object'] : ['verb'], fields: [{ path: 'memo', label: 'Order', format: 'orderNumber' }] } } } });
        const says = render(payment(), [docOf]).querySelector('div.partner-label p.partner-says');
        expect(text(says), verb).toBe(`Coffee Club says: ${verb}${object ? ` ${object}` : ''} ${word} Coffee Club till`);
      }
    }
  });

  it('only adds: the window without the box is byte for byte the window without labels', () => {
    for (const o of [{}, { asset: USDC_LOOKALIKE }, { amount: '1', memo: Memo.text('A-77_x') }, { destination: muxedOf(OTHER) }]) {
      const el = render(payment(o), [PAYMENT]);
      expect(el.querySelector('div.partner-label')).not.toBeNull();
      expect(without(el, 'div.partner-label')).toBe(render(payment(o)).outerHTML);
    }
  });

  it('item 1: after everything Journear says, every alert of every source included; only the details below it', () => {
    // Every alert source the window has: the red box and the amber box (the request's), an alert among the request's own
    // facts, and the page's notes: the test-app note (blue), the mainnet demo's banner (red), the out-of-policy line
    // (amber). (A box that overflows gets its line beside its message, among the request's facts, after rendering.)
    const d = dom(document);
    const notes = [alert(d, 'info', { class: 'note test-app' }, 'test app'), alert(d, 'danger', { tag: 'div', class: 'mainnet-demo' }, 'demo'), alert(d, 'warning', { class: 'note out-of-policy' }, 'out of policy')];
    const el = render(payment({ asset: USDC_LOOKALIKE }), [PAYMENT], { notes });
    const kids = [...el.children];
    const box = kids.findIndex((c) => c.matches('div.partner-label'));
    expect(box).toBe(kids.length - 2);
    expect(kids[box + 1]!.matches('details.request-details')).toBe(true);
    expect(box).toBeGreaterThanOrEqual(0);
    for (const n of notes) {
      const at = kids.indexOf(n);
      expect(at, n.textContent ?? '').toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(box);
    }
    // EVERY risk box, wherever it is: above the box (and there is at least one here).
    const risks = [...el.querySelectorAll('.risk-box')];
    expect(risks.length).toBeGreaterThan(0);
    for (const r of risks) expect(r.compareDocumentPosition(kids[box]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Journear's facts for the request (the memo row) are above the box too.
    const memo = kids.findIndex((c) => c.textContent === 'Memo1042');
    expect(memo).toBeGreaterThanOrEqual(0);
    expect(memo).toBeLessThan(box);
  });

  it('a label never adds, drops or changes a warning: the alerts with labels present are the alerts without (count and text)', () => {
    const alertsOf = (el: HTMLElement) => [...el.querySelectorAll('.risk-box, [role="alert"], .jp-alert, .alert')].filter((n) => !n.closest('div.partner-label')).map((n) => n.textContent);
    for (const o of [{}, { asset: USDC_LOOKALIKE }, { amount: '1', memo: Memo.text('A-77_x') }, { destination: muxedOf(OTHER) }]) {
      const d = dom(document);
      const notes = () => [alert(d, 'info', { class: 'note test-app' }, 'test app'), alert(d, 'warning', { class: 'note out-of-policy' }, 'out of policy')];
      const withLabels = alertsOf(render(payment(o), [PAYMENT], { notes: notes() }));
      const without = alertsOf(render(payment(o), [], { notes: notes() }));
      expect(withLabels.length).toBeGreaterThan(0);
      expect(withLabels).toEqual(without);
    }
  });

  it('a box that throws while it is built leaves the window plain (no box, no failure)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(guardedLabelBox(() => {
      throw new Error('boom: the stamp');
    })).toBeNull();
    expect(warn).toHaveBeenCalledWith('partner label skipped: it could not be shown');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('stamp');
    warn.mockRestore();
  });
});

describe('the identity: no labels, or labels that describe nothing here, or that Journear couldn’t check', () => {
  const args = [addr(USER), i128(25_000_000n)];
  const cases: [string, Decoded, readonly LabelDocument[], Partial<ApprovalRenderContext>][] = [
    ['a payment, a NEAR document (another chain)', payment(), [STAMPS_DOC], {}],
    ['a payment, a Soroban document (not this contract)', payment(), [SOROBAN], {}],
    ['a trust line and a sequence bump, a payment and a Soroban document (nothing moves to anyone)', stellar(txBytes([Operation.changeTrust({ asset: USDC_LOOKALIKE }), Operation.bumpSequence({ bumpTo: '9' })])), [PAYMENT, SOROBAN], {}],
    ['a swap back to the user’s own account', stellar(txBytes([Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: '1', destination: USER, destAsset: USDC_LOOKALIKE, destMin: '1', path: [] })])), [PAYMENT], {}],
    ['a payment from another account than the user’s', payment({ opSource: STRANGER, destination: STRANGER }), [PAYMENT], {}],
    ['a fee-bumped payment that would match', stellar(feeBumpBytes(paymentTx())), [PAYMENT], {}],
    ['a fee-bumped payment to an unlisted account (not described yet)', stellar(feeBumpBytes(paymentTx({ destination: STRANGER }))), [PAYMENT], {}],
    // After PR 123's second review: value moves the payment rule doesn't cover (listed in D896): plain, byte for byte.
    ['a payment document over an offer (manageSellOffer)', stellar(txBytes([Operation.manageSellOffer({ selling: Asset.native(), buying: USDC_LOOKALIKE, amount: '50', price: '1' })])), [PAYMENT], {}],
    ['a payment document over a liquidity pool deposit', stellar(txBytes([Operation.liquidityPoolDeposit({ liquidityPoolId: 'ab'.repeat(32), maxAmountA: '10', maxAmountB: '10', minPrice: '0.5', maxPrice: '2' })])), [PAYMENT], {}],
    ['a payment document over setOptions (a signer change)', stellar(txBytes([Operation.setOptions({ signer: { ed25519PublicKey: STRANGER, weight: 10 } })])), [PAYMENT], {}],
    ['a payment document over a Soroban token transfer', stellar(txBytes([invokeOp(TEST_USDC_SAC, 'transfer', [addr(USER), addr(STRANGER), i128(1_000_000n)], [sourceAuth(invocation(TEST_USDC_SAC, 'transfer', [addr(USER), addr(STRANGER), i128(1_000_000n)]))])])), [PAYMENT], {}],
    ['a router swap on another contract, its authorization reaching the described one', stellar(txBytes([invokeOp(ROUTER, 'swap', args, [sourceAuth(invocation(ROUTER, 'swap', args, [invocation(POOL, 'deposit', args)]))])])), [SOROBAN], {}],
    ['a NEAR call to the described contract, no code hash (the vault’s providers didn’t agree, or couldn’t be read)', collect(), [STAMPS_DOC], { address: ME }],
    ['a NEAR call to the described contract, the vault’s code hash for another account', collect(), [STAMPS_DOC], { address: ME, labelFacts: { near: { account: 'other.testnet', codeHash: STAMPS_HASH } } }],
    ['a NEAR call with a deposit and two actions, no code hash', nearDecoded([fn('collect', '{"stamp":"gold"}', { deposit: 5n }), fn('collect', '{}')]), [STAMPS_DOC], { address: ME }],
    ['a NEAR call, the vault’s hash all 1s (no program of its own, or a global contract): couldn’t check', collect(), [STAMPS_DOC], { address: ME, labelFacts: { near: { account: STAMPS, codeHash: '1'.repeat(32) } } }],
    ['a NEAR call of a method the document doesn’t describe, another code (what it is comes first)', nearDecoded([fn('vote', '{}')]), [STAMPS_DOC], { address: ME, labelFacts: { near: { account: STAMPS, codeHash: (parsed(GUESTBOOK_DOC_JSON).context as { codeHash: string }).codeHash } } }],
    ['a Soroban call from another account, the right code', stellar(txBytes([invokeOp(POOL, 'deposit', args, [sourceAuth(invocation(POOL, 'deposit', args))])], { source: STRANGER, soroban: callFootprint(POOL, POOL_WASM) })), [SOROBAN], {}],
    ['a Soroban call from another account, another code (still plain, never amber)', stellar(txBytes([invokeOp(POOL, 'deposit', args, [sourceAuth(invocation(POOL, 'deposit', args))])], { source: STRANGER, soroban: callFootprint(POOL, 'cd'.repeat(32)) })), [SOROBAN], {}],
    ['a Soroban call of an undescribed function, another code', soroban('withdraw', args, POOL, 'cd'.repeat(32)), [SOROBAN], {}],
    ['a NEAR call, a malformed code hash', collect(), [STAMPS_DOC], { address: ME, labelFacts: { near: { account: STAMPS, codeHash: 'nope' } } }],
    ['a live app’s relayed NEAR call: its network the vault didn’t check', collect(), [STAMPS_DOC], { ...NEAR_CTX, testApp: false }],
    ['a NEAR call on another network than the env’s', nearDecoded([fn('collect', '{"stamp":"sponsored"}')], { network: 'mainnet' }), [STAMPS_DOC], { ...NEAR_CTX, envNetwork: 'mainnet' }],
    ['a NEAR call to another contract', nearDecoded([fn('collect', '{"stamp":"sponsored"}')], { receiver: 'other.testnet' }), [STAMPS_DOC], NEAR_CTX],
    ['a NEAR call of another method', nearDecoded([fn('vote', '{}')]), [STAMPS_DOC], NEAR_CTX],
    ['a NEAR call to a reviewed contract (Journear reads it itself)', collect(), [STAMPS_DOC], { ...NEAR_CTX, reviewedNear: { stamps: STAMPS } }],
    ['a Soroban call, no footprint (no Wasm hash)', soroban('deposit', args), [SOROBAN], {}],
    ['a Soroban call whose footprint names no code', stellar(txBytes([invokeOp(POOL, 'deposit', args, [sourceAuth(invocation(POOL, 'deposit', args))])], { soroban: callFootprint(POOL, null) })), [SOROBAN], {}],
    ['a Soroban call whose footprint names two codes', soroban('deposit', args, POOL, [POOL_WASM, 'cd'.repeat(32)]), [SOROBAN], {}],
    ['a Soroban authorization entry (no footprint: never tied to code)', decodeApprovalRequest({ kind: 'stellar_auth_entry', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: authPreimageBytes(invocation(POOL, 'deposit', args)) }), [SOROBAN], {}],
    ['a Soroban call, the vault’s NEAR fact ignored', soroban('deposit', args), [SOROBAN], { labelFacts: { near: { account: POOL, codeHash: STAMPS_HASH } } }],
    ['a Soroban call of another function with an extra operation, no Wasm hash', stellar(txBytes([invokeOp(POOL, 'withdraw', args), Operation.bumpSequence({ bumpTo: '9' })])), [SOROBAN], {}],
    ['a Soroban call to another contract', soroban('deposit', args, TEST_USDC_SAC, POOL_WASM), [SOROBAN], {}],
  ];
  it.each(cases)('%s: the same window as without labels', (_, decoded, labels, ctx) => {
    const plain = render(decoded, undefined, ctx).outerHTML;
    const el = render(decoded, labels, ctx);
    expect(el.querySelector('div.partner-label, .partner-mismatch, .partner-not-listed')).toBeNull();
    expect(el.outerHTML).toBe(plain);
  });

  it('an EVM request, a message: no label can describe them (the plain window)', () => {
    const evm = decodeApprovalRequest({ kind: 'personal_sign', chain: 'evm', address: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23', context: {}, bytes: new TextEncoder().encode('hello') });
    expect(render(evm, [PAYMENT, STAMPS_DOC]).outerHTML).toBe(render(evm).outerHTML);
    expect(labelOutcome(evm, [PAYMENT], { user: '', networkChecked: false, reviewedNear: [] })).toEqual({ kind: 'none' });
  });

  it('item 8: a document that throws when read is no label: the plain window, a warning without any of its text', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const hostile = {
      get context(): never {
        throw new Error('Coffee Club till secret text');
      },
    } as unknown as LabelDocument;
    const el = render(payment(), [hostile]);
    expect(el.outerHTML).toBe(render(payment()).outerHTML);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Coffee|secret/u);
  });
});

describe('a described request that doesn’t meet its description: one line in Journear’s voice, no partner words', () => {
  const MISMATCH = `${APP} describes this kind of request, but this one doesn’t match, so Journear isn’t showing ${APP}’s description. If you’re not sure what this does, reject it.`;
  const NOT_LISTED = `This isn’t one of the accounts ${APP} has listed for payments. If you expected to pay ${APP}, don’t approve.`;
  const kinds: [string, Decoded][] = [
    ['more than the most it describes (out_of_bounds)', payment({ amount: '101' })],
    ['a token it doesn’t list (token_not_allowed)', payment({ asset: new Asset('ABC', ISSUER) })],
    ['another kind of memo (memo_mismatch)', payment({ memo: Memo.id('1042') })],
    ['a memo the window can’t show as an order number (value_not_displayable)', payment({ memo: Memo.text('order 1042') })],
    ['a memo with a hidden direction mark (value_not_displayable)', payment({ memo: Memo.text('‮2401') })],
    ['a memo that reads as an amount (value_not_displayable)', payment({ memo: Memo.text('1XLM') })],
    ['a memo that reads as Journear’s words (value_not_displayable)', payment({ memo: Memo.text('Journear-verified') })],
    ['a memo that reads as a claim (value_not_displayable)', payment({ memo: Memo.text('Free') })],
    ['another operation besides it (more_than_one_action)', payment({ extra: [Operation.bumpSequence({ bumpTo: '99' })] })],
    ['a path payment to the listed till (operation_mismatch)', stellar(txBytes([Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: '1', destination: OTHER, destAsset: USDC_LOOKALIKE, destMin: '1', path: [] })]))],
  ];
  it.each(kinds)('%s: the amber line, in full when it is the only one', (_, decoded) => {
    const el = render(decoded, [PAYMENT]);
    expect(el.querySelector('div.partner-label')).toBeNull();
    const line = el.querySelector('.risk-box .partner-mismatch');
    expect(line).not.toBeNull();
    expect(line!.closest('.risk-box')?.classList.contains('warning-box')).toBe(true);
    if (line!.matches('p.risk-lead')) expect(text(line)).toBe(MISMATCH);
    else expect(text(line)).toBe(`Doesn’t match how ${APP} describes this kind of request`);
    expect(el.outerHTML).not.toContain('Coffee Club till');
    expect(el.outerHTML).not.toContain('>order<');
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

  const unlisted: [string, Decoded][] = [
    ['a payment', payment({ destination: STRANGER })],
    ['a payment to an unlisted account’s M… form', payment({ destination: muxedOf(STRANGER) })],
    ['a strict-send path payment', stellar(txBytes([Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: '1', destination: STRANGER, destAsset: USDC_LOOKALIKE, destMin: '1', path: [] })]))],
    ['a strict-receive path payment', stellar(txBytes([Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: '1', destination: STRANGER, destAsset: USDC_LOOKALIKE, destAmount: '1', path: [] })]))],
    ['an account creation', stellar(txBytes([Operation.createAccount({ destination: STRANGER, startingBalance: '5' })]))],
    ['a merge of the account', stellar(txBytes([Operation.accountMerge({ destination: STRANGER })]))],
    ['a claimable balance', stellar(txBytes([Operation.createClaimableBalance({ asset: Asset.native(), amount: '1', claimants: [new Claimant(STRANGER)] })]))],
    ['a payment to the till, then one to an unlisted account', stellar(txBytes([Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '1' }), Operation.payment({ destination: STRANGER, asset: Asset.native(), amount: '1' })]))],
  ];
  it.each(unlisted)('item 2: %s to an account the app hasn’t listed: the red line, announced, no partner words', (_, decoded) => {
    const el = render(decoded, [PAYMENT]);
    expect(el.querySelector('div.partner-label')).toBeNull();
    const red = el.querySelector('.risk-box.danger-box');
    expect(red?.getAttribute('role')).toBe('alert');
    const line = red!.querySelector('.partner-not-listed');
    expect(line).not.toBeNull();
    if (line!.matches('p.risk-lead')) {
      expect(text(line)).toBe(NOT_LISTED);
      expect(red!.previousElementSibling?.matches('h2.summary-headline')).toBe(true);
      expect(without(el, '.risk-box.danger-box')).toBe(render(decoded).outerHTML);
    } else {
      // Beside another red line (a merge's own danger line): its bullet, last; the lead stays Journear's.
      expect(text(line)).toBe(`Not one of the accounts ${APP} has listed for payments`);
      expect(without(el, 'li.partner-not-listed')).toBe(render(decoded).outerHTML);
    }
    expect(el.outerHTML).not.toContain('Coffee Club till');
  });

  it('item 6: the user’s account as an M… source is the user (the payment matches, the box shows)', () => {
    const noMemo = parsed({ ...PAYMENT_DOC_JSON, display: { formats: { payment: { call: { memo: 'none', assets: ['native'] }, intent: { verb: 'pay', object: 'order' }, sentence: ['verb', 'object'], fields: [] } } } });
    const tx = new TransactionBuilder(new MuxedAccount(new Account(USER, '41'), '3'), { fee: '100', networkPassphrase: PASSPHRASE })
      .addOperation(Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '25' }))
      .setTimebounds(10, 2000)
      .build();
    const el = render(stellar(new Uint8Array(tx.toEnvelope().toXDR())), [noMemo]);
    expect(text(el.querySelector('p.partner-says'))).toBe('Coffee Club says: pay order to Coffee Club till');
  });

  it('the commit review: a listed account’s M… form is not red, and nothing in the box contradicts Journear’s own row', () => {
    const m = muxedOf(OTHER);
    const el = render(payment({ destination: m }), [PAYMENT]);
    expect(el.querySelector('.partner-not-listed, .partner-mismatch')).toBeNull();
    const box = el.querySelector('div.partner-label')!;
    expect(text(box)).not.toContain(OTHER);
    expect(text(box)).not.toContain(m);
    // D907: the M… form of a listed account is that account: its name ends the sentence.
    expect(text(box.querySelector('p.partner-says'))).toBe('Coffee Club says: pay for order 1042 to Coffee Club till');
    // Journear's own row shows the request's M… address whole.
    expect(text(el.querySelector('dl.id-rows'))).toContain(m);
  });

  it('the commit review: a payment from another source than the user’s is the plain window', () => {
    const tx = new TransactionBuilder(new Account(STRANGER, '41'), { fee: '100', networkPassphrase: PASSPHRASE })
      .addOperation(Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '25', source: USER }))
      .addMemo(Memo.text('1042'))
      .setTimebounds(10, 2000)
      .build();
    const decoded = stellar(new Uint8Array(tx.toEnvelope().toXDR()));
    expect(render(decoded, [PAYMENT]).outerHTML).toBe(render(decoded).outerHTML);
  });

  it('NEAR (with the vault’s code hash): every near miss is the amber line, after the acts-as-you line; a changed code hash too', () => {
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
    const changed = render(collect(), [STAMPS_DOC], { ...NEAR_CTX, labelFacts: { near: { account: STAMPS, codeHash: (parsed(GUESTBOOK_DOC_JSON).context as { codeHash: string }).codeHash } } }, 'Stamp Trail');
    expect(text(changed.querySelector('.risk-box.warning-box p.risk-lead'))).toMatch(/^This acts as you/u);
    expect(text(changed.querySelector('li.partner-mismatch'))).toBe('Doesn’t match how Stamp Trail describes this kind of request');
  });
});

describe('NEAR and Soroban rendering, with the code tied (D900: the vault’s NEAR hash; the transaction’s own footprint)', () => {
  it('a relayed NEAR call: “Stamp Trail says: collect the stamp Fare paid”; the stamp is in the sentence, so no row', () => {
    const el = render(collect(), [STAMPS_DOC], NEAR_CTX, 'Stamp Trail');
    const box = el.querySelector('div.partner-label')!;
    expect(text(box.querySelector('p.partner-says'))).toBe('Stamp Trail says: collect the stamp Fare paid');
    expect(box.querySelector('span.partner-value.partner-words')?.textContent).toBe('Fare paid');
    expect(box.querySelector('dl')).toBeNull();
    expect(without(el, 'div.partner-label')).toBe(render(collect(), undefined, NEAR_CTX, 'Stamp Trail').outerHTML);
  });

  it('a Soroban deposit: the amount as the app’s description of the request’s units, the user as “your account”', () => {
    const el = render(soroban('deposit', [addr(USER), i128(25_000_000n)], POOL, POOL_WASM), [SOROBAN]);
    expect(text(el.querySelector('p.partner-says'))).toBe('Coffee Club says: deposit 25,000,000 units, which Coffee Club says are 2.5 USDC from your account');
    expect(el.querySelector('div.partner-label dl')).toBeNull();
    expect(without(el, 'div.partner-label')).toBe(render(soroban('deposit', [addr(USER), i128(25_000_000n)], POOL, POOL_WASM)).outerHTML);
  });

  it('a Soroban payment to a listed account: its name set apart in the sentence; the one value not in it is the one row', () => {
    const el = render(soroban('pay_to', [addr(TEST_USDC_SAC), addr(OTHER), i128(10_000_000n)], POOL, POOL_WASM), [SOROBAN]);
    expect(el.querySelector('p.partner-says span.partner-value.partner-words')?.textContent).toBe('Club treasury');
    expect([...el.querySelectorAll('dl.partner-fields dt')].map(text)).toEqual(['Coin']);
    expect(el.querySelector('dl.partner-fields dd code.id-full')?.textContent).toBe(TEST_USDC_SAC);
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
  /** The payment document with one text replaced; the memo as a row (the sentence doesn't show it). */
  const doc = (o: { object?: string; name?: string; label?: string }) =>
    JSON.stringify({
      ...PAYMENT_DOC_JSON,
      metadata: { addressBook: [{ account: OTHER, name: o.name ?? 'Coffee Club till' }] },
      display: { formats: { payment: { ...PAYMENT_DOC_JSON.display.formats.payment, intent: { verb: 'pay', object: o.object ?? 'order' }, sentence: ['verb', 'object'], fields: [{ path: 'memo', label: o.label ?? 'Order', format: 'orderNumber' }] } } },
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
    ['a row named as Journear’s “Total”', doc({ label: 'Total' })],
    ['a row named as Journear’s “To”', doc({ label: 'To' })],
    ['a row named as Journear’s “Network”', doc({ label: 'Network' })],
    ['a row named as Journear’s “Memo”', doc({ label: 'Memo' })],
    ['a row named “Amount”', doc({ label: 'Amount' })],
    ['a row named “Sends”', doc({ label: 'Sends' })],
    ['a row named “From”', doc({ label: 'From' })],
  ];
  it.each(refused)('%s: refused at delivery, so the window is plain', (_, t) => {
    expect(windowLabelDocuments([t], 'testnet')).toEqual([]);
    expect(render(payment(), windowLabelDocuments([t], 'testnet')).outerHTML).toBe(render(payment()).outerHTML);
  });

  it('a phrase the rules let through renders only inside the box, attributed, in the normal style', () => {
    const odd = doc({ object: 'the danger zone order', label: 'Kiosk order reference' });
    const docs = windowLabelDocuments([odd], 'testnet');
    expect(docs).toHaveLength(1);
    const el = render(payment(), docs);
    const box = el.querySelector('div.partner-label')!;
    expect(text(box)).toContain('the danger zone order');
    expect([...box.querySelectorAll('dl.partner-fields dt')].map(text)).toEqual(['Kiosk order reference']);
    expect(box.closest('.jp-alert')).toBeNull();
    expect(box.querySelector('.jp-alert, svg, [role="alert"]')).toBeNull();
    expect(without(el, 'div.partner-label')).toBe(render(payment()).outerHTML);
  });

  it('a request’s own id that reads as Journear’s words, a claim, a token or an amount is never shown: the amber line', () => {
    for (const v of ['Journear-checked', '1XLM', 'USDC-25', 'Free', 'Verified-9', 'approve-1']) {
      const el = render(payment({ memo: Memo.text(v) }), [PAYMENT]);
      expect(el.querySelector('div.partner-label'), v).toBeNull();
      expect(el.querySelector('.partner-mismatch'), v).not.toBeNull();
    }
  });
});

describe('the window’s own sentences', () => {
  it('as recorded in D896, with the app’s name', () => {
    const app = { kind: 'app' };
    expect(LABEL_MISMATCH.full).toEqual([app, ' describes this kind of request, but this one doesn’t match, so Journear isn’t showing ', app, '’s description. If you’re not sure what this does, reject it.']);
    expect(LABEL_MISMATCH.short).toEqual(['Doesn’t match how ', app, ' describes this kind of request']);
    expect(LABEL_NOT_LISTED.full).toEqual(['This isn’t one of the accounts ', app, ' has listed for payments. If you expected to pay ', app, ', don’t approve.']);
    expect(LABEL_NOT_LISTED.short).toEqual(['Not one of the accounts ', app, ' has listed for payments']);
    expect(partnerAttribution(APP)).toBe('These are Coffee Club’s words, not Journear’s.');
  });

  it('D903: the attribution names the app as the window does everywhere: text only, bold and isolated, "’s" after any name', () => {
    // A name ending in "s" keeps "’s" (one app, as "{App}’s description" in the amber line); markup, quotes, a
    // right-to-left name and a 64-character name are only ever text.
    const rtl = 'نادي القهوة';
    for (const app of ['Coffee Beans', 'Ben & Jerry’s', '<img src=x onerror=alert(1)>', 'Acme "Club"', rtl, 'W'.repeat(64)]) {
      const el = render(payment(), [PAYMENT], {}, app);
      const line = el.querySelector('div.partner-label p.partner-attribution')!;
      expect(line.textContent, app).toBe(partnerAttribution(app));
      expect(line.querySelectorAll('*').length, app).toBe(1);
      expect(line.querySelector('strong.app-name')?.textContent, app).toBe(app);
    }
    expect(partnerAttribution('Coffee Beans')).toBe('These are Coffee Beans’s words, not Journear’s.');
    // No name (only spaces): "The app" heads the box, "the app" mid-sentence.
    const el = render(payment(), [PAYMENT], {}, '   ');
    expect(text(el.querySelector('p.partner-says strong.app-name'))).toBe('The app');
    expect(text(el.querySelector('p.partner-attribution'))).toBe('These are the app’s words, not Journear’s.');
  });
});

describe('plain words (D853) in the module’s own sentences', () => {
  it('no sentence of render-labels.ts holds a banned word', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { jargonIn, sentencesIn } = await import('@hana-id/brand/plain-words');
    const sentences = sentencesIn(readFileSync(join(process.cwd(), 'src/auth/render-labels.ts'), 'utf8'));
    expect(sentences.length).toBeGreaterThan(0);
    expect(sentences.filter((s) => jargonIn(s).length > 0)).toEqual([]);
  });
});

describe('D900: NEAR and Soroban labels in the real window, with their code tied', () => {
  const VOTE_DOC_JSON = {
    schema: 'journear-labels/1',
    context: { soroban: { networkPassphrase: PASSPHRASE, contract: POOL, wasmHash: POOL_WASM } },
    display: { formats: { vote: { call: { args: [{ name: 'choice', type: 'u32', min: 1, max: 3 }] }, intent: { verb: 'vote', object: 'in the club poll' }, sentence: ['verb', 'object'], fields: [] } } },
  };
  const VOTE = parsed(VOTE_DOC_JSON);
  const u32 = (n: number) => xdr.ScVal.scvU32(n);
  const vote = (code: string | readonly string[] | null = POOL_WASM, writes: xdr.LedgerKey[] = []) => soroban('vote', [u32(2)], POOL, code, writes);

  it('NEAR, relayed: the box after the amber “acts as you” box, the soft verb shown (the request attaches no NEAR)', () => {
    const el = render(collect(), [STAMPS_DOC], NEAR_CTX, 'Stamp Trail');
    const kids = [...el.children];
    const amber = kids.findIndex((c) => c.matches('.risk-box.warning-box'));
    const box = kids.findIndex((c) => c.matches('div.partner-label'));
    expect(amber).toBeGreaterThanOrEqual(0);
    expect(text(kids[amber])).toMatch(/^This acts as you/u);
    expect(box).toBeGreaterThan(amber);
    expect(kids[box + 1]!.matches('details.request-details')).toBe(true);
    expect(text(el.querySelector('p.partner-says'))).toBe('Stamp Trail says: collect the stamp Fare paid');
  });

  it('NEAR, the user’s own transaction: the box too, and the window without it is the window without labels', () => {
    const own = nearDecoded([fn('collect', '{"stamp":"sponsored"}')], { relayed: false });
    const el = render(own, [STAMPS_DOC], NEAR_CTX, 'Stamp Trail');
    expect(el.querySelector('div.partner-label')).not.toBeNull();
    expect(without(el, 'div.partner-label')).toBe(render(own, undefined, NEAR_CTX, 'Stamp Trail').outerHTML);
  });

  it('Soroban: a soft verb over a call that writes only its own data: the box, after the red box; nothing Journear says changes', () => {
    const el = render(vote(), [VOTE]);
    const kids = [...el.children];
    const red = kids.findIndex((c) => c.matches('.risk-box.danger-box'));
    const box = kids.findIndex((c) => c.matches('div.partner-label'));
    expect(red).toBeGreaterThanOrEqual(0);
    expect(box).toBeGreaterThan(red);
    expect(text(el.querySelector('p.partner-says'))).toBe('Coffee Club says: vote in the club poll');
    expect(without(el, 'div.partner-label')).toBe(render(vote()).outerHTML);
  });

  it('Soroban: the same soft verb over a call that may write elsewhere (a balance, the user’s account): the amber line, no words', () => {
    for (const w of [dataKeyOf(TEST_USDC_SAC, 'balance'), accountKey(USER)]) {
      const el = render(vote(POOL_WASM, [w]), [VOTE]);
      expect(el.querySelector('div.partner-label')).toBeNull();
      expect(el.querySelector('.partner-mismatch')).not.toBeNull();
      // The amber box holds only that line (a Soroban call has no amber line of its own); taken out, the window is the plain one.
      expect(text(el.querySelector('.risk-box.warning-box'))).toBe(text(el.querySelector('.partner-mismatch')));
      expect(without(el, '.risk-box.warning-box')).toBe(render(vote(POOL_WASM, [w])).outerHTML);
    }
  });

  it('a changed code (NEAR: the vault’s hash; Soroban: the footprint’s) is the amber line, never the words', () => {
    const near = render(collect(), [STAMPS_DOC], { ...NEAR_CTX, labelFacts: { near: { account: STAMPS, codeHash: (parsed(GUESTBOOK_DOC_JSON).context as { codeHash: string }).codeHash } } }, 'Stamp Trail');
    const sor = render(vote('cd'.repeat(32)), [VOTE]);
    for (const el of [near, sor]) {
      expect(el.querySelector('div.partner-label')).toBeNull();
      expect(el.querySelector('.partner-mismatch')).not.toBeNull();
    }
  });

  it('a code that couldn’t be tied (no vault hash; no or two codes in the footprint) is the plain window, byte for byte', () => {
    expect(render(collect(), [STAMPS_DOC], { address: ME }, 'Stamp Trail').outerHTML).toBe(render(collect(), undefined, { address: ME }, 'Stamp Trail').outerHTML);
    for (const code of [null, [POOL_WASM, 'cd'.repeat(32)]] as const) expect(render(vote(code), [VOTE]).outerHTML).toBe(render(vote(code)).outerHTML);
  });

  /** The documents with one text replaced, for each chain. */
  const nearDoc = (o: { object?: string; label?: string; enumLabel?: string }) =>
    JSON.stringify({
      ...STAMPS_DOC_JSON,
      metadata: { enums: { stamp: { ...STAMPS_DOC_JSON.metadata.enums.stamp, sponsored: o.enumLabel ?? 'Fare paid' } } },
      display: { formats: { collect: { ...STAMPS_DOC_JSON.display.formats.collect, intent: { verb: 'collect', object: o.object ?? 'the stamp' }, ...(o.label ? { sentence: ['verb', 'object'], fields: [{ path: 'args.stamp', label: o.label, format: 'enum', params: { enum: 'stamp' } }] } : {}) } } },
    });
  const sorobanDoc = (o: { object?: string }) => JSON.stringify({ ...VOTE_DOC_JSON, display: { formats: { vote: { ...VOTE_DOC_JSON.display.formats.vote, intent: { verb: 'vote', object: o.object ?? 'in the club poll' } } } } });
  const hostile: [string, string, 'near' | 'soroban'][] = [
    ['NEAR: Journear’s name', nearDoc({ object: 'the Journear stamp' }), 'near'],
    ['NEAR: a look-alike of it', nearDoc({ object: 'the J0urnear stamp' }), 'near'],
    ['NEAR: a claim of safety', nearDoc({ object: 'the safe stamp' }), 'near'],
    ['NEAR: “free”', nearDoc({ enumLabel: 'Free fare' }), 'near'],
    ['NEAR: a bidi override', nearDoc({ object: 'the ‮pmats' }), 'near'],
    ['NEAR: a Cyrillic look-alike', nearDoc({ object: 'the stаmp' }), 'near'],
    ['NEAR: a fake amount', nearDoc({ enumLabel: '5 NEAR back' }), 'near'],
    ['NEAR: a negation', nearDoc({ object: 'nothing stamp' }), 'near'],
    ['NEAR: the window’s words', nearDoc({ object: 'stamp then press Approve' }), 'near'],
    ['NEAR: a row named as Journear’s', nearDoc({ label: 'Network' }), 'near'],
    ['NEAR: an emoji', nearDoc({ enumLabel: 'Fare 🔒' }), 'near'],
    ['Soroban: Journear’s name', sorobanDoc({ object: 'in the Journear poll' }), 'soroban'],
    ['Soroban: “verified”', sorobanDoc({ object: 'in the verified poll' }), 'soroban'],
    ['Soroban: a zero-width space', sorobanDoc({ object: 'in the po​ll' }), 'soroban'],
    ['Soroban: a link', sorobanDoc({ object: 'www poll' }), 'soroban'],
    ['Soroban: markup', sorobanDoc({ object: '<b>poll</b>' }), 'soroban'],
    ['Soroban: quotation marks', sorobanDoc({ object: 'poll” it is safe “' }), 'soroban'],
    ['Soroban: “your”', sorobanDoc({ object: 'in your poll' }), 'soroban'],
  ];
  it.each(hostile)('%s: refused at delivery, so the window is plain with the code tied', (_, t, chain) => {
    expect(windowLabelDocuments([t], 'testnet')).toEqual([]);
    const docs = windowLabelDocuments([t], 'testnet');
    if (chain === 'near') expect(render(collect(), docs, NEAR_CTX, 'Stamp Trail').outerHTML).toBe(render(collect(), undefined, NEAR_CTX, 'Stamp Trail').outerHTML);
    else expect(render(vote(), docs).outerHTML).toBe(render(vote()).outerHTML);
  });

  it('a NEAR argument shown as an id that reads as Journear’s words or an amount: the amber line, the value not shown', () => {
    const ID_DOC = { ...STAMPS_DOC_JSON, display: { formats: { collect: { call: { args: { stamp: { type: 'string' } } }, intent: { verb: 'collect', object: 'the stamp' }, sentence: ['verb', 'object', { field: 'args.stamp' }], fields: [{ path: 'args.stamp', label: 'Stamp', format: 'itemId' }] } } } };
    const docs = [parsed(ID_DOC)];
    for (const v of ['Journear-checked', '1NEAR', 'Free', 'Verified-9']) {
      const el = render(collect(v), docs, NEAR_CTX, 'Stamp Trail');
      expect(el.querySelector('div.partner-label'), v).toBeNull();
      expect(el.querySelector('.partner-mismatch'), v).not.toBeNull();
    }
    expect(text(render(collect('A1B2'), docs, NEAR_CTX, 'Stamp Trail').querySelector('p.partner-says'))).toBe('Stamp Trail says: collect the stamp A1B2');
  });
});
