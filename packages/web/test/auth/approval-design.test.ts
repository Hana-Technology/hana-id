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

  it('is shown right under the request’s kind, and the rows still show the same value', () => {
    const el = renderApproval(dom(document), evm(), 'Partner App');
    expect(el.classList.contains('jp-confirm')).toBe(true);
    expect(el.children[0]?.tagName).toBe('H2');
    expect(el.children[1]?.className).toBe('headline');
    expect(el.querySelector('.amt')?.textContent).toBe('1ETH');
    expect(el.querySelector('dl.jp-kv')?.textContent).toContain('1 (1000000000000000000 wei)');
    expect(renderApproval(dom(document), evm({ data: '0xa9059cbb' + '00'.repeat(64) }), 'Partner App').querySelector('.headline')).toBeNull();
  });
});

describe('the system’s parts, with the page’s own classes kept', () => {
  it('facts are jp-kv rows; warnings and danger lines are alerts that keep their paragraph and classes', () => {
    const el = renderApproval(dom(document), stellar([addSignerOp()]), 'Partner App');
    expect(el.querySelectorAll('dl:not(.jp-kv)')).toHaveLength(0);
    const banner = el.querySelector('p.takeover.banner');
    expect(banner?.classList.contains('jp-alert-danger')).toBe(true);
    expect(banner?.getAttribute('role')).toBe('alert');
    // The icon is decorative and adds no text: the alert's text is the warning exactly.
    expect(banner?.querySelector('svg.ic')?.getAttribute('aria-hidden')).toBe('true');
    expect(banner?.querySelector(':scope > .body')?.textContent).toBe(banner?.textContent);
    for (const p of el.querySelectorAll('p.danger.takeover')) expect(p.classList.contains('jp-alert')).toBe(true);
  });
});
