// D894: the preview (`previewLabelDocument`): every format of a document with example values, built by the matcher's
// own field renderer and plain form, so the console's and the staff feed's preview is what a real match shows.
import { describe, expect, it } from 'vitest';
import { labelLinePlainText, labelRequestOf, matchLabel, previewLabelDocument } from '../src/partner-labels/match.ts';
import { ME, PAYMENT_DOC_JSON, SOROBAN_DOC_JSON, STAMPS_DOC_JSON, STAMPS_HASH, fn, nearDecoded, parsed } from './partner-labels-fixtures.ts';

describe('previewLabelDocument', () => {
  it('a NEAR format reads exactly as a real match of the same values does', () => {
    const doc = parsed(STAMPS_DOC_JSON);
    const [p] = previewLabelDocument(doc, 'Stamp Trail');
    const req = labelRequestOf(nearDecoded([fn('collect', '{"stamp":"arrival"}')]), ME)!;
    const m = matchLabel(doc, req, { codeHash: STAMPS_HASH, networkChecked: true });
    if (!m.ok) throw new Error(m.reason);
    expect(p!.line).toBe(labelLinePlainText('Stamp Trail', m));
    expect(p).toEqual({ key: 'collect', line: 'Stamp Trail says: collect the stamp “Arrival”', sentence: 'collect the stamp “Arrival”', parts: [{ kind: 'verb', text: 'collect' }, { kind: 'object', text: 'the stamp' }, { kind: 'value', text: '“Arrival”' }], fields: [{ label: 'Stamp', value: '“Arrival”' }] });
  });

  it('a Soroban format: "your account" for an isSelf argument, an amount within its bounds; a payment: the order as code', () => {
    expect(previewLabelDocument(parsed(SOROBAN_DOC_JSON), 'Pool').map((f) => [f.key, f.line, f.fields])).toMatchSnapshot();
    expect(previewLabelDocument(parsed(PAYMENT_DOC_JSON), 'Coffee Club').map((f) => [f.key, f.line, f.fields])).toEqual([['payment', 'Coffee Club says: pay for order “1042”', [{ label: 'Order', value: '“1042”' }]]]);
  });

  it('is deterministic and pure (the same document gives the same preview)', () => {
    const doc = parsed(SOROBAN_DOC_JSON);
    expect(previewLabelDocument(doc, 'Pool')).toEqual(previewLabelDocument(doc, 'Pool'));
  });
});
