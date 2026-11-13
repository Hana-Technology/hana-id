// The chain's answers are attacker-controlled (D753, D800): parsed strictly, bounded, notes neutralised; and the
// contract's rules and bytes as the site builds them.
import { describe, expect, it } from 'vitest';
import { decodeNearDelegateAction, decodeNearTransaction } from '@hana-id/core';
import { CONTRACT_ERRORS, NOTE_MAX_CHARS, RECENT_SHOWN, STAMP_IDS, checkNote, collectArgs, collectDelegate, collectTransaction, contractErrorCode, parsePassport, parseRecent, parseTotals, signatureMessage, u64 } from '../src/stamps.ts';
import { BLOCK_HASH } from './fakes.ts';
import { NEAR_ACCOUNT, OTHER_ACCOUNT, STAMPS } from './fixtures.ts';

const stamp = (s: string, at = 1_800_000_000_000, extra: Record<string, unknown> = {}) => ({ stamp: s, block_timestamp_ms: at, sponsored: true, ...extra });

describe('parsePassport', () => {
  it('reads the stamps in catalog order, each once', () => {
    const p = parsePassport({ account_id: NEAR_ACCOUNT, stamps: [stamp('postcard', 3, { note: 'hi' }), stamp('arrival', 1), stamp('arrival', 2), { ...stamp('own_fare', 4), sponsored: false }] }, NEAR_ACCOUNT);
    expect(p).toEqual({
      accountId: NEAR_ACCOUNT,
      stamps: [
        { stamp: 'arrival', atMs: 1, sponsored: true },
        { stamp: 'own_fare', atMs: 4, sponsored: false },
        { stamp: 'postcard', atMs: 3, sponsored: true, note: 'hi' },
      ],
    });
  });

  it('null for no passport, another account’s answer, or a malformed one', () => {
    expect(parsePassport(null, NEAR_ACCOUNT)).toBeNull();
    expect(parsePassport({ account_id: OTHER_ACCOUNT, stamps: [stamp('arrival')] }, NEAR_ACCOUNT)).toBeNull();
    for (const bad of ['x', 7, [], { account_id: NEAR_ACCOUNT }, { account_id: NEAR_ACCOUNT, stamps: 'arrival' }]) expect(parsePassport(bad, NEAR_ACCOUNT)).toBeNull();
  });

  it('drops entries with an unknown stamp, a bad time or a non-boolean sponsored, and accepts a U64 string time', () => {
    const p = parsePassport(
      {
        account_id: NEAR_ACCOUNT,
        stamps: [stamp('teleport'), stamp('arrival', -1), stamp('arrival', 1.5), { ...stamp('arrival'), sponsored: 'yes' }, stamp('arrival', '99999999999999999999' as unknown as number), stamp('sponsored', '1800000000123' as unknown as number), null, 'arrival', stamp('__proto__')],
      },
      NEAR_ACCOUNT,
    );
    expect(p!.stamps).toEqual([{ stamp: 'sponsored', atMs: 1_800_000_000_123, sponsored: true }]);
  });

  it('neutralises hostile notes: bidi overrides, zero-width and control characters, and cuts them to 140', () => {
    const hostile = 'safe \u202Eevil\u200B\u0000 <img src=x onerror=alert(1)> \u2066x\u2069';
    const p = parsePassport({ account_id: NEAR_ACCOUNT, stamps: [stamp('postcard', 1, { note: hostile })] }, NEAR_ACCOUNT)!;
    const note = p.stamps[0]!.note!;
    expect(note).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B\u0000]/u);
    expect(note).toContain('�');
    // Text, never markup: it is kept as typed, for a text node.
    expect(note).toContain('<img src=x onerror=alert(1)>');
    const long = parsePassport({ account_id: NEAR_ACCOUNT, stamps: [stamp('postcard', 1, { note: 'é'.repeat(400) })] }, NEAR_ACCOUNT)!;
    expect([...long.stamps[0]!.note!]).toHaveLength(NOTE_MAX_CHARS + 1); // 140 and the ellipsis
    // An oversized note (more than the contract could have stored) is dropped, the stamp kept.
    const huge = parsePassport({ account_id: NEAR_ACCOUNT, stamps: [stamp('postcard', 1, { note: 'x'.repeat(100_000) })] }, NEAR_ACCOUNT)!;
    expect(huge.stamps[0]).toEqual({ stamp: 'postcard', atMs: 1, sponsored: true });
    // Emoji sequences keep their joiners.
    expect(parsePassport({ account_id: NEAR_ACCOUNT, stamps: [stamp('postcard', 1, { note: 'hi 👩‍💻' })] }, NEAR_ACCOUNT)!.stamps[0]!.note).toBe('hi 👩‍💻');
  });

  it('reads at most a bounded number of entries', () => {
    const many = Array.from({ length: 10_000 }, () => stamp('teleport'));
    many.push(stamp('arrival'));
    expect(parsePassport({ account_id: NEAR_ACCOUNT, stamps: many }, NEAR_ACCOUNT)!.stamps).toEqual([]);
  });
});

describe('parseRecent', () => {
  it('newest first across pages, each (account, stamp) once, at most RECENT_SHOWN', () => {
    const page1 = Array.from({ length: 30 }, (_, i) => ({ account_id: NEAR_ACCOUNT, stamp: STAMP_IDS[i % 6], block_timestamp_ms: i }));
    const page2 = Array.from({ length: 30 }, (_, i) => ({ account_id: `acct${i}.testnet`, stamp: 'arrival', block_timestamp_ms: 1000 + i }));
    const r = parseRecent(page1, page2);
    expect(r).toHaveLength(RECENT_SHOWN);
    expect(r[0]).toEqual({ accountId: 'acct29.testnet', stamp: 'arrival', atMs: 1029 });
    expect(r.filter((x) => x.accountId === NEAR_ACCOUNT)).toHaveLength(0);
    const mine = parseRecent(page1);
    expect(mine).toHaveLength(6);
  });

  it('drops invalid accounts, stamps and times; survives non-arrays', () => {
    const r = parseRecent([{ account_id: 'Bad Account', stamp: 'arrival', block_timestamp_ms: 1 }, { account_id: NEAR_ACCOUNT, stamp: 'nope', block_timestamp_ms: 1 }, { account_id: NEAR_ACCOUNT, stamp: 'arrival', block_timestamp_ms: 'soon' }, { account_id: NEAR_ACCOUNT, stamp: 'arrival', block_timestamp_ms: 5 }], 'x', null, { 0: 1 });
    expect(r).toEqual([{ accountId: NEAR_ACCOUNT, stamp: 'arrival', atMs: 5 }]);
  });
});

describe('parseTotals and u64', () => {
  it('two counts or null', () => {
    expect(parseTotals({ passports: 3, stamps: '12' })).toEqual({ passports: 3, stamps: 12 });
    expect(parseTotals({ passports: -1, stamps: 1 })).toBeNull();
    expect(parseTotals([3, 12])).toBeNull();
    expect(u64('007')).toBeNull();
    expect(u64(2 ** 53)).toBeNull();
    expect(u64('0')).toBe(0);
  });
});

describe('the rules and bytes', () => {
  it('checkNote counts as the contract does (Rust trim, Unicode scalar values) and refuses a lone surrogate', () => {
    expect(checkNote('  hi  ')).toEqual({ ok: true, text: 'hi', chars: 2 });
    expect(checkNote('😀'.repeat(140))).toMatchObject({ ok: true, chars: 140 });
    expect(checkNote('😀'.repeat(141))).toMatchObject({ ok: false, reason: 'too_long' });
    // Rust's trim takes U+0085 (JavaScript's doesn't) and keeps U+FEFF (JavaScript's takes it).
    expect(checkNote('\u0085 ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(checkNote('\uFEFF')).toMatchObject({ ok: true, chars: 1 });
    expect(checkNote('a\uD800b')).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('collect’s arguments carry only the stamp’s own fields', () => {
    const proof = { message: 'm', nonce: 'n', recipient: STAMPS, signature: 's' };
    expect(collectArgs('arrival', { note: 'x', proof })).toEqual({ stamp: 'arrival' });
    expect(collectArgs('postcard', { note: 'x', proof })).toEqual({ stamp: 'postcard', note: 'x' });
    expect(collectArgs('signature', { note: 'x', proof })).toEqual({ stamp: 'signature', proof });
    expect(signatureMessage(NEAR_ACCOUNT)).toBe(`Stamp my passport: ${NEAR_ACCOUNT}`);
  });

  it('the delegate action and the transaction decode back to collect on the stamps contract, with no deposit', () => {
    const d = decodeNearDelegateAction(collectDelegate({ accountId: NEAR_ACCOUNT, contract: STAMPS, args: { stamp: 'arrival' }, tgas: 10, nonce: 7n, blockHeight: 100n }));
    expect(d).toMatchObject({ senderId: NEAR_ACCOUNT, receiverId: STAMPS, nonce: 7n, maxBlockHeight: 700n });
    const t = decodeNearTransaction(collectTransaction({ accountId: NEAR_ACCOUNT, contract: STAMPS, args: { stamp: 'own_fare' }, tgas: 10, nonce: 8n, blockHash: BLOCK_HASH }));
    expect(t).toMatchObject({ signerId: NEAR_ACCOUNT, receiverId: STAMPS, nonce: 8n });
    expect(t.actions[0]).toMatchObject({ type: 'functionCall', methodName: 'collect', deposit: 0n, gas: 10_000_000_000_000n });
  });

  it('every ERR_* of the spec has plain words; anything else is not echoed', () => {
    for (const code of ['ERR_NO_ARRIVAL', 'ERR_ALREADY', 'ERR_NOT_SPONSORED', 'ERR_NOT_OWN_FARE', 'ERR_BAD_PROOF', 'ERR_NOT_IMPLICIT', 'ERR_BAD_NOTE', 'ERR_TOO_SOON', 'ERR_UNKNOWN_STAMP']) {
      expect(contractErrorCode(`Smart contract panicked: ${code}`)).toBe(code);
      expect(CONTRACT_ERRORS[code]).toMatch(/\.$/u);
    }
    expect(contractErrorCode('Smart contract panicked: ERR_WHATEVER <b>')).toBeNull();
    expect(contractErrorCode('nothing')).toBeNull();
  });
});
