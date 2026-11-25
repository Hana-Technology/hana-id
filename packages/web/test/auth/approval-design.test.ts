// @vitest-environment happy-dom
// The approval popup on the Journear Passport design system (D765, the confirm and sign pattern): the amount first,
// only where one number says what a plain transfer sends (never for a contract call or a message); the facts in the
// system's key/value rows; notices as the system's alerts with the page's own classes kept; one primary button.
import { encodeNearTransaction, evmTxSigningPayload, nearImplicitAccountId, parseEvmTxRequest, sha256, utf8, type NearAction } from '@hana-id/core';
import { decodeApprovalRequest } from '@hana-id/core/decode';
import { Asset, Operation, type xdr } from '@stellar/stellar-base';
import { beforeEach, describe, expect, it } from 'vitest';
import { dom } from '../../src/auth/dom.ts';
import { amountHeadline, renderApproval } from '../../src/auth/render-approval.ts';
import { evmChainHeading, nativeAmount } from '../../src/auth/render-consent.ts';
import { ISSUER, OTHER, PASSPHRASE, USER, addSignerOp, changeTrustOp, paymentOp, txBytes } from '../../../core/test/stellar-fixtures.ts';

const EVM = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const TX = { chainId: '0xaa36a7', nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', to: EVM, value: '0xde0b6b3a7640000', data: '0x' };

const evm = (over: Record<string, string> = {}, chainId = 11155111) =>
  decodeApprovalRequest({ kind: 'evm_tx', chain: 'evm', address: EVM, context: { chainId }, bytes: evmTxSigningPayload(parseEvmTxRequest({ ...TX, chainId: `0x${chainId.toString(16)}`, ...over })) });
const stellar = (ops: xdr.Operation[]) => decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: txBytes(ops) });
const PUB = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ME = nearImplicitAccountId(PUB);
const near = (actions: NearAction[]) =>
  decodeApprovalRequest({
    kind: 'near_tx',
    chain: 'near',
    address: ME,
    context: { nearNetwork: 'testnet' },
    bytes: encodeNearTransaction({ signerId: ME, publicKey: { type: 'ed25519', bytes: PUB }, nonce: 3n, receiverId: 'bob.testnet', blockHash: sha256(utf8('block')), actions }),
  });

beforeEach(() => document.body.replaceChildren());

describe('the amount first (amountHeadline)', () => {
  it('an EVM transfer with no call data, on a chain Journear names: its value and the chain’s coin', () => {
    expect(amountHeadline(evm())).toEqual({ value: '1', unit: 'ETH' });
  });

  it('never for an EVM contract call (its value says nothing of the tokens it moves), nor on a chain Journear can’t name', () => {
    expect(amountHeadline(evm({ data: '0xa9059cbb' + '00'.repeat(64) }))).toBeNull();
    expect(amountHeadline(evm({}, 987654321))).toBeNull();
  });

  it('the six other EVM chains Sodax lists: their own coin on a plain transfer, still nothing for a contract call', () => {
    for (const [id, unit] of [[999, 'HYPE'], [1890, 'ETH'], [151, 'RBNT'], [8217, 'KAIA'], [295, 'HBAR'], [4663, 'ETH']] as const) {
      expect(amountHeadline(evm({}, id)), String(id)).toEqual({ value: '1', unit });
      expect(amountHeadline(evm({ data: '0xa9059cbb' + '00'.repeat(64) }, id))).toBeNull();
    }
    // The auto-approve consent screen names them the same way: the heading, and limits in the chain's coin.
    // Hedera's raw number is in weibars (18 decimals, as its relay counts HBAR), the HBAR figure the same.
    expect(nativeAmount(295, '1500000000000000000')).toBe('1.5 HBAR (1500000000000000000 weibars)');
    expect(nativeAmount(8217, '1000000000000000000')).toBe('1 KAIA (1000000000000000000 wei)');
    expect(nativeAmount(8453, '100000')).toBe('0.0000000000001 ETH (100000 wei)');
    const h2 = evmChainHeading(dom(document), 999);
    expect(h2.firstChild?.textContent).toBe('HyperEVM (real money)');
    expect(h2.querySelector('span.chain-id')?.textContent).toBe('network no. 999');
    expect(evmChainHeading(dom(document), 998).textContent).toBe('Ethereum-style network no. 998');
  });

  it('a Stellar transaction of one payment or one account creation; nothing for several operations, account control or another source', () => {
    expect(amountHeadline(stellar([paymentOp()]))).toEqual({ value: '1', unit: 'XLM' });
    // A credit asset's code is its issuer's choice (anyone can issue "USDC", or "XLM"): no headline, the rows show code and issuer.
    expect(amountHeadline(stellar([Operation.payment({ destination: OTHER, asset: new Asset('USDC', ISSUER), amount: '2.5' })]))).toBeNull();
    expect(amountHeadline(stellar([Operation.payment({ destination: OTHER, asset: new Asset('XLM', ISSUER), amount: '2.5' })]))).toBeNull();
    expect(amountHeadline(stellar([Operation.createAccount({ destination: OTHER, startingBalance: '3' })]))).toEqual({ value: '3', unit: 'XLM' });
    expect(amountHeadline(stellar([paymentOp(), paymentOp()]))).toBeNull();
    expect(amountHeadline(stellar([addSignerOp()]))).toBeNull();
    expect(amountHeadline(stellar([changeTrustOp()]))).toBeNull();
    expect(amountHeadline(stellar([Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '1', source: OTHER })]))).toBeNull();
  });

  it('a NEAR transaction of transfers only: their total; never with a contract call', () => {
    expect(amountHeadline(near([{ type: 'transfer', deposit: 10n ** 24n }, { type: 'transfer', deposit: 5n * 10n ** 23n }]))).toEqual({ value: '1.5', unit: 'NEAR' });
    expect(amountHeadline(near([{ type: 'transfer', deposit: 1n }, { type: 'functionCall', methodName: 'm', args: utf8('{}'), gas: 1n, deposit: 0n }]))).toBeNull();
  });

  it('never for a message', () => {
    expect(amountHeadline(decodeApprovalRequest({ kind: 'personal_sign', chain: 'evm', address: EVM, context: {}, bytes: utf8('Sign in') }))).toBeNull();
  });

  it('is shown right under the summary’s headline (D808), and the rows still show the same value', () => {
    const el = renderApproval(dom(document), evm(), 'Partner App');
    expect(el.classList.contains('jp-confirm')).toBe(true);
    expect(el.children[0]?.tagName).toBe('H2');
    expect(el.children[0]?.className).toBe('summary-headline');
    // D859: the headline's long values have their rows right under it (here the recipient), then the amount.
    expect(el.children[1]?.className).toBe('jp-kv id-rows');
    expect(el.children[2]?.className).toBe('headline');
    expect(el.querySelector('.amt')?.textContent).toBe('1ETH');
    expect(el.querySelector('dl.jp-kv.summary-facts')?.textContent).toBe('NetworkSepolia (test network)Network feeLess than 0.000001 ETH');
    expect(el.querySelector('details.request-details dl.jp-kv')?.textContent).toContain('1 (1000000000000000000 wei)');
    expect(renderApproval(dom(document), evm({ data: '0xa9059cbb' + '00'.repeat(64) }), 'Partner App').querySelector('.headline')).toBeNull();
  });
});

describe('the folded details count a raw native amount in the chain’s own unit (D922)', () => {
  /** The details' rows of the transaction, as "name: value". */
  const detailRows = (el: HTMLElement): Record<string, string> =>
    Object.fromEntries([...el.querySelectorAll('details.request-details dl.jp-kv dt')].map((dt) => [dt.textContent ?? '', dt.nextElementSibling?.textContent ?? '']));
  // maxFeePerGas 710000000000 (Hedera's usual gas price, in weibars), gas 21000: the most the fee can be is 0.01491 HBAR.
  const fees = { maxFeePerGas: '0xa54f4c3c00', maxPriorityFeePerGas: '0x0' };

  it('Hedera: the value, the fee and the gas prices in weibars, at 18 decimals, the same figure as the headline’s HBAR', () => {
    const el = renderApproval(dom(document), evm(fees, 295), 'Partner App');
    expect(el.querySelector('.amt')?.textContent).toBe('1HBAR');
    const r = detailRows(el);
    expect(r['Value']).toBe('1 (1000000000000000000 weibars)');
    expect(r['Maximum network fee']).toBe('0.01491 (14910000000000000 weibars)');
    expect(r['Max fee per gas']).toBe('0.00000071 HBAR (710000000000 weibars)');
    expect(r['Priority fee per gas']).toBe('0 HBAR (0 weibars)');
    expect(el.querySelector('details.request-details')?.textContent).not.toMatch(/\bg?wei\b/u);
    // The main view's fee is the same amount in HBAR.
    expect(el.querySelector('dl.summary-facts')?.textContent).toContain('Up to 0.01491 HBAR');
    // A legacy transaction's gas price too.
    const legacy = evm({ type: '0x0', gasPrice: '0xa54f4c3c00', maxFeePerGas: undefined as never, maxPriorityFeePerGas: undefined as never }, 295);
    expect(detailRows(renderApproval(dom(document), legacy, 'Partner App'))['Gas price']).toBe('0.00000071 HBAR (710000000000 weibars)');
  });

  it('every other chain, named or not: wei and gwei, as before', () => {
    for (const id of [8453, 8217, 999, 987654321]) {
      const r = detailRows(renderApproval(dom(document), evm(fees, id), 'Partner App'));
      expect(r['Value'], String(id)).toBe('1 (1000000000000000000 wei)');
      expect(r['Maximum network fee']).toBe('0.01491 (14910000000000000 wei)');
      expect(r['Max fee per gas']).toBe('710 gwei');
      expect(r['Priority fee per gas']).toBe('0 gwei');
    }
    // Hedera's test network has no name, but its relay counts in weibars too.
    expect(detailRows(renderApproval(dom(document), evm(fees, 296), 'Partner App'))['Value']).toBe('1 (1000000000000000000 weibars)');
    expect(detailRows(renderApproval(dom(document), evm(fees, 296), 'Partner App'))['Max fee per gas']).toBe('0.00000071 (710000000000 weibars)');
    expect(nativeAmount(296, '1500000000000000000')).toBe('1.5 of this network’s own coin (1500000000000000000 weibars)');
  });
});

describe('the system’s parts, with the page’s own classes kept', () => {
  it('facts are jp-kv rows; the red items are one alert box (D814) that keeps their classes', () => {
    const el = renderApproval(dom(document), stellar([addSignerOp()]), 'Partner App');
    expect(el.querySelectorAll('dl:not(.jp-kv)')).toHaveLength(0);
    const box = el.querySelector('div.danger-box');
    expect(box?.classList.contains('jp-alert-danger')).toBe(true);
    expect(box?.getAttribute('role')).toBe('alert');
    expect(el.querySelectorAll('.jp-alert-danger')).toHaveLength(1);
    // The icon is decorative and adds no text: the box's text is its lead and its bullets exactly.
    expect(box?.querySelector('svg.ic')?.getAttribute('aria-hidden')).toBe('true');
    expect(box?.querySelector(':scope > .body')?.textContent).toBe(box?.textContent);
    expect(box?.querySelector('p.risk-lead.takeover.banner')).not.toBeNull();
    // The headline names the signer whole, so no bullet repeats it.
    expect(box?.querySelectorAll('ul.risk-more > li')).toHaveLength(0);
  });
});
