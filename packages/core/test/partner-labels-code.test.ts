// D900 (piece 5 of D892): which code a request runs, for a label. A Soroban transaction's code is its footprint's one
// ContractCode entry (the network refuses to run other code), never a fact from outside; an authorization entry has no
// footprint, so nothing ties it to code. And the soft-verb rule at match time: a verb that says no value moves matches
// only a request that moves none Journear can see (NEAR: no deposit; Soroban: a footprint that writes nothing but the
// labelled contract's own data); otherwise `value_may_move`, a described mismatch (the window's amber line).
import { type xdr } from '@stellar/stellar-base';
import { describe, expect, it } from 'vitest';
import { decodeApprovalRequest } from '../src/decode/request.ts';
import type { StellarTransaction } from '../src/decode/stellar.ts';
import { sorobanFootprintCode, sorobanWritesOnlyOwn } from '../src/partner-labels/code.ts';
import { type LabelMatchResult, type LabelRequest, labelRequestOf, matchLabel, noMatchKind } from '../src/partner-labels/match.ts';
import { type LabelDocument } from '../src/partner-labels/schema.ts';
import { SOFT_VERBS } from '../src/partner-labels/words.ts';
import { ME, POOL_WASM, STAMPS, STAMPS_DOC_JSON, STAMPS_HASH, TEST_USDC_SAC, fn, nearDecoded, parsed } from './partner-labels-fixtures.ts';
import { OTHER, PASSPHRASE, POOL, USER, accountKey, addr, authPreimageBytes, callFootprint, codeKeyOf, contractDataKey, dataKeyOf, i128, invocation, invokeOp, sorobanData, sourceAuth, txBytes } from './stellar-fixtures.ts';

const OTHER_WASM = 'cd'.repeat(32);

const decodeTx = (bytes: Uint8Array) => decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes });
const txOf = (soroban?: xdr.SorobanTransactionData, fnName = 'vote', args: xdr.ScVal[] = [addr(USER)]): StellarTransaction => {
  const d = decodeTx(txBytes([invokeOp(POOL, fnName, args, [sourceAuth(invocation(POOL, fnName, args))])], soroban ? { soroban } : {}));
  if (d.kind !== 'stellar_tx') throw new Error('not a transaction');
  return d.envelope.tx;
};
const reqOf = (soroban?: xdr.SorobanTransactionData, fnName = 'vote', args: xdr.ScVal[] = [addr(USER)]): LabelRequest => labelRequestOf(decodeTx(txBytes([invokeOp(POOL, fnName, args, [sourceAuth(invocation(POOL, fnName, args))])], soroban ? { soroban } : {})), USER)!;
const reason = (r: LabelMatchResult): string => (r.ok ? 'match' : r.reason);

/** A Soroban document with a soft verb (vote) and a value verb (deposit) on the same contract. */
const SOROBAN_SOFT: LabelDocument = parsed({
  schema: 'journear-labels/1',
  context: { soroban: { networkPassphrase: PASSPHRASE, contract: POOL, wasmHash: POOL_WASM } },
  display: {
    formats: {
      vote: { call: { args: [{ name: 'voter', type: 'address', isSelf: true }] }, intent: { verb: 'vote', object: 'in the club poll' }, sentence: ['verb', 'object'], fields: [{ path: 'args.voter', label: 'Member', format: 'account' }] },
      deposit: {
        call: { args: [{ name: 'from', type: 'address', isSelf: true }, { name: 'amount', type: 'i128' }] },
        intent: { verb: 'deposit' },
        sentence: ['verb', { field: 'args.amount' }],
        fields: [
          { path: 'args.amount', label: 'Club share', format: 'tokenAmount', params: { token: TEST_USDC_SAC } },
          { path: 'args.from', label: 'Member', format: 'account' },
        ],
      },
    },
  },
});

describe('sorobanFootprintCode: the one code a transaction can run', () => {
  it('exactly one ContractCode, read or written: that hash', () => {
    expect(sorobanFootprintCode(txOf(callFootprint(POOL, POOL_WASM)))).toBe(POOL_WASM);
    expect(sorobanFootprintCode(txOf(sorobanData([], [codeKeyOf(POOL_WASM)])))).toBe(POOL_WASM);
    // The same hash declared twice (read and written) is still one code.
    expect(sorobanFootprintCode(txOf(sorobanData([codeKeyOf(POOL_WASM)], [codeKeyOf(POOL_WASM)])))).toBe(POOL_WASM);
  });

  it('none, several, or no footprint at all: null', () => {
    expect(sorobanFootprintCode(txOf())).toBeNull();
    expect(sorobanFootprintCode(txOf(callFootprint(POOL, null)))).toBeNull();
    expect(sorobanFootprintCode(txOf(callFootprint(POOL, [POOL_WASM, OTHER_WASM])))).toBeNull();
  });
});

describe('sorobanWritesOnlyOwn: what the transaction may change', () => {
  it('only the contract’s own data: true', () => {
    expect(sorobanWritesOnlyOwn(txOf(callFootprint(POOL, POOL_WASM)), POOL)).toBe(true);
    expect(sorobanWritesOnlyOwn(txOf(sorobanData([codeKeyOf(POOL_WASM)], [])), POOL)).toBe(true);
  });

  it('an account, another contract’s data (a token balance), a code entry, or no footprint: false', () => {
    for (const w of [accountKey(USER), accountKey(OTHER), dataKeyOf(TEST_USDC_SAC, 'balance'), contractDataKey(TEST_USDC_SAC), codeKeyOf(OTHER_WASM)]) {
      expect(sorobanWritesOnlyOwn(txOf(callFootprint(POOL, POOL_WASM, [w])), POOL)).toBe(false);
    }
    expect(sorobanWritesOnlyOwn(txOf(), POOL)).toBe(false);
    expect(sorobanWritesOnlyOwn(txOf(callFootprint(POOL, POOL_WASM)), TEST_USDC_SAC)).toBe(false);
  });
});

describe('the Soroban code hash in the matcher', () => {
  it('a transaction’s code is its footprint’s; a caller’s fact is never used for one', () => {
    expect(reason(matchLabel(SOROBAN_SOFT, reqOf(callFootprint(POOL, POOL_WASM)), {}))).toBe('match');
    expect(reason(matchLabel(SOROBAN_SOFT, reqOf(callFootprint(POOL, POOL_WASM)), { codeHash: OTHER_WASM }))).toBe('match');
    expect(reason(matchLabel(SOROBAN_SOFT, reqOf(callFootprint(POOL, OTHER_WASM)), { codeHash: POOL_WASM }))).toBe('code_hash_mismatch');
    expect(reason(matchLabel(SOROBAN_SOFT, reqOf(undefined), { codeHash: POOL_WASM }))).toBe('no_code_hash');
    expect(reason(matchLabel(SOROBAN_SOFT, reqOf(callFootprint(POOL, [POOL_WASM, OTHER_WASM])), { codeHash: POOL_WASM }))).toBe('no_code_hash');
  });

  it('a changed code is a described mismatch (the amber line); no code is couldn’t check (the plain window)', () => {
    expect(noMatchKind('code_hash_mismatch')).toBe('described_mismatch');
    expect(noMatchKind('no_code_hash')).toBe('couldnt_check');
    expect(noMatchKind('value_may_move')).toBe('described_mismatch');
  });

  it('an authorization entry: only a caller’s fact could tie it (the window has none): no code hash', () => {
    const auth = labelRequestOf(decodeApprovalRequest({ kind: 'stellar_auth_entry', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: authPreimageBytes(invocation(POOL, 'vote', [addr(USER)])) }), USER)!;
    expect(reason(matchLabel(SOROBAN_SOFT, auth, {}))).toBe('no_code_hash');
  });
});

describe('soft verbs at match time', () => {
  it('the verb list: vote and collect are soft, deposit isn’t', () => {
    expect(SOFT_VERBS.has('vote')).toBe(true);
    expect(SOFT_VERBS.has('collect')).toBe(true);
    expect(SOFT_VERBS.has('deposit')).toBe(false);
  });

  it('Soroban: a soft verb only over a transaction that changes nothing but the contract’s own data', () => {
    expect(reason(matchLabel(SOROBAN_SOFT, reqOf(callFootprint(POOL, POOL_WASM)), {}))).toBe('match');
    for (const w of [accountKey(USER), dataKeyOf(TEST_USDC_SAC, 'balance'), contractDataKey(TEST_USDC_SAC)]) {
      const r = matchLabel(SOROBAN_SOFT, reqOf(callFootprint(POOL, POOL_WASM, [w])), {});
      expect(r).toEqual({ ok: false, reason: 'value_may_move', at: 'footprint' });
    }
  });

  it('Soroban: a value verb matches whatever the footprint may write (the amount is shown, and Journear’s lines stay)', () => {
    const args = [addr(USER), i128(25_000_000n)];
    expect(reason(matchLabel(SOROBAN_SOFT, reqOf(callFootprint(POOL, POOL_WASM, [dataKeyOf(TEST_USDC_SAC, 'balance')]), 'deposit', args), {}))).toBe('match');
  });

  it('Soroban: a soft verb over an authorization entry is never a match, even with a caller’s fact (no footprint)', () => {
    const auth = labelRequestOf(decodeApprovalRequest({ kind: 'stellar_auth_entry', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: authPreimageBytes(invocation(POOL, 'vote', [addr(USER)])) }), USER)!;
    expect(matchLabel(SOROBAN_SOFT, auth, { codeHash: POOL_WASM })).toEqual({ ok: false, reason: 'value_may_move', at: 'footprint' });
  });

  it('NEAR: a soft verb never matches a request that attaches NEAR, even if a document allowed one', () => {
    const doc = parsed(STAMPS_DOC_JSON);
    const facts = { codeHash: STAMPS_HASH, networkChecked: true };
    const req = (deposit: bigint) => labelRequestOf(nearDecoded([fn('collect', '{"stamp":"sponsored"}', { deposit })]), ME)!;
    expect(reason(matchLabel(doc, req(0n), facts))).toBe('match');
    // The parser refuses a soft verb with a deposit allowed; a document built around it (a D1 write, say) still can't.
    const format = doc.formats.collect!;
    if (format.chain !== 'near') throw new Error('fixture');
    const lax: LabelDocument = { ...doc, formats: { collect: { ...format, call: { ...format.call, deposit: { atMost: '1000' } } } } };
    expect(matchLabel(lax, req(1n), facts)).toEqual({ ok: false, reason: 'value_may_move', at: 'deposit' });
    expect(reason(matchLabel(lax, req(0n), facts))).toBe('match');
    expect(STAMPS).toBe((doc.context as { account: string }).account);
  });
});
