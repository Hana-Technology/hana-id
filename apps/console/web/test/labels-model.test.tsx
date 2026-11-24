// D899: the request labels editor's pure parts. The form's draft and the document's text round-trip (the form's own text
// reads back to the same draft; every document core's tests describe reads into the form and back to the same parsed
// document); a text the form can't show is said, never silently changed; the units are exact; each parser problem is
// placed beside the control that writes its path; the preview's example payments are what the approval window reads
// as a match, a mismatch (amber) and a payment to an unlisted account (red).
import { decodeApprovalRequest } from '@hana-id/core/decode';
import { LABEL_STELLAR_NETWORKS, type LabelDocument, parseLabelDocument } from '@hana-id/core/partner-labels';
import { describe, expect, it } from 'vitest';
import { GUESTBOOK_DOC_JSON, PAYMENT_DOC_JSON, SOROBAN_DOC_JSON, STAMPS_DOC_JSON } from '../../../../packages/core/test/partner-labels-fixtures.ts';
import { labelOutcome } from '../../../../packages/web/src/auth/render-labels.ts';
import { EXAMPLE_STRANGER, EXAMPLE_USER, paymentExample } from '../src/labels/examples.ts';
import { ARG_TYPES, type Draft, EXAMPLE_ACCOUNT, emptyArg, emptyDraft, emptyField, emptyFormat, exampleDraft, fromDocumentText, isEmptyDraft, toDocumentText } from '../src/labels/model.ts';
import { draftProblems, keyOfPath, problemsOf, problemsOfApi } from '../src/labels/problems.ts';
import { toDisplay, toRaw } from '../src/labels/units.ts';

const parsed = (text: string): LabelDocument => {
  const r = parseLabelDocument(text);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.document;
};

/** A complete payment draft the parser accepts. */
function paymentDraft(): Draft {
  const d = emptyDraft('stellar');
  d.addressBook = [{ account: 'GBBQI276ICJLH2KJSTVNUFO4YIGYVKQHWZMP2OKU5OHA564L3SS55TZP', name: 'Coffee Club till' }];
  const f = d.formats[0]!;
  f.object = 'order';
  f.memo = 'text';
  f.feeAtMost = '100000';
  f.fields = [{ ...emptyField('memo', 'orderNumber'), label: 'Order' }];
  f.sentence = [{ kind: 'verb' }, { kind: 'word', word: 'for' }, { kind: 'object' }, { kind: 'field', path: 'memo' }];
  return d;
}

describe('the draft and the text', () => {
  it('a payment draft writes a document core accepts, on the scope’s network, and reads back to the same draft', () => {
    for (const env of ['test', 'live'] as const) {
      const d = paymentDraft();
      const text = toDocumentText(d, env);
      const doc = parsed(text);
      expect(doc.context).toEqual({ chain: 'stellar', networkPassphrase: env === 'test' ? LABEL_STELLAR_NETWORKS.test : LABEL_STELLAR_NETWORKS.public });
      const back = fromDocumentText(text, env);
      expect(back).toEqual({ ok: true, draft: d, networkChanged: false });
    }
  });

  it('every document of core’s tests reads into the form and back to the same parsed document', () => {
    for (const json of [PAYMENT_DOC_JSON, STAMPS_DOC_JSON, GUESTBOOK_DOC_JSON, SOROBAN_DOC_JSON]) {
      const text = JSON.stringify(json);
      const r = fromDocumentText(text, 'test');
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) continue;
      const again = toDocumentText(r.draft, 'test');
      expect(parsed(again)).toEqual(parsed(text));
      // And the form's text is stable: written again from its own draft, it is the same text.
      const r2 = fromDocumentText(again, 'test');
      expect(r2.ok && toDocumentText(r2.draft, 'test')).toBe(again);
    }
  });

  it('a draft with every kind of argument and shown value round-trips (NEAR and Soroban)', () => {
    for (const kind of ['near', 'soroban'] as const) {
      const d = emptyDraft(kind);
      if (kind === 'near') {
        d.nearAccount = 'club.testnet';
        d.codeHash = 'GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn';
      } else {
        d.contract = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
        d.wasmHash = 'ab'.repeat(32);
      }
      d.enums = [{ name: 'tier', values: [{ raw: 'gold', label: 'Gold' }] }];
      const f = emptyFormat(kind, 'join');
      f.verb = 'join';
      f.object = 'the club';
      f.relayed = 'relayed';
      f.feeAtMost = kind === 'soroban' ? '5000' : '';
      f.gasAtMost = kind === 'near' ? '30000000000000' : '';
      f.args = ARG_TYPES[kind].map((t, i) => ({ ...emptyArg(`a${i}`, t), ...(t === 'string' ? { maxLength: '12', oneOf: ['gold'] } : {}), ...(t === 'u64' ? { atLeast: '1', atMost: '9' } : {}), ...(t === 'u32' || t === 'integer' ? { min: '1', max: '3' } : {}), ...(t === 'bool' || t === 'boolean' ? { equals: 'true' as const } : {}), ...(t === 'accountId' || t === 'address' ? { isSelf: true } : {}), ...(kind === 'near' && i === 1 ? { optional: true } : {}) }));
      f.fields = [{ ...emptyField('args.a0', 'enum'), label: 'Tier', enumName: 'tier' }];
      f.sentence = [{ kind: 'verb' }, { kind: 'object' }, { kind: 'field', path: 'args.a0' }];
      d.formats = [f];
      const text = toDocumentText(d, 'test');
      expect(fromDocumentText(text, 'test')).toEqual({ ok: true, draft: d, networkChanged: false });
    }
  });

  it('a text the form can’t show is said, with what to fix; a network other than the scope’s is noted', () => {
    expect(fromDocumentText('{', 'test')).toEqual({ ok: false, reason: 'This isn’t valid JSON yet.' });
    const extra = { ...PAYMENT_DOC_JSON, display: { formats: { payment: { ...PAYMENT_DOC_JSON.display.formats.payment, visible: 'never' } } } };
    expect(fromDocumentText(JSON.stringify(extra), 'test')).toEqual({ ok: false, reason: 'The request “payment” has “visible”, which the form doesn’t have.' });
    const two = { ...PAYMENT_DOC_JSON, context: { stellar: PAYMENT_DOC_JSON.context.stellar, near: {} } };
    expect(fromDocumentText(JSON.stringify(two), 'test')).toMatchObject({ ok: false });
    const other = { ...STAMPS_DOC_JSON, display: { formats: { collect: { ...STAMPS_DOC_JSON.display.formats.collect, call: { ...STAMPS_DOC_JSON.display.formats.collect.call, otherArgs: 'allow' } } } } };
    expect(fromDocumentText(JSON.stringify(other), 'test')).toMatchObject({ ok: false, reason: expect.stringContaining('otherArgs') });
    expect(fromDocumentText(JSON.stringify(PAYMENT_DOC_JSON), 'live')).toMatchObject({ ok: true, networkChanged: true });
  });

  it('the argument types the form offers are exactly ones core’s parser takes', () => {
    for (const kind of ['near', 'soroban'] as const) {
      for (const type of ARG_TYPES[kind]) {
        const d = emptyDraft(kind);
        d.nearAccount = 'club.testnet';
        d.codeHash = 'GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn';
        d.contract = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
        d.wasmHash = 'ab'.repeat(32);
        const f = emptyFormat(kind, 'go');
        f.verb = 'join';
        f.args = [emptyArg('x', type)];
        d.formats = [f];
        const r = parseLabelDocument(toDocumentText(d, 'test'));
        const typeErrors = r.ok ? [] : r.errors.filter((e) => e.path.endsWith('.type'));
        expect(typeErrors, `${kind} ${type}`).toEqual([]);
      }
    }
  });
});

describe('units', () => {
  it('XLM, NEAR and TGas to the document’s units and back, exactly', () => {
    expect(toRaw('0.01', 7)).toBe('100000');
    expect(toRaw('25', 7)).toBe('250000000');
    expect(toRaw('0', 7)).toBe('0');
    expect(toRaw('1.00000001', 7)).toBeNull();
    expect(toRaw('-1', 7)).toBeNull();
    expect(toRaw('1e3', 7)).toBeNull();
    expect(toRaw('', 7)).toBe('');
    expect(toRaw('30', 12)).toBe('30000000000000');
    expect(toRaw('0.000000000000000000000001', 24)).toBe('1');
    expect(toDisplay('100000', 7)).toBe('0.01');
    expect(toDisplay('1', 24)).toBe('0.000000000000000000000001');
    expect(toDisplay('', 7)).toBe('');
  });
});

describe('problems beside their fields', () => {
  it('maps each parser path to the control that writes it', () => {
    const d = paymentDraft();
    d.enums = [{ name: 'tier', values: [{ raw: 'a.b', label: 'x' }] }];
    expect(keyOfPath('display.formats.payment.intent.object', d)).toBe('f.0.object');
    expect(keyOfPath('display.formats.payment.intent.verb', d)).toBe('f.0.verb');
    expect(keyOfPath('display.formats.payment.call.feeAtMost', d)).toBe('f.0.fee');
    expect(keyOfPath('display.formats.payment.call.assets[1]', d)).toBe('f.0.assets');
    expect(keyOfPath('display.formats.payment.sentence[2]', d)).toBe('f.0.sentence');
    expect(keyOfPath('display.formats.payment.fields[0].label', d)).toBe('f.0.field.0');
    expect(keyOfPath('metadata.addressBook[0].name', d)).toBe('book.0.name');
    expect(keyOfPath('metadata.addressBook[0].account', d)).toBe('book.0.account');
    expect(keyOfPath('metadata.addressBook', d)).toBe('book');
    expect(keyOfPath('metadata.enums.tier.a.b', d)).toBe('enum.0.v.0');
    expect(keyOfPath('metadata.enums.tier', d)).toBe('enum.0');
    expect(keyOfPath('context.near.codeHash', d)).toBe('context.hash');
    expect(keyOfPath('context.soroban.contract', d)).toBe('context.account');
    expect(keyOfPath('', d)).toBe('general');
    const n = emptyDraft('near');
    n.formats = [{ ...emptyFormat('near', 'collect'), args: [emptyArg('stamp'), emptyArg('to', 'accountId')] }];
    expect(keyOfPath('display.formats.collect.call.args.to.isSelf', n)).toBe('f.0.arg.1');
    expect(keyOfPath('display.formats.collect.call.deposit.atMost', n)).toBe('f.0.deposit');
    expect(keyOfPath('display.formats.collect', n)).toBe('f.0');
    const s = emptyDraft('soroban');
    s.formats = [{ ...emptyFormat('soroban', 'deposit'), args: [emptyArg('who', 'address')] }];
    expect(keyOfPath('display.formats.deposit.call.args[0].name', s)).toBe('f.0.arg.0');
  });

  it('a claim word in the phrase is core’s refusal, beside the phrase, live as typed', () => {
    const d = paymentDraft();
    d.formats[0]!.object = 'free order';
    const ps = problemsOf(toDocumentText(d, 'test'), d);
    expect(ps).toEqual([expect.objectContaining({ key: 'f.0.object', code: 'text_claim' })]);
    d.formats[0]!.object = 'order';
    expect(problemsOf(toDocumentText(d, 'test'), d)).toEqual([]);
  });

  it('a payment without accounts, and the form’s own duplicates (two requests or values of one name)', () => {
    const d = paymentDraft();
    d.addressBook = [];
    expect(problemsOf(toDocumentText(d, 'test'), d).map((p) => p.key)).toContain('book');
    const n = emptyDraft('near');
    n.formats = [emptyFormat('near', 'go'), emptyFormat('near', 'go')];
    n.enums = [{ name: 'x', values: [{ raw: 'a', label: 'A' }, { raw: 'a', label: 'B' }] }];
    expect(draftProblems(n).map((p) => p.key)).toEqual(['f.1', 'enum.0.v.1']);
  });

  it('the API’s label_invalid message as problems, each placed as the parser’s', () => {
    const d = paymentDraft();
    expect(problemsOfApi('wrong_environment at context.stellar.networkPassphrase: These apps are test apps: describe calls on the Stellar test network.; text_claim at display.formats.payment.intent.object: No claims; use plain words.', d)).toEqual([
      { key: 'general', code: 'wrong_environment', message: 'These apps are test apps: describe calls on the Stellar test network.' },
      { key: 'f.0.object', code: 'text_claim', message: 'No claims; use plain words.' },
    ]);
    expect(problemsOfApi('Something else', null)).toEqual([{ key: 'general', code: 'label_invalid', message: 'Something else' }]);
  });
});

describe('the preview’s example payments, as the approval window reads them', () => {
  const doc = parsed(toDocumentText(paymentDraft(), 'test'));
  const outcome = (kind: 'match' | 'mismatch' | 'not_listed') => {
    const ex = paymentExample(doc, kind);
    if (!ex.ok) throw new Error(ex.why);
    return labelOutcome(ex.decoded, [doc], { user: EXAMPLE_USER, networkChecked: false, reviewedNear: [] }).kind;
  };
  it('a match, an amber mismatch and a red payment to an unlisted account', () => {
    expect(outcome('match')).toBe('match');
    expect(outcome('mismatch')).toBe('mismatch');
    expect(outcome('not_listed')).toBe('not_listed');
    const ex = paymentExample(doc, 'not_listed');
    expect(ex.ok && ex.payee).toBe(EXAMPLE_STRANGER);
  });
  it('a memo-less description: the mismatch carries a memo; a highest amount and fee are kept', () => {
    const d = paymentDraft();
    const f = d.formats[0]!;
    f.memo = 'none';
    f.fields = [];
    f.sentence = [{ kind: 'verb' }, { kind: 'object' }];
    f.amountAtMost = '50000000';
    f.feeAtMost = '50';
    const doc2 = parsed(toDocumentText(d, 'test'));
    const m = paymentExample(doc2, 'match');
    expect(m.ok && labelOutcome(m.decoded, [doc2], { user: EXAMPLE_USER, networkChecked: false, reviewedNear: [] }).kind).toBe('match');
    const mm = paymentExample(doc2, 'mismatch');
    expect(mm.ok && labelOutcome(mm.decoded, [doc2], { user: EXAMPLE_USER, networkChecked: false, reviewedNear: [] }).kind).toBe('mismatch');
  });
  it('no Stellar account listed: says what to add', () => {
    const d = paymentDraft();
    d.addressBook = [{ account: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA', name: 'Pool' }];
    expect(paymentExample(parsed(toDocumentText(d, 'test')), 'match')).toEqual({ ok: false, why: 'Add one of your Stellar accounts (G…) to see a matching payment.' });
  });
  it('the example user is a fixed account, decoded as the window decodes', () => {
    expect(EXAMPLE_USER).toMatch(/^G[A-Z2-7]{55}$/u);
    expect(typeof decodeApprovalRequest).toBe('function');
  });
});

describe('D908: the example the form can be filled with', () => {
  it('passes the form’s own checks on a test and a live app, and is exactly the founder’s sample', () => {
    for (const env of ['test', 'live'] as const) {
      const d = exampleDraft('stellar')!;
      const text = toDocumentText(d, env);
      expect(problemsOf(text, d), env).toEqual([]);
      const doc = parsed(text);
      expect(doc.metadata.addressBook).toEqual([{ account: EXAMPLE_ACCOUNT, name: 'Coffee Club till' }]);
      const f = doc.formats.payment!;
      expect(f.intent).toEqual({ verb: 'pay', object: 'the order' });
      expect(f.chain === 'stellar' && f.call).toEqual({ memo: 'id', assets: ['native'], amountAtMost: '500000000', feeAtMost: '100000' });
      expect(f.fields).toEqual([{ path: 'memo', label: 'Order', params: { format: 'orderNumber' } }]);
      // The text reads back to the same draft (the form shows exactly the example).
      const back = fromDocumentText(text, env);
      expect(back.ok && back.draft).toEqual(d);
      // The window's own outcome for the preview's example payment: the partner's box.
      const ex = paymentExample(doc, 'match');
      if (!ex.ok) throw new Error(ex.why);
      expect(labelOutcome(ex.decoded, [doc], { user: EXAMPLE_USER, networkChecked: false, reviewedNear: [] }).kind).toBe('match');
    }
  });
  it('no example for a NEAR program or a Soroban contract (they need the partner’s own account and code)', () => {
    expect(exampleDraft('near')).toBeNull();
    expect(exampleDraft('soroban')).toBeNull();
  });
  it('a new form is empty; anything typed, or the example, is not', () => {
    for (const k of ['stellar', 'near', 'soroban'] as const) expect(isEmptyDraft(emptyDraft(k))).toBe(true);
    const typed = emptyDraft('stellar');
    typed.formats[0]!.object = 'o';
    expect(isEmptyDraft(typed)).toBe(false);
    expect(isEmptyDraft(exampleDraft('stellar')!)).toBe(false);
  });
});
