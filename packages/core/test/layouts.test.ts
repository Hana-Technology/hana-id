// Byte layouts against independent implementations: the on-chain ones against contracts/hana-signer/src/test_fixture.json
// (the vectors hana-signer's Rust tests use), the off-chain ones against test/vectors/layouts-v1.json
// (scripts/gen-layout-vectors.mjs). Ported from apps/smoke/test/{layouts,session}.test.ts, plus the batch B layouts.
import { describe, expect, it } from 'vitest';
import { type ApprovalChain, type ApprovalContext, type ApprovalDigestInput, type ApprovalKind, approvalContextString, approvalDigest } from '../src/approval.ts';
import { base64UrlDecode, fromHex, toHex, utf8 } from '../src/bytes.ts';
import { decodeJwt } from '../src/id-token.ts';
import {
  KEY_INDEX_LIMIT,
  checkSessionParams,
  ckdPayload,
  createShareId,
  recordAad,
  relayAad,
  relayIdFor,
  revokePayload,
  sessionMessage,
  sessionNonce,
  sessionNoncePreimage,
  vaultMessage,
  vaultPayload,
} from '../src/layouts.ts';
import { newSessionKey, signDerive, signRevoke, signVaultMessage, verifyEd25519 } from '../src/session.ts';
import { type Example, contractFixture, ed25519KeyFromSeed, readJson } from './helpers.ts';

const fixture = contractFixture();
const L = fixture.layouts;
const NOW_MS = 1_800_000_000_000;
const EXPIRES_MS = NOW_MS + 3_600_000;
const EXPIRES_LATE_MS = NOW_MS + 2 * 3_600_000;
const SALT = new Uint8Array(16).fill(9);
const PK7 = fromHex(fixture.session_pk7_hex);
const PK8 = fromHex(fixture.session_pk8_hex);
const base = { signer: fixture.signer, scopeId: 's1', sessionPublicKey: PK7, expiresAtMs: EXPIRES_MS, keyIndex: 0, maxUses: 3, salt: SALT };

const joined = (ex: Example): string => ex.parts.map(([, hex]) => hex).join('');

describe('session nonce (create_session)', () => {
  it('matches the layouts.session_nonce worked example field by field', () => {
    const preimage = sessionNoncePreimage(base);
    expect(toHex(preimage)).toBe(L.session_nonce!.preimage_hex);
    expect(toHex(preimage)).toBe(joined(L.session_nonce!));
    expect(sessionNonce(base)).toBe(L.session_nonce!.nonce);
    expect(L.session_nonce!.nonce).toHaveLength(43);
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
  ] as const)('matches nonces.%s', (name, change) => {
    expect(sessionNonce({ ...base, ...change })).toBe(fixture.nonces[name]);
  });

  it('is the nonce carried by the fixture tokens (own and shared client)', () => {
    expect(decodeJwt(fixture.tokens.session_a_k1!)!.claims.nonce).toBe(sessionNonce({ ...base, sessionPublicKey: PK8, keyIndex: 1 }));
    expect(decodeJwt(fixture.tokens.shared_s3!)!.claims.nonce).toBe(sessionNonce({ ...base, scopeId: 's3' }));
  });

  it('commits to max_uses and the salt', () => {
    const n = sessionNonce(base);
    expect(sessionNonce({ ...base, maxUses: 4 })).not.toBe(n);
    expect(sessionNonce({ ...base, salt: new Uint8Array(32).fill(9) })).not.toBe(n);
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
    expect(toHex(ckdPayload(L.ckd_payload!.pk1!, L.ckd_payload!.pk2!))).toBe(L.ckd_payload!.preimage_hex);
  });

  it('matches layouts.session_message_ckd (counter 1, payload = the CKD payload)', () => {
    const msg = sessionMessage(1, ckdPayload(L.ckd_payload!.pk1!, L.ckd_payload!.pk2!));
    expect(toHex(msg)).toBe(L.session_message_ckd!.preimage_hex);
    expect(toHex(msg)).toBe(joined(L.session_message_ckd!));
  });

  it('matches layouts.session_message_revoke (counter 2, payload "revoke")', () => {
    expect(toHex(sessionMessage(2, revokePayload()))).toBe(L.session_message_revoke!.preimage_hex);
  });

  it('encodes the counter as u64 LE', () => {
    const msg = sessionMessage(258, utf8('revoke'));
    const domain = utf8('hana-id-session-v1:');
    expect([...msg.slice(0, domain.length)]).toEqual([...domain]);
    expect([...msg.slice(domain.length, domain.length + 8)]).toEqual([2, 1, 0, 0, 0, 0, 0, 0]);
    expect(msg).toHaveLength(domain.length + 8 + 32);
  });

  it('decodes base64url without padding', () => {
    expect(toHex(base64UrlDecode('AQID'))).toBe('010203');
    expect(toHex(base64UrlDecode('_-8'))).toBe('ffef');
  });
});

describe('session key', () => {
  it('is a non-extractable Ed25519 key', async () => {
    const s = await newSessionKey();
    expect(s.keyPair.privateKey.extractable).toBe(false);
    expect(s.keyPair.privateKey.algorithm.name).toBe('Ed25519');
    await expect(crypto.subtle.exportKey('pkcs8', s.keyPair.privateKey)).rejects.toThrow();
    expect(s.publicKey).toHaveLength(32);
    expect(toHex((await newSessionKey()).publicKey)).not.toBe(toHex(s.publicKey));
  });

  it('signs derive and revoke messages that verify against the session public key', async () => {
    const s = await newSessionKey();
    const sig = await signDerive(s.keyPair.privateKey, 3, 'bls12381g1:A', 'bls12381g2:B');
    expect(sig).toHaveLength(64);
    expect(await verifyEd25519(s.publicKey, sig, sessionMessage(3, ckdPayload('bls12381g1:A', 'bls12381g2:B')))).toBe(true);
    expect(await verifyEd25519(s.publicKey, sig, sessionMessage(4, ckdPayload('bls12381g1:A', 'bls12381g2:B')))).toBe(false);
    const rev = await signRevoke(s.keyPair.privateKey, 4);
    expect(await verifyEd25519(s.publicKey, rev, sessionMessage(4, revokePayload()))).toBe(true);
  });

  it('signs the fixture session message with the fixture key (seed [7; 32])', async () => {
    const key = await ed25519KeyFromSeed(new Uint8Array(32).fill(7));
    const sig = await signDerive(key, 1, L.ckd_payload!.pk1!, L.ckd_payload!.pk2!);
    expect(await verifyEd25519(PK7, sig, fromHex(L.session_message_ckd!.preimage_hex))).toBe(true);
  });

  it('verifyEd25519 refuses malformed keys and signatures', async () => {
    expect(await verifyEd25519(new Uint8Array(31), new Uint8Array(64), utf8('x'))).toBe(false);
    expect(await verifyEd25519(PK7, new Uint8Array(63), utf8('x'))).toBe(false);
  });

  it('checks key_index (≥ 2^31 reserved) and max_uses ranges', () => {
    expect(KEY_INDEX_LIMIT).toBe(0x7fffffff);
    expect(() => checkSessionParams({ keyIndex: 0, maxUses: 1 })).not.toThrow();
    expect(() => checkSessionParams({ keyIndex: 0x7fffffff, maxUses: 500 })).not.toThrow();
    expect(() => checkSessionParams({ keyIndex: 0x80000000, maxUses: 5 })).toThrow(/reserved/);
    expect(() => checkSessionParams({ keyIndex: 0xffffffff, maxUses: 5 })).toThrow(/key_index/);
    expect(() => checkSessionParams({ keyIndex: -1, maxUses: 5 })).toThrow(/key_index/);
    expect(() => checkSessionParams({ keyIndex: 1.5, maxUses: 5 })).toThrow(/key_index/);
    expect(() => checkSessionParams({ keyIndex: Number.NaN, maxUses: 5 })).toThrow(/key_index/);
    expect(() => checkSessionParams({ keyIndex: 0, maxUses: 0 })).toThrow(/max_uses/);
    expect(() => checkSessionParams({ keyIndex: 0, maxUses: 501 })).toThrow(/max_uses/);
  });
});

// ---- off-chain layouts (test/vectors/layouts-v1.json) ----

interface LayoutVectors {
  signer: string;
  app_id: string;
  parent_origin: string;
  path: string;
  session_pk7_hex: string;
  layouts: Record<string, Example>;
}
const V = readJson<LayoutVectors>('vectors/layouts-v1.json');
const VL = V.layouts;
const SHARE_ID = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

describe('vault message', () => {
  const cases = [
    ['vault_message_create_share', createShareId(), 0, vaultPayload.createShare(V.parent_origin)],
    ['vault_message_unlock', SHARE_ID, 5, vaultPayload.unlock()],
    ['vault_message_touch', SHARE_ID, 6, vaultPayload.touch()],
    ['vault_message_revoke', SHARE_ID, 7, vaultPayload.revoke()],
    ['vault_message_revoke_all', SHARE_ID, 8, vaultPayload.revokeAll()],
  ] as const;

  it.each(cases)('matches %s byte for byte', (name, shareId, counter, payload) => {
    const ex = VL[name]!;
    expect(toHex(payload)).toBe(ex.payload_hex);
    const msg = vaultMessage({ signer: V.signer, appId: V.app_id, shareId, counter, payload });
    expect(toHex(msg)).toBe(ex.preimage_hex);
    expect(toHex(msg)).toBe(joined(ex));
  });

  it.each(cases)('%s: the session key signs it as the generator did (seed [7; 32])', async (name, shareId, counter, payload) => {
    const key = await ed25519KeyFromSeed(new Uint8Array(32).fill(7));
    const input = { signer: V.signer, appId: V.app_id, shareId, counter, payload };
    const sig = await signVaultMessage(key, input);
    expect(toHex(sig)).toBe(VL[name]!.signature_seed7_hex); // Ed25519 is deterministic
    expect(await verifyEd25519(fromHex(V.session_pk7_hex), sig, vaultMessage(input))).toBe(true);
  });

  it('can never be read as a session message: different prefix, and binds the app id', () => {
    const msg = vaultMessage({ signer: V.signer, appId: V.app_id, shareId: SHARE_ID, counter: 5, payload: vaultPayload.revoke() });
    expect(new TextDecoder().decode(msg.slice(0, 17))).toBe('hana-id-vault-v1:');
    expect(toHex(msg)).not.toContain(toHex(utf8('hana-id-session-v1:')));
    const other = vaultMessage({ signer: V.signer, appId: 'app_other', shareId: SHARE_ID, counter: 5, payload: vaultPayload.revoke() });
    expect(toHex(other)).not.toBe(toHex(msg));
  });

  it('refuses a shareId that is not 16 bytes, and create-share ids are fresh zero arrays', () => {
    expect(() => vaultMessage({ signer: V.signer, appId: V.app_id, shareId: new Uint8Array(15), counter: 0, payload: vaultPayload.unlock() })).toThrow(/16 bytes/);
    const a = createShareId();
    a[0] = 1;
    expect([...createShareId()]).toEqual(new Array(16).fill(0));
  });
});

describe('vault record AAD', () => {
  it('matches record_aad byte for byte', () => {
    const aad = recordAad({
      signer: V.signer,
      appId: V.app_id,
      path: V.path,
      sessionPublicKey: fromHex(V.session_pk7_hex),
      derivationVersion: 1,
      ckdKeyHash: fromHex(VL.record_aad!.parts[6]![1]),
      parentOrigin: V.parent_origin,
      expiresAtMs: 1_800_003_600_000,
    });
    expect(toHex(aad)).toBe(VL.record_aad!.preimage_hex);
  });

  it('refuses malformed lengths', () => {
    const ok = { signer: 's', appId: 'a', path: 'p', sessionPublicKey: new Uint8Array(32), derivationVersion: 1, ckdKeyHash: new Uint8Array(32), parentOrigin: 'o', expiresAtMs: 1 };
    expect(() => recordAad({ ...ok, sessionPublicKey: new Uint8Array(33) })).toThrow(/32 bytes/);
    expect(() => recordAad({ ...ok, ckdKeyHash: new Uint8Array(31) })).toThrow(/32 bytes/);
  });
});

describe('approval digest', () => {
  interface ApprovalInput {
    id: string;
    kind: string;
    chain: string;
    address: string;
    context: string;
    parentOrigin: string;
    bytes: string;
  }
  // The vectors hold the context string; approvalDigest takes the context object it comes from.
  const contextOf = (chain: string, s: string): ApprovalContext => (s === '' ? {} : chain === 'stellar' ? { networkPassphrase: s } : { chainId: Number(s) });

  it.each(['approval_stellar', 'approval_evm', 'approval_raw_no_context'])('matches %s', (name) => {
    const ex = VL[name]!;
    const i = ex.input as ApprovalInput;
    const input = { id: i.id, kind: i.kind as ApprovalKind, chain: i.chain as ApprovalChain, address: i.address, parentOrigin: i.parentOrigin, context: contextOf(i.chain, i.context), bytes: fromHex(i.bytes) };
    expect(approvalContextString(input.chain, input.context)).toBe(i.context);
    expect(toHex(approvalDigest(input))).toBe(ex.digest_hex);
  });

  it('changes with any field, including only the context', () => {
    const i: ApprovalDigestInput = { id: 'a', kind: 'evm_tx', chain: 'evm', address: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23', parentOrigin: 'https://p.example', context: { chainId: 1 }, bytes: utf8('x') };
    const d = toHex(approvalDigest(i));
    const changes: Partial<ApprovalDigestInput>[] = [{ id: 'b' }, { kind: 'personal_sign', context: {} }, { address: '0x2C7536E3605D9C16A7A3D7B1898E529396A65C23' }, { parentOrigin: 'https://q.example' }, { context: { chainId: 2 } }, { bytes: utf8('y') }];
    for (const change of changes) {
      expect(toHex(approvalDigest({ ...i, ...change }))).not.toBe(d);
    }
  });
});

describe('relay id and AAD', () => {
  it('matches relay_aad: relayId = b64url(sha256(readKey)), AAD = "hana-id/relay/v1" ‖ relayId', () => {
    const ex = VL.relay_aad!;
    const relayId = relayIdFor(fromHex(ex.relay_read_key_hex as string));
    expect(relayId).toBe(ex.relay_id);
    expect(relayId).toHaveLength(43);
    expect(toHex(relayAad(relayId))).toBe(ex.preimage_hex);
  });

  it('refuses a malformed relay id or read key', () => {
    expect(() => relayAad('short')).toThrow(/relayId/);
    expect(() => relayAad(`${'a'.repeat(42)}=`)).toThrow(/relayId/);
    expect(() => relayIdFor(new Uint8Array(31))).toThrow(/32 bytes/);
  });
});
