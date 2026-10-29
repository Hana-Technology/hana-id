// @vitest-environment happy-dom
// The approval popup's rendering of Stellar classic operations (CORE-1, docs/decisions.md D110): every operation is
// shown field by field, account-control operations (setOptions signer, threshold or master-weight changes and
// accountMerge) get the danger-level account-control warnings, and partner-chosen values only ever reach the page as
// text.
import { decodeApprovalRequest } from '@hana-id/core/decode';
import { Operation, type xdr } from '@stellar/stellar-base';
import { beforeEach, describe, expect, it } from 'vitest';
import { dom } from '../../src/auth/dom.ts';
import { ACCOUNT_CONTROL_BANNER, accountControlWarnings, renderApproval } from '../../src/auth/render-approval.ts';
import {
  ATTACKER,
  BALANCE_ID,
  ISSUER,
  OTHER,
  PASSPHRASE,
  POOL_ID,
  USER,
  accountControlOps,
  addSignerOp,
  changeTrustOp,
  feeBumpBytes,
  masterWeightOp,
  mergeOp,
  paymentOp,
  plainClassicOps,
  thresholdsOp,
  txBytes,
} from '../../../core/test/stellar-fixtures.ts';

function render(ops: xdr.Operation[], bytes = txBytes(ops)): HTMLElement {
  const decoded = decodeApprovalRequest({
    kind: 'stellar_tx',
    chain: 'stellar',
    address: USER,
    context: { networkPassphrase: PASSPHRASE },
    bytes,
  });
  const el = renderApproval(dom(document), decoded, 'Partner App');
  document.body.replaceChildren(el);
  return el;
}

const takeovers = (el: HTMLElement) => [...el.querySelectorAll('p.danger.takeover')].map((p) => p.textContent);
const usdc = `USDC:${ISSUER}`;

describe('renderApproval: Stellar account-control operations', () => {
  beforeEach(() => document.body.replaceChildren());

  it('shows a new signer with its key and weight, under the account-control banner', () => {
    const el = render([addSignerOp(255)]);
    const banner = el.querySelector('p.takeover.banner');
    expect(banner?.textContent).toBe(ACCOUNT_CONTROL_BANNER);
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(takeovers(el)).toEqual([
      ACCOUNT_CONTROL_BANNER,
      `This adds ${ATTACKER} as a signer with weight 255. Whoever holds that key can sign for the account and, with enough weight, move all its funds and lock you out.`,
    ]);
    expect(el.querySelector('li.op.takeover-op')).not.toBeNull();
    expect(el.textContent).toContain('Adds signer');
    expect(el.textContent).toContain(`${ATTACKER} (ed25519, weight 255)`);
    // Not the old "Hana does not decode this operation" notice.
    expect(el.textContent).not.toContain('does not decode');
  });

  it('shows a signer removal, threshold and master-weight changes with their own warnings', () => {
    const el = render([addSignerOp(0), thresholdsOp(), masterWeightOp(0)]);
    const w = takeovers(el);
    expect(w[0]).toBe(ACCOUNT_CONTROL_BANNER);
    expect(w).toContain(`This removes signer ${ATTACKER} from the account.`);
    expect(w.some((t) => t?.startsWith('This changes the account’s signing thresholds'))).toBe(true);
    expect(w.some((t) => t?.includes('your Hana key) to 0: it can no longer sign'))).toBe(true);
    expect(el.textContent).toContain('Removes signer');
    expect(el.textContent).toContain('Low threshold0');
    expect(el.textContent).toContain('Medium threshold2');
    expect(el.textContent).toContain('High threshold255');
    expect(el.textContent).toContain('Own key weight0');
    expect(el.querySelectorAll('li.op.takeover-op')).toHaveLength(3);
  });

  it('shows the accountMerge destination in the warning and the rows', () => {
    const el = render([mergeOp(OTHER)]);
    expect(takeovers(el)).toEqual([
      ACCOUNT_CONTROL_BANNER,
      `This closes the account and sends all of its XLM to ${OTHER}. It can’t be undone.`,
    ]);
    expect(el.textContent).toContain(`Sends all XLM to${OTHER}`);
  });

  it('keeps the banner on a fee-bump around an account-control operation', () => {
    const el = render([], feeBumpBytes(txBytes([mergeOp()]), OTHER));
    expect(el.querySelector('p.takeover.banner')?.textContent).toBe(ACCOUNT_CONTROL_BANNER);
  });

  it.each(Object.entries(accountControlOps))('warns on %s', (_, op) => {
    const el = render([changeTrustOp(), op()]);
    expect(el.querySelector('p.takeover.banner')).not.toBeNull();
    expect(takeovers(el).length).toBeGreaterThanOrEqual(2);
  });

  it('gives no account-control warning to other operations, a home-domain setOptions included', () => {
    const el = render([paymentOp(), ...Object.values(plainClassicOps).map((b) => b())]);
    expect(el.querySelector('.takeover')).toBeNull();
    expect(el.querySelector('.takeover-op')).toBeNull();
    expect(el.textContent).not.toContain('does not decode');
  });

  it('accountControlWarnings is empty for operations that change no control', () => {
    const decoded = decodeApprovalRequest({
      kind: 'stellar_tx',
      chain: 'stellar',
      address: USER,
      context: { networkPassphrase: PASSPHRASE },
      bytes: txBytes([paymentOp(), Operation.setOptions({ homeDomain: 'example.com', setFlags: 1 })]),
    });
    if (decoded.kind !== 'stellar_tx') throw new Error('unexpected kind');
    expect(decoded.envelope.tx.operations.map(accountControlWarnings)).toEqual([[], []]);
  });
});

describe('renderApproval: other Stellar classic operations', () => {
  const text = (op: xdr.Operation) => render([op]).textContent ?? '';

  it('shows path payments with both amounts, the destination and the path', () => {
    const r = text(plainClassicOps.pathPaymentStrictReceive?.() as xdr.Operation);
    expect(r).toContain(`To${OTHER}`);
    expect(r).toContain('Pays at most5 XLM (50000000 stroops)');
    expect(r).toContain(`Receives exactly1 ${usdc} (10000000 stroops)`);
    expect(r).toContain(`ThroughEURC:${ISSUER}`);
    const s = text(plainClassicOps.pathPaymentStrictSend?.() as xdr.Operation);
    expect(s).toContain(`Pays exactly2 ${usdc} (20000000 stroops)`);
    expect(s).toContain('Receives at least0.5 XLM (5000000 stroops)');
    expect(s).toContain('Throughdirect');
  });

  it('shows offers, flags, data entries, claimable balances, sponsorship, clawback and pools', () => {
    expect(text(plainClassicOps.manageSellOffer?.() as xdr.Operation)).toContain('Price1/2 per unit sold');
    expect(text(plainClassicOps.manageSellOffer?.() as xdr.Operation)).toContain('Offerchanges offer 7');
    expect(text(plainClassicOps.manageBuyOffer?.() as xdr.Operation)).toContain('Offernew offer');
    expect(text(plainClassicOps.setOptions?.() as xdr.Operation)).toContain('Home domainexample.com');
    expect(text(Operation.setOptions({ setFlags: 9, clearFlags: 2 }))).toContain('Sets flagsauth required, clawback enabled (9)');
    expect(text(plainClassicOps.allowTrust?.() as xdr.Operation)).toContain('Authorizationauthorized (1)');
    expect(text(plainClassicOps.manageData?.() as xdr.Operation)).toContain('Nameconfig');
    expect(text(plainClassicOps.manageData?.() as xdr.Operation)).toContain('Value0102');
    expect(text(Operation.manageData({ name: 'config', value: null }))).toContain('Valuedeletes the entry');
    expect(text(plainClassicOps.bumpSequence?.() as xdr.Operation)).toContain('Bumps the sequence number to1000');
    expect(text(plainClassicOps.createClaimableBalance?.() as xdr.Operation)).toContain(`${OTHER} (at any time)`);
    expect(text(plainClassicOps.claimClaimableBalance?.() as xdr.Operation)).toContain(`Balance${BALANCE_ID}`);
    expect(text(plainClassicOps.beginSponsoringFutureReserves?.() as xdr.Operation)).toContain(`Pays the reserves of${OTHER}`);
    expect(text(plainClassicOps.revokeSponsorship?.() as xdr.Operation)).toContain(`account ${OTHER}`);
    expect(text(plainClassicOps.clawback?.() as xdr.Operation)).toContain(`Takes back from${OTHER}`);
    expect(text(plainClassicOps.setTrustLineFlags?.() as xdr.Operation)).toContain('Clears flagsclawback enabled (4)');
    expect(text(plainClassicOps.liquidityPoolDeposit?.() as xdr.Operation)).toContain(`Pool${POOL_ID}`);
    expect(text(plainClassicOps.liquidityPoolWithdraw?.() as xdr.Operation)).toContain('At least0.1 of asset A and 0.2 of asset B');
  });

  it('renders partner-chosen strings as text, never markup, and invisible characters as hex', () => {
    const el = render([Operation.manageData({ name: '<img src=x onerror=alert(1)>', value: null }), Operation.setOptions({ homeDomain: `a${String.fromCodePoint(0x202e)}b` })]);
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(el.textContent).toContain(`(shown as hex) ${Buffer.from(`a${String.fromCodePoint(0x202e)}b`).toString('hex')}`);
    expect(el.textContent).not.toContain(String.fromCodePoint(0x202e));
  });
});
