// The partner label document's strict parser (src/partner-labels/schema.ts, D892): what it accepts, and a table of
// what it refuses, each with its stable code and the path it names: unknown keys, wrong types, oversize documents,
// duplicate keys and anything not in v1.
import { describe, expect, it } from 'vitest';
import { LABEL_LIMITS, LABEL_MAX_ERRORS, type LabelErrorCode, isNearCodeHash, parseLabelDocument } from '../src/partner-labels/schema.ts';
import { GUESTBOOK_DOC_JSON, OTHER, PAYMENT_DOC_JSON, POOL, SOROBAN_DOC_JSON, STAMPS_DOC_JSON, STAMPS_HASH, parsed } from './partner-labels-fixtures.ts';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The stamps document with one change made by `edit`. */
function stampsWith(edit: (d: Json) => void): string {
  const d = clone(STAMPS_DOC_JSON) as Json;
  edit(d);
  return JSON.stringify(d);
}
const collectFormat = (d: Json): Json => d.display.formats.collect;

function refused(text: string): { code: LabelErrorCode; path: string }[] {
  const r = parseLabelDocument(text);
  if (r.ok) throw new Error('accepted');
  return r.errors.map((e) => ({ code: e.code, path: e.path }));
}

describe('accepts', () => {
  it('the stamps, guestbook, Soroban and payment documents, frozen, with null-prototype maps', () => {
    for (const json of [STAMPS_DOC_JSON, GUESTBOOK_DOC_JSON, SOROBAN_DOC_JSON, PAYMENT_DOC_JSON]) {
      const doc = parsed(json);
      expect(Object.isFrozen(doc)).toBe(true);
      expect(Object.isFrozen(doc.formats)).toBe(true);
      expect(Object.getPrototypeOf(doc.formats)).toBeNull();
      expect(Object.getPrototypeOf(doc.metadata.enums)).toBeNull();
    }
    const doc = parsed(STAMPS_DOC_JSON);
    expect(doc.context).toEqual({ chain: 'near', network: 'testnet', account: 'stamps-partner.testnet', codeHash: STAMPS_HASH });
    const f = doc.formats.collect!;
    expect(f.chain).toBe('near');
    expect(f.call).toEqual({ deposit: { exactly: '0' }, gasAtMost: '30000000000000', relayed: 'either', args: [{ type: 'string', name: 'stamp' }, { type: 'string', maxLength: 140, optional: true, name: 'note' }] });
    expect(f.sentence).toEqual([{ kind: 'verb' }, { kind: 'object' }, { kind: 'field', path: 'args.stamp' }]);
  });

  it('a method named "__proto__" is just a key', () => {
    const r = parseLabelDocument(JSON.stringify(STAMPS_DOC_JSON).replace('"collect":', '"__proto__":'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.document.formats)).toEqual(['__proto__']);
  });

  it('the proposal’s sketch, once it uses v1’s shape (its "unknownValue" is refused: an unlisted value always means no match)', () => {
    const sketch = {
      schema: 'journear-labels/1',
      context: { near: { network: 'testnet', account: 'stamps.example.testnet', codeHash: STAMPS_HASH } },
      metadata: { enums: { stamp: { fare_paid: 'Fare paid', gate_open: 'Gate open' } }, addressBook: [] },
      display: {
        formats: {
          collect: {
            call: { deposit: { exactly: '0' }, gasAtMost: '30000000000000', args: { stamp_id: { type: 'string' } }, otherArgs: 'refuse' },
            intent: { verb: 'collect', object: 'the stamp' },
            sentence: ['verb', 'object', { field: 'args.stamp_id' }],
            fields: [{ path: 'args.stamp_id', label: 'Stamp', format: 'enum', enum: 'stamp', unknownValue: 'no_match' }],
          },
        },
      },
    };
    expect(refused(JSON.stringify(sketch))).toEqual([
      { code: 'unknown_key', path: 'display.formats.collect.fields[0].enum' },
      { code: 'not_in_v1', path: 'display.formats.collect.fields[0].unknownValue' },
      { code: 'missing_key', path: 'display.formats.collect.fields[0].params' },
    ]);
    const v1 = clone(sketch) as Json;
    v1.display.formats.collect.fields = [{ path: 'args.stamp_id', label: 'Stamp', format: 'enum', params: { enum: 'stamp' } }];
    expect(parseLabelDocument(JSON.stringify(v1)).ok).toBe(true);
  });
});

describe('refuses, with a stable code and the path', () => {
  const big = (n: number, f: (i: number) => unknown) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, f(i)]));
  const table: [string, string, LabelErrorCode, string][] = [
    // the text itself
    ['not JSON', '{', 'not_json', ''],
    ['empty', '', 'not_json', ''],
    ['a BOM', `﻿${JSON.stringify(STAMPS_DOC_JSON)}`, 'not_json', ''],
    ['trailing text', `${JSON.stringify(STAMPS_DOC_JSON)} x`, 'not_json', ''],
    ['a duplicate key at the top', JSON.stringify(STAMPS_DOC_JSON).replace('{"schema":"journear-labels/1"', '{"schema":"journear-labels/1","schema":"journear-labels/1"'), 'duplicate_key', ''],
    ['a duplicate enum value', JSON.stringify(STAMPS_DOC_JSON).replace('"arrival":"Arrival"', '"arrival":"Arrival","arrival":"Gate"'), 'duplicate_key', ''],
    ['a lone surrogate', JSON.stringify(STAMPS_DOC_JSON).replace('"Arrival"', '"\\ud800"'), 'not_json', ''],
    ['over the size limit', stampsWith((d) => (d.metadata.enums.stamp.arrival = 'a'.repeat(LABEL_LIMITS.documentBytes))), 'too_large', ''],
    ['nested too deep', JSON.stringify({ schema: 'journear-labels/1', context: { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } } }), 'too_deep', ''],
    ['a list at the top', '[]', 'wrong_type', ''],
    ['an unknown key at the top', stampsWith((d) => (d.extra = 1)), 'unknown_key', 'extra'],
    ['a missing schema', stampsWith((d) => delete d.schema), 'missing_key', 'schema'],
    ['another schema', stampsWith((d) => (d.schema = 'journear-labels/2')), 'bad_schema', 'schema'],
    ['an ERC-7730 owner', stampsWith((d) => (d.metadata.owner = 'Acme')), 'not_in_v1', 'metadata.owner'],
    ['an ERC-7730 token', stampsWith((d) => (d.metadata.token = { ticker: 'USDC', decimals: 6 })), 'not_in_v1', 'metadata.token'],
    // context
    ['two contexts', stampsWith((d) => (d.context.stellar = { networkPassphrase: 'x' })), 'bad_context', 'context'],
    ['an EVM context', stampsWith((d) => (d.context = { evm: { chainId: 1 } })), 'not_in_v1', 'context'],
    ['an ERC-7730 contract context', stampsWith((d) => (d.context = { contract: { deployments: [] } })), 'not_in_v1', 'context'],
    ['another NEAR network', stampsWith((d) => (d.context.near.network = 'betanet')), 'bad_network', 'context.near.network'],
    ['an account in capitals', stampsWith((d) => (d.context.near.account = 'Stamps.testnet')), 'bad_account', 'context.near.account'],
    ['no code hash', stampsWith((d) => delete d.context.near.codeHash), 'missing_key', 'context.near.codeHash'],
    ['a code hash that isn’t base58', stampsWith((d) => (d.context.near.codeHash = '0OIl')), 'bad_code_hash', 'context.near.codeHash'],
    ['a code hash of 31 bytes', stampsWith((d) => (d.context.near.codeHash = '1'.repeat(31))), 'bad_code_hash', 'context.near.codeHash'],
    ['a key the NEAR context doesn’t have', stampsWith((d) => (d.context.near.factory = 'x')), 'not_in_v1', 'context.near.factory'],
    ['a Soroban context on another network', JSON.stringify({ ...SOROBAN_DOC_JSON, context: { soroban: { ...SOROBAN_DOC_JSON.context.soroban, networkPassphrase: 'Test SDF Future Network ; October 2022' } } }), 'bad_network', 'context.soroban.networkPassphrase'],
    ['a Soroban contract that is an account', JSON.stringify({ ...SOROBAN_DOC_JSON, context: { soroban: { ...SOROBAN_DOC_JSON.context.soroban, contract: OTHER } } }), 'bad_account', 'context.soroban.contract'],
    ['a Wasm hash in capitals', JSON.stringify({ ...SOROBAN_DOC_JSON, context: { soroban: { ...SOROBAN_DOC_JSON.context.soroban, wasmHash: 'AB'.repeat(32) } } }), 'bad_code_hash', 'context.soroban.wasmHash'],
    // metadata
    ['too many enumerations', stampsWith((d) => (d.metadata.enums = big(LABEL_LIMITS.enums + 1, () => ({ a: 'Gate' })))), 'too_many', 'metadata.enums'],
    ['too many enumeration values', stampsWith((d) => (d.metadata.enums.stamp = big(LABEL_LIMITS.enumValues + 1, (i) => `Gate ${i}`))), 'too_many', 'metadata.enums.stamp'],
    ['an empty enumeration', stampsWith((d) => (d.metadata.enums.stamp = {})), 'too_many', 'metadata.enums.stamp'],
    ['an enumeration value with a space', stampsWith((d) => (d.metadata.enums.stamp['fare paid'] = 'Fare')), 'bad_params', 'metadata.enums.stamp.fare paid'],
    ['an enumeration label that claims', stampsWith((d) => (d.metadata.enums.stamp.arrival = 'Verified arrival')), 'text_claim', 'metadata.enums.stamp.arrival'],
    ['an enumeration label in Cyrillic', stampsWith((d) => (d.metadata.enums.stamp.arrival = 'Аrrival')), 'text_character', 'metadata.enums.stamp.arrival'],
    ['two values with one label', stampsWith((d) => (d.metadata.enums.stamp.layover = 'arrival')), 'duplicate', 'metadata.enums.stamp.layover'],
    ['an enumeration label that isn’t text', stampsWith((d) => (d.metadata.enums.stamp.arrival = 1)), 'text_not_string', 'metadata.enums.stamp.arrival'],
    ['too many address book entries', stampsWith((d) => (d.metadata.addressBook = Array.from({ length: LABEL_LIMITS.addressBook + 1 }, (_, i) => ({ account: `a${i}.testnet`, name: `Till ${i}` })))), 'too_many', 'metadata.addressBook'],
    ['an address book account of another chain', stampsWith((d) => (d.metadata.addressBook = [{ account: OTHER, name: 'Till' }])), 'bad_account', 'metadata.addressBook[0].account'],
    ['an address book name that names a token', stampsWith((d) => (d.metadata.addressBook = [{ account: 'a.testnet', name: 'USDC desk' }])), 'text_reviewed_name', 'metadata.addressBook[0].name'],
    ['an address book account twice', stampsWith((d) => (d.metadata.addressBook = [{ account: 'a.testnet', name: 'Till' }, { account: 'a.testnet', name: 'Desk' }])), 'duplicate', 'metadata.addressBook[1].account'],
    ['an address book name twice', stampsWith((d) => (d.metadata.addressBook = [{ account: 'a.testnet', name: 'Till' }, { account: 'b.testnet', name: 'till' }])), 'duplicate', 'metadata.addressBook[1].name'],
    // formats
    ['no formats', stampsWith((d) => (d.display.formats = {})), 'missing_key', 'display.formats'],
    ['too many formats', stampsWith((d) => (d.display.formats = big(LABEL_LIMITS.formats + 1, () => collectFormat(d)))), 'too_many', 'display.formats'],
    ['a method name with a space', stampsWith((d) => (d.display.formats['col lect'] = collectFormat(d))), 'bad_method', 'display.formats.col lect'],
    ['a method name over 64', stampsWith((d) => (d.display.formats[`a${'b'.repeat(64)}`] = collectFormat(d))), 'bad_method', `display.formats.a${'b'.repeat(64)}`],
    ['a classic operation other than payment', JSON.stringify({ ...PAYMENT_DOC_JSON, display: { formats: { changeTrust: PAYMENT_DOC_JSON.display.formats.payment } } }), 'not_in_v1', 'display.formats.changeTrust'],
    ['a payment with no address book', JSON.stringify({ ...PAYMENT_DOC_JSON, metadata: {} }), 'missing_key', 'metadata.addressBook'],
    ['a payment field other than the memo', JSON.stringify({ ...PAYMENT_DOC_JSON, display: { formats: { payment: { ...PAYMENT_DOC_JSON.display.formats.payment, fields: [{ path: 'amount', label: 'Order', format: 'orderNumber' }], sentence: ['verb', { word: 'for' }, 'object'] } } } }), 'bad_field', 'display.formats.payment.fields[0].path'],
    ['a payment asset that isn’t one', JSON.stringify({ ...PAYMENT_DOC_JSON, display: { formats: { payment: { ...PAYMENT_DOC_JSON.display.formats.payment, call: { memo: 'text', assets: ['USDC'] } } } } }), 'bad_params', 'display.formats.payment.call.assets[0]'],
    // the call
    ['other arguments allowed', stampsWith((d) => (collectFormat(d).call.otherArgs = 'allow')), 'not_in_v1', 'display.formats.collect.call.otherArgs'],
    ['a deposit with both bounds', stampsWith((d) => (collectFormat(d).call.deposit = { exactly: '0', atMost: '1' })), 'bad_params', 'display.formats.collect.call.deposit'],
    ['a negative deposit', stampsWith((d) => (collectFormat(d).call.deposit = { atMost: '-1' })), 'bad_number', 'display.formats.collect.call.deposit.atMost'],
    ['a deposit as a JSON number', stampsWith((d) => (collectFormat(d).call.deposit = { atMost: 1 })), 'bad_number', 'display.formats.collect.call.deposit.atMost'],
    ['gas in exponent form', stampsWith((d) => (collectFormat(d).call.gasAtMost = '3e13')), 'bad_number', 'display.formats.collect.call.gasAtMost'],
    ['a relay rule that isn’t one', stampsWith((d) => (collectFormat(d).call.relayed = 'maybe')), 'wrong_type', 'display.formats.collect.call.relayed'],
    ['too many arguments', stampsWith((d) => (collectFormat(d).call.args = big(LABEL_LIMITS.args + 1, () => ({ type: 'string' })))), 'too_many', 'display.formats.collect.call.args'],
    ['a nested object argument', stampsWith((d) => (collectFormat(d).call.args.proof = { type: 'object' })), 'not_in_v1', 'display.formats.collect.call.args.proof.type'],
    ['an argument type that isn’t one', stampsWith((d) => (collectFormat(d).call.args.stamp = { type: 'float' })), 'wrong_type', 'display.formats.collect.call.args.stamp.type'],
    ['a Soroban type on NEAR', stampsWith((d) => (collectFormat(d).call.args.stamp = { type: 'i128' })), 'wrong_type', 'display.formats.collect.call.args.stamp.type'],
    ['an argument key that isn’t one', stampsWith((d) => (collectFormat(d).call.args.stamp.default = 'arrival')), 'unknown_key', 'display.formats.collect.call.args.stamp.default'],
    ['a maxLength of 0', stampsWith((d) => (collectFormat(d).call.args.stamp.maxLength = 0)), 'bad_number', 'display.formats.collect.call.args.stamp.maxLength'],
    ['a maxLength over the limit', stampsWith((d) => (collectFormat(d).call.args.stamp.maxLength = LABEL_LIMITS.stringMaxLength + 1)), 'bad_number', 'display.formats.collect.call.args.stamp.maxLength'],
    ['atLeast over atMost', stampsWith((d) => (collectFormat(d).call.args.n = { type: 'u128', atLeast: '5', atMost: '4' })), 'bad_number', 'display.formats.collect.call.args.n'],
    ['isSelf false', stampsWith((d) => (collectFormat(d).call.args.to = { type: 'accountId', isSelf: false })), 'wrong_type', 'display.formats.collect.call.args.to.isSelf'],
    ['an argument name with a dot', stampsWith((d) => (collectFormat(d).call.args['a.b'] = { type: 'string' })), 'bad_params', 'display.formats.collect.call.args.a.b'],
    ['a Soroban argument with no name', JSON.stringify({ ...SOROBAN_DOC_JSON, display: { formats: { deposit: { ...SOROBAN_DOC_JSON.display.formats.deposit, call: { args: [{ type: 'address' }] } } } } }), 'bad_params', 'display.formats.deposit.call.args[0].name'],
    ['two Soroban arguments named the same', JSON.stringify({ ...SOROBAN_DOC_JSON, display: { formats: { deposit: { ...SOROBAN_DOC_JSON.display.formats.deposit, call: { args: [{ name: 'from', type: 'address' }, { name: 'from', type: 'i128' }] } } } } }), 'duplicate', 'display.formats.deposit.call.args[1].name'],
    ['an optional Soroban argument', JSON.stringify({ ...SOROBAN_DOC_JSON, display: { formats: { deposit: { ...SOROBAN_DOC_JSON.display.formats.deposit, call: { args: [{ name: 'from', type: 'address', optional: true }, { name: 'amount', type: 'i128' }] } } } } }), 'unknown_key', 'display.formats.deposit.call.args[0].optional'],
    // the intent
    ['the verb "approve"', stampsWith((d) => (collectFormat(d).intent.verb = 'approve')), 'bad_verb', 'display.formats.collect.intent.verb'],
    ['the verb "mint"', stampsWith((d) => (collectFormat(d).intent.verb = 'mint')), 'bad_verb', 'display.formats.collect.intent.verb'],
    ['the verb "burn"', stampsWith((d) => (collectFormat(d).intent.verb = 'burn')), 'bad_verb', 'display.formats.collect.intent.verb'],
    ['a verb in capitals', stampsWith((d) => (collectFormat(d).intent.verb = 'Collect')), 'bad_verb', 'display.formats.collect.intent.verb'],
    ['an object that claims', stampsWith((d) => (collectFormat(d).intent.object = 'the free stamp')), 'text_claim', 'display.formats.collect.intent.object'],
    ['an object with Journear’s name', stampsWith((d) => (collectFormat(d).intent.object = 'the Journear stamp')), 'text_brand', 'display.formats.collect.intent.object'],
    ['an object that speaks to the user', stampsWith((d) => (collectFormat(d).intent.object = 'your stamp')), 'text_you', 'display.formats.collect.intent.object'],
    ['an object over 30 characters', stampsWith((d) => (collectFormat(d).intent.object = 'the stamp of the grand arrival hall')), 'text_too_long', 'display.formats.collect.intent.object'],
    ['free intent text (ERC-7730)', stampsWith((d) => (collectFormat(d).interpolatedIntent = 'Collect {stamp}')), 'not_in_v1', 'display.formats.collect.interpolatedIntent'],
    // the sentence
    ['a sentence that doesn’t start with the verb', stampsWith((d) => (collectFormat(d).sentence = ['object', 'verb', { field: 'args.stamp' }])), 'bad_sentence', 'display.formats.collect.sentence'],
    ['the verb twice', stampsWith((d) => (collectFormat(d).sentence = ['verb', 'object', 'verb'])), 'bad_sentence', 'display.formats.collect.sentence'],
    ['the object twice', stampsWith((d) => (collectFormat(d).sentence = ['verb', 'object', 'object'])), 'bad_sentence', 'display.formats.collect.sentence'],
    ['no object although the intent has one', stampsWith((d) => (collectFormat(d).sentence = ['verb', { field: 'args.stamp' }])), 'bad_sentence', 'display.formats.collect.sentence'],
    ['a field not declared', stampsWith((d) => (collectFormat(d).sentence = ['verb', 'object', { field: 'args.note' }])), 'bad_sentence', 'display.formats.collect.sentence[2]'],
    ['a field twice', stampsWith((d) => (collectFormat(d).sentence = ['verb', 'object', { field: 'args.stamp' }, { word: 'and' }, { field: 'args.stamp' }])), 'bad_sentence', 'display.formats.collect.sentence[4]'],
    ['a joining word not on the list', stampsWith((d) => (collectFormat(d).sentence = ['verb', { word: 'safely' }, 'object'])), 'bad_sentence', 'display.formats.collect.sentence[1]'],
    ['free text in the sentence', stampsWith((d) => (collectFormat(d).sentence = ['verb', 'object', 'now'])), 'bad_sentence', 'display.formats.collect.sentence[2]'],
    ['a joining word at the end', stampsWith((d) => (collectFormat(d).sentence = ['verb', 'object', { field: 'args.stamp' }, { word: 'for' }])), 'bad_sentence', 'display.formats.collect.sentence[3]'],
    ['two joining words together', stampsWith((d) => (collectFormat(d).sentence = ['verb', { word: 'for' }, { word: 'to' }, 'object'])), 'bad_sentence', 'display.formats.collect.sentence[1]'],
    ['too many parts', stampsWith((d) => (collectFormat(d).sentence = ['verb', 'object', { word: 'for' }, 'verb', 'verb', 'verb', 'verb', 'verb', 'verb'])), 'too_many', 'display.formats.collect.sentence'],
    // fields
    ['too many fields', stampsWith((d) => (collectFormat(d).fields = Array.from({ length: LABEL_LIMITS.fields + 1 }, () => collectFormat(d).fields[0]))), 'too_many', 'display.formats.collect.fields'],
    ['a field shown twice', stampsWith((d) => collectFormat(d).fields.push({ path: 'args.stamp', label: 'Again', format: 'itemId' })), 'duplicate', 'display.formats.collect.fields[1].path'],
    ['a hidden field (ERC-7730 visible)', stampsWith((d) => (collectFormat(d).fields[0].visible = 'never')), 'not_in_v1', 'display.formats.collect.fields[0].visible'],
    ['the raw format', stampsWith((d) => (collectFormat(d).fields[0].format = 'raw')), 'not_in_v1', 'display.formats.collect.fields[0].format'],
    ['the calldata format', stampsWith((d) => (collectFormat(d).fields[0].format = 'calldata')), 'not_in_v1', 'display.formats.collect.fields[0].format'],
    ['the nftName format', stampsWith((d) => (collectFormat(d).fields[0].format = 'nftName')), 'not_in_v1', 'display.formats.collect.fields[0].format'],
    ['a format that isn’t one', stampsWith((d) => (collectFormat(d).fields[0].format = 'text')), 'bad_field', 'display.formats.collect.fields[0].format'],
    ['a path to nothing declared', stampsWith((d) => (collectFormat(d).fields[0].path = 'args.missing')), 'bad_field', 'display.formats.collect.fields[0].path'],
    ['a nested path', stampsWith((d) => (collectFormat(d).fields[0].path = 'args.stamp.id')), 'bad_field', 'display.formats.collect.fields[0].path'],
    ['an amount format on a string', stampsWith((d) => (collectFormat(d).fields[0] = { path: 'args.stamp', label: 'Stamp', format: 'tokenAmount', params: { token: 'usdc.testnet' } })), 'bad_field', 'display.formats.collect.fields[0].format'],
    ['an enumeration that isn’t declared', stampsWith((d) => (collectFormat(d).fields[0].params.enum = 'stamps')), 'unknown_enum', 'display.formats.collect.fields[0].params.enum'],
    ['an enum field with no params', stampsWith((d) => delete collectFormat(d).fields[0].params), 'missing_key', 'display.formats.collect.fields[0].params'],
    ['params on an itemId', stampsWith((d) => (collectFormat(d).fields[0] = { path: 'args.stamp', label: 'Stamp', format: 'itemId', params: { x: 1 } })), 'bad_params', 'display.formats.collect.fields[0].params'],
    ['a field label that claims', stampsWith((d) => (collectFormat(d).fields[0].label = 'Safe stamp')), 'text_claim', 'display.formats.collect.fields[0].label'],
    ['a field label over 24 characters', stampsWith((d) => (collectFormat(d).fields[0].label = 'The stamp you will collect')), 'text_too_long', 'display.formats.collect.fields[0].label'],
    ['a token amount with both token and tokenPath', JSON.stringify({ ...SOROBAN_DOC_JSON, display: { formats: { deposit: { ...SOROBAN_DOC_JSON.display.formats.deposit, fields: [{ path: 'args.amount', label: 'Club share', format: 'tokenAmount', params: { token: POOL, tokenPath: 'args.from' } }, SOROBAN_DOC_JSON.display.formats.deposit.fields[1]] } } } }), 'bad_params', 'display.formats.deposit.fields[0].params'],
    ['a tokenPath that isn’t an account', JSON.stringify({ ...SOROBAN_DOC_JSON, display: { formats: { deposit: { ...SOROBAN_DOC_JSON.display.formats.deposit, fields: [{ path: 'args.amount', label: 'Club share', format: 'tokenAmount', params: { tokenPath: 'args.amount' } }, SOROBAN_DOC_JSON.display.formats.deposit.fields[1]] } } } }), 'bad_params', 'display.formats.deposit.fields[0].params.tokenPath'],
    ['a token that is an account id on Stellar', JSON.stringify({ ...SOROBAN_DOC_JSON, display: { formats: { deposit: { ...SOROBAN_DOC_JSON.display.formats.deposit, fields: [{ path: 'args.amount', label: 'Club share', format: 'tokenAmount', params: { token: 'usdc.testnet' } }, SOROBAN_DOC_JSON.display.formats.deposit.fields[1]] } } } }), 'bad_account', 'display.formats.deposit.fields[0].params.token'],
    ['a NEAR amount on Soroban', JSON.stringify({ ...SOROBAN_DOC_JSON, display: { formats: { deposit: { ...SOROBAN_DOC_JSON.display.formats.deposit, call: { args: [{ name: 'from', type: 'address' }, { name: 'amount', type: 'u128' }] }, fields: [{ path: 'args.amount', label: 'Club share', format: 'nativeAmount' }, SOROBAN_DOC_JSON.display.formats.deposit.fields[1]] } } } }), 'bad_field', 'display.formats.deposit.fields[0].format'],
    ['a count with min over max', stampsWith((d) => {
      collectFormat(d).call.args.n = { type: 'integer' };
      collectFormat(d).fields.push({ path: 'args.n', label: 'Tickets', format: 'count', params: { min: 5, max: 1 } });
    }), 'bad_number', 'display.formats.collect.fields[1].params'],
    ['a count bound over the limit', stampsWith((d) => {
      collectFormat(d).call.args.n = { type: 'integer' };
      collectFormat(d).fields.push({ path: 'args.n', label: 'Tickets', format: 'count', params: { min: 0, max: LABEL_LIMITS.countMax + 1 } });
    }), 'bad_number', 'display.formats.collect.fields[1].params.max'],
    ['a date without a unit', stampsWith((d) => {
      collectFormat(d).call.args.t = { type: 'u64' };
      collectFormat(d).fields.push({ path: 'args.t', label: 'Ends', format: 'date', params: {} });
    }), 'missing_key', 'display.formats.collect.fields[1].params.unit'],
  ];
  it.each(table)('%s', (_what, text, code, path) => {
    const errors = refused(text);
    expect(errors.map((e) => e.code)).toContain(code);
    expect(errors.find((e) => e.code === code)!.path).toBe(path);
  });

  it('reports at most LABEL_MAX_ERRORS errors, each with a plain message', () => {
    const r = parseLabelDocument(stampsWith((d) => (d.metadata.enums.stamp = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`v${i}`, `free ${i}`])))));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.length).toBe(LABEL_MAX_ERRORS);
    for (const e of r.errors) {
      expect(e.message.length).toBeGreaterThan(10);
      expect(Object.isFrozen(e)).toBe(true);
    }
  });

  it('never echoes a long or unsafe key back', () => {
    const r = parseLabelDocument(stampsWith((d) => (d[`x‮${'y'.repeat(100)}`] = 1)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).not.toMatch(/‮|y{41}/u);
  });
});

describe('code hashes', () => {
  it('a NEAR code hash is base58 of exactly 32 bytes in canonical form', () => {
    expect(isNearCodeHash(STAMPS_HASH)).toBe(true);
    expect(isNearCodeHash(`1${STAMPS_HASH}`)).toBe(false);
    expect(isNearCodeHash(STAMPS_HASH.slice(0, -4))).toBe(false);
    expect(isNearCodeHash(`${STAMPS_HASH} `)).toBe(false);
    expect(isNearCodeHash(5)).toBe(false);
  });
});
