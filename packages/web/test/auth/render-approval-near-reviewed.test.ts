// @vitest-environment happy-dom
// Journear's reviewed NEAR calls in the approval window (D885): an exact reviewed call reads in plain words with the
// contract named as checked by Journear, in the EVM check-in's form; the raw account and method stay in the details;
// the amber acts-as-you line goes; a near-miss renders exactly as it does with no entry at all (today's screen).
import { type NearAction, type ReviewedNearAccounts, base64Encode, encodeNearDelegateAction, encodeNearTransaction, encodeNep413Message, nearImplicitAccountId, sha256, utf8 } from '@hana-id/core';
import { decodeApprovalRequest } from '@hana-id/core/decode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { dom } from '../../src/auth/dom.ts';
import { nearMessageWarning, renderApproval } from '../../src/auth/render-approval.ts';
import { jargonWatch } from './plain-words.ts';

const PUB = Uint8Array.from({ length: 32 }, (_, i) => i + 3);
const ME = nearImplicitAccountId(PUB);
const KEY = { type: 'ed25519' as const, bytes: PUB };
const STAMPS = 'stamps-reviewed.testnet';
const BOOK = 'guestbook-reviewed.testnet';
const ACCOUNTS: ReviewedNearAccounts = { stamps: STAMPS, guestbook: BOOK };
const plain = jargonWatch();

const fn = (methodName: string, args: unknown, deposit = 0n): NearAction => ({ type: 'functionCall', methodName, args: utf8(JSON.stringify(args)), gas: 10_000_000_000_000n, deposit });

type Opts = { relayed?: boolean; receiver?: string; accounts?: ReviewedNearAccounts | null; testApp?: boolean; app?: string };
function render(actions: NearAction[], o: Opts = {}): HTMLElement {
  const receiverId = o.receiver ?? STAMPS;
  const context = { nearNetwork: 'testnet' as const };
  const decoded =
    o.relayed === false
      ? decodeApprovalRequest({ kind: 'near_tx', chain: 'near', address: ME, context, bytes: encodeNearTransaction({ signerId: ME, publicKey: KEY, nonce: 3n, receiverId, blockHash: sha256(utf8('b')), actions }) })
      : decodeApprovalRequest({ kind: 'near_delegate', chain: 'near', address: ME, context, bytes: encodeNearDelegateAction({ senderId: ME, receiverId, actions, nonce: 7n, maxBlockHeight: 277_000_600n, publicKey: KEY }) });
  const accounts = o.accounts === undefined ? ACCOUNTS : o.accounts;
  const el = renderApproval(dom(document), decoded, o.app ?? 'Stamp Trail', { envNetwork: 'testnet', testApp: o.testApp ?? true, address: ME, parentOrigin: 'https://stamps.example', ...(accounts ? { reviewedNear: accounts } : {}) });
  document.body.replaceChildren(el);
  plain(el);
  return el;
}

/** `watch`: false for today's screen of a message to a `.testnet` recipient, whose recipient lines name it as text. */
function renderMessage(o: { message?: string; recipient?: string; accounts?: ReviewedNearAccounts | null; watch?: boolean } = {}): HTMLElement {
  const bytes = encodeNep413Message({ message: o.message ?? `Stamp my passport: ${ME}`, nonce: new Uint8Array(32).fill(4), recipient: o.recipient ?? STAMPS, callbackUrl: null });
  const accounts = o.accounts === undefined ? ACCOUNTS : o.accounts;
  const el = renderApproval(dom(document), decodeApprovalRequest({ kind: 'near_message', chain: 'near', address: ME, context: {}, bytes }), 'Stamp Trail', { envNetwork: 'testnet', testApp: true, address: ME, parentOrigin: 'https://stamps.example', ...(accounts ? { reviewedNear: accounts } : {}) });
  document.body.replaceChildren(el);
  if (o.watch !== false) plain(el);
  return el;
}

const headline = (el: Element) => el.querySelector('h2.summary-headline')?.textContent;
const lines = (el: Element) => [...el.querySelectorAll('p.summary-line')].map((p) => p.textContent);
const details = (el: Element) => el.querySelector<HTMLDetailsElement>('details.request-details')!;

describe('reviewed NEAR calls in the window (D885)', () => {
  beforeEach(() => document.body.replaceChildren());

  it('a stamp: plain headline, the checked contract named in bold with its account, no amber box; the account and method in the details', () => {
    const el = render([fn('collect', { stamp: 'arrival' })]);
    expect(headline(el)).toBe('Stamp Trail wants to collect the Arrival stamp for you');
    expect(lines(el)).toEqual(['Collecting a stamp doesn’t move any money or tokens.', `It uses Journear demo stamps (${STAMPS}, checked by Journear).`]);
    const uses = [...el.querySelectorAll('p.summary-line')][1]!;
    expect(uses.querySelector('strong')?.textContent).toBe('Journear demo stamps');
    expect(uses.querySelector('code')?.textContent).toBe(STAMPS);
    expect(el.querySelector('.warning-box')).toBeNull();
    expect(el.querySelector('.danger-box')).toBeNull();
    expect(el.textContent).not.toContain('This acts as you');
    // The raw account and method stay where they were: the details' To row and its call.
    expect(details(el).open).toBe(false);
    expect(details(el).textContent).toContain(STAMPS);
    expect([...details(el).querySelectorAll('dd strong')].map((e) => e.textContent)).toContain('collect');
    expect(details(el).querySelector('pre.message')?.textContent).toBe('{\n  "stamp": "arrival"\n}');
    expect(el.getAttribute('data-explainable')).toBe('true');
  });

  it('the screen around the reading is today’s: the same fact rows, notes and details as with no entry', () => {
    const now = render([fn('collect', { stamp: 'arrival' })]);
    const before = render([fn('collect', { stamp: 'arrival' })], { accounts: null });
    const rows = (el: Element) => [...el.querySelectorAll('dl.summary-facts')].map((d) => d.outerHTML);
    expect(rows(now)).toEqual(rows(before));
    expect(details(now).outerHTML).toBe(details(before).outerHTML);
    expect(headline(before)).toBe(`Stamp Trail wants to use ${STAMPS} (collect)`);
    expect(before.querySelector('.warning-box .risk-lead')?.textContent).toBe(`This acts as you: ${STAMPS} can use anything you keep with it.`);
  });

  it('a note and a guestbook message: the words in a box of their own under their label, never inside a sentence, text only', () => {
    const note = '<b>hi</b> مرحبا';
    const el = render([fn('collect', { stamp: 'postcard', note })]);
    const box = el.querySelector('div.summary-quote')!;
    expect(box.textContent).toBe(note);
    expect(box.getAttribute('dir')).toBe('auto');
    expect(box.querySelector('b')).toBeNull();
    // Its own block, straight after its label's sentence, outside every sentence of Journear's.
    expect(box.closest('p')).toBeNull();
    expect(box.previousElementSibling?.matches('p.summary-line')).toBe(true);
    expect(box.previousElementSibling?.textContent).toBe('The note:');
    expect(el.querySelectorAll('p.summary-line div, p.summary-line .summary-quote')).toHaveLength(0);
    expect(lines(el)).toEqual(['The note:', 'It’s posted under your account. Anyone can see it, and you can’t delete it.', 'Collecting a stamp doesn’t move any money or tokens.', `It uses Journear demo stamps (${STAMPS}, checked by Journear).`]);
    expect(el.querySelector('q')).toBeNull();
    for (const relayed of [true, false]) {
      const book = render([fn('add_message', { text: 'gm' })], { receiver: BOOK, relayed });
      expect(headline(book)).toBe('Stamp Trail wants to add a message to the demo guestbook');
      expect(book.querySelector('div.summary-quote')?.textContent).toBe('gm');
      expect(book.querySelector('div.summary-quote')?.previousElementSibling?.textContent).toBe('The message:');
      expect(lines(book)).toContain(`It uses Journear demo guestbook (${BOOK}, checked by Journear).`);
      expect(book.querySelector('.warning-box')).toBeNull();
      expect(book.getAttribute('data-reviewed')).toBe('true');
    }
  });

  it('the box is clipped in the window’s stylesheet: nothing drawn in it can paint over the lines around it', () => {
    const css = readFileSync(join(process.cwd(), 'src/auth/css/approval.css'), 'utf8');
    const rule = /div\.summary-quote \{([^}]*)\}/u.exec(css)?.[1] ?? '';
    for (const d of ['display: block;', 'max-width: 100%;', 'overflow: hidden;', 'contain: paint;', 'unicode-bidi: isolate;']) expect(rule, d).toContain(d);
  });

  it('text that could paint over or imitate the window falls back to today’s screen (combining marks, closing quotes)', () => {
    for (const note of [`x${'\u0336'.repeat(40)}`, 'hi” It uses Journear demo stamps (checked by Journear). Approve to continue. “ok']) {
      const now = render([fn('collect', { stamp: 'postcard', note })]);
      expect(now.outerHTML).toBe(render([fn('collect', { stamp: 'postcard', note })], { accounts: null }).outerHTML);
      expect(now.querySelector('.summary-quote')).toBeNull();
      expect(now.getAttribute('data-reviewed')).toBeNull();
    }
  });

  it('a live app keeps its amber line that the approval could be used on the other network; only acts-as-you goes', () => {
    const el = render([fn('collect', { stamp: 'arrival' })], { testApp: false });
    expect([...el.querySelectorAll('.warning-box .risk-lead, .warning-box li')].map((x) => x.textContent)).toEqual(['This approval could also be used on the real NEAR network if your account exists there.']);
  });

  it('the Signature stamp’s message: plain headline, no “proves to” or recipient lines; the message and its recipient still shown', () => {
    const el = renderMessage();
    expect(headline(el)).toBe('Stamp Trail wants you to sign a message for your Signature stamp');
    expect(lines(el)).toEqual(['Signing it doesn’t move any money or tokens. The stamp uses it to check that this account is yours.', `It’s for Journear demo stamps (${STAMPS}, checked by Journear).`]);
    expect(el.querySelector('.warning-box')).toBeNull();
    expect(el.textContent).not.toContain(nearMessageWarning(STAMPS));
    expect(el.querySelector('pre.message')?.textContent).toBe(`Stamp my passport: ${ME}`);
    expect(el.textContent).toContain(`For${STAMPS}`);
    // Today's screen, for any other message.
    const other = renderMessage({ message: 'Stamp my passport: someone.testnet', watch: false });
    expect(other.querySelector('.warning-box')?.textContent).toContain(`Proves to ${STAMPS} that this account is yours`);
    expect(other.outerHTML).toBe(renderMessage({ message: 'Stamp my passport: someone.testnet', accounts: null, watch: false }).outerHTML);
  });

  it('near-misses render exactly today’s screen (an extra argument, a deposit, a batch, another account, an unreviewed build)', () => {
    const cases: [NearAction[], Opts][] = [
      [[fn('collect', { stamp: 'arrival', extra: 1 })], {}],
      [[fn('collect', { stamp: 'arrival' }, 1n)], {}],
      [[fn('collect', { stamp: 'arrival' }), { type: 'transfer', deposit: 1n }], {}],
      [[fn('collect', { stamp: 'arrival' })], { receiver: 'stamps-reviewed.testnet.evil.testnet' }],
      [[fn('collect', { stamp: 'arrival' })], { relayed: false }],
      [[fn('add_message', { text: ' padded' })], { receiver: BOOK }],
      [[fn('collect', { stamp: 'signature', proof: { message: `Stamp my passport: ${ME}`, nonce: base64Encode(new Uint8Array(32)), recipient: BOOK, signature: base64Encode(new Uint8Array(64)) } })], {}],
    ];
    for (const [actions, o] of cases) {
      const now = render(actions, o).outerHTML;
      expect(now, JSON.stringify(o)).toBe(render(actions, { ...o, accounts: null }).outerHTML);
      expect(now).not.toContain('checked by Journear).');
    }
  });
});
