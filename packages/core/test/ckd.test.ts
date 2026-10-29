// CKD client: ported from apps/smoke/test/ckd.test.ts (itself from legacy/client/ckd.test.ts), plus the batch B checks:
// a substituted path, CKD or signer fails the pairing check against ckdAppId(SIGNER, path); the identity point is
// refused; parseNetworkKey refuses an invalid G2; ckdKeyProblem and isValidNetworkKey as moved from smoke.
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { sha256, toHex } from '../src/bytes.ts';
import { ckdAppId, ckdKeyHash, ckdKeyProblem, decryptCkd, isValidNetworkKey, newAppKey, parseNetworkKey } from '../src/ckd.ts';
import { g1, mpcNetwork, readJson, simulateMpc } from './helpers.ts';

const G1 = bls.G1.ProjectivePoint;
const G2 = bls.G2.ProjectivePoint;

const SIGNER = 'hana-signer.testnet';
const PATH = 'global#google#123';

describe('CKD client', () => {
  const appId = ckdAppId(SIGNER, PATH);

  it('builds the app id exactly as near-mpc kdf.rs (sha3-256 of prefix ‖ account ‖ "," ‖ path)', () => {
    expect(appId).toHaveLength(32);
    expect(ckdAppId(SIGNER, PATH)).toEqual(appId);
    expect(ckdAppId(SIGNER, 'global#google#124')).not.toEqual(appId);
    expect(ckdAppId('hana-signer-other.testnet', PATH)).not.toEqual(appId);
  });

  it('matches the frozen app ids of the derivation vectors (independent node:crypto sha3-256)', () => {
    const v = readJson<{ mpc: { signer: string }; vectors: { path?: string; appIdHex?: string }[] }>('vectors/derivation-v1.json');
    for (const x of v.vectors.filter((x) => x.path)) expect(toHex(ckdAppId(v.mpc.signer, x.path!))).toBe(x.appIdHex);
  });

  it('decrypts and verifies a well-formed response', () => {
    const key = newAppKey();
    const { response, networkKey, expected } = simulateMpc(key.publicKey.AppPublicKeyPV.pk1, appId);
    expect(decryptCkd(response, key.a, appId, networkKey)).toEqual(expected);
  });

  it('rejects a response for a different app id, key or network', () => {
    const key = newAppKey();
    const { response, networkKey } = simulateMpc(key.publicKey.AppPublicKeyPV.pk1, appId);
    expect(() => decryptCkd(response, key.a, ckdAppId(SIGNER, 'other'), networkKey)).toThrow(/pairing/);
    expect(() => decryptCkd(response, newAppKey().a, appId, networkKey)).toThrow(/pairing/);
    const other = simulateMpc(key.publicKey.AppPublicKeyPV.pk1, appId);
    expect(() => decryptCkd(response, key.a, appId, other.networkKey)).toThrow(/pairing/);
  });

  it('rejects a CKD made for an attacker path, or for another signer’s app_id, against ckdAppId(SIGNER, path)', () => {
    const net = mpcNetwork();
    const key = newAppKey();
    const attacker = simulateMpc(key.publicKey.AppPublicKeyPV.pk1, ckdAppId(SIGNER, 's1#google#attacker#0'), net);
    expect(() => decryptCkd(attacker.response, key.a, ckdAppId(SIGNER, 's1#google#victim#0'), net.networkKey)).toThrow(/pairing/);
    const otherSigner = simulateMpc(key.publicKey.AppPublicKeyPV.pk1, ckdAppId('evil-signer.testnet', PATH), net);
    expect(() => decryptCkd(otherSigner.response, key.a, appId, net.networkKey)).toThrow(/pairing/);
  });

  it('rejects a substituted (attacker-chosen) CKD response', () => {
    const net = mpcNetwork();
    const key = newAppKey();
    const forged = { big_y: g1(G1.BASE.multiply(5n)), big_c: g1(G1.BASE.multiply(7n)) };
    expect(() => decryptCkd(forged, key.a, appId, net.networkKey)).toThrow(/pairing/);
  });

  it('rejects a response that decrypts to the identity point, and identity inputs', () => {
    const net = mpcNetwork();
    const a = 3n;
    const y = G1.BASE.multiply(11n);
    // C = a·Y gives sig = C − a·Y = identity.
    expect(() => decryptCkd({ big_y: g1(y), big_c: g1(y.multiply(a)) }, a, appId, net.networkKey)).toThrow(/identity/);
    const zero = `bls12381g1:${base58.encode(G1.ZERO.toRawBytes(true))}`;
    expect(() => decryptCkd({ big_y: zero, big_c: g1(y) }, a, appId, net.networkKey)).toThrow();
  });

  it('rejects malformed points and app ids', () => {
    const key = newAppKey();
    const { response, networkKey } = simulateMpc(key.publicKey.AppPublicKeyPV.pk1, appId);
    expect(() => decryptCkd({ ...response, big_y: response.big_y.replace('bls12381g1:', 'bls12381g2:') }, key.a, appId, networkKey)).toThrow(/bls12381g1/);
    expect(() => decryptCkd(response, key.a, appId, networkKey.replace('bls12381g2:', 'bls12381g1:'))).toThrow(/bls12381g2/);
    expect(() => decryptCkd(response, key.a, appId.slice(1), networkKey)).toThrow(/32 bytes/);
  });

  it('publishes a matching (a·G1, a·G2) pair, as the contract pairing check requires', () => {
    const { a, publicKey } = newAppKey();
    expect(publicKey.AppPublicKeyPV.pk1).toBe(g1(G1.BASE.multiply(a)));
    expect(publicKey.AppPublicKeyPV.pk2).toBe(`bls12381g2:${base58.encode(G2.BASE.multiply(a).toRawBytes(true))}`);
  });
});

describe('pinned network key', () => {
  it('parseNetworkKey accepts a valid G2 and refuses an invalid one', () => {
    const net = mpcNetwork();
    expect(toHex(parseNetworkKey(net.networkKey).bytes)).toBe(toHex(net.pkBytes));
    const bad = Uint8Array.from(net.pkBytes);
    bad[50] = bad[50]! ^ 0xff;
    expect(() => parseNetworkKey(`bls12381g2:${base58.encode(bad)}`)).toThrow();
    expect(() => parseNetworkKey(`bls12381g2:${base58.encode(net.pkBytes.slice(0, 95))}`)).toThrow(/96-byte/);
    expect(() => parseNetworkKey(`bls12381g2:${base58.encode(G2.ZERO.toRawBytes(true))}`)).toThrow();
    expect(() => parseNetworkKey('bls12381g1:abc')).toThrow(/bls12381g2/);
  });

  it('isValidNetworkKey validates the pinned key format', () => {
    expect(isValidNetworkKey(mpcNetwork().networkKey)).toBe(true);
    expect(isValidNetworkKey('UNSET-run-scripts/fetch-ckd-key.ts')).toBe(false);
    expect(isValidNetworkKey('bls12381g2:abc')).toBe(false);
  });

  it('ckdKeyProblem fails clearly while ckdNetworkKey is the UNSET placeholder or invalid (moved from smoke)', () => {
    expect(ckdKeyProblem({ name: 'sandbox-dev', ckdNetworkKey: 'UNSET-run-scripts/fetch-ckd-key.ts' })).toMatch(/UNSET placeholder.*fetch-ckd-key sandbox-dev/);
    expect(ckdKeyProblem({ name: 'x', ckdNetworkKey: 'bls12381g2:zzz' })).toMatch(/not a valid/);
    expect(ckdKeyProblem({ name: 'x', ckdNetworkKey: mpcNetwork().networkKey })).toBeNull();
    // Usable as an Array.prototype.map callback (the extra index argument is ignored).
    expect([{ name: 'x', ckdNetworkKey: mpcNetwork().networkKey }].map(ckdKeyProblem)).toEqual([null]);
  });

  it('ckdKeyHash is sha256 of the 96-byte compressed G2', () => {
    const net = mpcNetwork();
    expect(toHex(ckdKeyHash(net.networkKey))).toBe(toHex(sha256(net.pkBytes)));
    expect(() => ckdKeyHash('bls12381g2:abc')).toThrow();
  });
});
