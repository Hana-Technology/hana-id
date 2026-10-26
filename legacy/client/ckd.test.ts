import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { baseDecode, baseEncode } from '@near-js/utils';
import { describe, expect, it } from 'vitest';
import { ckdAppId, decryptCkd, deriveChainKeys, newAppKey } from './ckd';

const G1 = bls.G1.ProjectivePoint;
const G2 = bls.G2.ProjectivePoint;

/** Plays the MPC side, as near/mpc's ckd-example-cli test does: (Y, C) = (y·G1, msk·H + y·A). */
function simulateMpc(appPk1: string, appId: Uint8Array) {
  const msk = bls.G1.normPrivateKeyToScalar(bls.utils.randomPrivateKey());
  const pk = G2.BASE.multiply(msk);
  const pkBytes = pk.toRawBytes(true);
  const h = G1.fromAffine(bls.G1.hashToCurve(Uint8Array.from([...pkBytes, ...appId]), { DST: 'NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_' }).toAffine());
  const y = bls.G1.normPrivateKeyToScalar(bls.utils.randomPrivateKey());
  const a1 = G1.fromHex(baseDecode(appPk1.slice('bls12381g1:'.length)));
  const response = {
    big_y: `bls12381g1:${baseEncode(G1.BASE.multiply(y).toRawBytes(true))}`,
    big_c: `bls12381g1:${baseEncode(h.multiply(msk).add(a1.multiply(y)).toRawBytes(true))}`,
  };
  return { response, networkKey: `bls12381g2:${baseEncode(pkBytes)}`, expected: h.multiply(msk).toRawBytes(true) };
}

describe('CKD client', () => {
  const appId = ckdAppId('hana-signer.testnet', 'global#google#123');

  it('builds the app id exactly as near-mpc kdf.rs (sha3-256 of prefix ‖ account ‖ "," ‖ path)', () => {
    expect(appId).toHaveLength(32);
    expect(ckdAppId('hana-signer.testnet', 'global#google#123')).toEqual(appId);
    expect(ckdAppId('hana-signer.testnet', 'global#google#124')).not.toEqual(appId);
  });

  it('decrypts and verifies a well-formed response', () => {
    const key = newAppKey();
    const { response, networkKey, expected } = simulateMpc(key.publicKey.AppPublicKeyPV.pk1, appId);
    expect(decryptCkd(response, key.a, appId, networkKey)).toEqual(expected);
  });

  it('rejects a response for a different app id, key or network', () => {
    const key = newAppKey();
    const { response, networkKey } = simulateMpc(key.publicKey.AppPublicKeyPV.pk1, appId);
    expect(() => decryptCkd(response, key.a, ckdAppId('hana-signer.testnet', 'other'), networkKey)).toThrow(/pairing/);
    expect(() => decryptCkd(response, newAppKey().a, appId, networkKey)).toThrow(/pairing/);
    const other = simulateMpc(key.publicKey.AppPublicKeyPV.pk1, appId);
    expect(() => decryptCkd(response, key.a, appId, other.networkKey)).toThrow(/pairing/);
  });

  it('publishes a matching (a·G1, a·G2) pair, as the contract pairing check requires', () => {
    const { a, publicKey } = newAppKey();
    expect(publicKey.AppPublicKeyPV.pk1).toBe(`bls12381g1:${baseEncode(G1.BASE.multiply(a).toRawBytes(true))}`);
    expect(publicKey.AppPublicKeyPV.pk2).toBe(`bls12381g2:${baseEncode(G2.BASE.multiply(a).toRawBytes(true))}`);
  });

  it('derives stable, distinct per-chain keys from the secret', () => {
    const secret = new Uint8Array(48).fill(7);
    const k1 = deriveChainKeys(secret);
    const k2 = deriveChainKeys(secret);
    expect(k1).toEqual(k2);
    expect(k1.evmPrivateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Buffer.from(k1.stellarSeed).toString('hex')).not.toBe(k1.evmPrivateKey.slice(2));
    expect(deriveChainKeys(new Uint8Array(48).fill(8)).evmPrivateKey).not.toBe(k1.evmPrivateKey);
  });
});
