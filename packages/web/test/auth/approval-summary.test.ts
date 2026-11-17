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
  newRequestId,
  parseEvmTxRequest,
  sha256,
  utf8,
} from '@hana-id/core';
import { type DecodedApproval, decodeApprovalRequest, parseFunctionSignature } from '@hana-id/core/decode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARD_DELAY_MS } from '../../src/auth/approve-guard.ts';
import { TEST_APP_NOTE, startApprovePage } from '../../src/auth/approve-page.ts';
import { dom } from '../../src/auth/dom.ts';
import { ACCOUNT_CONTROL_BANNER, DETAILS_LABELS, NEAR_ACCOUNT_CONTROL_BANNER, NO_NETWORK_NOTE, markOverflowing, nearMessageWarning, renderApproval, watchOverflowing } from '../../src/auth/render-approval.ts';
import { PASSPHRASE, USER, addSignerOp, paymentOp, txBytes } from '../../../core/test/stellar-fixtures.ts';
import { ENV, FakeWindow, PARTNER, type RemoteWindow, asWindow, remoteWindow, resetDom } from './helpers.ts';

const EVM = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const TOKEN = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x3333333333333333333333333333333333333333';
const TX = { chainId: '0xaa36a7', nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', to: EVM, value: '0xde0b6b3a7640000', data: '0x' };
const word = (v: bigint | string) => (typeof v === 'string' ? v.slice(2).toLowerCase().padStart(64, '0') : v.toString(16).padStart(64, '0'));
const evmBytes = (over: Record<string, string> = {}) => evmTxSigningPayload(parseEvmTxRequest({ ...TX, ...over }));
const evm = (over: Record<string, string> = {}) => decodeApprovalRequest({ kind: 'evm_tx', chain: 'evm', address: EVM, context: { chainId: 11155111 }, bytes: evmBytes(over) });
const approveData = (amount: bigint) => `${parseFunctionSignature('approve(address,uint256)').selector}${word(SPENDER)}${word(amount)}`;

const render = (decoded: DecodedApproval, app = 'Partner App', address = EVM): HTMLElement => {
  const el = renderApproval(dom(document), decoded, app, { envNetwork: 'testnet', testApp: false, parentOrigin: PARTNER, address });
  document.body.replaceChildren(el);
  return el;
};
const details = (el: ParentNode) => el.querySelector<HTMLDetailsElement>('details.request-details');
/** True when `node` sits inside the foldable details. */
const folded = (node: Element | null) => node !== null && node.closest('details.request-details') !== null;

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
    expect(fee?.nextElementSibling?.textContent).toBe('up to 0.000000000000042 ETH');
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

  it('a request Journear can’t explain: the plain line outside, the details open (the raw data in them)', () => {
    const el = render(evm({ to: TOKEN, value: '0x0', data: '0xdeadbeef00' }));
    const warn = el.querySelector('p.summary-warning.cannot-explain');
    expect(warn?.textContent).toBe('Journear can’t explain this request in plain words: it calls a function Journear doesn’t recognise. Only approve if you trust Partner App.');
    expect(folded(warn)).toBe(false);
    expect(details(el)?.open).toBe(true);
    expect(details(el)?.querySelector('summary')?.textContent).toBe(DETAILS_LABELS.hide);
    expect(details(el)?.textContent).toContain('0xdeadbeef00');
    expect(el.dataset.explainable).toBe('false');
  });

  it('raw signing: a details section that can’t be folded (no toggle at all), its danger line outside', () => {
    const el = render(decodeApprovalRequest({ kind: 'raw', chain: 'evm', address: EVM, context: {}, bytes: new Uint8Array(32).fill(1) }));
    expect(el.querySelector('details')).toBeNull();
    expect(el.querySelector('summary')).toBeNull();
    const fixed = el.querySelector('section.request-details.fixed');
    expect(fixed?.querySelector('h3')?.textContent).toBe(DETAILS_LABELS.fixed);
    expect(fixed?.textContent).toContain(`0x${'01'.repeat(32)}`);
    expect(el.querySelector('p.danger')?.closest('.request-details')).toBeNull();
    expect(el.textContent).toContain(NO_NETWORK_NOTE);
  });
});

describe('warnings are never folded', () => {
  it('an unlimited approve: the red warning outside the closed details', () => {
    const el = render(evm({ to: TOKEN, value: '0x0', data: approveData(2n ** 256n - 1n) }));
    const w = el.querySelector('p.summary-warning.unlimited-spend');
    expect(w?.classList.contains('jp-alert-danger')).toBe(true);
    expect(w?.textContent).toContain(`This lets ${SPENDER}, an address Journear hasn’t verified, spend all of your tokens of contract ${TOKEN}, with no limit`);
    expect(folded(w)).toBe(false);
    expect(details(el)?.open).toBe(false);
  });

  it('approve(spender, 0) on a contract Journear doesn’t know: amber, it may be an NFT’s item 0 (review M1)', () => {
    const el = render(evm({ to: TOKEN, value: '0x0', data: approveData(0n) }));
    const w = el.querySelector('p.summary-warning.spend-permission');
    expect(w?.textContent).toContain('item 0');
    expect(folded(w)).toBe(false);
    expect(el.querySelector('h2.summary-headline')?.textContent).toBe(`Partner App wants to change ${SPENDER}’s permission for contract ${TOKEN}`);
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
    expect(el.children[1]?.textContent).toBe(NEAR_ACCOUNT_CONTROL_BANNER);
    expect(el.children[2]?.classList.contains('takeover')).toBe(true);
    expect(el.querySelectorAll('p.summary-line')).toHaveLength(6);
    expect(details(el)?.open).toBe(true);
  });

  it('Stellar account control: the banner and each operation’s warning outside the fold, the operation framed inside', () => {
    const el = render(decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: txBytes([paymentOp(), addSignerOp()]) }), 'Partner App', USER);
    const banner = el.querySelector('p.takeover.banner');
    expect(banner?.textContent).toBe(ACCOUNT_CONTROL_BANNER);
    expect(folded(banner)).toBe(false);
    for (const p of el.querySelectorAll('p.danger.takeover')) expect(folded(p)).toBe(false);
    expect(el.querySelectorAll('p.danger.takeover')).toHaveLength(2);
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
    expect(network?.nextElementSibling?.textContent).toBe('NEAR testnet (Journear found its block hash on testnet)');
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
    expect(el.querySelector('h2.summary-headline')?.textContent).toBe(`${name} wants to use contract ${TOKEN}`);
    expect(el.querySelector('p.cannot-explain')?.textContent).toContain(`trust ${name}.`);
  });

  it('a typed-data type name never reaches the summary; the tree is in the open details', () => {
    const json = {
      types: { EIP712Domain: [{ name: 'name', type: 'string' }], SafeLoginNoFundsMove: [{ name: 'note', type: 'string' }] },
      primaryType: 'SafeLoginNoFundsMove',
      domain: { name: 'Safe' },
      message: { note: 'hi' },
    };
    const el = render(decodeApprovalRequest({ kind: 'eip712', chain: 'evm', address: EVM, context: {}, bytes: utf8(JSON.stringify(json)) }));
    const outside = [...el.children].filter((c) => !c.matches('details')).map((c) => c.textContent).join(' ');
    expect(outside).not.toContain('SafeLoginNoFundsMove');
    expect(details(el)?.open).toBe(true);
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
