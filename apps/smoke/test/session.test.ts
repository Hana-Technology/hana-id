import { describe, expect, it } from 'vitest';
import fixture from '../../../contracts/hana-signer/src/test_fixture.json' with { type: 'json' };
import { checkSessionParams, ckdPayload, concatBytes, createProofPayload, fromHex, jsonBytes, revokePayload, sessionMessage, sessionNonce, toHex } from '@hana-id/core';
import { SESSION_LIFETIME_MS, newPendingSession, signCreateProof, signDerive, signRevoke } from '../src/session.ts';

const params = { signer: 'hana-id-signer-dev1.testnet', scopeId: 's1', keyIndex: 0, maxUses: 5 };

/** The fixture's session key: Ed25519 from the 32-byte seed [7; 32] (PKCS#8 wrapping, as gen-fixtures.mjs does). */
async function seed7Key(): Promise<CryptoKey> {
  const pkcs8 = concatBytes(fromHex('302e020100300506032b657004220420'), new Uint8Array(32).fill(7));
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

async function verify(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(publicKey), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'Ed25519' }, key, Uint8Array.from(signature), message);
}

describe('session key', () => {
  it('is a non-extractable Ed25519 key with a 32-byte salt, 1 h expiry and the A.2 nonce', async () => {
    const now = 1_800_000_000_000;
    const s = await newPendingSession(params, now);
    expect(s.privateKey.extractable).toBe(false);
    expect(s.privateKey.algorithm.name).toBe('Ed25519');
    await expect(crypto.subtle.exportKey('pkcs8', s.privateKey)).rejects.toThrow();
    expect(s.publicKey).toHaveLength(32);
    expect(s.salt).toHaveLength(32);
    expect(s.expiresAtMs).toBe(now + SESSION_LIFETIME_MS);
    expect(s.nonce).toBe(sessionNonce({ ...params, sessionPublicKey: s.publicKey, expiresAtMs: s.expiresAtMs, salt: s.salt }));
    const other = await newPendingSession(params, now);
    expect(toHex(other.salt)).not.toBe(toHex(s.salt));
    expect(other.nonce).not.toBe(s.nonce);
  });

  it('signs derive and revoke messages that verify against the session public key', async () => {
    const s = await newPendingSession(params);
    const sig = await signDerive(s.privateKey, 3, 'bls12381g1:A', 'bls12381g2:B');
    expect(sig).toHaveLength(64);
    expect(await verify(s.publicKey, sig, sessionMessage(3, ckdPayload('bls12381g1:A', 'bls12381g2:B')))).toBe(true);
    expect(await verify(s.publicKey, sig, sessionMessage(4, ckdPayload('bls12381g1:A', 'bls12381g2:B')))).toBe(false);
    const rev = await signRevoke(s.privateKey, 4);
    expect(await verify(s.publicKey, rev, sessionMessage(4, revokePayload()))).toBe(true);
  });

  it("signs create_session's proof of possession over the pending session's own parameters (D137)", async () => {
    const s = await newPendingSession(params);
    const sig = await signCreateProof(s);
    const session = { ...params, sessionPublicKey: s.publicKey, expiresAtMs: s.expiresAtMs, salt: s.salt };
    expect(await verify(s.publicKey, sig, sessionMessage(0, createProofPayload(session)))).toBe(true);
    expect(await verify(s.publicKey, sig, sessionMessage(0, createProofPayload({ ...session, maxUses: 6 })))).toBe(false);
  });

  it('signs the fixture session message with the fixture key (seed [7; 32])', async () => {
    const key = await seed7Key();
    const sig = await signDerive(key, 1, fixture.layouts.ckd_payload.pk1, fixture.layouts.ckd_payload.pk2);
    expect(await verify(fromHex(fixture.session_pk7_hex), sig, fromHex(fixture.layouts.session_message_ckd.preimage_hex))).toBe(true);
  });

  it('checks key_index (≥ 2^31 reserved) and max_uses ranges', async () => {
    expect(() => checkSessionParams({ keyIndex: 0, maxUses: 1 })).not.toThrow();
    expect(() => checkSessionParams({ keyIndex: 0x7fffffff, maxUses: 500 })).not.toThrow();
    expect(() => checkSessionParams({ keyIndex: 0x80000000, maxUses: 5 })).toThrow(/reserved/);
    await expect(newPendingSession({ ...params, keyIndex: 0x80000000 })).rejects.toThrow(/reserved/);
    expect(() => checkSessionParams({ keyIndex: -1, maxUses: 5 })).toThrow(/key_index/);
    expect(() => checkSessionParams({ keyIndex: 1.5, maxUses: 5 })).toThrow(/key_index/);
    expect(() => checkSessionParams({ keyIndex: 2 ** 32, maxUses: 5 })).toThrow(/key_index/);
    expect(() => checkSessionParams({ keyIndex: 0, maxUses: 0 })).toThrow(/max_uses/);
    expect(() => checkSessionParams({ keyIndex: 0, maxUses: 501 })).toThrow(/max_uses/);
    expect(() => checkSessionParams({ keyIndex: Number.NaN, maxUses: 5 })).toThrow(/key_index/);
  });

  it('sends byte arrays as JSON number arrays', () => {
    expect(jsonBytes(Uint8Array.from([0, 255]))).toEqual([0, 255]);
  });
});
