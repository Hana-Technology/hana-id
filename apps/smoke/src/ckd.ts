// NEAR Confidential Key Derivation (CKD), client side. Ported from legacy/client/ckd.ts (itself ported from near/mpc
// @ a7ae426: crates/ckd-example-cli/src/ckd.rs, crates/near-mpc-crypto-types/src/kdf.rs,
// crates/contract/src/primitives/ckd.rs). Changes from legacy: base58 from @scure/base instead of @near-js/utils, and
// the chain-key step lives in chain-keys.ts.
//
// - app key: random scalar a; publicly verifiable form (a·G1, a·G2), checked on-chain by a pairing.
// - response (big_y, big_c) = (y·G1, msk·H + y·a·G1), so the secret sig = big_c − a·big_y = msk·H.
// - H = hash_to_curve_G1(network_pk_G2_compressed ‖ app_id, DST "NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_").
// - app_id = SHA3-256("near-mpc v0.1.0 app_id derivation:" ‖ account ‖ "," ‖ path); account = the contract that called
//   the MPC (hana-signer).
// - verify e(H, pk) = e(sig, G2) against the pinned network key; the secret bytes are sig's 48-byte compressed form.
// SECURITY: the output of decryptCkd is a full private key. Never log, display, persist or send it.
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { sha3_256 } from '@noble/hashes/sha3';
import { base58 } from '@scure/base';
import { utf8 } from './bytes.ts';

const G1 = bls.G1.ProjectivePoint;
const G2 = bls.G2.ProjectivePoint;
export const CKD_DST = 'NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_';
const APP_ID_PREFIX = 'near-mpc v0.1.0 app_id derivation:';
const G1_PREFIX = 'bls12381g1:';
const G2_PREFIX = 'bls12381g2:';

export interface AppKey {
  /** The ephemeral scalar: decrypts the response. Memory only; drop the reference after decrypting. */
  a: bigint;
  /** What the contract and MPC see: `{ AppPublicKeyPV: { pk1, pk2 } }`. */
  publicKey: { AppPublicKeyPV: { pk1: string; pk2: string } };
}

export interface CkdResponse {
  big_y: string;
  big_c: string;
}

const encodeG1 = (p: InstanceType<typeof G1>): string => `${G1_PREFIX}${base58.encode(p.toRawBytes(true))}`;
const encodeG2 = (p: InstanceType<typeof G2>): string => `${G2_PREFIX}${base58.encode(p.toRawBytes(true))}`;

export function decodePoint(text: string, prefix: typeof G1_PREFIX | typeof G2_PREFIX): Uint8Array {
  if (!text.startsWith(prefix)) throw new Error(`Expected a ${prefix} point`);
  return base58.decode(text.slice(prefix.length));
}

/** True if `key` looks like a pinned CKD network key (`bls12381g2:<base58 of a valid compressed G2 point>`). */
export function isValidNetworkKey(key: string): boolean {
  try {
    G2.fromHex(decodePoint(key, G2_PREFIX)).assertValidity();
    return true;
  } catch {
    return false;
  }
}

/** A fresh ephemeral BLS12-381 key (publicly verifiable form, so the MPC contract can check it). */
export function newAppKey(): AppKey {
  const a = bls.G1.normPrivateKeyToScalar(bls.utils.randomPrivateKey());
  return { a, publicKey: { AppPublicKeyPV: { pk1: encodeG1(G1.BASE.multiply(a)), pk2: encodeG2(G2.BASE.multiply(a)) } } };
}

/** The CKD app id the MPC uses for a caller account (hana-signer) and derivation path. */
export const ckdAppId = (account: string, path: string): Uint8Array => sha3_256(utf8(`${APP_ID_PREFIX}${account},${path}`));

/**
 * Decrypts the MPC response with the ephemeral key and checks it really is the network's BLS signature on
 * H(pk, app_id). Returns the 48-byte secret. Throws if the check fails (wrong key, tampered response, wrong app id or
 * network key). The thrown messages never contain key material.
 */
export function decryptCkd(response: CkdResponse, a: bigint, appId: Uint8Array, networkPublicKey: string): Uint8Array {
  const bigY = G1.fromHex(decodePoint(response.big_y, G1_PREFIX));
  const bigC = G1.fromHex(decodePoint(response.big_c, G1_PREFIX));
  const pkBytes = decodePoint(networkPublicKey, G2_PREFIX);
  const pk = G2.fromHex(pkBytes);
  const sig = bigC.subtract(bigY.multiply(a));
  if (sig.equals(G1.ZERO)) throw new Error('CKD response decrypts to the identity point');
  const hashPoint = bls.G1.hashToCurve(Uint8Array.from([...pkBytes, ...appId]), { DST: CKD_DST });
  const lhs = bls.pairing(G1.fromAffine(hashPoint.toAffine()), pk);
  const rhs = bls.pairing(sig, G2.BASE);
  if (!bls.fields.Fp12.eql(lhs, rhs)) throw new Error('CKD response failed the pairing check');
  return sig.toRawBytes(true);
}
