// The wallet record (src/wallet-record.ts, D311): the statement's byte layout against an independent node:crypto build,
// the verifier's refusals (forged, mismatched, another session, path, time, app, env), and the argument of the
// module's header, point by point: a record signature is never a Stellar transaction, Soroban auth entry or SEP-53
// signature, never an EVM transaction, EIP-191 or EIP-712 signature, and its statement is never a payload the approval
// flow would sign (the raw Stellar refusal's prefix; the EVM raw digest the vault refuses is walletRecordEvmDigest).
import { createHash } from 'node:crypto';
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder, xdr } from '@stellar/stellar-base';
import { hashMessage, hashTypedData, keccak256, parseTransaction, recoverAddress, serializeSignature, toHex as viemHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { APPROVAL_DIGEST_DOMAIN } from '../src/approval.ts';
import { fromHex, sha256, toHex } from '../src/bytes.ts';
import { deriveAddresses, deriveWalletAddresses, withChainKey } from '../src/derivation.ts';
import { encodeNep413Message, nearDelegateActionHash, nearTransactionHash, nep413Hash } from '../src/near/codec.ts';
import { signNep413Message } from '../src/near/sign.ts';
import { ed25519 } from '@noble/curves/ed25519';
import { functionCall, nearDelegateBytes, nearTxBytes, transfer } from './near-fixtures.ts';
import { IDENTITY_MESSAGE_DOMAIN, IDENTITY_WALLET_DOMAIN, walletProofMessage } from '../src/identity.ts';
import { CKD_PAYLOAD_PREFIX, CREATE_PROOF_PREFIX, SESSION_MESSAGE_DOMAIN, VAULT_MESSAGE_DOMAIN } from '../src/layouts.ts';
import { recoverEvmAddress } from '../src/signers/evm.ts';
import { sep53MessageHash, stellarTransactionHash, verifyStellarSignature } from '../src/signers/stellar.ts';
import {
  WALLET_RECORD_DOMAIN,
  WALLET_RECORD_PROOFS_DOMAIN,
  WALLET_RECORD_PROOFS_DOMAIN_V2,
  WALLET_RECORD_SESSION_DOMAIN,
  type WalletRecordChain,
  type WalletRecordContext,
  type WalletRecordProofs,
  isWalletRecordResponse,
  signWalletRecord,
  signWalletRecordSession,
  verifyWalletRecord,
  verifyWalletRecordSession,
  walletRecordEvmDigest,
  walletRecordSessionMessage,
  walletRecordStatement,
} from '../src/wallet-record.ts';

const PRK = fromHex('11'.repeat(32));
const OTHER_PRK = fromHex('22'.repeat(32));
const ADDR = deriveWalletAddresses(PRK);
const PK = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const CTX: WalletRecordContext = {
  env: 'local-e2e',
  signer: 'hana-signer.test.near',
  appId: 'app_Test123',
  scopeId: 's1',
  path: 's1#google#1102#0',
  sessionPublicKey: PK,
  issuedAtMs: 1_800_000_000_123,
};

const sign = (chain: WalletRecordChain, ctx = CTX, prk = PRK, address = ADDR[chain]) =>
  withChainKey(prk, chain, 0, (key) => signWalletRecord(chain, key, walletRecordStatement(ctx, chain, address)));

/** The layout again, with node:crypto-free plain Buffers: an independent build of the header's formula. */
function referenceStatement(c: WalletRecordContext, chain: string, address: string): Buffer {
  const b = (s: string) => {
    const v = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(v.length);
    return Buffer.concat([len, v]);
  };
  const t = Buffer.alloc(8);
  t.writeBigUInt64LE(BigInt(c.issuedAtMs));
  return Buffer.concat([Buffer.from('hana-id/wallet-record/v1'), Buffer.of(0), b(c.env), b(c.signer), b(c.appId), b(c.scopeId), b(c.path), b(chain), b(address), Buffer.from(c.sessionPublicKey), t]);
}

describe('the statement', () => {
  it('is the documented layout, byte for byte, for both chains', () => {
    for (const chain of ['stellar', 'evm'] as const) {
      expect(toHex(walletRecordStatement(CTX, chain, ADDR[chain]))).toBe(referenceStatement(CTX, chain, ADDR[chain]).toString('hex'));
      expect(toHex(walletRecordEvmDigest(CTX, ADDR.evm))).toBe(createHash('sha256').update(referenceStatement(CTX, 'evm', ADDR.evm)).digest('hex'));
    }
  });

  it('refuses a non-canonical address, a path of another scope, a short key and a bad time', () => {
    expect(() => walletRecordStatement(CTX, 'evm', ADDR.evm.toLowerCase())).toThrow(/canonical/u);
    expect(() => walletRecordStatement(CTX, 'stellar', 'GNOTANADDRESS')).toThrow(/canonical/u);
    expect(() => walletRecordStatement({ ...CTX, path: 's2#google#1102#0' }, 'stellar', ADDR.stellar)).toThrow(/scope/u);
    expect(() => walletRecordStatement({ ...CTX, sessionPublicKey: PK.subarray(1) }, 'stellar', ADDR.stellar)).toThrow(/32 bytes/u);
    expect(() => walletRecordStatement({ ...CTX, issuedAtMs: -1 }, 'stellar', ADDR.stellar)).toThrow(/issuedAtMs/u);
    expect(() => walletRecordStatement({ ...CTX, env: '' }, 'stellar', ADDR.stellar)).toThrow(/env/u);
  });

  it('has a domain no other Hana signature uses, closed by 0x00', () => {
    const s = walletRecordStatement(CTX, 'stellar', ADDR.stellar);
    expect(s[WALLET_RECORD_DOMAIN.length]).toBe(0);
    for (const other of [SESSION_MESSAGE_DOMAIN, VAULT_MESSAGE_DOMAIN, IDENTITY_MESSAGE_DOMAIN, IDENTITY_WALLET_DOMAIN, APPROVAL_DIGEST_DOMAIN]) {
      expect(WALLET_RECORD_DOMAIN.startsWith(other) || other.startsWith(WALLET_RECORD_DOMAIN)).toBe(false);
    }
    // The identity wallet proof over the same session and address is a different message.
    const proof = walletProofMessage({ signer: CTX.signer, appId: CTX.appId, sessionPublicKey: PK }, 'stellar', ADDR.stellar);
    expect(toHex(proof)).not.toBe(toHex(s));
  });
});

describe('verifyWalletRecord', () => {
  it('accepts a record by each address’s own key, and an EVM address in any case', () => {
    expect(verifyWalletRecord(CTX, 'stellar', { address: ADDR.stellar, signature: sign('stellar') })).toBe(ADDR.stellar);
    expect(verifyWalletRecord(CTX, 'evm', { address: ADDR.evm, signature: sign('evm') })).toBe(ADDR.evm);
    expect(verifyWalletRecord(CTX, 'evm', { address: ADDR.evm.toLowerCase(), signature: sign('evm') })).toBe(ADDR.evm);
  });

  it('refuses a forged or mismatched record', () => {
    const other = deriveAddresses(OTHER_PRK);
    // Another key's signature for this address, this key's signature for another address.
    expect(verifyWalletRecord(CTX, 'stellar', { address: ADDR.stellar, signature: sign('stellar', CTX, OTHER_PRK, ADDR.stellar) })).toBeNull();
    expect(verifyWalletRecord(CTX, 'evm', { address: ADDR.evm, signature: sign('evm', CTX, OTHER_PRK, ADDR.evm) })).toBeNull();
    expect(verifyWalletRecord(CTX, 'stellar', { address: other.stellar, signature: sign('stellar') })).toBeNull();
    expect(verifyWalletRecord(CTX, 'evm', { address: other.evm, signature: sign('evm') })).toBeNull();
    // A flipped bit, a wrong length, the other chain's signature.
    const bad = sign('stellar');
    bad[5]! ^= 1;
    expect(verifyWalletRecord(CTX, 'stellar', { address: ADDR.stellar, signature: bad })).toBeNull();
    expect(verifyWalletRecord(CTX, 'stellar', { address: ADDR.stellar, signature: sign('stellar').subarray(1) })).toBeNull();
    expect(verifyWalletRecord(CTX, 'evm', { address: ADDR.evm, signature: sign('evm').subarray(0, 64) })).toBeNull();
    expect(verifyWalletRecord(CTX, 'stellar', { address: ADDR.evm, signature: sign('evm') })).toBeNull();
    expect(verifyWalletRecord(CTX, 'evm', { address: 'not an address', signature: sign('evm') })).toBeNull();
  });

  it('binds every field: another session, path, time, app, scope, env or signer refuses', () => {
    const changes: Partial<WalletRecordContext>[] = [
      { sessionPublicKey: Uint8Array.from({ length: 32 }, () => 9) },
      { path: 's1#google#9999#0' },
      { path: 's1#google#1102#1' },
      { issuedAtMs: CTX.issuedAtMs + 1 },
      { appId: 'app_Other' },
      { scopeId: 's1x', path: 's1x#google#1102#0' },
      { env: 'sandbox-dev' },
      { signer: 'other.test.near' },
    ];
    for (const chain of ['stellar', 'evm'] as const) {
      const signature = sign(chain);
      for (const c of changes) expect(verifyWalletRecord({ ...CTX, ...c }, chain, { address: ADDR[chain], signature })).toBeNull();
    }
  });
});

describe('a record can never be replayed as a Stellar signature', () => {
  const kp = Keypair.fromRawEd25519Seed(Buffer.from(withChainKey(PRK, 'stellar', 0, (k) => Uint8Array.from(k))));
  const signature = sign('stellar');
  const statement = walletRecordStatement(CTX, 'stellar', ADDR.stellar);

  it('signs the statement itself, which is longer than any 32-byte hash the network checks', () => {
    expect(kp.publicKey()).toBe(ADDR.stellar);
    expect(statement.length).toBeGreaterThan(32);
    expect(verifyStellarSignature(ADDR.stellar, statement, signature)).toBe(true);
  });

  it('is not a signature over a transaction or its hash: the statement is no envelope', () => {
    const tx = new TransactionBuilder(new Account(ADDR.stellar, '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: ADDR.stellar, asset: Asset.native(), amount: '1' }))
      .setTimeout(0)
      .build();
    const hash = stellarTransactionHash(tx.toEnvelope().toXDR('base64'), Networks.TESTNET);
    expect(verifyStellarSignature(ADDR.stellar, hash, signature)).toBe(false);
    expect(() => xdr.TransactionEnvelope.fromXDR(Buffer.from(statement))).toThrow();
    expect(() => xdr.HashIdPreimage.fromXDR(Buffer.from(statement))).toThrow();
  });

  it('is not a SEP-53 signature of the statement (or of anything: those sign a 32-byte hash)', () => {
    expect(verifyStellarSignature(ADDR.stellar, sep53MessageHash(statement), signature)).toBe(false);
    expect(verifyStellarSignature(ADDR.stellar, sha256(statement), signature)).toBe(false);
  });

  it('starts with "hana-id", the prefix the vault refuses in raw Stellar requests (D179)', () => {
    expect(new TextDecoder().decode(statement.subarray(0, 7))).toBe('hana-id');
  });
});

describe('a record can never be replayed as an EVM signature', () => {
  const signature = sign('evm');
  const statement = walletRecordStatement(CTX, 'evm', ADDR.evm);
  const sigHex = serializeSignature({ r: viemHex(signature.subarray(0, 32)), s: viemHex(signature.subarray(32, 64)), v: BigInt(signature[64]!) });

  it('recovers the address only for sha256(statement)', async () => {
    expect(recoverEvmAddress(sha256(statement), signature)).toBe(ADDR.evm);
    expect(await recoverAddress({ hash: viemHex(sha256(statement)), signature: sigHex })).toBe(ADDR.evm);
  });

  it('is not an EIP-191 or keccak signature of the statement', async () => {
    expect(await recoverAddress({ hash: hashMessage({ raw: statement }), signature: sigHex })).not.toBe(ADDR.evm);
    expect(await recoverAddress({ hash: keccak256(statement), signature: sigHex })).not.toBe(ADDR.evm);
  });

  it('is no transaction: the statement parses as none, and starts with neither a list, a tx type nor 0x19', () => {
    expect(() => parseTransaction(viemHex(statement))).toThrow();
    const first = statement[0]!;
    // 'h' (0x68): never an RLP list (≥ 0xc0, a legacy transaction), an EIP-2718 type byte or EIP-191's 0x19.
    expect(first).toBe(0x68);
    expect([0x01, 0x02, 0x03, 0x04, 0x19]).not.toContain(first);
  });

  it('is not an EIP-712 signature (those are over 0x1901 ‖ domain ‖ struct)', async () => {
    const typed = hashTypedData({ domain: { name: 'x', chainId: 1 }, types: { M: [{ name: 's', type: 'bytes' }] }, primaryType: 'M', message: { s: viemHex(statement) } });
    expect(await recoverAddress({ hash: typed, signature: sigHex })).not.toBe(ADDR.evm);
  });

  it('gives the vault the digest it refuses as a raw EVM request for its own session', () => {
    expect(toHex(walletRecordEvmDigest(CTX, ADDR.evm))).toBe(toHex(sha256(statement)));
  });
});

// ---- the session signature (D311 as amended: a security review finding) ----

async function sessionKey(): Promise<{ privateKey: CryptoKey; publicKey: Uint8Array }> {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  return { privateKey: kp.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)) };
}

function referenceSessionMessage(c: WalletRecordContext, proofs: WalletRecordProofs): Buffer {
  const b = (s: string) => {
    const v = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(v.length);
    return Buffer.concat([len, v]);
  };
  const bb = (v: Uint8Array) => {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(v.length);
    return Buffer.concat([len, Buffer.from(v)]);
  };
  const t = Buffer.alloc(8);
  t.writeBigUInt64LE(BigInt(c.issuedAtMs));
  const near = proofs.near ? [b('near'), b(proofs.near.address), bb(proofs.near.signature)] : [];
  const domain = proofs.near ? 'hana-id/wallet-record-proofs/v2' : 'hana-id/wallet-record-proofs/v1';
  const p = createHash('sha256')
    .update(Buffer.concat([Buffer.from(domain), Buffer.of(0), b('stellar'), b(proofs.stellar.address), bb(proofs.stellar.signature), b('evm'), b(proofs.evm.address), bb(proofs.evm.signature), ...near]))
    .digest();
  return Buffer.concat([Buffer.from('hana-id/wallet-record-session/v1'), Buffer.of(0), b(c.env), b(c.signer), b(c.appId), b(c.scopeId), b(c.path), Buffer.from(c.sessionPublicKey), t, p]);
}

describe('the session signature over the whole record', () => {
  const proofsFor = (ctx: WalletRecordContext, prk = PRK): WalletRecordProofs => {
    const a = deriveAddresses(prk);
    return { stellar: { address: a.stellar, signature: sign('stellar', ctx, prk, a.stellar) }, evm: { address: a.evm, signature: sign('evm', ctx, prk, a.evm) } };
  };

  it('is the documented layout, byte for byte', () => {
    const proofs = proofsFor(CTX);
    expect(toHex(walletRecordSessionMessage(CTX, proofs))).toBe(referenceSessionMessage(CTX, proofs).toString('hex'));
  });

  it('verifies for the session key that signed it, and for no other key', async () => {
    const s = await sessionKey();
    const ctx = { ...CTX, sessionPublicKey: s.publicKey };
    const proofs = proofsFor(ctx);
    const sig = await signWalletRecordSession(s.privateKey, ctx, proofs);
    expect(verifyWalletRecordSession(ctx, proofs, sig)).toBe(true);
    // The attack the signature closes: a valid record by the attacker's own key, naming the victim's session key,
    // signed by any session key but the victim's.
    const attacker = await sessionKey();
    const forged = proofsFor(ctx, OTHER_PRK);
    expect(verifyWalletRecordSession(ctx, forged, await signWalletRecordSession(attacker.privateKey, ctx, forged))).toBe(false);
    expect(verifyWalletRecordSession(ctx, forged, sig)).toBe(false);
    expect(verifyWalletRecordSession(ctx, proofs, new Uint8Array(64))).toBe(false);
    expect(verifyWalletRecordSession(ctx, proofs, sig.subarray(1))).toBe(false);
  });

  it('binds every field: env, signer, app, scope, path, session key, time, each address and each chain signature', async () => {
    const s = await sessionKey();
    const ctx = { ...CTX, sessionPublicKey: s.publicKey };
    const proofs = proofsFor(ctx);
    const sig = await signWalletRecordSession(s.privateKey, ctx, proofs);
    const other = deriveAddresses(OTHER_PRK);
    const flip = (b: Uint8Array) => Uint8Array.from(b, (x, i) => (i === 5 ? x ^ 1 : x));
    const changed: [string, WalletRecordContext, WalletRecordProofs][] = [
      ['env', { ...ctx, env: 'sandbox-dev' }, proofs],
      ['signer', { ...ctx, signer: 'other.test.near' }, proofs],
      ['app', { ...ctx, appId: 'app_Other' }, proofs],
      ['scope', { ...ctx, scopeId: 's2', path: 's2#google#1102#0' }, proofs],
      ['path', { ...ctx, path: 's1#google#999#0' }, proofs],
      ['session key', { ...ctx, sessionPublicKey: (await sessionKey()).publicKey }, proofs],
      ['time', { ...ctx, issuedAtMs: ctx.issuedAtMs + 1 }, proofs],
      ['stellar address', ctx, { ...proofs, stellar: { ...proofs.stellar, address: other.stellar } }],
      ['evm address', ctx, { ...proofs, evm: { ...proofs.evm, address: other.evm } }],
      ['stellar signature', ctx, { ...proofs, stellar: { ...proofs.stellar, signature: flip(proofs.stellar.signature) } }],
      ['evm signature', ctx, { ...proofs, evm: { ...proofs.evm, signature: flip(proofs.evm.signature) } }],
    ];
    for (const [what, c, p] of changed) expect(verifyWalletRecordSession(c, p, sig), what).toBe(false);
  });

  it('has a domain no other session-key message (or Hana signature) uses, closed by 0x00', () => {
    const m = walletRecordSessionMessage(CTX, proofsFor(CTX));
    expect(m[WALLET_RECORD_SESSION_DOMAIN.length]).toBe(0);
    for (const other of [SESSION_MESSAGE_DOMAIN, VAULT_MESSAGE_DOMAIN, IDENTITY_MESSAGE_DOMAIN, IDENTITY_WALLET_DOMAIN, APPROVAL_DIGEST_DOMAIN, WALLET_RECORD_DOMAIN, CREATE_PROOF_PREFIX, CKD_PAYLOAD_PREFIX]) {
      expect(WALLET_RECORD_SESSION_DOMAIN.startsWith(other) || other.startsWith(WALLET_RECORD_SESSION_DOMAIN), other).toBe(false);
      // Different within the first 8 bytes ("hana-id/" vs "hana-id-") or later, never a prefix of each other.
      expect(Buffer.from(m.subarray(0, other.length)).toString('utf8')).not.toBe(other);
    }
  });
});

// ---- NEAR (D755): the third record, under the v2 proofs domain ----

describe('the NEAR record', () => {
  const seed = () => withChainKey(PRK, 'near', 0, (k) => Uint8Array.from(k));
  const signature = sign('near');
  const statement = walletRecordStatement(CTX, 'near', ADDR.near);

  it('is the documented layout with chain "near" and the implicit account id', () => {
    expect(toHex(statement)).toBe(referenceStatement(CTX, 'near', ADDR.near).toString('hex'));
    expect(ADDR.near).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('verifies by the account’s own key only, for the canonical (lowercase) id only, and binds every field', () => {
    expect(verifyWalletRecord(CTX, 'near', { address: ADDR.near, signature })).toBe(ADDR.near);
    const other = deriveWalletAddresses(OTHER_PRK);
    expect(verifyWalletRecord(CTX, 'near', { address: ADDR.near, signature: sign('near', CTX, OTHER_PRK, ADDR.near) })).toBeNull();
    expect(verifyWalletRecord(CTX, 'near', { address: other.near, signature })).toBeNull();
    expect(verifyWalletRecord(CTX, 'near', { address: ADDR.near.toUpperCase(), signature })).toBeNull();
    expect(verifyWalletRecord(CTX, 'near', { address: `${ADDR.near}.testnet`, signature })).toBeNull();
    expect(verifyWalletRecord(CTX, 'near', { address: ADDR.near, signature: signature.subarray(1) })).toBeNull();
    // The Stellar record (same curve, another key and chain) is not a NEAR record, nor the other way round.
    expect(verifyWalletRecord(CTX, 'near', { address: ADDR.near, signature: sign('stellar') })).toBeNull();
    expect(verifyWalletRecord(CTX, 'stellar', { address: ADDR.stellar, signature })).toBeNull();
    expect(() => walletRecordStatement(CTX, 'near', ADDR.near.toUpperCase())).toThrow(/canonical/u);
    for (const c of [{ path: 's1#google#9999#0' }, { issuedAtMs: CTX.issuedAtMs + 1 }, { appId: 'app_Other' }, { env: 'sandbox-dev' }, { sessionPublicKey: new Uint8Array(32).fill(9) }]) {
      expect(verifyWalletRecord({ ...CTX, ...c }, 'near', { address: ADDR.near, signature })).toBeNull();
    }
  });

  it('verifies strictly (RFC 8032, not ZIP 215): a small-order key with R = identity and S = 0, and a non-canonical S (S + L), are refused', () => {
    // The key 01 00…00 is the identity point (small order); R = identity and S = 0 satisfy [S]B = R + [k]A for every
    // message, so a ZIP 215 verifier takes this "signature" of any statement. The strict verifier must not.
    const small = `01${'00'.repeat(31)}`;
    const forged = new Uint8Array(64);
    forged[0] = 1;
    const statementOfSmall = walletRecordStatement(CTX, 'near', small);
    expect(ed25519.verify(forged, statementOfSmall, fromHex(small), { zip215: true })).toBe(true);
    expect(verifyWalletRecord(CTX, 'near', { address: small, signature: forged })).toBeNull();
    // S + L: the same signature with a non-canonical scalar (still below 2^256) is refused.
    const L = 2n ** 252n + 27742317777372353535851937790883648493n;
    const sig = sign('near');
    let s = 0n;
    for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(sig[32 + i]!);
    const big = s + L;
    const malleable = Uint8Array.from(sig);
    for (let i = 0; i < 32; i++) malleable[32 + i] = Number((big >> BigInt(8 * i)) & 0xffn);
    expect(verifyWalletRecord(CTX, 'near', { address: ADDR.near, signature: sig })).toBe(ADDR.near);
    expect(verifyWalletRecord(CTX, 'near', { address: ADDR.near, signature: malleable })).toBeNull();
  });

  it('is never a NEAR transaction, delegate action or NEP-413 signature: those sign a 32-byte sha256, the record signs the longer statement', () => {
    const pk = fromHex(ADDR.near);
    expect(statement.length).toBeGreaterThan(32);
    expect(ed25519.verify(signature, statement, pk, { zip215: false })).toBe(true);
    // Whatever 32-byte hash a NEAR signer could have made from these bytes, the record signature is not over it.
    expect(ed25519.verify(signature, sha256(statement), pk)).toBe(false);
    expect(ed25519.verify(signature, nearTransactionHash(statement), pk)).toBe(false);
    expect(ed25519.verify(signature, nearDelegateActionHash(statement), pk)).toBe(false);
    expect(ed25519.verify(signature, nep413Hash(statement), pk)).toBe(false);
    // And the other way round: the vault's real NEAR signatures over real requests are not records.
    const s = seed();
    try {
      const tx = nearTxBytes([transfer(1n)]);
      const da = nearDelegateBytes([functionCall('add_message', { text: 'hi' }, 30_000_000_000_000n, 0n)]);
      const txSig = ed25519.sign(nearTransactionHash(tx), s);
      const daSig = ed25519.sign(nearDelegateActionHash(da), s);
      // A partner page could ask for a NEP-413 message whose text is the statement itself, with any recipient.
      const nep = encodeNep413Message({ message: new TextDecoder().decode(statement), recipient: 'hana-id', nonce: new Uint8Array(32), callbackUrl: null });
      const nepSig = Buffer.from(signNep413Message(s, nep).signature, 'base64');
      for (const sig of [txSig, daSig, Uint8Array.from(nepSig)]) expect(verifyWalletRecord(CTX, 'near', { address: ADDR.near, signature: Uint8Array.from(sig) })).toBeNull();
    } finally {
      s.fill(0);
    }
  });
});

describe('the session signature with a NEAR record (v2 proofs)', () => {
  const proofs3 = (ctx: WalletRecordContext, prk = PRK): WalletRecordProofs => {
    const a = deriveWalletAddresses(prk);
    return {
      stellar: { address: a.stellar, signature: sign('stellar', ctx, prk, a.stellar) },
      evm: { address: a.evm, signature: sign('evm', ctx, prk, a.evm) },
      near: { address: a.near, signature: sign('near', ctx, prk, a.near) },
    };
  };

  it('is the documented layout, v2 domain, stellar, evm then near', () => {
    const p = proofs3(CTX);
    expect(toHex(walletRecordSessionMessage(CTX, p))).toBe(referenceSessionMessage(CTX, p).toString('hex'));
    expect(WALLET_RECORD_PROOFS_DOMAIN_V2).not.toBe(WALLET_RECORD_PROOFS_DOMAIN);
    expect(WALLET_RECORD_PROOFS_DOMAIN_V2.startsWith(WALLET_RECORD_PROOFS_DOMAIN) || WALLET_RECORD_PROOFS_DOMAIN.startsWith(WALLET_RECORD_PROOFS_DOMAIN_V2)).toBe(false);
  });

  it('can’t be taken for two chains, nor two for three: a NEAR record can’t be added to or taken from a signed body', async () => {
    const s = await sessionKey();
    const ctx = { ...CTX, sessionPublicKey: s.publicKey };
    const three = proofs3(ctx);
    const { near, ...two } = three;
    const sig3 = await signWalletRecordSession(s.privateKey, ctx, three);
    const sig2 = await signWalletRecordSession(s.privateKey, ctx, two);
    expect(verifyWalletRecordSession(ctx, three, sig3)).toBe(true);
    expect(verifyWalletRecordSession(ctx, two, sig2)).toBe(true);
    expect(verifyWalletRecordSession(ctx, two, sig3)).toBe(false);
    expect(verifyWalletRecordSession(ctx, three, sig2)).toBe(false);
    // An attacker's own NEAR record added to the victim's two-chain body.
    const attacker = deriveWalletAddresses(OTHER_PRK);
    expect(verifyWalletRecordSession(ctx, { ...two, near: { address: attacker.near, signature: sign('near', ctx, OTHER_PRK, attacker.near) } }, sig2)).toBe(false);
    // Every NEAR byte is bound.
    expect(verifyWalletRecordSession(ctx, { ...three, near: { ...near!, address: attacker.near } }, sig3)).toBe(false);
    expect(verifyWalletRecordSession(ctx, { ...three, near: { ...near!, signature: Uint8Array.from(near!.signature, (x, i) => (i === 0 ? x ^ 1 : x)) } }, sig3)).toBe(false);
  });
});

describe('the response check', () => {
  it('takes {recorded: true} only', () => {
    expect(isWalletRecordResponse({ recorded: true })).toBe(true);
    expect(isWalletRecordResponse({ recorded: 'yes' })).toBe(false);
    expect(isWalletRecordResponse(null)).toBe(false);
  });
});
