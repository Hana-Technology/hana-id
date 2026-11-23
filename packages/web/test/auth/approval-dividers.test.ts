// @vitest-environment happy-dom
// The approval and consent windows' dividers (D884's note, 2026-11-23). A list's rules are drawn by where it sits, not
// by which rows it has (css/approval.css "the dividers"): one rule where two ruled blocks meet, none against a box or
// a group's edge, the same space on each side. What the browser draws is measured in apps/e2e
// (tests/approval-dividers.spec.ts, tests/divider-checks.ts); here, the structure that rule relies on and the rules.
import { evmTxSigningPayload, parseEvmTxRequest } from '@hana-id/core';
import { decodeApprovalRequest } from '@hana-id/core/decode';
import { validateAutoApprovePolicy } from '@hana-id/core/policy';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { dom, row, rows, withoutEmptyLists } from '../../src/auth/dom.ts';
import { renderApproval } from '../../src/auth/render-approval.ts';
import { renderConsent } from '../../src/auth/render-consent.ts';

const EVM = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
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

describe('where ruled blocks meet', () => {
  it('the stylesheet: one rule where two lists meet, none against a box or a group’s edge, nothing for an empty list, the group’s gap on both sides', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'auth', 'css', 'approval.css'), 'utf8');
    const BOX = String.raw`:is\(\.jp-alert, div\.summary-quote, pre\.message, code\.mono, details\.request-details\)`;
    const S = String.raw`:is\(\.request, div\.consent\)`;
    // The second of two lists, a list after a box, a list first in its group (but the details' first, under "Hide details"): no rule above.
    expect(css).toMatch(new RegExp(String.raw`${S} dl\.jp-kv:not\(:empty\) \+ dl\.jp-kv,\s*${S} ${BOX} \+ dl\.jp-kv,\s*${S} :not\(\.details-body\) > dl\.jp-kv:first-child \{\s*border-top: 0;\s*padding-top: 0;`, 'u'));
    // A list before a box, before a framed operation, or last in its group: no rule below.
    expect(css).toMatch(new RegExp(String.raw`${S} dl\.jp-kv:has\(\+ ${BOX}\),\s*${S} dl\.jp-kv:has\(\+ :is\(\.ops, \.contracts\) > li\.takeover-op:first-child\),\s*${S} dl\.jp-kv:last-child \{\s*border-bottom: 0;\s*padding-bottom: 0;`, 'u'));
    // An operation or contract line right after a list or a box: its own top rule goes.
    expect(css).toMatch(new RegExp(String.raw`\+ :is\(\.ops, \.contracts\) > li:first-child:not\(\.takeover-op\) \{\s*border-top: 0;\s*padding-top: 0;`, 'u'));
    // An operation after a framed one, or after one that ends in a box.
    expect(css).toMatch(/> li:is\(\.takeover-op, :has\(> :is\([^)]*pre\.message[^)]*\):last-child, > \.args:last-child > :is\([^)]*pre\.message[^)]*\):last-child\)\)\s*\+ li:not\(\.takeover-op\) \{\s*border-top: 0;\s*padding-top: 0;/u);
    expect(css).toMatch(new RegExp(String.raw`${S} dl\.jp-kv:empty \{\s*display: none;`, 'u'));
    expect(css).toMatch(new RegExp(String.raw`${S} dl\.jp-kv \{\s*padding-block: var\(--rule-space\);`, 'u'));
    // D884's one-off (the free fee's list with no rule under it) is gone: the general rule covers it, evenly.
    expect(css).not.toMatch(/dl\.fee-facts \{\s*border-bottom: 0;/u);
  });
});
