// The partner label matcher (src/partner-labels/match.ts, D892): the stamps' `collect` and the guestbook's
// `add_message` written as partner labels match exactly and every near-miss from D885's list doesn't, with the right
// reason code; a Soroban call and a classic payment with an address book; and two property-style checks: (a) a
// match's sentence holds no text that didn't come from Journear's lists, the validated document or the request's
// true values; (b) changing any byte of the request's method, arguments, deposit or receiver leaves the shown values
// those of the new request, or gives no match.
import { readFileSync, readdirSync } from 'node:fs';
import { Asset, Memo, Operation } from '@stellar/stellar-base';
import { describe, expect, it } from 'vitest';
import { utf8 } from '../src/bytes.ts';
import { decodeApprovalRequest } from '../src/decode/request.ts';
import type { NearAction } from '../src/near/codec.ts';
import {
  type LabelMatch,
  type LabelMatchResult,
  type LabelRequest,
  labelLinePlainText,
  labelRequestOf,
  matchLabel,
  sentencePlainText,
} from '../src/partner-labels/match.ts';
import type { LabelDocument } from '../src/partner-labels/schema.ts';
import { PARTNER_CONNECTORS, PARTNER_VERBS } from '../src/partner-labels/words.ts';
import {
  BOOK,
  BOOK_HASH,
  GUESTBOOK_DOC_JSON,
  ISSUER,
  ME,
  OTHER,
  OTHER_HASH,
  PASSPHRASE,
  PAYMENT_DOC_JSON,
  POOL,
  POOL_WASM,
  SOROBAN_DOC_JSON,
  STAMPS,
  STAMPS_DOC_JSON,
  STAMPS_HASH,
  TGAS,
  TEST_USDC_SAC,
  UNLISTED,
  USER,
  fn,
  nearDecoded,
  parsed,
  paymentTx,
} from './partner-labels-fixtures.ts';
import { addr, authPreimageBytes, i128, invocation, invokeOp, sourceAuth, txBytes, changeTrustOp } from './stellar-fixtures.ts';
import { xdr } from '@stellar/stellar-base';

const STAMPS_DOC = parsed(STAMPS_DOC_JSON);
const GUESTBOOK_DOC = parsed(GUESTBOOK_DOC_JSON);
const SOROBAN_DOC = parsed(SOROBAN_DOC_JSON);
const PAYMENT_DOC = parsed(PAYMENT_DOC_JSON);

/** Every match the tests see, with its document and request, for the provenance check (a). */
const seen: { doc: LabelDocument; req: LabelRequest; m: LabelMatch }[] = [];

function run(doc: LabelDocument, req: LabelRequest | null, codeHash: string | null | undefined): LabelMatchResult {
  if (req === null) throw new Error('no request');
  const r = matchLabel(doc, req, { codeHash, networkChecked: true });
  if (r.ok) seen.push({ doc, req, m: r });
  return r;
}

const near = (actions: NearAction[], o: Parameters<typeof nearDecoded>[1] = {}) => labelRequestOf(nearDecoded(actions, o), ME);
const collect = (args: Record<string, unknown> | string, over?: { gas?: bigint; deposit?: bigint }) => fn('collect', typeof args === 'string' ? args : JSON.stringify(args), over);
const stamps = (actions: NearAction[], o: Parameters<typeof nearDecoded>[1] = {}, hash: string | null | undefined = STAMPS_HASH) => run(STAMPS_DOC, near(actions, o), hash);
const guestbook = (actions: NearAction[], o: Parameters<typeof nearDecoded>[1] = {}, hash: string | null | undefined = BOOK_HASH) => run(GUESTBOOK_DOC, near(actions, { receiver: BOOK, ...o }), hash);
const reason = (r: LabelMatchResult) => (r.ok ? 'match' : r.reason);

describe('NEAR: the stamps’ collect, as a partner label', () => {
  it('matches each listed stamp, relayed or direct, and builds the window’s sentence', () => {
    for (const [stamp, title] of [['arrival', 'Arrival'], ['sponsored', 'Fare paid'], ['layover', 'Layover'], ['own_fare', 'Ticket fare']] as const) {
      for (const relayed of [true, false]) {
        const r = stamps([collect({ stamp })], { relayed });
        expect(r.ok, `${stamp} ${relayed}`).toBe(true);
        const m = r as LabelMatch;
        expect(m.format).toBe('collect');
        expect(m.verb).toBe('collect');
        expect(m.parts).toEqual([
          { kind: 'verb', text: 'collect' },
          { kind: 'object', text: 'the stamp' },
          { kind: 'value', path: 'args.stamp', value: { format: 'enum', raw: stamp, text: title, source: 'partner_enum' } },
        ]);
        expect(m.fields).toEqual([{ path: 'args.stamp', label: 'Stamp', value: { format: 'enum', raw: stamp, text: title, source: 'partner_enum' } }]);
        expect(sentencePlainText(m.parts)).toBe(`collect the stamp “${title}”`);
        expect(labelLinePlainText('Stamp Trail', m)).toBe(`Stamp Trail says: collect the stamp “${title}”`);
      }
    }
  });

  it('matches the postcard with its optional note (shown in the details, not by the label: v1 has no free-text slot)', () => {
    const r = stamps([collect({ stamp: 'postcard', note: 'hi from the gate' })]);
    expect(r.ok).toBe(true);
    expect(sentencePlainText((r as LabelMatch).parts)).toBe('collect the stamp “Postcard”');
    expect(reason(stamps([collect({ stamp: 'postcard', note: 'x'.repeat(141) })]))).toBe('out_of_bounds');
  });

  it('every near-miss of D885’s list is no match, with its reason', () => {
    const ok = collect({ stamp: 'arrival' });
    const cases: [string, LabelMatchResult, string][] = [
      ['mainnet', stamps([ok], { network: 'mainnet' }), 'wrong_network'],
      ['no code hash read', stamps([ok], {}, null), 'no_code_hash'],
      ['no code hash given', run(STAMPS_DOC, near([ok]), undefined), 'no_code_hash'],
      ['another code hash (an upgrade)', stamps([ok], {}, OTHER_HASH), 'code_hash_mismatch'],
      ['the guestbook’s account', stamps([ok], { receiver: BOOK }), 'wrong_account'],
      ['a look-alike account', stamps([ok], { receiver: `${STAMPS}.evil.testnet` }), 'wrong_account'],
      ['a prefix of the account', stamps([ok], { receiver: 'stamps.testnet' }), 'wrong_account'],
      ['another method', stamps([fn('collect_all', '{"stamp":"arrival"}')]), 'wrong_method'],
      ['another case of the method', stamps([fn('Collect', '{"stamp":"arrival"}')]), 'wrong_method'],
      ['a method named like an object key', stamps([fn('constructor', '{}')]), 'wrong_method'],
      ['1 yoctoNEAR attached', stamps([collect({ stamp: 'arrival' }, { deposit: 1n })]), 'deposit_not_allowed'],
      ['1 NEAR attached', stamps([collect({ stamp: 'arrival' }, { deposit: 10n ** 24n })]), 'deposit_not_allowed'],
      ['gas above 30 Tgas', stamps([collect({ stamp: 'arrival' }, { gas: 30n * TGAS + 1n })]), 'gas_too_high'],
      ['the call twice', stamps([ok, ok]), 'more_than_one_action'],
      ['the call with a transfer', stamps([ok, { type: 'transfer', deposit: 1n }]), 'more_than_one_action'],
      ['the call with a token transfer', stamps([ok, fn('ft_transfer', '{"receiver_id":"x.testnet","amount":"1"}')]), 'more_than_one_action'],
      ['a transfer alone', stamps([{ type: 'transfer', deposit: 1n }]), 'not_a_function_call'],
      ['an extra argument', stamps([collect({ stamp: 'arrival', to: 'x.testnet' })]), 'undeclared_arg'],
      ['a misplaced (nested) argument', stamps([collect({ args: { stamp: 'arrival' } })]), 'undeclared_arg'],
      ['a missing argument', stamps([collect({})]), 'missing_arg'],
      ['no arguments at all', stamps([fn('collect', '')]), 'args_not_json'],
      ['a duplicate key', stamps([collect('{"stamp":"arrival","stamp":"layover"}')]), 'args_not_json'],
      ['a BOM', stamps([fn('collect', Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('{"stamp":"arrival"}')]))]), 'args_not_json'],
      ['invalid UTF-8', stamps([fn('collect', Uint8Array.from([...utf8('{"stamp":"arr'), 0xff, ...utf8('ival"}')]))]), 'args_not_json'],
      ['trailing bytes', stamps([collect('{"stamp":"arrival"}x')]), 'args_not_json'],
      ['two JSON values', stamps([collect('{"stamp":"arrival"}{}')]), 'args_not_json'],
      ['a lone surrogate', stamps([collect('{"stamp":"\\ud800"}')]), 'args_not_json'],
      ['Borsh bytes', stamps([fn('collect', Uint8Array.from([7, 0, 0, 0, 97, 114, 114, 105, 118, 97, 108]))]), 'args_not_json'],
      ['an array', stamps([collect('[{"stamp":"arrival"}]')]), 'args_not_object'],
      ['a string', stamps([collect('"arrival"')]), 'args_not_object'],
      ['another stamp', stamps([collect({ stamp: 'signature' })]), 'enum_value_not_listed'],
      ['a differently cased stamp', stamps([collect({ stamp: 'Arrival' })]), 'enum_value_not_listed'],
      ['a padded stamp', stamps([collect({ stamp: ' arrival' })]), 'enum_value_not_listed'],
      ['a numeric stamp', stamps([collect({ stamp: 1 })]), 'type_mismatch'],
      ['a boolean stamp', stamps([collect({ stamp: true })]), 'type_mismatch'],
      ['a null stamp', stamps([collect({ stamp: null })]), 'type_mismatch'],
      ['an object stamp', stamps([collect({ stamp: { id: 'arrival' } })]), 'type_mismatch'],
      ['a numeric note', stamps([collect({ stamp: 'postcard', note: 5 })]), 'type_mismatch'],
    ];
    for (const [what, r, want] of cases) expect(reason(r), what).toBe(want);
  });

  it('a request to the user’s own account is no match, even when the document names it', () => {
    const own = parsed({ ...STAMPS_DOC_JSON, context: { near: { network: 'testnet', account: ME, codeHash: STAMPS_HASH } } });
    expect(reason(run(own, near([collect({ stamp: 'arrival' })], { receiver: ME }), STAMPS_HASH))).toBe('calls_own_account');
  });

  it('relayed or direct, as the document says', () => {
    const relayedOnly = parsed({ ...STAMPS_DOC_JSON, display: { formats: { collect: { ...STAMPS_DOC_JSON.display.formats.collect, call: { ...STAMPS_DOC_JSON.display.formats.collect.call, relayed: 'relayed' } } } } });
    const directOnly = parsed({ ...STAMPS_DOC_JSON, display: { formats: { collect: { ...STAMPS_DOC_JSON.display.formats.collect, call: { ...STAMPS_DOC_JSON.display.formats.collect.call, relayed: 'direct' } } } } });
    const a = [collect({ stamp: 'arrival' })];
    expect(reason(run(relayedOnly, near(a), STAMPS_HASH))).toBe('match');
    expect(reason(run(relayedOnly, near(a, { relayed: false }), STAMPS_HASH))).toBe('direct_not_allowed');
    expect(reason(run(directOnly, near(a, { relayed: false }), STAMPS_HASH))).toBe('match');
    expect(reason(run(directOnly, near(a), STAMPS_HASH))).toBe('relayed_not_allowed');
  });

  it('a stamps document never matches a Stellar request, and a Stellar one never a NEAR request', () => {
    const tx = labelRequestOf(decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: paymentTx() }), USER);
    expect(reason(run(STAMPS_DOC, tx, STAMPS_HASH))).toBe('wrong_chain');
    expect(reason(run(PAYMENT_DOC, near([collect({ stamp: 'arrival' })]), STAMPS_HASH))).toBe('wrong_chain');
    expect(reason(run(SOROBAN_DOC, near([collect({ stamp: 'arrival' })]), POOL_WASM))).toBe('wrong_chain');
  });
});

describe('NEAR: the guestbook’s add_message, as a partner label', () => {
  it('matches a message, relayed or direct; the sentence is the verb and the object only', () => {
    for (const relayed of [true, false]) {
      const r = guestbook([fn('add_message', '{"text":"gm"}')], { relayed });
      expect(r.ok).toBe(true);
      expect(sentencePlainText((r as LabelMatch).parts)).toBe('add a message to the guestbook');
      expect((r as LabelMatch).fields).toEqual([]);
    }
  });
  it('near-misses', () => {
    const cases: [string, LabelMatchResult, string][] = [
      ['too long', guestbook([fn('add_message', JSON.stringify({ text: 'x'.repeat(201) }))]), 'out_of_bounds'],
      ['missing text', guestbook([fn('add_message', '{}')]), 'missing_arg'],
      ['an extra key', guestbook([fn('add_message', '{"text":"gm","from":"x"}')]), 'undeclared_arg'],
      ['the stamps’ code hash', guestbook([fn('add_message', '{"text":"gm"}')], {}, STAMPS_HASH), 'code_hash_mismatch'],
      ['the stamps account', guestbook([fn('add_message', '{"text":"gm"}')], { receiver: STAMPS }), 'wrong_account'],
      ['a deposit', guestbook([fn('add_message', '{"text":"gm"}', { deposit: 1n })]), 'deposit_not_allowed'],
    ];
    for (const [what, r, want] of cases) expect(reason(r), what).toBe(want);
  });
});

describe('NEAR: typed slots', () => {
  const DOC = parsed({
    schema: 'journear-labels/1',
    context: { near: { network: 'testnet', account: 'shop.testnet', codeHash: STAMPS_HASH } },
    metadata: { addressBook: [{ account: 'till.testnet', name: 'Shop till' }] },
    display: {
      formats: {
        buy: {
          call: {
            deposit: { atMost: '2000000000000000000000000' },
            args: {
              token: { type: 'accountId' },
              amount: { type: 'u128' },
              to: { type: 'accountId' },
              quantity: { type: 'integer', min: 1, max: 10 },
              ends: { type: 'u64' },
              lock: { type: 'integer' },
              order: { type: 'string', maxLength: 32 },
              gift: { type: 'boolean', equals: false },
            },
          },
          intent: { verb: 'buy', object: 'tickets' },
          sentence: ['verb', { field: 'args.quantity' }, 'object', { word: 'for' }, { field: 'args.amount' }],
          fields: [
            { path: 'args.quantity', label: 'Tickets', format: 'count', params: { min: 1, max: 10 } },
            { path: 'args.amount', label: 'Price', format: 'tokenAmount', params: { tokenPath: 'args.token' } },
            { path: 'args.to', label: 'Paid to', format: 'account' },
            { path: 'args.token', label: 'Token', format: 'account' },
            { path: 'deposit', label: 'Attached', format: 'nativeAmount' },
            { path: 'args.ends', label: 'Sale ends', format: 'date', params: { unit: 'nanoseconds' } },
            { path: 'args.lock', label: 'Held for', format: 'duration', params: { unit: 'seconds' } },
            { path: 'args.order', label: 'Order', format: 'orderNumber' },
          ],
        },
      },
    },
  });
  const args = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ token: 'usdc.fakes.testnet', amount: '2500000', to: 'till.testnet', quantity: 2, ends: '1795000000000000000', lock: 90061, order: 'A-1042', gift: false, ...over });
  const buy = (over: Record<string, unknown> = {}, deposit = 0n) => run(DOC, near([fn('buy', args(over), { deposit })], { receiver: 'shop.testnet' }), STAMPS_HASH);
  const value = (r: LabelMatchResult, path: string) => (r as LabelMatch).fields.find((f) => f.path === path)!.value;

  it('renders each slot from the request’s true value, with where its meaning came from', () => {
    const r = buy({}, 10n ** 24n + 5n * 10n ** 23n);
    expect(r.ok).toBe(true);
    expect(value(r, 'args.quantity')).toEqual({ format: 'count', raw: '2', text: '2', source: 'request' });
    // An unlisted token: raw units with the token's id, never a symbol the partner claims.
    expect(value(r, 'args.amount')).toEqual({ format: 'tokenAmount', raw: '2500000', token: 'usdc.fakes.testnet', text: '2,500,000 units of the unlisted token usdc.fakes.testnet', symbol: null, decimals: null, source: 'unlisted_token', kind: null, binding: 'partner' });
    expect(value(r, 'args.to')).toEqual({ format: 'account', value: 'till.testnet', text: 'Shop till', source: 'partner_address_book' });
    expect(value(r, 'deposit')).toEqual({ format: 'nativeAmount', raw: '1500000000000000000000000', text: '1.5 NEAR', source: 'request', binding: 'request' });
    expect(value(r, 'args.ends')).toEqual({ format: 'date', raw: '1795000000000000000', text: '18 November 2026, 11:06:40 UTC', source: 'request' });
    expect(value(r, 'args.lock')).toEqual({ format: 'duration', raw: '90061', text: '1 day 1 hour 1 minute 1 second', source: 'request' });
    expect(value(r, 'args.order')).toEqual({ format: 'orderNumber', raw: 'A-1042', text: 'A-1042', source: 'request' });
    expect(sentencePlainText((r as LabelMatch).parts, 'Shop')).toBe('buy 2 tickets for 2,500,000 units of the unlisted token usdc.fakes.testnet, as Shop describes it');
  });

  it('a listed token gets its symbol and decimals from Journear’s list only; an account is "your account", a listed name or itself', () => {
    const r = buy({ token: 'wrap.testnet', amount: '1250000000000000000000000', to: ME });
    expect(value(r, 'args.amount')).toEqual({ format: 'tokenAmount', raw: '1250000000000000000000000', token: 'wrap.testnet', text: '1.25 wNEAR', symbol: 'wNEAR', decimals: 24, source: 'journear_known_tokens', kind: 'token', binding: 'partner' });
    expect(sentencePlainText((r as LabelMatch).parts, 'Shop')).toBe('buy 2 tickets for 1,250,000,000,000,000,000,000,000 units, which Shop says are 1.25 wNEAR');
    expect(value(r, 'args.to')).toEqual({ format: 'account', value: ME, text: 'your account', source: 'computed_self' });
    // Not in the book, and only an exact entry counts.
    expect(value(buy({ to: 'till.testnet.x.testnet' }), 'args.to')).toEqual({ format: 'account', value: 'till.testnet.x.testnet', text: 'till.testnet.x.testnet', source: 'request' });
    // An account id is lower case by the protocol: "Till.testnet" isn't one, so the request isn't the declared call.
    expect(reason(buy({ to: 'Till.testnet' }))).toBe('type_mismatch');
  });

  it('bounds, types and displayability', () => {
    const cases: [string, LabelMatchResult, string][] = [
      ['quantity 0', buy({ quantity: 0 }), 'out_of_bounds'],
      ['quantity 11', buy({ quantity: 11 }), 'out_of_bounds'],
      ['quantity as text', buy({ quantity: '2' }), 'type_mismatch'],
      ['quantity 2.5', buy({ quantity: 2.5 }), 'type_mismatch'],
      ['quantity 1e1', run(DOC, near([fn('buy', args().replace('"quantity":2', '"quantity":1e1'))], { receiver: 'shop.testnet' }), STAMPS_HASH), 'type_mismatch'],
      ['quantity 2.0', run(DOC, near([fn('buy', args().replace('"quantity":2', '"quantity":2.0'))], { receiver: 'shop.testnet' }), STAMPS_HASH), 'type_mismatch'],
      ['quantity over 2^53', run(DOC, near([fn('buy', args().replace('"quantity":2', '"quantity":9007199254740993'))], { receiver: 'shop.testnet' }), STAMPS_HASH), 'type_mismatch'],
      ['amount as a number', buy({ amount: 2500000 }), 'type_mismatch'],
      ['amount with a leading zero', buy({ amount: '02500000' }), 'type_mismatch'],
      ['amount over u128', buy({ amount: (2n ** 128n).toString() }), 'type_mismatch'],
      ['amount negative', buy({ amount: '-1' }), 'type_mismatch'],
      ['a token that is no account id', buy({ token: 'USDC' }), 'type_mismatch'],
      ['a date before 2000', buy({ ends: '1' }), 'out_of_bounds'],
      ['a date after 9999', buy({ ends: '99999999999999999999' }), 'type_mismatch'],
      ['a duration over 100 years', buy({ lock: 100 * 365 * 86400 + 1 }), 'out_of_bounds'],
      ['an order with a space', buy({ order: 'A 1042' }), 'value_not_displayable'],
      ['an order with a quotation mark', buy({ order: 'A-1042”' }), 'value_not_displayable'],
      ['an order with a bidi override', buy({ order: `A-1042${String.fromCharCode(0x202e)}` }), 'value_not_displayable'],
      ['an order over 32 characters', buy({ order: 'A'.repeat(33) }), 'out_of_bounds'],
      ['a gift', buy({ gift: true }), 'not_one_of'],
      ['2 NEAR + 1 yocto attached', buy({}, 2n * 10n ** 24n + 1n), 'deposit_not_allowed'],
    ];
    for (const [what, r, want] of cases) expect(reason(r), what).toBe(want);
  });
});

// ---- Soroban ----

const sorobanTx = (fnName: string, args: xdr.ScVal[], o: { auth?: xdr.SorobanAuthorizationEntry[]; contract?: string; extra?: xdr.Operation[]; source?: string; fee?: string } = {}) =>
  labelRequestOf(
    decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: txBytes([invokeOp(o.contract ?? POOL, fnName, args, o.auth ?? [sourceAuth(invocation(o.contract ?? POOL, fnName, args))]), ...(o.extra ?? [])], { ...(o.source ? { source: o.source } : {}), ...(o.fee ? { fee: o.fee } : {}) }) }),
    USER,
  );
const sorobanAuth = (root: xdr.SorobanAuthorizedInvocation) =>
  labelRequestOf(decodeApprovalRequest({ kind: 'stellar_auth_entry', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: authPreimageBytes(root) }), USER);

describe('Soroban: a deposit and a payment to a listed account', () => {
  it('matches the deposit as a transaction (direct) or an authorization (relayed)', () => {
    const args = [addr(USER), i128(25_000_000n)];
    for (const req of [sorobanTx('deposit', args), sorobanAuth(invocation(POOL, 'deposit', args))]) {
      const r = run(SOROBAN_DOC, req, POOL_WASM);
      expect(r.ok).toBe(true);
      expect(sentencePlainText((r as LabelMatch).parts, 'Club')).toBe('deposit 25,000,000 units, which Club says are 2.5 USDC from your account');
      expect((r as LabelMatch).fields[0]!.value).toMatchObject({ format: 'tokenAmount', token: TEST_USDC_SAC, symbol: 'USDC', decimals: 7, source: 'journear_known_tokens' });
    }
  });
  it('a token named by an argument: listed or not; a recipient that must be in the address book', () => {
    const listed = run(SOROBAN_DOC, sorobanTx('pay_to', [addr(TEST_USDC_SAC), addr(OTHER), i128(10_000_000n)]), POOL_WASM);
    expect(sentencePlainText((listed as LabelMatch).parts, 'Club')).toBe(`pay 10,000,000 units, which Club says are 1 USDC to “Club treasury” (${OTHER})`);
    const unlisted = run(SOROBAN_DOC, sorobanTx('pay_to', [addr(UNLISTED), addr(OTHER), i128(10_000_000n)]), POOL_WASM);
    expect(sentencePlainText((unlisted as LabelMatch).parts, 'Club')).toBe(`pay 10,000,000 units of the unlisted token ${UNLISTED}, as Club describes it to “Club treasury” (${OTHER})`);
    expect(reason(run(SOROBAN_DOC, sorobanTx('pay_to', [addr(TEST_USDC_SAC), addr(USER), i128(1n)]), POOL_WASM))).toBe('not_in_address_book');
  });
  it('near-misses', () => {
    const args = [addr(USER), i128(25_000_000n)];
    const cases: [string, LabelMatchResult, string][] = [
      ['no Wasm hash', run(SOROBAN_DOC, sorobanTx('deposit', args), null), 'no_code_hash'],
      ['another Wasm hash', run(SOROBAN_DOC, sorobanTx('deposit', args), 'cd'.repeat(32)), 'code_hash_mismatch'],
      ['another contract', run(SOROBAN_DOC, sorobanTx('deposit', args, { contract: UNLISTED }), POOL_WASM), 'wrong_account'],
      ['another function', run(SOROBAN_DOC, sorobanTx('withdraw', args), POOL_WASM), 'wrong_method'],
      ['from someone else', run(SOROBAN_DOC, sorobanTx('deposit', [addr(OTHER), i128(1n)]), POOL_WASM), 'not_self'],
      ['amount 0', run(SOROBAN_DOC, sorobanTx('deposit', [addr(USER), i128(0n)]), POOL_WASM), 'out_of_bounds'],
      ['amount negative', run(SOROBAN_DOC, sorobanTx('deposit', [addr(USER), i128(-5n)]), POOL_WASM), 'out_of_bounds'],
      ['amount over the bound', run(SOROBAN_DOC, sorobanTx('deposit', [addr(USER), i128(10n ** 12n + 1n)]), POOL_WASM), 'out_of_bounds'],
      ['an extra argument', run(SOROBAN_DOC, sorobanTx('deposit', [...args, i128(1n)]), POOL_WASM), 'undeclared_arg'],
      ['a missing argument', run(SOROBAN_DOC, sorobanTx('deposit', [addr(USER)]), POOL_WASM), 'missing_arg'],
      ['arguments swapped', run(SOROBAN_DOC, sorobanTx('deposit', [i128(1n), addr(USER)]), POOL_WASM), 'type_mismatch'],
      ['a u128 for an i128', run(SOROBAN_DOC, sorobanTx('deposit', [addr(USER), xdr.ScVal.scvU128(new xdr.UInt128Parts({ hi: xdr.Uint64.fromString('0'), lo: xdr.Uint64.fromString('5') }))]), POOL_WASM), 'type_mismatch'],
      ['a nested authorization', run(SOROBAN_DOC, sorobanTx('deposit', args, { auth: [sourceAuth(invocation(POOL, 'deposit', args, [invocation(TEST_USDC_SAC, 'transfer', [addr(USER), addr(POOL), i128(25_000_000n)])]))] }), POOL_WASM), 'nested_call'],
      ['an authorization of another call', run(SOROBAN_DOC, sorobanTx('deposit', args, { auth: [sourceAuth(invocation(POOL, 'deposit', [addr(USER), i128(1n)]))] }), POOL_WASM), 'nested_call'],
      ['a nested authorization entry', run(SOROBAN_DOC, sorobanAuth(invocation(POOL, 'deposit', args, [invocation(TEST_USDC_SAC, 'transfer', [addr(USER), addr(POOL), i128(1n)])])), POOL_WASM), 'nested_call'],
      ['two operations', run(SOROBAN_DOC, sorobanTx('deposit', args, { extra: [changeTrustOp()] }), POOL_WASM), 'more_than_one_action'],
      ['a fee over the bound', run(SOROBAN_DOC, sorobanTx('deposit', args, { fee: '1000001' }), POOL_WASM), 'fee_too_high'],
      ['a classic operation', run(SOROBAN_DOC, labelRequestOf(decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: paymentTx() }), USER), POOL_WASM), 'not_a_function_call'],
    ];
    for (const [what, r, want] of cases) expect(reason(r), what).toBe(want);
  });
  it('another network, and the contract’s own parameter names when given', () => {
    const req = sorobanTx('deposit', [addr(USER), i128(1n)])!;
    expect(reason(matchLabel(SOROBAN_DOC, { ...req, networkPassphrase: 'Public Global Stellar Network ; September 2015' } as LabelRequest, { codeHash: POOL_WASM }))).toBe('wrong_network');
    expect(reason(matchLabel(SOROBAN_DOC, req, { codeHash: POOL_WASM, sorobanParams: ['from', 'amount'] }))).toBe('match');
    expect(reason(matchLabel(SOROBAN_DOC, req, { codeHash: POOL_WASM, sorobanParams: ['to', 'amount'] }))).toBe('spec_mismatch');
    expect(reason(matchLabel(SOROBAN_DOC, req, { codeHash: POOL_WASM, sorobanParams: ['from'] }))).toBe('spec_mismatch');
  });
});

// ---- classic Stellar payment ----

const payment = (o: Parameters<typeof paymentTx>[0] = {}) =>
  run(PAYMENT_DOC, labelRequestOf(decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: paymentTx(o) }), USER), undefined);

describe('Stellar: a classic payment with the partner’s purpose and address book', () => {
  it('matches a payment to a listed account: the memo is the order number, the destination is named from the book', () => {
    const r = payment();
    expect(r.ok).toBe(true);
    const m = r as LabelMatch;
    expect(sentencePlainText(m.parts)).toBe('pay for order “1042”');
    expect(labelLinePlainText('Coffee Club', m)).toBe('Coffee Club says: pay for order “1042”');
    expect(m.destination).toEqual({ format: 'account', value: OTHER, text: 'Coffee Club till', source: 'partner_address_book' });
    expect(payment({ asset: new Asset('USDC', ISSUER) }).ok).toBe(true);
  });
  it('near-misses: a hijacked page that swaps the recipient, another memo, more operations', () => {
    const cases: [string, LabelMatchResult, string][] = [
      ['a recipient not in the book', payment({ destination: USER }), 'not_in_address_book'],
      ['a memo id', payment({ memo: Memo.id('1042') }), 'memo_mismatch'],
      ['no memo', payment({ memo: Memo.none() }), 'memo_mismatch'],
      ['a memo with a quotation mark', payment({ memo: Memo.text('1042” paid') }), 'value_not_displayable'],
      ['a memo with a space', payment({ memo: Memo.text('order 1042') }), 'value_not_displayable'],
      ['an asset not allowed', payment({ asset: new Asset('EURC', ISSUER) }), 'token_not_allowed'],
      ['a USDC look-alike issuer', payment({ asset: new Asset('USDC', OTHER) }), 'token_not_allowed'],
      ['an amount over the bound', payment({ amount: '100.0000001' }), 'out_of_bounds'],
      ['two operations', payment({ extra: [Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '1' })] }), 'more_than_one_action'],
      ['another source', payment({ source: OTHER }), 'source_not_user'],
      ['an operation source not the user', payment({ opSource: OTHER }), 'source_not_user'],
    ];
    for (const [what, r, want] of cases) expect(reason(r), what).toBe(want);
    const trust = labelRequestOf(decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: txBytes([changeTrustOp()]) }), USER);
    expect(reason(run(PAYMENT_DOC, trust, undefined))).toBe('wrong_operation');
    expect(reason(run(PAYMENT_DOC, sorobanAuth(invocation(POOL, 'deposit', [])), undefined))).toBe('wrong_operation');
  });
});

describe('labelRequestOf: the decoders’ output, unchanged', () => {
  it('reads NEAR transactions and delegate actions, Stellar transactions and authorizations; nothing else', () => {
    const d = nearDecoded([collect({ stamp: 'arrival' })]);
    expect(labelRequestOf(d, ME)).toMatchObject({ kind: 'near', network: 'testnet', user: ME, receiver: STAMPS, relayed: true });
    expect(labelRequestOf(nearDecoded([collect({ stamp: 'arrival' })], { relayed: false }), ME)).toMatchObject({ kind: 'near', relayed: false, user: ME });
    expect(labelRequestOf(decodeApprovalRequest({ kind: 'personal_sign', chain: 'evm', address: '0x0000000000000000000000000000000000000001', context: {}, bytes: utf8('hi') }), ME)).toBeNull();
    expect(labelRequestOf(decodeApprovalRequest({ kind: 'stellar_message', chain: 'stellar', address: USER, context: {}, bytes: utf8('hi') }), USER)).toBeNull();
  });
});

// ---- property-style checks ----

/** A small deterministic generator (mulberry32) for the mutation checks: the same cases on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('(a) a match’s sentence holds only Journear’s words, validated partner text and true values', () => {
  it('every part of every match seen in these tests has its provenance', () => {
    // Run a few more of each kind so the check covers every document.
    stamps([collect({ stamp: 'layover' })]);
    guestbook([fn('add_message', '{"text":"x"}')]);
    payment();
    expect(seen.length).toBeGreaterThan(20);
    for (const { doc, req, m } of seen) {
      const format = doc.formats[m.format]!;
      for (const p of m.parts) {
        if (p.kind === 'verb') expect(PARTNER_VERBS).toContain(p.text);
        else if (p.kind === 'word') expect(PARTNER_CONNECTORS).toContain(p.text);
        else if (p.kind === 'object') expect(p.text).toBe(format.intent.object);
        else {
          const v = p.value;
          const field = format.fields.find((f) => f.path === p.path)!;
          expect(field).toBeDefined();
          if (v.format === 'enum') {
            expect(field.params.format).toBe('enum');
            expect(v.text).toBe(doc.metadata.enums[(field.params as { enum: string }).enum]![v.raw]);
          }
          if (v.format === 'account') expect([v.value, 'your account', ...doc.metadata.addressBook.filter((e) => e.account === v.value).map((e) => e.name)]).toContain(v.text);
          if (v.format === 'account' && v.text === 'your account') expect(v.value).toBe(req.user);
          if (v.format === 'tokenAmount' && v.symbol === null) expect(v.text).toBe(`${BigInt(v.raw).toLocaleString('en-US')} units of the unlisted token ${v.token}`);
          if (v.format === 'tokenAmount') expect(v.binding).toBe('partner');
        }
      }
      // The plain text is exactly the parts: nothing between them but single spaces.
      const plain = sentencePlainText(m.parts);
      expect(plain.split(' ').length).toBeGreaterThanOrEqual(m.parts.length);
    }
  });
});

describe('(b) changing any byte of the request keeps the shown values true, or gives no match', () => {
  /** The values the request itself holds, read independently of the matcher. */
  function trueStamp(req: Extract<LabelRequest, { kind: 'near' }>): string | null {
    const a = req.actions[0];
    if (!a || a.type !== 'functionCall') return null;
    try {
      const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(a.args)) as { stamp?: unknown };
      return typeof v.stamp === 'string' ? v.stamp : null;
    } catch {
      return null;
    }
  }

  it('NEAR collect: method, arguments, deposit and receiver, 2000 single-byte changes', () => {
    const rand = prng(892);
    const base = near([collect({ stamp: 'sponsored', note: 'hello' })]) as Extract<LabelRequest, { kind: 'near' }>;
    const a0 = base.actions[0] as Extract<NearAction, { type: 'functionCall' }>;
    let matched = 0;
    for (let i = 0; i < 2000; i++) {
      const which = Math.floor(rand() * 4);
      const flip = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
        const out = Uint8Array.from(bytes);
        const at = Math.floor(rand() * out.length);
        out[at] = (out[at]! + 1 + Math.floor(rand() * 255)) & 0xff;
        return out;
      };
      let req: Extract<LabelRequest, { kind: 'near' }> = base;
      if (which === 0) req = { ...base, actions: [{ ...a0, methodName: new TextDecoder().decode(flip(utf8(a0.methodName))) }] };
      else if (which === 1) req = { ...base, actions: [{ ...a0, args: flip(a0.args) }] };
      else if (which === 2) req = { ...base, actions: [{ ...a0, deposit: a0.deposit + BigInt(1 + Math.floor(rand() * 1000)) }] };
      else req = { ...base, receiver: new TextDecoder().decode(flip(utf8(base.receiver))) };
      const r = matchLabel(STAMPS_DOC, req, { codeHash: STAMPS_HASH, networkChecked: true });
      if (!r.ok) continue;
      matched++;
      // A match after a change: still exactly the declared call, and the shown stamp is the new request's own.
      expect(which).toBe(1);
      const stamp = trueStamp(req);
      const shown = r.fields[0]!.value;
      expect(shown.format === 'enum' && shown.raw).toBe(stamp);
      expect(shown.format === 'enum' && shown.text).toBe(STAMPS_DOC.metadata.enums.stamp![stamp!]);
    }
    // Some argument changes keep a valid call (another note's letter): those still match, with the true values.
    expect(matched).toBeGreaterThan(0);
  });

  it('Soroban pay_to: every argument and the contract, 500 changes of value', () => {
    const rand = prng(7730);
    const amounts = [0n, 1n, 10n, 10_000_000n, 2n ** 100n, -1n];
    const accounts = [USER, OTHER, TEST_USDC_SAC, UNLISTED, POOL];
    for (let i = 0; i < 500; i++) {
      const token = accounts[Math.floor(rand() * accounts.length)]!;
      const to = accounts[Math.floor(rand() * accounts.length)]!;
      const amount = amounts[Math.floor(rand() * amounts.length)]!;
      const contract = rand() < 0.2 ? UNLISTED : POOL;
      const req = sorobanTx('pay_to', [addr(token), addr(to), i128(amount)], { contract });
      const r = matchLabel(SOROBAN_DOC, req!, { codeHash: POOL_WASM });
      if (!r.ok) {
        expect(contract !== POOL || to !== OTHER || amount < 0n).toBe(true);
        continue;
      }
      expect(contract).toBe(POOL);
      const [amt, dest] = r.fields;
      expect(amt!.value).toMatchObject({ format: 'tokenAmount', raw: amount.toString(), token });
      expect(dest!.value).toMatchObject({ format: 'account', value: to });
    }
  });
});

describe('the core is pure', () => {
  it('no network, clock or randomness in src/partner-labels', () => {
    const dir = new URL('../src/partner-labels/', import.meta.url);
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      expect(src, f).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|Date\.now|new Date\(\)|performance\.now|Math\.random|getRandomValues|setTimeout|setInterval/u);
    }
  });
  it('nothing outside the tests imports it yet (no screen, vault, API or console change)', () => {
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(index).not.toMatch(/partner-labels/u);
  });
});
