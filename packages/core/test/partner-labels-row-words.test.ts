// D896 after PR 123's second review: no partner row may be named like one of the approval window's own rows. The list
// of the window's row labels is read from its source (packages/web render-approval.ts `row(d, '…')`), so a row added
// there later fails here until the text rules refuse it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { partnerTextProblem } from '../src/partner-labels/text-rules.ts';

const source = readFileSync(new URL('../../web/src/auth/render-approval.ts', import.meta.url), 'utf8');
const ROW_LABELS = [...new Set([...source.matchAll(/row\(d, '([^']+)'/gu)].map((m) => m[1]!))].sort();

describe('field labels never read as the window’s own rows', () => {
  it('finds the window’s row labels', () => {
    expect(ROW_LABELS.length).toBeGreaterThan(50);
    expect(ROW_LABELS).toContain('Amount');
  });
  it.each(ROW_LABELS)('refuses the window’s row “%s” as a field label', (label) => {
    expect(partnerTextProblem(label, 'fieldLabel')).not.toBeNull();
  });
  it.each(['Asset', 'Source', 'Through', 'Offer', 'Buys', 'Sells', 'For', 'Limit', 'Name', 'Code', 'Calls', 'Sequence', 'Destination', 'Address', 'Beneficiary', 'Spend', 'Currency', 'Worth', 'Due'])(
    'refuses the money or identity word “%s”',
    (label) => expect(partnerTextProblem(label, 'fieldLabel')?.code).toBe('text_row_word'),
  );
  it.each(['Stamp', 'Ticket', 'Seat', 'Club share', 'Member', 'Coin', 'Sale ends', 'Kiosk order reference'])('keeps the honest label “%s”', (label) => {
    expect(partnerTextProblem(label, 'fieldLabel')).toBeNull();
  });
});

import { idValueProblem } from '../src/partner-labels/text-rules.ts';

describe('id values that read as a result, a lure or an amount are not shown (after PR 123’s second review)', () => {
  it.each(['paid', 'PAID', 'paid-in-full', 'Paid_In_Full', 'bonus', 'gift', 'prize', 'reward', 'Rewards', 'cashback', 'airdrop', 'claim', 'done', 'success', 'scam', 'Free', 'Frees', '1M', '1k', '10k', '2.5M', 'SOL-1', '1SOL', 'SOL1', 'XYZ99', '99-XYZ', 'hana', 'hana-7', 'HanaID', 'hanaid42', 'Journear-verified', 'JOURNEAR', '1XLM'])(
    'refuses “%s”',
    (v) => expect(idValueProblem(v)).toBe(true),
  );
  it.each(['1042', 'A1B2C3', 'INV-2026-0042', 'Hanami-12', 'order_77', 'K7', 'T-1000', 'seat-12C', 'abc'])('keeps “%s”', (v) => expect(idValueProblem(v)).toBe(false));
});
