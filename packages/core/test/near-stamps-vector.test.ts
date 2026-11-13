// The cross-language NEP-413 vector of the Journear Passport stamps contract (D795): signatures made by this package's
// own NEP-413 signer (`encodeNep413Message` + `signNep413Message`, exactly what the vault signs for
// `hana.near.signMessage`), written to contracts/hana-stamps/tests/nep413-vector.json, which the contract's Rust unit
// tests read and must accept or refuse (`src/tests.rs`, "signature"). This test pins the file: it fails when this
// package's signer would sign other bytes than the ones the contract verifies.
//
// The keys are throwaway TEST keys, derived here from public labels (sha256 of a sentence that says so); they are not
// in the file, hold nothing and are never funded. Ed25519 is deterministic, so the file never changes unless the
// signer does. To rewrite it after a deliberate change: HANA_WRITE_STAMPS_VECTOR=1 corepack pnpm --filter
// @hana-id/core exec vitest run test/near-stamps-vector.test.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519';
import { describe, expect, it } from 'vitest';
import { base64Encode, sha256, utf8 } from '../src/bytes.ts';
import { decodeNep413Message, encodeNep413Message, nep413Hash, NEP413_TAG } from '../src/near/codec.ts';
import { signNep413Message } from '../src/near/sign.ts';

const VECTOR_FILE = new URL('../../../contracts/hana-stamps/tests/nep413-vector.json', import.meta.url);

/** The stamps contract's account in the vector (the Rust tests run the contract as this account). */
const CONTRACT = 'stamps.testnet';
/** The stamp's message: the contract's `SIGN_MESSAGE_PREFIX` and the caller's account id. */
const message = (accountId: string) => `Stamp my passport: ${accountId}`;
/** TEST keys: never real, never funded. */
const seedA = sha256(utf8('hana-stamps NEP-413 test vector, key A: a throwaway TEST key, never funded'));
const seedB = sha256(utf8('hana-stamps NEP-413 test vector, key B: a throwaway TEST key, never funded'));
const NONCE = Uint8Array.from({ length: 32 }, (_, i) => i);

interface Proof {
  message: string;
  nonce: string;
  recipient: string;
  signature: string;
}

function sign(seed: Uint8Array, p: { message: string; recipient: string; callbackUrl?: string }): { accountId: string; proof: Proof } {
  const bytes = encodeNep413Message({ message: p.message, nonce: NONCE, recipient: p.recipient, callbackUrl: p.callbackUrl ?? null });
  const signed = signNep413Message(seed, bytes);
  return { accountId: signed.accountId, proof: { message: p.message, nonce: base64Encode(NONCE), recipient: p.recipient, signature: signed.signature } };
}

function vector() {
  const a = sign(seedA, { message: message(implicit(seedA)), recipient: CONTRACT });
  const b = sign(seedB, { message: message(implicit(seedB)), recipient: CONTRACT });
  return {
    about:
      "Cross-language test vector (D795): NEP-413 signatures made by @hana-id/core's signer (packages/core/test/near-stamps-vector.test.ts writes and pins this file) that the hana-stamps contract's unit tests must accept or refuse. Throwaway TEST keys, derived from public labels, never funded.",
    contract: CONTRACT,
    nep413Tag: NEP413_TAG,
    a: { account_id: a.accountId, proof: a.proof },
    b: { account_id: b.accountId, proof: b.proof },
    /** A's message, signed by B's key: the contract must refuse it from A (another account's key). */
    a_message_signed_by_b: sign(seedB, { message: message(a.accountId), recipient: CONTRACT }).proof,
    /** A's message for another recipient: refused (recipient) and, with the recipient swapped back, a bad signature. */
    a_for_other_recipient: sign(seedA, { message: message(a.accountId), recipient: 'other.testnet' }).proof,
    /** A's message signed with a callbackUrl: the contract verifies with callback_url None, so it is refused. */
    a_with_callback_url: sign(seedA, { message: message(a.accountId), recipient: CONTRACT, callbackUrl: 'https://example.com/back' }).proof,
  };
}

function implicit(seed: Uint8Array): string {
  return Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
}

describe('the hana-stamps NEP-413 vector (D795)', () => {
  it('is what this package signs, byte for byte', () => {
    const want = `${JSON.stringify(vector(), null, 2)}\n`;
    if (process.env.HANA_WRITE_STAMPS_VECTOR === '1') writeFileSync(VECTOR_FILE, want);
    expect(readFileSync(VECTOR_FILE, 'utf8')).toBe(want);
  });

  it('signs sha256(u32le(2^31 + 413) ‖ borsh{message, nonce, recipient, callback_url: None}), as the contract rebuilds it', () => {
    const v = vector();
    // The bytes written out by hand, as the contract's nep413_bytes builds them.
    const u32 = (n: number) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
    const str = (s: string) => [...u32(utf8(s).length), ...utf8(s)];
    const manual = Uint8Array.from([...u32(2 ** 31 + 413), ...str(v.a.proof.message), ...NONCE, ...str(CONTRACT), 0]);
    expect(encodeNep413Message({ message: v.a.proof.message, nonce: NONCE, recipient: CONTRACT, callbackUrl: null })).toEqual(manual);
    expect(decodeNep413Message(manual)).toEqual({ message: v.a.proof.message, nonce: NONCE, recipient: CONTRACT, callbackUrl: null });
    const sig = Buffer.from(v.a.proof.signature, 'base64');
    expect(sig).toHaveLength(64);
    expect(ed25519.verify(sig, nep413Hash(manual), Buffer.from(v.a.account_id, 'hex'))).toBe(true);
    expect(v.a.account_id).toMatch(/^[0-9a-f]{64}$/u);
    expect(v.a.account_id).not.toBe(v.b.account_id);
    expect(Buffer.from(v.a.proof.nonce, 'base64')).toHaveLength(32);
  });
});
