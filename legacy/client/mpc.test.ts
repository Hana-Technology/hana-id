import { Buffer } from 'buffer';
import { Keypair } from '@stellar/stellar-sdk';
import { baseEncode } from '@near-js/utils';
import { hexToBytes, keccak256, recoverAddress, toHex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { ed25519Signature, envelope, evmAddressFromNearKey, secp256k1Signature, stellarAddressFromNearKey } from './mpc';

const PK = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318' as const;

describe('embed mpc helpers', () => {
  it('derives the EVM address from a NEAR secp256k1 key', () => {
    const account = privateKeyToAccount(PK);
    const uncompressed = hexToBytes(account.publicKey).slice(1); // drop 0x04
    expect(evmAddressFromNearKey(`secp256k1:${baseEncode(uncompressed)}`)).toBe(account.address);
  });

  it('derives the Stellar address from a NEAR ed25519 key', () => {
    const kp = Keypair.random();
    expect(stellarAddressFromNearKey(`ed25519:${baseEncode(kp.rawPublicKey())}`)).toBe(kp.publicKey());
  });

  it('rejects keys of the wrong curve', () => {
    expect(() => evmAddressFromNearKey('ed25519:abc')).toThrow();
    expect(() => stellarAddressFromNearKey('secp256k1:abc')).toThrow();
  });

  it('turns an MPC secp256k1 response into a signature that recovers the signer', async () => {
    const hash = keccak256(new TextEncoder().encode('hello'));
    const sig = await sign({ hash, privateKey: PK });
    const parsed = secp256k1Signature({
      scheme: 'Secp256k1',
      big_r: { affine_point: `02${sig.r.slice(2)}` },
      s: { scalar: sig.s.slice(2) },
      recovery_id: sig.yParity as 0 | 1,
    });
    expect(await recoverAddress({ hash, signature: parsed })).toBe(privateKeyToAccount(PK).address);
  });

  it('accepts only 64-byte Ed25519 signatures', () => {
    const kp = Keypair.random();
    const sig = kp.sign(Buffer.from('x'));
    expect(toHex(ed25519Signature({ scheme: 'Ed25519', signature: [...sig] }))).toBe(toHex(sig));
    expect(() => ed25519Signature({ scheme: 'Ed25519', signature: [1, 2] })).toThrow();
  });

  it('builds the envelope the contract expects (same layout as its Rust tests)', () => {
    const u32 = (n: number) => [n & 255, (n >> 8) & 255, 0, 0];
    const str = (t: string) => [...u32(t.length), ...new TextEncoder().encode(t)];
    expect(envelope('evm', Uint8Array.from([97, 98, 99]))).toEqual([
      ...str('hana-embed'),
      0,
      ...new Array(32).fill(0),
      ...new Array(8).fill(0),
      ...str('hana-signer.testnet'),
      ...new Array(32).fill(0),
      ...u32(1),
      2,
      ...str('sign_evm'),
      ...u32(3),
      97,
      98,
      99,
      ...new Array(8 + 16).fill(0),
    ]);
    expect(envelope('stellar', Uint8Array.from([1]))).toContain(115); // 's' of sign_stellar
  });
});
