// Nonce and session-message bytes against the vectors hana-signer's Rust tests use
// (contracts/hana-signer/src/test_fixture.json, written by scripts/gen-fixtures.mjs).
import { describe, expect, it } from 'vitest';
import fixture from '../../../contracts/hana-signer/src/test_fixture.json' with { type: 'json' };
import { base64UrlDecode, fromHex, toHex, utf8 } from '../src/bytes.ts';
import { readClaims } from '../src/google.ts';
import { ckdPayload, revokePayload, sessionMessage, sessionNonce, sessionNoncePreimage } from '../src/layouts.ts';

const L = fixture.layouts;
const NOW_MS = 1_800_000_000_000;
const EXPIRES_MS = NOW_MS + 3_600_000;
const EXPIRES_LATE_MS = NOW_MS + 2 * 3_600_000;
const SALT = new Uint8Array(16).fill(9);
const PK7 = fromHex(fixture.session_pk7_hex);
const PK8 = fromHex(fixture.session_pk8_hex);
const base = { signer: fixture.signer, scopeId: 's1', sessionPublicKey: PK7, expiresAtMs: EXPIRES_MS, keyIndex: 0, maxUses: 3, salt: SALT };

describe('session nonce (create_session)', () => {
  it('matches the layouts.session_nonce worked example field by field', async () => {
    const preimage = sessionNoncePreimage(base);
    expect(toHex(preimage)).toBe(L.session_nonce.preimage_hex);
    expect(toHex(preimage)).toBe(L.session_nonce.parts.map(([, hex]) => hex).join(''));
    expect(await sessionNonce(base)).toBe(L.session_nonce.nonce);
    expect(L.session_nonce.nonce).toHaveLength(43);
  });

  it.each([
    ['session_s1_pk7_k0', {}],
    ['session_s1_pk8_k0', { sessionPublicKey: PK8 }],
    ['session_s2_pk8_k0', { scopeId: 's2', sessionPublicKey: PK8 }],
    ['session_s1_pk8_k1', { sessionPublicKey: PK8, keyIndex: 1 }],
    ['session_s1_pk7_late_k0', { expiresAtMs: EXPIRES_LATE_MS }],
    ['session_s1_pk7_other_signer', { signer: fixture.other_signer }],
    ['session_s3_pk7_k0', { scopeId: 's3' }],
    ['session_s4_pk8_k0', { scopeId: 's4', sessionPublicKey: PK8 }],
    ['session_s1_pk8_late_k0', { sessionPublicKey: PK8, expiresAtMs: EXPIRES_LATE_MS }],
  ] as const)('matches nonces.%s', async (name, change) => {
    expect(await sessionNonce({ ...base, ...change })).toBe(fixture.nonces[name]);
  });

  it('is the nonce carried by the fixture tokens (own and shared client)', async () => {
    expect(readClaims(fixture.tokens.session_a_k1).nonce).toBe(await sessionNonce({ ...base, sessionPublicKey: PK8, keyIndex: 1 }));
    expect(readClaims(fixture.tokens.shared_s3).nonce).toBe(await sessionNonce({ ...base, scopeId: 's3' }));
  });

  it('commits to max_uses and the salt', async () => {
    const n = await sessionNonce(base);
    expect(await sessionNonce({ ...base, maxUses: 4 })).not.toBe(n);
    expect(await sessionNonce({ ...base, salt: new Uint8Array(32).fill(9) })).not.toBe(n);
  });

  it('rejects a malformed key, salt or integer', () => {
    expect(() => sessionNoncePreimage({ ...base, sessionPublicKey: new Uint8Array(31) })).toThrow(/32 bytes/);
    expect(() => sessionNoncePreimage({ ...base, salt: new Uint8Array(15) })).toThrow(/Salt/);
    expect(() => sessionNoncePreimage({ ...base, salt: new Uint8Array(65) })).toThrow(/Salt/);
    expect(() => sessionNoncePreimage({ ...base, keyIndex: 2 ** 32 })).toThrow(/u32/);
    expect(() => sessionNoncePreimage({ ...base, expiresAtMs: -1 })).toThrow(/u64/);
  });
});

describe('session message (derive_key, revoke_session)', () => {
  it('builds the CKD payload exactly as layouts.ckd_payload', () => {
    expect(toHex(ckdPayload(L.ckd_payload.pk1, L.ckd_payload.pk2))).toBe(L.ckd_payload.preimage_hex);
  });

  it('matches layouts.session_message_ckd (counter 1, payload = the CKD payload)', async () => {
    const msg = await sessionMessage(1, ckdPayload(L.ckd_payload.pk1, L.ckd_payload.pk2));
    expect(toHex(msg)).toBe(L.session_message_ckd.preimage_hex);
    expect(toHex(msg)).toBe(L.session_message_ckd.parts.map(([, hex]) => hex).join(''));
  });

  it('matches layouts.session_message_revoke (counter 2, payload "revoke")', async () => {
    expect(toHex(await sessionMessage(2, revokePayload()))).toBe(L.session_message_revoke.preimage_hex);
  });

  it('encodes the counter as u64 LE', async () => {
    const msg = await sessionMessage(258, utf8('revoke'));
    const domain = utf8('hana-id-session-v1:');
    expect([...msg.slice(0, domain.length)]).toEqual([...domain]);
    expect([...msg.slice(domain.length, domain.length + 8)]).toEqual([2, 1, 0, 0, 0, 0, 0, 0]);
    expect(msg).toHaveLength(domain.length + 8 + 32);
  });

  it('decodes base64url claims without padding', () => {
    expect(toHex(base64UrlDecode('AQID'))).toBe('010203');
    expect(toHex(base64UrlDecode('_-8'))).toBe('ffef');
  });
});
