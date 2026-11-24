// The preview and the diff the API answers for a payment's labels (labels/document.ts), after PR 135's review: the
// line ends with the example account's name, every account of the address book is listed with its name and whole
// address, and a renamed or re-pointed account (any of them, not only the first) is a change, never "same".
import { describe, expect, it } from 'vitest';
import { diffOf, parseDocument, previewOf } from '../src/labels/document.ts';

/** Two tills: random public keys no one has the secret key of. */
const TILL = 'GDGXQACKG7AOXXIO4JFXPVAOUHWB2VBNI62EQ6HHYWWVCRDQX3OEH5GS';
const KIOSK = 'GCVFJJYF75734IR7PQB2IOI3C3RDQ66D6OMVMJG2DRO4VBN66ODCE76B';
const OTHER = 'GDYEVY7RMP63A6SJGK4NLZDNH4XAYEBE36HVP3XKPEDKDDAOSHFXK77G';

const doc = (book: { account: string; name: string }[]) =>
  JSON.stringify({
    schema: 'journear-labels/1',
    context: { stellar: { networkPassphrase: 'Test SDF Network ; September 2015' } },
    metadata: { addressBook: book },
    display: { formats: { payment: { call: { memo: 'text' }, intent: { verb: 'pay', object: 'order' }, sentence: ['verb', { word: 'for' }, 'object', { field: 'memo' }], fields: [{ path: 'memo', label: 'Order', format: 'orderNumber' }] } } },
  });

async function parsed(text: string) {
  const r = await parseDocument(text);
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.doc;
}

describe('a payment’s preview and diff name every account', () => {
  it('the preview: the line with the first account’s name, then every account with its name and whole address', async () => {
    const p = previewOf(await parsed(doc([{ account: TILL, name: 'Harbour till' }, { account: KIOSK, name: 'Harbour kiosk' }])), 'Harbour Pay');
    expect(p.formats.map((f) => f.line)).toEqual([`Harbour Pay says: pay for order “1042” to “Harbour till” (${TILL})`]);
    expect(p.accounts).toEqual([`Account “Harbour till” (${TILL})`, `Account “Harbour kiosk” (${KIOSK})`]);
  });

  it('a rename of the second account is a change; so is re-pointing it, and adding or removing one', async () => {
    const before = await parsed(doc([{ account: TILL, name: 'Harbour till' }, { account: KIOSK, name: 'Harbour kiosk' }]));
    const renamed = diffOf(before, await parsed(doc([{ account: TILL, name: 'Harbour till' }, { account: KIOSK, name: 'Harbour stall' }])), 'Harbour Pay');
    expect(renamed.filter((d) => d.change !== 'same')).toEqual([{ key: `(account) ${KIOSK}`, change: 'changed', before: `Account “Harbour kiosk” (${KIOSK})`, after: `Account “Harbour stall” (${KIOSK})` }]);
    const repointed = diffOf(before, await parsed(doc([{ account: TILL, name: 'Harbour till' }, { account: OTHER, name: 'Harbour kiosk' }])), 'Harbour Pay');
    expect(repointed.filter((d) => d.change !== 'same').map((d) => [d.key, d.change])).toEqual([
      [`(account) ${KIOSK}`, 'removed'],
      [`(account) ${OTHER}`, 'added'],
    ]);
    const same = diffOf(before, before, 'Harbour Pay');
    expect(same.every((d) => d.change === 'same')).toBe(true);
    // A first version: everything added, each account with it.
    expect(diffOf(null, before, 'Harbour Pay').map((d) => [d.key, d.change])).toEqual([
      ['(contract)', 'added'],
      [`(account) ${TILL}`, 'added'],
      [`(account) ${KIOSK}`, 'added'],
      ['payment', 'added'],
    ]);
  });

  it('refuses an account whose secret key is public, and a verb that says the money comes the other way', async () => {
    const pub = await parseDocument(doc([{ account: 'GBBQI276ICJLH2KJSTVNUFO4YIGYVKQHWZMP2OKU5OHA564L3SS55TZP', name: 'Till' }]));
    expect(pub.ok === false && pub.problems.map((p) => p.code)).toContain('public_account');
    const sell = await parseDocument(doc([{ account: TILL, name: 'Till' }]).replace('"verb":"pay"', '"verb":"sell"'));
    expect(sell.ok === false && sell.problems.map((p) => p.code)).toEqual(['bad_verb']);
  });
});
