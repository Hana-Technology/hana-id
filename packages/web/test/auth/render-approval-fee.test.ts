// @vitest-environment happy-dom
// D884: where the approval window shows the network fee. A fee row in the main view means the user pays it; a fee the
// user doesn't pay (a sponsored EVM action, a relayed NEAR action) is only in the folded details, first, as
// "Free. Sponsored by {App}.", the app's name exactly as the window's header and headline show it.
import { type NearAction, encodeNearDelegateAction, encodeNearTransaction, evmTxSigningPayload, nearImplicitAccountId, parseEvmTxRequest, utf8 } from '@hana-id/core';
import { type DecodedApproval, decodeApprovalRequest, summarizeApproval, summaryString } from '@hana-id/core/decode';
import { beforeEach, describe, expect, it } from 'vitest';
import { dom } from '../../src/auth/dom.ts';
import { NO_APP_NAME, renderApproval } from '../../src/auth/render-approval.ts';
import { OTHER, PASSPHRASE, USER, feeBumpBytes, paymentOp, txBytes } from '../../../core/test/stellar-fixtures.ts';
import { CHECK_IN, CHECK_IN_DATA, SPENDER, SPONSOR_CHAINS, SPONSOR_ME, SPONSOR_NOW_MS, TOKEN, UINT256_MAX, calldata, sponsorSubject, sponsoredApproval, sponsoredCall } from '../../../core/test/evm-sponsored-fixture.ts';
import { jargonWatch } from './plain-words.ts';

const APP = 'Partner App';
const PUB = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const NEAR_ME = nearImplicitAccountId(PUB);
const BLOCK = new Uint8Array(32).fill(7);
const plain = jargonWatch();

const sponsored = (calls = [sponsoredCall(CHECK_IN, CHECK_IN_DATA)], authNonce: bigint | null = null): DecodedApproval =>
  decodeApprovalRequest(sponsoredApproval(sponsorSubject({ calls, authNonce })), { sponsorChains: SPONSOR_CHAINS, nowMs: SPONSOR_NOW_MS });
const evmTx = (): DecodedApproval => {
  const tx = { chainId: '0x14a34', nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x1', to: TOKEN, value: '0x2386f26fc10000', data: '0x' };
  return decodeApprovalRequest({ kind: 'evm_tx', chain: 'evm', address: SPONSOR_ME, context: { chainId: 84532 }, bytes: evmTxSigningPayload(parseEvmTxRequest(tx)) });
};
const call = (methodName: string, deposit = 0n): NearAction => ({ type: 'functionCall', methodName, args: utf8('{}'), gas: 30_000_000_000_000n, deposit });
const nearDelegate = (actions: NearAction[], receiverId = 'guestbook.testnet'): DecodedApproval =>
  decodeApprovalRequest({
    kind: 'near_delegate',
    chain: 'near',
    address: NEAR_ME,
    context: { nearNetwork: 'testnet' },
    bytes: encodeNearDelegateAction({ senderId: NEAR_ME, receiverId, actions, nonce: 7n, maxBlockHeight: 9n, publicKey: { type: 'ed25519', bytes: PUB } }),
  });
const nearTx = (actions: NearAction[], receiverId = 'bob.testnet'): DecodedApproval =>
  decodeApprovalRequest({
    kind: 'near_tx',
    chain: 'near',
    address: NEAR_ME,
    context: { nearNetwork: 'testnet' },
    bytes: encodeNearTransaction({ signerId: NEAR_ME, publicKey: { type: 'ed25519', bytes: PUB }, nonce: 3n, receiverId, blockHash: BLOCK, actions }),
  });
const stellar = (bytes: Uint8Array): DecodedApproval => decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes });

/** Every kind of request, the free fees and the paid ones, and the ones that cost no fee at all. */
const CASES: readonly [string, () => DecodedApproval, string][] = [
  ['an EVM transaction (the user pays)', evmTx, SPONSOR_ME],
  ['a sponsored EVM check-in, later (free)', () => sponsored(), SPONSOR_ME],
  ['a sponsored EVM check-in, first time with its setup (free)', () => sponsored(undefined, 0n), SPONSOR_ME],
  ['a sponsored unlimited permission (free, beside a red box)', () => sponsored([sponsoredCall(TOKEN, calldata('approve(address,uint256)', SPENDER, UINT256_MAX))]), SPONSOR_ME],
  ['a sponsored call Journear can’t read (free, beside a red box)', () => sponsored([sponsoredCall('0x4444444444444444444444444444444444444444', CHECK_IN_DATA)]), SPONSOR_ME],
  ['a NEAR transfer (the user pays)', () => nearTx([{ type: 'transfer', deposit: 10n ** 24n }]), NEAR_ME],
  ['a relayed NEAR call (free)', () => nearDelegate([call('collect')]), NEAR_ME],
  ['a relayed NEAR call that attaches NEAR (free; the NEAR is the sender’s)', () => nearDelegate([call('collect', 10n ** 24n)]), NEAR_ME],
  ['a relayed NEAR token transfer (free fee; the user’s tokens move)', () => nearDelegate([call('ft_transfer', 1n)], 'usdc.testnet'), NEAR_ME],
  ['a relayed NEAR stake (free fee; the user’s NEAR is locked)', () => nearDelegate([{ type: 'stake', stake: 10n ** 24n, publicKey: { type: 'ed25519', bytes: PUB } }], NEAR_ME), NEAR_ME],
  ['a Stellar payment (the user pays)', () => stellar(txBytes([paymentOp()])), USER],
  ['a Stellar fee bump the user pays', () => stellar(feeBumpBytes(txBytes([paymentOp()]))), USER],
  ['a Stellar fee bump another account pays (no fee row; a line names the payer)', () => stellar(feeBumpBytes(txBytes([paymentOp()]), OTHER)), USER],
  ['a message (no fee)', () => decodeApprovalRequest({ kind: 'personal_sign', chain: 'evm', address: SPONSOR_ME, context: {}, bytes: utf8('Sign in') }), SPONSOR_ME],
];

const render = (decoded: DecodedApproval, address: string, appName = APP): HTMLElement => {
  const el = renderApproval(dom(document), decoded, appName, { envNetwork: 'testnet', testApp: true, address, nowMs: SPONSOR_NOW_MS });
  document.body.replaceChildren(el);
  expect(el.querySelector('.summary-failed')).toBeNull();
  if (appName === APP) plain(el);
  return el;
};
const feeRows = (root: Element) => [...root.querySelectorAll('dt')].filter((dt) => dt.textContent === 'Network fee').map((dt) => dt.nextElementSibling as HTMLElement);
const mainView = (el: Element) => [...el.children].filter((c) => !c.matches('details'));
const detailsBody = (el: Element) => el.querySelector('details.request-details > .details-body') as HTMLElement;

beforeEach(() => document.body.replaceChildren());

describe('D884: a fee the user pays is always in the main view; a free one never is', () => {
  for (const [name, decode, address] of CASES) {
    it(name, () => {
      const decoded = decode();
      const summary = summarizeApproval(decoded, { address });
      const el = render(decoded, address);
      const inMain = mainView(el).flatMap(feeRows);
      const inDetails = feeRows(detailsBody(el));
      if (summary.fee === null) {
        expect(inMain).toEqual([]);
        expect(inDetails).toEqual([]);
      } else if (summary.freeFee) {
        // Never in the main view; once, first in the details, the words naming the app.
        expect(inMain).toEqual([]);
        expect(inDetails).toHaveLength(1);
        expect(inDetails[0]?.textContent).toBe(`Free. Sponsored by ${APP}.`);
        expect(detailsBody(el).firstElementChild?.matches('dl.jp-kv.fee-facts')).toBe(true);
        expect(inDetails[0]?.classList.contains('fee-free')).toBe(true);
        // The check mark: plain text colour beside a red box, the success colour otherwise (D877).
        expect(inDetails[0]?.classList.contains('beside-danger')).toBe(el.querySelector('.danger-box') !== null);
      } else {
        // The user pays it: in the main view's facts, as before, and nowhere else.
        expect(inMain).toHaveLength(1);
        expect(inMain[0]?.textContent).toBe(summaryString(summary.fee, APP));
        expect(inMain[0]?.closest('dl.summary-facts')).not.toBeNull();
        expect(inMain[0]?.classList.contains('fee-free')).toBe(false);
        expect(inMain[0]?.textContent).not.toMatch(/free|sponsor/iu);
        expect(inDetails).toEqual([]);
      }
      // Nowhere does the window say Journear pays, nor that someone unnamed does (D884 replaces both).
      expect(el.textContent).not.toMatch(/Journear pays|Someone else pays|paid by someone else|Free for you/u);
    });
  }

  it('the free kinds are exactly the sponsored EVM action and the relayed NEAR action', () => {
    const free = CASES.filter(([, decode, address]) => summarizeApproval(decode(), { address }).freeFee === true).map(([, decode]) => decode().kind);
    expect(new Set(free)).toEqual(new Set(['evm_sponsored', 'near_delegate']));
  });

  it('a free action that still takes the user’s NEAR or tokens says so in the main view (the total row stays)', () => {
    const stake = render(nearDelegate([{ type: 'stake', stake: 10n ** 24n, publicKey: { type: 'ed25519', bytes: PUB } }], NEAR_ME), NEAR_ME);
    expect(mainView(stake).map((c) => c.textContent).join('\n')).toContain('NEAR locked up for staking1 NEAR');
    const tokens = render(nearDelegate([call('ft_transfer', 1n)], 'usdc.testnet'), NEAR_ME);
    expect(mainView(tokens).map((c) => c.textContent).join('\n')).toContain('NEAR leaving your accountNone of your NEAR. Tokens it moves are yours.');
  });
});

describe('D884: the app’s name in the fee line', () => {
  it('is the header’s name, as every sentence shows it: bold, its own element, the text exactly as given', () => {
    // Right-to-left letters and look-alikes are kept as given: the page's CSS isolates `strong` (bidi), and the API
    // refuses names that hold "Journear" or look like a web address (D686, D765).
    for (const name of ['متجر', 'Café Ünïcode', 'A'.repeat(200), 'x < y & "z"']) {
      const el = render(sponsored(), SPONSOR_ME, name);
      const fee = feeRows(detailsBody(el))[0] as HTMLElement;
      expect(fee.textContent).toBe(`Free. Sponsored by ${name}.`);
      const app = fee.querySelector('strong.app-name') as HTMLElement;
      expect(app.textContent).toBe(name);
      expect(app.children).toHaveLength(0);
      // Nothing follows the name but the full stop: a long name can't push words of the window after it.
      expect(app.nextSibling?.textContent).toBe('.');
      expect(app.nextSibling?.nextSibling).toBeNull();
      // The same element and text as the headline's name.
      expect(el.querySelector('h2.summary-headline strong.app-name')?.textContent).toBe(name);
    }
  });

  it('with no name to show, says "the app" (a whole, true sentence), in the fee line and the relayed note', () => {
    for (const name of ['', '   ']) {
      const evm = feeRows(detailsBody(render(sponsored(), SPONSOR_ME, name)))[0] as HTMLElement;
      expect(evm.textContent).toBe(`Free. Sponsored by ${NO_APP_NAME}.`);
      expect(evm.querySelector('strong.app-name')).toBeNull();
      const near = render(nearDelegate([call('collect')]), NEAR_ME, name);
      expect(feeRows(detailsBody(near))[0]?.textContent).toBe('Free. Sponsored by the app.');
      expect(near.querySelector('p.relayer-note')?.textContent).toMatch(/^Someone else sends this for you, sponsored by the app\. /u);
    }
  });

  it('the relayed note names the app as the fee line does', () => {
    const el = render(nearDelegate([call('collect')]), NEAR_ME);
    const note = el.querySelector('details p.relayer-note') as HTMLElement;
    expect(note.querySelector('strong.app-name')?.textContent).toBe(APP);
    expect(note.textContent).toBe(
      `Someone else sends this for you, sponsored by ${APP}. They pay the network fee and any NEAR it attaches or sends. If an action fails, that NEAR comes back to your account. The actions run as your account.`,
    );
  });
});
