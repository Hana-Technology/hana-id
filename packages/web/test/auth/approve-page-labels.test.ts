// @vitest-environment happy-dom
// D896: partner labels through the real approval page (approve-page.ts): the vault's hana:approve-request carries the
// documents' text; the page parses them with its own parser and shows a label only for a request that matches one.
// A request whose labels describe nothing here, or that the page's parser refuses, shows exactly the page it shows
// without the field; hostile documents never reach the screen; the answer's digest never depends on labels.
import { approvalDigest, newRequestId } from '@hana-id/core';
import { partnerAttribution } from '@hana-id/core/partner-labels';
import { Keypair } from '@stellar/stellar-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARD_DELAY_MS } from '../../src/auth/approve-guard.ts';
import { startApprovePage } from '../../src/auth/approve-page.ts';
import { OTHER, PASSPHRASE, PAYMENT_DOC_JSON, STAMPS_DOC_JSON, USER, paymentTx } from '../../../core/test/partner-labels-fixtures.ts';
import { ENV, FakeWindow, PARTNER, type RemoteWindow, asWindow, remoteWindow, resetDom } from './helpers.ts';

const T0 = 1_800_000_000_000;
const PAYMENT_TEXT = JSON.stringify(PAYMENT_DOC_JSON);
const STRANGER = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(21) as never).publicKey();

type Req = Record<string, unknown> & { id: string };
const request = (over: Record<string, unknown> = {}): Req => ({
  v: 1,
  t: 'hana:approve-request',
  id: newRequestId(),
  appName: 'Coffee Club',
  parentOrigin: PARTNER,
  kind: 'stellar_tx',
  chain: 'stellar',
  address: USER,
  bytes: paymentTx(),
  context: { networkPassphrase: PASSPHRASE },
  position: 1,
  queued: 1,
  testApp: true,
  ...over,
});

let win: FakeWindow;
let vault: RemoteWindow;
let page: ReturnType<typeof startApprovePage>;

function start(): void {
  win = new FakeWindow('/approve');
  vault = remoteWindow();
  win.opener = asWindow(vault);
  page = startApprovePage({ win, env: ENV, isGesture: () => true });
  win.dispatch('focus');
}
const send = (m: unknown) => win.message(m, ENV.vaultOrigin, vault);
const app = () => document.getElementById('app')!;
/** The page for `m`, as HTML, in a fresh window (the same request id, so the same screen). */
function screenOf(m: Req): string {
  page?.stop();
  resetDom();
  start();
  send(m);
  return app().innerHTML;
}

beforeEach(() => {
  resetDom();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  start();
});
afterEach(() => {
  page.stop();
  vi.useRealTimers();
});

describe('the approval page with partner labels (D896)', () => {
  it('a matching payment: the partner’s box, attributed; Approve answers the same digest as without labels', () => {
    const m = request({ partnerLabels: [PAYMENT_TEXT] });
    send(m);
    const box = document.querySelector('div.partner-label');
    expect(box?.querySelector('p.partner-says')?.textContent).toBe('Coffee Club says: pay for order 1042');
    expect(box?.querySelector('p.partner-attribution')?.textContent).toBe(partnerAttribution('Coffee Club'));
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    win.dispatch('pointermove', { pointerType: 'mouse', movementX: 3, movementY: 1 });
    win.dispatch('pointerdown', { pointerType: 'mouse' });
    document.querySelector<HTMLButtonElement>('button.primary')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    const result = vault.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>).find((x) => x.t === 'hana:approve-result');
    expect(result).toMatchObject({ id: m.id, approved: true });
    expect(result!.digest).toEqual(approvalDigest({ id: m.id, kind: 'stellar_tx', chain: 'stellar', address: USER, parentOrigin: PARTNER, context: { networkPassphrase: PASSPHRASE }, bytes: m.bytes as Uint8Array }));
  });

  it('the same page without the field, and with documents that describe nothing here or that its parser refuses', () => {
    const base = request();
    const plain = screenOf(base);
    expect(plain).not.toContain('partner-label');
    const hostile = PAYMENT_TEXT.replace('"order"', '"order ‮redro"');
    const claim = PAYMENT_TEXT.replace('"order"', '"verified order"');
    const mainnet = PAYMENT_TEXT.replace(PASSPHRASE, 'Public Global Stellar Network ; September 2015');
    for (const partnerLabels of [[JSON.stringify(STAMPS_DOC_JSON)], [hostile], [claim], [mainnet], [PAYMENT_TEXT, PAYMENT_TEXT.replace('"order"', '"ticket"')], ['{']]) {
      expect(screenOf({ ...base, partnerLabels }), JSON.stringify(partnerLabels).slice(0, 60)).toBe(plain);
    }
  });

  it('a payment to an account the app hasn’t listed: the red lines and no partner words', () => {
    send(request({ bytes: paymentTx({ destination: STRANGER }), partnerLabels: [PAYMENT_TEXT] }));
    expect(document.querySelector('.risk-box.danger-box p.risk-lead')?.textContent).toBe('This isn’t one of the accounts Coffee Club has listed for payments. If you expected to pay Coffee Club, don’t approve.');
    expect(app().textContent).not.toContain('Coffee Club till');
    expect(document.querySelector('div.partner-label')).toBeNull();
    // Approve stays (a warning, never a block).
    expect(document.querySelector('button.primary')).not.toBeNull();
    expect(OTHER).not.toBe(STRANGER);
  });

  it('a malformed field: the vault’s message is dropped whole by the page’s validator, as any malformed message', () => {
    send(request({ partnerLabels: [] }));
    expect(document.querySelector('h2.summary-headline')).toBeNull();
    send(request({ partnerLabels: 'x' }));
    expect(document.querySelector('h2.summary-headline')).toBeNull();
  });
});
