// @vitest-environment happy-dom
// The approval window's plain summary and its details (D808–D812): the summary first; every warning, danger line and
// page note outside the fold; the technical details folded behind "Show details" for a request Journear can explain,
// open from the start for one it can't, and never foldable for raw signing; the overflow mark measured again when the
// details open; the Approve guard untouched by opening or closing them; every partner-chosen value as text.
import {
  type NearAction,
  encodeNearTransaction,
  encodeNep413Message,
  evmTxSigningPayload,
  nearImplicitAccountId,
  nearPublicKeyString,
  newRequestId,
  parseEvmTxRequest,
  sha256,
  utf8,
} from '@hana-id/core';
import { type DecodedApproval, decodeApprovalRequest, parseFunctionSignature } from '@hana-id/core/decode';
import { Asset, Keypair, Operation, nativeToScVal, xdr } from '@stellar/stellar-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARD_DELAY_MS } from '../../src/auth/approve-guard.ts';
import { MAINNET_DEMO_BANNER, MAINNET_DEMO_WHY, OUT_OF_POLICY_TEXT, TEST_APP_DEMO_NOTE, TEST_APP_NOTE, startApprovePage } from '../../src/auth/approve-page.ts';
import { ZERO_COST } from '../../../core/test/plain-words.ts';
import { dom } from '../../src/auth/dom.ts';
import { policyId, validateAutoApprovePolicy } from '@hana-id/core/policy';
import { policyJson } from '../../../core/test/policy-fixtures.ts';
import { ACCOUNT_CONTROL_BANNER, DETAILS_LABELS, NEAR_ACCOUNT_CONTROL_BANNER, NEAR_DELEGATE_NONE, NEAR_DELEGATE_NOTES, NEAR_OWN_CONTRACT_TOTAL, NO_NETWORK_NOTE, TYPED_DATA_NO_CHAIN, overflowNote, markOverflowing, nearMessageWarning, renderApproval, watchOverflowing } from '../../src/auth/render-approval.ts';
import { PASSPHRASE, USER, addSignerOp, paymentOp, txBytes } from '../../../core/test/stellar-fixtures.ts';
import { idProblems, jargonWatch, shownText } from './plain-words.ts';
import { shortId } from '@hana-id/core/decode';
import { ENV, FakeWindow, PARTNER, type RemoteWindow, asWindow, remoteWindow, resetDom } from './helpers.ts';

/** A public key computed here (never a literal in the source), for the full-key assertions. */
const KEY9 = nearPublicKeyString(new Uint8Array(32).fill(9));
const EVM = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const TOKEN = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x3333333333333333333333333333333333333333';
const TX = { chainId: '0xaa36a7', nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', to: EVM, value: '0xde0b6b3a7640000', data: '0x' };
const word = (v: bigint | string) => (typeof v === 'string' ? v.slice(2).toLowerCase().padStart(64, '0') : v.toString(16).padStart(64, '0'));
const evmBytes = (over: Record<string, string> = {}) => evmTxSigningPayload(parseEvmTxRequest({ ...TX, ...over }));
const evm = (over: Record<string, string> = {}) => decodeApprovalRequest({ kind: 'evm_tx', chain: 'evm', address: EVM, context: { chainId: 11155111 }, bytes: evmBytes(over) });
const approveData = (amount: bigint) => `${parseFunctionSignature('approve(address,uint256)').selector}${word(SPENDER)}${word(amount)}`;

const plain = jargonWatch();
const render = (decoded: DecodedApproval, app = 'Partner App', address = EVM): HTMLElement => {
  const el = renderApproval(dom(document), decoded, app, { envNetwork: 'testnet', testApp: false, parentOrigin: PARTNER, address });
  document.body.replaceChildren(el);
  // A valid request never gets the catch-all summary (review 3).
  expect(el.querySelector('.summary-failed')).toBeNull();
  plain(el);
  return el;
};
const details = (el: ParentNode) => el.querySelector<HTMLDetailsElement>('details.request-details');
/** True when `node` sits inside the foldable details. */
const folded = (node: Element | null) => node !== null && node.closest('details.request-details') !== null;
/** Everything in view before the details: the text a user reads without opening them. */
const aboveFold = (el: HTMLElement): string => [...el.children].filter((c) => !c.matches('details')).map((c) => c.textContent).join('\n');

beforeEach(() => document.body.replaceChildren());

describe('the summary first, the details folded', () => {
  it('an EVM send: the headline, the network and fee lines; the technical rows in closed details', () => {
    const el = render(evm());
    expect(el.querySelector('h2.summary-headline')?.textContent).toBe(`Partner App wants to send 1 ETH to your account`);
    expect(el.querySelector('h2.summary-headline strong.app-name')?.textContent).toBe('Partner App');
    expect(el.dataset.explainable).toBe('true');
    const d = details(el)!;
    expect(d.open).toBe(false);
    expect(d.querySelector('summary')?.textContent).toBe(DETAILS_LABELS.show);
    for (const label of ['Nonce', 'Gas limit', 'Max fee per gas', 'Priority fee per gas', 'Chain ID']) {
      const dt = [...el.querySelectorAll('dt')].find((x) => x.textContent === label);
      expect(folded(dt ?? null), label).toBe(true);
    }
    const fee = [...el.querySelectorAll('dt')].find((x) => x.textContent === 'Network fee');
    expect(folded(fee ?? null)).toBe(false);
    expect(fee?.nextElementSibling?.textContent).toBe('Less than 0.000001 ETH');
  });

  it('the user opens and closes the details; the label follows', () => {
    const d = details(render(evm()))!;
    d.open = true;
    d.dispatchEvent(new Event('toggle'));
    expect(d.querySelector('summary')?.textContent).toBe(DETAILS_LABELS.hide);
    d.open = false;
    d.dispatchEvent(new Event('toggle'));
    expect(d.querySelector('summary')?.textContent).toBe(DETAILS_LABELS.show);
  });

  it('a request Journear can’t explain: the red risk line outside, the details folded (the raw data in them) (D810)', () => {
    const el = render(evm({ to: TOKEN, value: '0x0', data: '0xdeadbeef00' }));
    const warn = el.querySelector('p.summary-warning.cannot-explain');
    expect(warn?.textContent).toBe('Journear can’t check what this does (it asks for an action Journear doesn’t know). It could take your money or tokens. If you’re not sure, reject it.');
    expect(warn?.closest('.danger-box')?.classList.contains('jp-alert-danger')).toBe(true);
    expect(folded(warn)).toBe(false);
    expect(details(el)?.open).toBe(false);
    expect(details(el)?.querySelector('summary')?.textContent).toBe(DETAILS_LABELS.show);
    expect(details(el)?.textContent).toContain('0xdeadbeef00');
    expect(el.dataset.explainable).toBe('false');
  });

  it('raw signing: the details fold like any others; the red risk line stays outside (D810)', () => {
    const el = render(decodeApprovalRequest({ kind: 'raw', chain: 'evm', address: EVM, context: {}, bytes: new Uint8Array(32).fill(1) }));
    expect(el.querySelector('section.request-details')).toBeNull();
    expect(details(el)?.open).toBe(false);
    expect(details(el)?.textContent).toContain(`0x${'01'.repeat(32)}`);
    const red = el.querySelector('p.summary-warning.raw-signing');
    expect(red?.textContent).toBe('Signing this could hand over your whole account and everything in it. Reject it unless you know exactly why you’re signing.');
    expect(red?.closest('.danger-box')?.classList.contains('jp-alert-danger')).toBe(true);
    expect(folded(red)).toBe(false);
    expect(el.textContent).toContain(NO_NETWORK_NOTE);
  });

  it('every case that used to open the details renders them folded, its risk line in view (D810)', () => {
    const pub = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const me = nearImplicitAccountId(pub);
    const nearTx = (actions: NearAction[]) =>
      decodeApprovalRequest({ kind: 'near_tx', chain: 'near', address: me, context: { nearNetwork: 'testnet' }, bytes: encodeNearTransaction({ signerId: me, publicKey: { type: 'ed25519', bytes: pub }, nonce: 1n, receiverId: 'x.testnet', blockHash: sha256(utf8('b')), actions }) });
    const cases: [string, DecodedApproval, string, string][] = [
      ['unknown call', evm({ to: TOKEN, value: '0x0', data: '0xdeadbeef' }), 'cannot-explain', 'jp-alert-danger'],
      ['NEAR unreadable arguments', nearTx([{ type: 'functionCall', methodName: 'm', args: Uint8Array.of(0xff), gas: 1n, deposit: 0n }]), 'cannot-explain', 'jp-alert-danger'],
      ['NEAR steps left out that move value', nearTx(['a', 'b', 'c', 'd', 'e'].map((m): NearAction => ({ type: 'functionCall', methodName: m, args: utf8('{}'), gas: 1n, deposit: 0n }))), 'steps-not-listed', 'jp-alert-danger'],
      ['Stellar neutral steps left out', decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: txBytes([Operation.bumpSequence({ bumpTo: '9' }), Operation.manageData({ name: 'a', value: 'b' }), Operation.manageData({ name: 'a', value: null }), Operation.setOptions({ homeDomain: 'x.example' }), Operation.inflation({})]) }), 'steps-not-listed', 'jp-alert-warning'],
      ['a message that isn’t text', decodeApprovalRequest({ kind: 'personal_sign', chain: 'evm', address: EVM, context: {}, bytes: Uint8Array.of(0xff, 0xfe) }), 'cannot-explain', 'jp-alert-warning'],
    ];
    for (const [name, decoded, cls, tone] of cases) {
      const el = render(decoded, 'Partner App', decoded.kind.startsWith('near') ? me : decoded.kind === 'stellar_tx' ? USER : EVM);
      expect(details(el)?.open, name).toBe(false);
      const w = el.querySelector(`.summary-warning.${cls}`);
      expect(w?.closest('.risk-box')?.classList.contains(tone), name).toBe(true);
      expect(folded(w), name).toBe(false);
    }
  });
});

describe('warnings are never folded', () => {
  it('an unlimited approve: the red warning outside the closed details', () => {
    const el = render(evm({ to: TOKEN, value: '0x0', data: approveData(2n ** 256n - 1n) }));
    const w = el.querySelector('p.summary-warning.unlimited-spend');
    expect(w?.closest('.danger-box')?.classList.contains('jp-alert-danger')).toBe(true);
    expect(shownText(w)).toContain(`This lets ${shortId(SPENDER)} (not checked by Journear) take all your tokens from ${shortId(TOKEN)} (an unlisted token), now or later, with no limit`);
    expect(folded(w)).toBe(false);
    expect(details(el)?.open).toBe(false);
  });

  it('approve(spender, 0) on a contract Journear doesn’t know: amber, it may be an NFT’s item 0 (review M1)', () => {
    const el = render(evm({ to: TOKEN, value: '0x0', data: approveData(0n) }));
    const w = el.querySelector('p.summary-warning.spend-permission');
    expect(w?.textContent).toContain('item no. 0');
    expect(folded(w)).toBe(false);
    expect(shownText(el.querySelector('h2.summary-headline'))).toBe(`Partner App wants to change ${shortId(SPENDER)}’s permission for ${shortId(TOKEN)}`);
  });

  it('99 harmless actions and one full-access key: the red banner sits right under the headline; the details start open (review M2)', () => {
    const pub = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const me = nearImplicitAccountId(pub);
    const actions: NearAction[] = [
      ...Array.from({ length: 99 }, (): NearAction => ({ type: 'transfer', deposit: 1n })),
      { type: 'addKey', publicKey: { type: 'ed25519', bytes: new Uint8Array(32).fill(9) }, accessKey: { nonce: 0n, permission: { type: 'fullAccess' } } },
    ];
    const bytes = encodeNearTransaction({ signerId: me, publicKey: { type: 'ed25519', bytes: pub }, nonce: 1n, receiverId: me, blockHash: sha256(utf8('b')), actions });
    const el = render(decodeApprovalRequest({ kind: 'near_tx', chain: 'near', address: me, context: { nearNetwork: 'testnet' }, bytes }), 'Partner App', me);
    expect(el.children[0]?.matches('h2.summary-headline')).toBe(true);
    // D814: one red box right under the headline, the banner in full, the key as one bullet; two grouped lines.
    const box = el.children[1] as HTMLElement;
    expect(box.matches('div.danger-box.jp-alert-danger')).toBe(true);
    expect(box.querySelector('.risk-lead')?.textContent).toBe(NEAR_ACCOUNT_CONTROL_BANNER);
    // The key's own line names it whole, so no bullet repeats it: the key appears exactly once above the fold.
    expect([...box.querySelectorAll('li')].map((li) => li.textContent)).toEqual([]);
    expect(aboveFold(el).split(KEY9).length - 1).toBe(1);
    expect(el.querySelectorAll('.jp-alert-danger')).toHaveLength(1);
    expect([...el.querySelectorAll('p.summary-line')].map(shownText)).toEqual([`Give full control of your account to another key, ${shortId(KEY9)}`, 'Send NEAR to your account, 99 times (less than 0.000001 NEAR in total)']);
    // D859: the whole key once, in its own row right under its line.
    const keyRow = el.querySelector('p.summary-line + dl.id-rows');
    expect(keyRow?.querySelector('dt')?.textContent).toBe('Key');
    expect(keyRow?.querySelector('dd')?.textContent).toBe(KEY9);
    expect(details(el)?.open).toBe(false);
  });

  it('Stellar account control: the banner and each operation’s warning outside the fold, the operation framed inside', () => {
    const el = render(decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: txBytes([paymentOp(), addSignerOp()]) }), 'Partner App', USER);
    const banner = el.querySelector('p.takeover.banner');
    expect(banner?.textContent).toBe(ACCOUNT_CONTROL_BANNER);
    expect(folded(banner)).toBe(false);
    const red = el.querySelectorAll('.danger-box .risk-lead, .danger-box li');
    for (const p of red) expect(folded(p)).toBe(false);
    expect(red).toHaveLength(1);
    expect(folded(el.querySelector('li.op.takeover-op'))).toBe(true);
    expect(details(el)?.open).toBe(false);
  });

  it('NEAR account control and own-contract calls: banner and red lines outside; the NEAR leaving the account outside', () => {
    const pub = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const me = nearImplicitAccountId(pub);
    const actions: NearAction[] = [{ type: 'functionCall', methodName: 'm', args: utf8('{}'), gas: 1n, deposit: 0n }];
    const bytes = encodeNearTransaction({ signerId: me, publicKey: { type: 'ed25519', bytes: pub }, nonce: 1n, receiverId: me, blockHash: sha256(utf8('b')), actions });
    const el = render(decodeApprovalRequest({ kind: 'near_tx', chain: 'near', address: me, context: { nearNetwork: 'testnet' }, bytes }), 'Partner App', me);
    expect(el.querySelector('p.takeover.banner')?.textContent).toBe(NEAR_ACCOUNT_CONTROL_BANNER);
    expect([...el.querySelectorAll('p.danger.takeover')].every((p) => !folded(p))).toBe(true);
    const leaving = [...el.querySelectorAll('dt')].find((x) => x.textContent === 'NEAR leaving your account');
    expect(folded(leaving ?? null)).toBe(false);
    const network = [...el.querySelectorAll('dl.summary-facts dt')].find((x) => x.textContent === 'Network');
    expect(network?.nextElementSibling?.textContent).toBe('NEAR test network (checked by Journear)');
    expect(el.querySelector('h2.summary-headline')?.textContent).toBe('Partner App wants to use your account (m)');
  });

  it('NEP-413: the recipient, its warnings and the message outside; the nonce folded', () => {
    const pub = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const me = nearImplicitAccountId(pub);
    const bytes = encodeNep413Message({ message: 'Sign in to Guestbook', nonce: new Uint8Array(32).fill(1), recipient: 'bank.example', callbackUrl: null });
    const el = render(decodeApprovalRequest({ kind: 'near_message', chain: 'near', address: me, context: {}, bytes }), 'Partner App', me);
    expect(el.querySelector('h2.summary-headline')?.textContent).toBe('Partner App wants you to sign a message for bank.example');
    const w = [...el.querySelectorAll('p.warn')].find((p) => p.textContent === nearMessageWarning('bank.example'));
    expect(folded(w ?? null)).toBe(false);
    expect(folded(el.querySelector('p.recipient-mismatch'))).toBe(false);
    expect(folded(el.querySelector('pre.message'))).toBe(false);
    const nonce = [...el.querySelectorAll('dt')].find((x) => x.textContent === 'Nonce');
    expect(folded(nonce ?? null)).toBe(true);
  });

  it('a plain message stays in view, with the no-network note; its bytes are in the details', () => {
    const el = render(decodeApprovalRequest({ kind: 'personal_sign', chain: 'evm', address: EVM, context: {}, bytes: utf8('Hello there') }));
    expect(el.querySelector('pre.message')?.textContent).toBe('Hello there');
    expect(folded(el.querySelector('pre.message'))).toBe(false);
    expect(el.textContent).toContain(NO_NETWORK_NOTE);
    expect(details(el)?.textContent).toContain('0x48656c6c6f207468657265');
  });
});

describe('hostile values stay text', () => {
  it('an app name with markup is text in the headline and in every warning', () => {
    const name = '<img src=x onerror=alert(1)>';
    const el = render(evm({ to: TOKEN, value: '0x0', data: '0xdeadbeef' }), name);
    expect(el.querySelector('img')).toBeNull();
    expect(shownText(el.querySelector('h2.summary-headline'))).toBe(`${name} wants to use the program ${shortId(TOKEN)}`);
    // The red line names no app (its ending is "If you’re not sure, reject it."); an amber one does, as text.
    expect(el.querySelector('p.cannot-explain')?.textContent).toContain('If you’re not sure, reject it.');
    const amber = render(decodeApprovalRequest({ kind: 'personal_sign', chain: 'evm', address: EVM, context: {}, bytes: new Uint8Array([0, 0xff]) }), name);
    expect(amber.querySelector('img')).toBeNull();
    expect(amber.querySelector('p.cannot-explain')?.textContent).toContain(`Approve only if you expected this from ${name}.`);
  });

  it('a typed-data type name never reaches the summary; the tree is in the (folded) details', () => {
    const json = {
      types: { EIP712Domain: [{ name: 'name', type: 'string' }], SafeLoginNoFundsMove: [{ name: 'note', type: 'string' }] },
      primaryType: 'SafeLoginNoFundsMove',
      domain: { name: 'Safe' },
      message: { note: 'hi' },
    };
    const el = render(decodeApprovalRequest({ kind: 'eip712', chain: 'evm', address: EVM, context: {}, bytes: utf8(JSON.stringify(json)) }));
    const outside = [...el.children].filter((c) => !c.matches('details')).map((c) => c.textContent).join(' ');
    expect(outside).not.toContain('SafeLoginNoFundsMove');
    expect(details(el)?.open).toBe(false);
    expect(details(el)?.textContent).toContain('SafeLoginNoFundsMove');
  });
});

describe('the overflow mark and the fold', () => {
  it('a box inside closed details is measured again when they open', () => {
    const pub = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const me = nearImplicitAccountId(pub);
    const json = `{${Array.from({ length: 30 }, (_, i) => `"k${i}":${i}`).join(',')}}`;
    const bytes = encodeNearTransaction({ signerId: me, publicKey: { type: 'ed25519', bytes: pub }, nonce: 1n, receiverId: 'guestbook.testnet', blockHash: sha256(utf8('b')), actions: [{ type: 'functionCall', methodName: 'add', args: utf8(json), gas: 1n, deposit: 0n }] });
    const el = render(decodeApprovalRequest({ kind: 'near_tx', chain: 'near', address: me, context: { nearNetwork: 'testnet' }, bytes }), 'P', me);
    const d = details(el)!;
    const box = d.querySelector<HTMLElement>('pre.message')!;
    // A browser lays out a box in closed details at zero; open, it overflows.
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => (d.open ? 900 : 0) });
    Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => (d.open ? 320 : 0) });
    const stop = watchOverflowing(document, { addEventListener: () => {}, removeEventListener: () => {} });
    expect(el.querySelectorAll('p.overflow-note')).toHaveLength(0);
    d.open = true;
    d.dispatchEvent(new Event('toggle'));
    expect(el.querySelectorAll('p.overflow-note')).toHaveLength(1);
    d.open = false;
    d.dispatchEvent(new Event('toggle'));
    expect(el.querySelectorAll('p.overflow-note')).toHaveLength(0);
    stop();
    d.open = true;
    d.dispatchEvent(new Event('toggle'));
    expect(el.querySelectorAll('p.overflow-note')).toHaveLength(0);
    markOverflowing(document);
    expect(el.querySelectorAll('p.overflow-note')).toHaveLength(1);
  });
});

describe('/approve: the page around the summary', () => {
  let win: FakeWindow;
  let vault: RemoteWindow;
  let page: ReturnType<typeof startApprovePage>;
  const primary = () => document.querySelector<HTMLButtonElement>('button.primary');
  const request = (over: Record<string, unknown> = {}) => ({
    v: 1,
    t: 'hana:approve-request',
    id: newRequestId(),
    appName: 'Partner App',
    parentOrigin: PARTNER,
    kind: 'evm_tx',
    chain: 'evm',
    address: EVM,
    bytes: evmBytes({ to: TOKEN, value: '0x0', data: approveData(2n ** 256n - 1n) }),
    context: { chainId: 11155111 },
    position: 1,
    queued: 1,
    ...over,
  });

  beforeEach(() => {
    resetDom();
    vi.useFakeTimers();
    win = new FakeWindow('/approve');
    vault = remoteWindow();
    win.opener = asWindow(vault);
    page = startApprovePage({ win, env: ENV, isGesture: () => true });
    win.dispatch('focus');
  });
  afterEach(() => {
    page.stop();
    vi.useRealTimers();
  });

  it('the account line and the test-app note stay in view; the Support ID folds', () => {
    win.message(request({ testApp: true, supportId: 'HANA-2750-G5HM' }), ENV.vaultOrigin, vault);
    expect(folded(document.querySelector('p.account'))).toBe(false);
    const note = document.querySelector('p.note.test-app');
    expect(note?.textContent).toBe(TEST_APP_NOTE);
    expect(folded(note)).toBe(false);
    expect(folded(document.querySelector('p.support-id'))).toBe(true);
    expect(folded(document.querySelector('.summary-warning.unlimited-spend'))).toBe(false);
  });

  it('a renderer that fails shows the refusal with no Approve, never the previous screen (review 2, N1)', () => {
    page.stop();
    resetDom();
    win = new FakeWindow('/approve');
    vault = remoteWindow();
    win.opener = asWindow(vault);
    let fail = false;
    page = startApprovePage({
      win,
      env: ENV,
      isGesture: () => true,
      render: (...args) => {
        if (fail) throw new Error('render failed');
        return renderApproval(...args);
      },
    });
    win.dispatch('focus');
    // A first request on show, armed: its Approve works.
    const first = request();
    win.message(first, ENV.vaultOrigin, vault);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    win.dispatch('pointermove', { pointerType: 'mouse', movementX: 3, movementY: 1 });
    const staleApprove = primary()!;
    expect(staleApprove.disabled).toBe(false);
    // The next one fails to render.
    fail = true;
    const second = request();
    win.message(second, ENV.vaultOrigin, vault);
    expect(document.querySelector('.request p.danger')?.textContent).toBe('Journear can’t read this request, so it can’t be approved.');
    expect(primary()).toBeNull();
    expect(document.querySelector('h2.summary-headline')).toBeNull();
    // The old Approve, even if a page kept it, answers nothing: it was drawn for the first request.
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    win.dispatch('pointermove', { pointerType: 'mouse', movementX: 4, movementY: 2 });
    win.dispatch('pointerdown', { pointerType: 'mouse' });
    staleApprove.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    const answers = vault.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((m) => m.t === 'hana:approve-result');
    // The first was rejected when the second arrived; nothing approved the second.
    expect(answers.map((a) => [a.id, a.approved])).toEqual([[first.id, false]]);
    // Reject still answers the second, as not approved.
    document.querySelector<HTMLButtonElement>('button.secondary')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    const after = vault.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((m) => m.t === 'hana:approve-result');
    expect(after.map((a) => [a.id, a.approved])).toEqual([[first.id, false], [second.id, false]]);
  });

  it('a consent renderer that fails shows the refusal with no Allow (review 2, N1)', () => {
    page.stop();
    resetDom();
    win = new FakeWindow('/approve');
    vault = remoteWindow();
    win.opener = asWindow(vault);
    page = startApprovePage({ win, env: ENV, isGesture: () => true, renderConsentScreen: () => { throw new Error('render failed'); } });
    win.dispatch('focus');
    const policy = validateAutoApprovePolicy(policyJson());
    if (!policy.ok) throw new Error('policy');
    win.message({ v: 1, t: 'hana:consent-request', id: newRequestId(), appName: 'Partner App', parentOrigin: PARTNER, policy: JSON.parse(JSON.stringify(policy.policy)), policyId: policyId(policy.policy), expiresAtMs: Date.now() + 3_600_000, position: 1, queued: 1 }, ENV.vaultOrigin, vault);
    expect(document.querySelector('div.consent p.danger')).not.toBeNull();
    expect(primary()).toBeNull();
  });

  it('opening or closing the details neither arms nor resets the Approve guard', () => {
    win.message(request(), ENV.vaultOrigin, vault);
    const d = document.querySelector<HTMLDetailsElement>('details.request-details')!;
    // Before the guard is armed: toggling (and the press on the summary) doesn't enable Approve.
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    win.dispatch('pointerdown', { pointerType: 'mouse' });
    d.open = true;
    d.dispatchEvent(new Event('toggle'));
    expect(primary()?.disabled).toBe(true);
    // Armed by a real move: toggling again doesn't disable it, and Approve still answers.
    win.dispatch('pointermove', { pointerType: 'mouse', movementX: 3, movementY: 1 });
    expect(primary()?.disabled).toBe(false);
    d.open = false;
    d.dispatchEvent(new Event('toggle'));
    expect(primary()?.disabled).toBe(false);
    win.dispatch('pointerdown', { pointerType: 'mouse' });
    primary()!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    const answers = vault.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((m) => m.t === 'hana:approve-result');
    expect(answers.map((a) => a.approved)).toEqual([true]);
  });
});

describe('control bullets keep the whole key; bullets merge only when their full texts match (review of 5ef13452)', () => {
  it('signers left out of the lines keep their bullets, whole; those in a line get none', () => {
    const k = (i: number) => Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(90 + i) as never).publicKey();
    const el = render(decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: txBytes([1, 2, 3, 4, 5].map((i) => Operation.setOptions({ signer: { ed25519PublicKey: k(i), weight: 1 } }))) }), 'Partner App', USER);
    const bullets = [...el.querySelectorAll('.danger-box li')].map((li) => li.textContent ?? '').join('\n');
    for (const i of [1, 2, 3]) expect(bullets).not.toContain(k(i));
    for (const i of [4, 5]) expect(bullets).toContain(k(i));
  });

  it('property: every signer and spender is named whole above the fold at least once', () => {
    let seed = 31;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const keys = Array.from({ length: 6 }, (_, i) => Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(100 + i) as never).publicKey());
    const token = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';
    for (let round = 0; round < 40; round++) {
      const named: string[] = [];
      const ops = Array.from({ length: 2 + rnd(10) }, () => {
        const kind = rnd(4);
        const key = keys[rnd(keys.length)]!;
        if (kind === 0) {
          named.push(key);
          return Operation.setOptions({ signer: { ed25519PublicKey: key, weight: 1 + rnd(9) } });
        }
        if (kind === 1) {
          named.push(key);
          return Operation.invokeContractFunction({ contract: token, function: 'approve', args: [nativeToScVal(USER, { type: 'address' }), nativeToScVal(key, { type: 'address' }), nativeToScVal(BigInt(1 + rnd(99)), { type: 'i128' }), xdr.ScVal.scvU32(9)] });
        }
        if (kind === 2) return Operation.payment({ destination: keys[rnd(keys.length)]!, asset: Asset.native(), amount: String(1 + rnd(50)) });
        return Operation.bumpSequence({ bumpTo: String(rnd(3)) });
      });
      const el = render(decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: txBytes(ops) }), 'Partner App', USER);
      const above = aboveFold(el);
      for (const id of named) expect(above.includes(id), `${id} in round ${round}`).toBe(true);
    }
  });
});

describe('a control change is named whole above the fold: once in its own line, or as a bullet when left out', () => {
  it('property: every NEAR key added or removed appears in full above the fold, never zero times', () => {
    const pub = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const me = nearImplicitAccountId(pub);
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let round = 0; round < 60; round++) {
      const named = new Set<string>();
      const actions = Array.from({ length: 1 + rnd(12) }, (): NearAction => {
        const kind = rnd(4);
        const bytes = new Uint8Array(32).fill(40 + rnd(8));
        if (kind === 0) {
          named.add(nearPublicKeyString(bytes));
          return { type: 'addKey', publicKey: { type: 'ed25519', bytes }, accessKey: { nonce: 0n, permission: { type: 'fullAccess' } } };
        }
        if (kind === 1) {
          named.add(nearPublicKeyString(bytes));
          return { type: 'deleteKey', publicKey: { type: 'ed25519', bytes } };
        }
        if (kind === 2) return { type: 'transfer', deposit: BigInt(1 + rnd(5)) * 10n ** 24n };
        return { type: 'functionCall', methodName: `m${rnd(6)}`, args: utf8('{}'), gas: 1n, deposit: 0n };
      });
      const bytes = encodeNearTransaction({ signerId: me, publicKey: { type: 'ed25519', bytes: pub }, nonce: 1n, receiverId: me, blockHash: sha256(utf8('b')), actions });
      const el = render(decodeApprovalRequest({ kind: 'near_tx', chain: 'near', address: me, context: { nearNetwork: 'testnet' }, bytes }), 'Partner App', me);
      const above = aboveFold(el);
      for (const key of named) expect(above.includes(key), `${key} in round ${round}`).toBe(true);
      // A key whose step is in a visible line is not repeated as a bullet.
      const lines = [...el.querySelectorAll('h2.summary-headline, p.summary-line')].map((p) => p.textContent ?? '').join('\n');
      const bullets = [...el.querySelectorAll('.danger-box li')].map((li) => li.textContent ?? '').join('\n');
      for (const key of named) if (lines.includes(key) && !bullets.includes('Not in the lines above')) expect(bullets.includes(key), `${key} repeated in round ${round}`).toBe(false);
    }
  });
});

describe('D859: addresses and keys in sentences: short there, whole once in their own row', () => {
  const word = (v: string | bigint) => (typeof v === 'string' ? v.slice(2).toLowerCase().padStart(64, '0') : v.toString(16).padStart(64, '0'));
  const data = (sig: string, ...args: (string | bigint)[]) => `${parseFunctionSignature(sig).selector}${args.map(word).join('')}`;
  const idRows = (el: Element) => [...(el.matches('dl.id-rows') ? [el] : []), ...el.querySelectorAll('dl.id-rows')].flatMap((dl) => [...dl.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));

  it('one recipient: its short form in the sentence, the whole value in a "To" row right under it, in one piece (D876)', () => {
    const el = render(evm({ to: TOKEN, value: '0x0', data: data('transfer(address,uint256)', SPENDER, 5n) }));
    expect(shownText(el.querySelector('h2.summary-headline'))).toBe(`Partner App wants to send 5 units of an unlisted token to ${shortId(SPENDER)}`);
    expect(el.children[1]?.matches('dl.id-rows')).toBe(true);
    expect(idRows(el.children[1]!)).toEqual([['To', SPENDER]]);
    // D876 (it replaced D859's groups of four): one text node, nothing inside it, so a copy of it is the value exactly.
    const whole = el.children[1]!.querySelector('dd > code.mono.id-full')!;
    expect(whole.textContent).toBe(SPENDER);
    expect(whole.childNodes).toHaveLength(1);
    expect(whole.firstChild?.nodeType).toBe(3);
    expect(el.querySelector('.grp')).toBeNull();
    // No Copy above the fold: the user's own account has one, in the details.
    expect(el.children[1]!.querySelector('button')).toBeNull();
    // The short form and the row come from the same value; the short form is hidden from screen readers.
    const short = el.querySelector('h2 code.short-id')!;
    expect(short.textContent).toBe(shortId(SPENDER));
    expect(short.getAttribute('aria-hidden')).toBe('true');
    expect(short.nextElementSibling?.textContent).toBe(' (written out below)');
    expect(idProblems(el)).toEqual([]);
  });

  it('two different addresses with the same short form: numbered in the sentence, both whole in their rows', () => {
    const a = `0x1234${'5'.repeat(32)}abcd`;
    const b = `0x1234${'6'.repeat(32)}abcd`;
    // The decoder writes them EIP-55 ("…abcD", "…aBcd"): short forms that differ only in letter case still look alike.
    expect(shortId(a)).toBe(shortId(b));
    const el = render(evm({ to: TOKEN, value: '0x0', data: data('transferFrom(address,address,uint256)', a, b, 5n) }));
    const head = shownText(el.querySelector('h2.summary-headline'))!;
    expect(head).toBe('Partner App wants to move 5 units of an unlisted token from account 1 to account 2');
    expect(head).not.toContain(shortId(a));
    expect(idRows(el.children[1]!).map(([l, v]) => [l, v?.toLowerCase()])).toEqual([['From (account 1)', a], ['To (account 2)', b]]);
    expect(idProblems(el)).toEqual([]);
  });

  it('an address that shares the user’s own short form (a look-alike of the account line) is numbered, never shown by it', () => {
    const lookalike = `${EVM.slice(0, 6)}${'0'.repeat(32)}${EVM.slice(-4)}`;
    expect(shortId(lookalike)).toBe(shortId(EVM));
    const el = render(evm({ to: lookalike }));
    expect(shownText(el.querySelector('h2.summary-headline'))).toBe('Partner App wants to send 1 ETH to account 1');
    expect(el.textContent?.toLowerCase()).not.toContain(shortId(EVM).toLowerCase());
    expect(idRows(el).map(([l, v]) => [l, v?.toLowerCase()])).toEqual([['To (account 1)', lookalike]]);
  });

  it('a value named twice gets one row, under the first sentence that names it (the headline’s come right after the red box)', () => {
    const el = render(evm({ to: TOKEN, value: '0x0', data: approveData(2n ** 256n - 1n) }));
    const box = el.querySelector('.danger-box')!;
    // The token is the headline's: its row comes right after the red box; the spender's row is in the box, under its line.
    expect(idRows(box)).toEqual([['Who gets the permission', SPENDER]]);
    expect(box.nextElementSibling?.matches('dl.id-rows')).toBe(true);
    expect(idRows(box.nextElementSibling!)).toEqual([['Token', TOKEN]]);
    expect(idProblems(el)).toEqual([]);
  });

  it('a readable NEAR name stays whole in the sentence with no row; an implicit account is cut and gets one', () => {
    const pub = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const me = nearImplicitAccountId(pub);
    const other = nearImplicitAccountId(new Uint8Array(32).fill(7));
    const tx = (receiverId: string) => encodeNearTransaction({ signerId: me, publicKey: { type: 'ed25519', bytes: pub }, nonce: 1n, receiverId, blockHash: sha256(utf8('b')), actions: [{ type: 'transfer', deposit: 10n ** 24n }] });
    const named = render(decodeApprovalRequest({ kind: 'near_tx', chain: 'near', address: me, context: { nearNetwork: 'testnet' }, bytes: tx('e2e-stamps.testnet') }), 'Partner App', me);
    expect(shownText(named.querySelector('h2.summary-headline'))).toBe('Partner App wants to send 1 NEAR to e2e-stamps.testnet');
    expect(named.querySelector('dl.id-rows')).toBeNull();
    const implicit = render(decodeApprovalRequest({ kind: 'near_tx', chain: 'near', address: me, context: { nearNetwork: 'testnet' }, bytes: tx(other) }), 'Partner App', me);
    expect(shownText(implicit.querySelector('h2.summary-headline'))).toBe(`Partner App wants to send 1 NEAR to ${shortId(other)}`);
    expect(idRows(implicit)).toEqual([['To', other]]);
  });

  it('screen readers: "(written out below)" at the first mention, "(written out above)" once the row is above, nothing in between', () => {
    const el = render(evm({ to: TOKEN, value: '0x0', data: approveData(0n) }));
    const hints = (sel: string) => [...el.querySelectorAll(`${sel} code.short-id`)].map((c) => (c.nextElementSibling?.matches('.sr-only') ? c.nextElementSibling.textContent : null));
    expect(hints('h2.summary-headline')).toEqual([' (written out below)', ' (written out below)']);
    // The amber line names both again, after their rows.
    expect(hints('.warning-box .risk-lead')).toEqual([' (written out above)', ' (written out above)', ' (written out above)']);
    expect(idProblems(el)).toEqual([]);
  });
});

describe('the renderer’s own fixed texts claim no zero cost (review of PR 80)', () => {
  it('every fixed note, row and banner passes the zero-cost scan', () => {
    const fixed = [NEAR_DELEGATE_NONE, NEAR_OWN_CONTRACT_TOTAL, NEAR_DELEGATE_NOTES.relayer, NEAR_DELEGATE_NOTES.network('testnet'), NEAR_DELEGATE_NOTES.network('mainnet'), NO_NETWORK_NOTE, TYPED_DATA_NO_CHAIN, ACCOUNT_CONTROL_BANNER, NEAR_ACCOUNT_CONTROL_BANNER, TEST_APP_NOTE, TEST_APP_DEMO_NOTE, MAINNET_DEMO_BANNER, MAINNET_DEMO_WHY, OUT_OF_POLICY_TEXT, overflowNote(10)];
    for (const t of fixed) expect(ZERO_COST.test(t), t).toBe(false);
    // The test-app note claims no more than holds: it doesn't promise nothing is approved on a real network.
    expect(TEST_APP_NOTE).toBe('This app is a test version, so it works only with test money. Don’t keep real money in this account.');
  });
});

