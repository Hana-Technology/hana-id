// D896, after PR 123's review: what the matcher decides first (whether the request is what a document speaks about),
// the red line for every classic operation that moves the user's value to an account the app hasn't listed, fee bumps,
// muxed accounts, the request's own text shown as an id, and the parser's tightened rows and row labels.
import { Account, Asset, Claimant, Keypair, Memo, MuxedAccount, Operation, TransactionBuilder, xdr } from '@stellar/stellar-base';
import { describe, expect, it } from 'vitest';
import { decodeApprovalRequest } from '../src/decode/request.ts';
import { type LabelMatchResult, type LabelRequest, labelRequestOf, matchLabel, noMatchKind } from '../src/partner-labels/match.ts';
import { LABEL_LIMITS, parseLabelDocument } from '../src/partner-labels/schema.ts';
import { idValueProblem } from '../src/partner-labels/text-rules.ts';
import { ISSUER, OTHER, PASSPHRASE, PAYMENT_DOC_JSON, POOL, POOL_WASM, SOROBAN_DOC_JSON, USER, parsed, paymentTx } from './partner-labels-fixtures.ts';
import { ROUTER, addr, authPreimageBytes, feeBumpBytes, i128, invocation, invokeOp, sourceAuth, txBytes } from './stellar-fixtures.ts';

const PAYMENT = parsed(PAYMENT_DOC_JSON);
const SOROBAN = parsed(SOROBAN_DOC_JSON);
const STRANGER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 41)).publicKey();

const stellarReq = (bytes: Uint8Array): LabelRequest => labelRequestOf(decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes }), USER)!;
const reason = (r: LabelMatchResult) => (r.ok ? 'match' : r.reason);
const kind = (r: LabelMatchResult) => (r.ok ? 'match' : noMatchKind(r.reason));
const ops = (list: xdr.Operation[], o: Parameters<typeof txBytes>[1] = {}) => stellarReq(txBytes(list, o));

describe('item 2: every classic operation that moves the user’s value to an account the app hasn’t listed is the red line', () => {
  const pay = (to: string) => Operation.payment({ destination: to, asset: Asset.native(), amount: '1' });
  const cases: [string, xdr.Operation][] = [
    ['a payment', pay(STRANGER)],
    ['a strict-send path payment', Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: '1', destination: STRANGER, destAsset: new Asset('USDC', ISSUER), destMin: '1', path: [] })],
    ['a strict-receive path payment', Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: '1', destination: STRANGER, destAsset: new Asset('USDC', ISSUER), destAmount: '1', path: [] })],
    ['an account creation', Operation.createAccount({ destination: STRANGER, startingBalance: '5' })],
    ['a merge of the user’s account', Operation.accountMerge({ destination: STRANGER })],
    ['a claimable balance one claimant of which is unlisted', Operation.createClaimableBalance({ asset: Asset.native(), amount: '1', claimants: [new Claimant(OTHER), new Claimant(STRANGER)] })],
  ];
  it.each(cases)('%s, alone', (_, op) => {
    expect(reason(matchLabel(PAYMENT, ops([op]), {}))).toBe('not_in_address_book');
  });
  it.each(cases)('%s, after a harmless operation and a payment to the listed till', (_, op) => {
    expect(reason(matchLabel(PAYMENT, ops([Operation.bumpSequence({ bumpTo: '99' }), pay(OTHER), op]), {}))).toBe('not_in_address_book');
  });
  it('the same operations to the listed till, or back to the user’s own account, are not red', () => {
    expect(reason(matchLabel(PAYMENT, ops([Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: '1', destination: OTHER, destAsset: new Asset('USDC', ISSUER), destMin: '1', path: [] })]), {}))).toBe('operation_mismatch');
    expect(kind(matchLabel(PAYMENT, ops([Operation.createAccount({ destination: OTHER, startingBalance: '5' })]), {}))).toBe('described_mismatch');
    expect(reason(matchLabel(PAYMENT, ops([pay(OTHER), pay(OTHER)]), {}))).toBe('more_than_one_action');
    // A swap back to the user's own account moves nothing to anyone else: not described (the plain window).
    expect(reason(matchLabel(PAYMENT, ops([Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: '1', destination: USER, destAsset: new Asset('USDC', ISSUER), destMin: '1', path: [] })]), {}))).toBe('wrong_operation');
  });
  it('value moved from another account than the user’s is not the user’s: not described', () => {
    expect(reason(matchLabel(PAYMENT, ops([Operation.payment({ destination: STRANGER, asset: Asset.native(), amount: '1', source: OTHER })]), {}))).toBe('wrong_operation');
  });
});

describe('item 3: what the request is comes first; a request the document doesn’t speak about is not described', () => {
  it('a classic transaction of two operations, neither moving value to another account, with a payment document', () => {
    expect(kind(matchLabel(PAYMENT, ops([Operation.bumpSequence({ bumpTo: '99' }), Operation.changeTrust({ asset: new Asset('USDC', ISSUER) })]), {}))).toBe('not_described');
  });
  it('the same with only a Soroban document', () => {
    expect(kind(matchLabel(SOROBAN, ops([Operation.bumpSequence({ bumpTo: '99' }), Operation.changeTrust({ asset: new Asset('USDC', ISSUER) })]), { codeHash: POOL_WASM }))).toBe('not_described');
  });
  it('a router swap on another contract whose nested authorization reaches the described one', () => {
    const args = [addr(USER), i128(5n)];
    const nested = sourceAuth(invocation(ROUTER, 'swap', args, [invocation(POOL, 'deposit', args)]));
    const req = stellarReq(txBytes([invokeOp(ROUTER, 'swap', args, [nested])]));
    expect(kind(matchLabel(SOROBAN, req, { codeHash: POOL_WASM }))).toBe('not_described');
    const auth = labelRequestOf(decodeApprovalRequest({ kind: 'stellar_auth_entry', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: authPreimageBytes(invocation(ROUTER, 'swap', args, [invocation(POOL, 'deposit', args)])) }), USER)!;
    expect(kind(matchLabel(SOROBAN, auth, { codeHash: POOL_WASM }))).toBe('not_described');
  });
  it('a Soroban call to the described contract with no code hash is couldn’t-check whatever its shape (nothing until piece 5)', () => {
    const args = [addr(USER), i128(5n)];
    for (const req of [ops([invokeOp(POOL, 'deposit', args, [sourceAuth(invocation(POOL, 'deposit', args))]), Operation.bumpSequence({ bumpTo: '9' })]), ops([invokeOp(POOL, 'deposit', args, [sourceAuth(invocation(POOL, 'deposit', args, [invocation(ROUTER, 'x', [])]))])]), ops([invokeOp(POOL, 'withdraw', args)])]) {
      expect(kind(matchLabel(SOROBAN, req, {}))).toBe('couldnt_check');
    }
  });
});

describe('item 5: a fee bump is not described yet (its fee is another envelope’s)', () => {
  it('the plain window for a fee-bumped payment that would otherwise match, and for one to an unlisted account', () => {
    for (const to of [OTHER, STRANGER]) {
      const req = stellarReq(feeBumpBytes(paymentTx({ destination: to })));
      expect(req.kind === 'stellar_tx' && req.feeBump).toBe(true);
      const r = matchLabel(PAYMENT, req, {});
      expect(reason(r)).toBe('fee_bump');
      expect(kind(r)).toBe('not_described');
    }
    expect(reason(matchLabel(SOROBAN, stellarReq(feeBumpBytes(txBytes([invokeOp(POOL, 'deposit', [addr(USER), i128(5n)])]))), { codeHash: POOL_WASM }))).toBe('fee_bump');
  });
});

describe('item 6: muxed accounts are their base accounts', () => {
  const muxedOf = (g: string, id = '7') => new MuxedAccount(new Account(g, '0'), id).accountId();
  it('a payment to the M… form of the listed till matches (the book names its base account)', () => {
    const r = matchLabel(PAYMENT, stellarReq(paymentTx({ destination: muxedOf(OTHER) })), {});
    expect(reason(r)).toBe('match');
    if (r.ok) expect(r.destination?.text).toBe('Coffee Club till');
  });
  it('a payment to the M… form of an unlisted account is still red', () => {
    expect(reason(matchLabel(PAYMENT, stellarReq(paymentTx({ destination: muxedOf(STRANGER) })), {}))).toBe('not_in_address_book');
  });
  it('the user’s own account as an M… source is the user', () => {
    const b = new TransactionBuilder(new MuxedAccount(new Account(USER, '41'), '3'), { fee: '100', networkPassphrase: PASSPHRASE })
      .addOperation(Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '25' }))
      .addMemo(Memo.text('1042'))
      .setTimebounds(10, 2000)
      .build();
    expect(reason(matchLabel(PAYMENT, stellarReq(new Uint8Array(b.toEnvelope().toXDR())), {}))).toBe('match');
  });
});

describe('item 4: the request’s own text as an id, and the parser’s rows', () => {
  it('an order number that reads as an amount, a claim, a token or Journear’s words is not shown (the amber line)', () => {
    for (const v of ['1XLM', '25USDC', 'USDC-25', 'Free', 'free-coffee', 'Journear-verified', 'J0URNEAR', 'Passport-7', 'Verified', 'refund-42', 'NEAR-1', 'approve-me', 'Safe1', 'Official']) {
      expect(idValueProblem(v), v).toBe(true);
      const r = matchLabel(PAYMENT, stellarReq(paymentTx({ memo: Memo.text(v) })), {});
      expect(reason(r), v).toBe('value_not_displayable');
    }
    for (const v of ['1042', 'A-77_x', 'ORD-2026-1042', 'A1B2C3D4E5F6G7H8J9K0L1M2N3P4', 'table-12', 'B7']) expect(idValueProblem(v), v).toBe(false);
  });
  it('at most three rows besides the sentence’s values', () => {
    expect(LABEL_LIMITS.rows).toBe(3);
    const doc = (n: number) =>
      JSON.stringify({
        ...SOROBAN_DOC_JSON,
        display: {
          formats: {
            note: {
              call: { args: Array.from({ length: n }, (_, i) => ({ name: `a${i}`, type: 'u32' })) },
              intent: { verb: 'vote', object: 'the poll' },
              sentence: ['verb', 'object'],
              fields: Array.from({ length: n }, (_, i) => ({ path: `args.a${i}`, label: `Choice ${String.fromCharCode(65 + i)}`, format: 'count', params: { min: 0, max: 9 } })),
            },
          },
        },
      });
    expect(parseLabelDocument(doc(3)).ok).toBe(true);
    const r = parseLabelDocument(doc(4));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => [e.code, e.path])).toContainEqual(['too_many', 'display.formats.note.fields']);
  });
  it('a row labelled with Journear’s row names is refused', () => {
    const t = JSON.stringify(PAYMENT_DOC_JSON).replace('"label":"Order"', '"label":"Total"');
    const r = parseLabelDocument(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatchObject({ code: 'text_row_word', path: 'display.formats.payment.fields[0].label' });
  });
});
