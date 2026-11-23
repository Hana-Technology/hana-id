// @vitest-environment happy-dom
// The approval and consent windows' dividers (D884's note, 2026-11-23). A list's rules are drawn by where it sits, not
// by which rows it has (css/approval.css "the dividers"): one rule where two ruled blocks meet, none against a box or
// a group's edge, the same space on each side, and every operation after the first its own rule. What the browser
// draws is measured in apps/e2e (tests/approval-dividers.spec.ts, tests/divider-checks.ts); here, the structure the
// stylesheet relies on.
import { type NearAction, encodeNearTransaction, evmTxSigningPayload, nearImplicitAccountId, parseEvmTxRequest, sha256, utf8 } from '@hana-id/core';
import { decodeApprovalRequest } from '@hana-id/core/decode';
import { validateAutoApprovePolicy } from '@hana-id/core/policy';
import { beforeEach, describe, expect, it } from 'vitest';
import { dom, row, rows, withoutEmptyLists } from '../../src/auth/dom.ts';
import { renderApproval } from '../../src/auth/render-approval.ts';
import { renderConsent } from '../../src/auth/render-consent.ts';
import { CHECK_IN, CHECK_IN_DATA, SPONSOR_CHAINS, SPONSOR_ME, SPONSOR_NOW_MS, sponsorSubject, sponsoredApproval, sponsoredCall } from '../../../core/test/evm-sponsored-fixture.ts';
import { PASSPHRASE, USER, paymentOp, txBytes } from '../../../core/test/stellar-fixtures.ts';

const EVM = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const OTHER_EVM = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
/** A contract Journear doesn't know. */
const UNKNOWN = '0x4444444444444444444444444444444444444444';
const PUB = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ME = nearImplicitAccountId(PUB);
const TX = { chainId: '0xaa36a7', nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', to: EVM, value: '0xde0b6b3a7640000', data: '0x' };
const evmSend = () => decodeApprovalRequest({ kind: 'evm_tx', chain: 'evm', address: EVM, context: { chainId: 11155111 }, bytes: evmTxSigningPayload(parseEvmTxRequest(TX)) });

beforeEach(() => document.body.replaceChildren());

describe('withoutEmptyLists', () => {
  it('removes every list with no rows, at any depth, and keeps the rest', () => {
    const d = dom(document);
    const full = rows(d, [row(d, 'Network', 'Local test network')], 'jp-kv facts');
    const el = d.h('div', {}, rows(d, [null, false], 'jp-kv facts'), full, d.h('section', {}, d.h('dl', { class: 'jp-kv' })));
    expect(withoutEmptyLists(el)).toBe(el);
    expect([...el.querySelectorAll('dl')]).toEqual([full]);
  });

  it('the approval window: a list whose rows all went elsewhere is not in the page', () => {
    const d = dom(document);
    const el = renderApproval(d, evmSend(), 'Partner App', { envNetwork: 'testnet', testApp: false, notes: [rows(d, [], 'jp-kv facts')], detailsExtra: [rows(d, [], 'jp-kv facts')] });
    expect(el.querySelectorAll('dl.jp-kv').length).toBeGreaterThan(0);
    for (const dl of el.querySelectorAll('dl')) expect(dl.firstElementChild).not.toBeNull();
  });

  it('the consent screen: every list has rows', () => {
    const p = validateAutoApprovePolicy({
      v: 1,
      label: 'Deposits',
      maxConsentMs: 3_600_000,
      limits: { perDayCount: 3 },
      evm: { chains: [{ chainId: 8453, maxValueWei: '1000', maxValueWeiPerDay: '3000', maxFeeWei: '1000', contracts: [{ address: EVM, name: 'Vault', selectors: [{ selector: '0xb6b55f25', signature: 'deposit(uint256)', addressArgs: 'self-or-listed' }] }] }] },
    });
    if (!p.ok) throw new Error('fixture policy is invalid');
    const el = renderConsent(dom(document), { policy: p.policy, appName: 'Partner App', parentOrigin: 'https://partner.example', expiresAtMs: 2e12, nowMs: 2e12 - 3_600_000 });
    expect(el.querySelectorAll('dl.jp-kv').length).toBeGreaterThan(0);
    for (const dl of el.querySelectorAll('dl')) expect(dl.firstElementChild).not.toBeNull();
  });
});

describe('operations: each one after the first has its own rule (the stylesheet draws it on `.ops > li + li`)', () => {
  // The structure that rule relies on: every operation an `li` of its list, one right after the other, whatever the
  // one before ends with. Whether the rule is drawn is measured in apps/e2e (tests/approval-dividers.spec.ts).
  const ops = (el: HTMLElement) => [...el.querySelectorAll('details.request-details ol.ops > li')];

  it('a sponsored batch whose first call Journear can’t read: its raw data ends that operation, the next is its own item', () => {
    const decoded = decodeApprovalRequest(sponsoredApproval(sponsorSubject({ calls: [sponsoredCall(UNKNOWN, '0xdeadbeef'), sponsoredCall(CHECK_IN, CHECK_IN_DATA)] })), { sponsorChains: SPONSOR_CHAINS, nowMs: SPONSOR_NOW_MS });
    const el = renderApproval(dom(document), decoded, 'Partner App', { envNetwork: 'testnet', testApp: false, address: SPONSOR_ME });
    const [first, second] = ops(el);
    expect(ops(el)).toHaveLength(2);
    expect(first?.lastElementChild?.matches('code.mono')).toBe(true);
    expect(first?.nextElementSibling).toBe(second);
    expect(second?.querySelector('h3')?.textContent).toBe('2. Call');
  });

  it('a NEAR call with arguments (JSON, and not JSON) then a transfer: the arguments end the call, the transfer is its own item', () => {
    for (const args of [utf8('{"stamp":"arrival"}'), new Uint8Array([0xff, 0x00, 0x01])]) {
      const actions: NearAction[] = [{ type: 'functionCall', methodName: 'collect', args, gas: 1n, deposit: 0n }, { type: 'transfer', deposit: 1n }];
      const bytes = encodeNearTransaction({ signerId: ME, publicKey: { type: 'ed25519', bytes: PUB }, nonce: 3n, receiverId: 'bob.testnet', blockHash: sha256(utf8('block')), actions });
      const el = renderApproval(dom(document), decodeApprovalRequest({ kind: 'near_tx', chain: 'near', address: ME, context: { nearNetwork: 'testnet' }, bytes }), 'Partner App');
      const [call, transfer] = ops(el);
      expect(ops(el)).toHaveLength(2);
      expect(call?.lastElementChild?.matches('.args')).toBe(true);
      expect(call?.nextElementSibling).toBe(transfer);
      expect(transfer?.querySelector('h3')?.textContent).toBe('2. Send NEAR');
    }
  });

  it('a Stellar transaction of two operations', () => {
    const el = renderApproval(dom(document), decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: txBytes([paymentOp(), paymentOp()]) }), 'Partner App');
    const [one, two] = ops(el);
    expect(ops(el)).toHaveLength(2);
    expect(one?.nextElementSibling).toBe(two);
  });

  it('the consent screen’s contract lines: one item each, one after the other', () => {
    const selectors = [{ selector: '0xb6b55f25', signature: 'deposit(uint256)', addressArgs: 'self-or-listed' }];
    const p = validateAutoApprovePolicy({
      v: 1,
      label: 'Deposits',
      maxConsentMs: 3_600_000,
      limits: { perDayCount: 3 },
      evm: { chains: [{ chainId: 8453, maxValueWei: '1000', maxValueWeiPerDay: '3000', maxFeeWei: '1000', contracts: [{ address: EVM, name: 'Vault', selectors }, { address: OTHER_EVM, name: 'Other vault', selectors }] }] },
    });
    if (!p.ok) throw new Error('fixture policy is invalid');
    const el = renderConsent(dom(document), { policy: p.policy, appName: 'Partner App', parentOrigin: 'https://partner.example', expiresAtMs: 2e12, nowMs: 2e12 - 3_600_000 });
    const lines = [...el.querySelectorAll('ul.contracts > li')];
    expect(lines).toHaveLength(2);
    expect(lines[0]?.nextElementSibling).toBe(lines[1]);
  });
});
