// NEAR Confidential Key Derivation (CKD), client side: the MPC network releases a deterministic secret for
// (calling contract, derivation path), encrypted so only this browser can read it. From that secret we derive the
// user's EVM and Stellar keys and sign locally.
//
// Ported from near/mpc @ a7ae426 (crates/ckd-example-cli/src/ckd.rs, crates/near-mpc-crypto-types/src/kdf.rs,
// crates/contract/src/primitives/ckd.rs):
// - app key: random scalar a; publicly verifiable form (a·G1, a·G2), checked on-chain by a pairing.
// - response (big_y, big_c) = (y·G1, msk·H + y·a·G1), so the secret sig = big_c − a·big_y = msk·H.
// - H = hash_to_curve_G1(network_pk_G2_compressed ‖ app_id, DST "NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_").
// - app_id = SHA3-256("near-mpc v0.1.0 app_id derivation:" ‖ account ‖ "," ‖ path); account = the contract that called.
// - verify e(H, pk) = e(sig, G2); the secret bytes are sig's 48-byte compressed encoding.
// SECURITY: the output is a full private key. Never log it.
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { sha3_256 } from '@noble/hashes/sha3';
import { baseDecode, baseEncode } from '@near-js/utils';

const G1 = bls.G1.ProjectivePoint;
const G2 = bls.G2.ProjectivePoint;
const CKD_DST = 'NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_';
const APP_ID_PREFIX = 'near-mpc v0.1.0 app_id derivation:';
const utf8 = (s: string) => new TextEncoder().encode(s);

/** Our own HKDF convention (the protocol leaves it to the app): one `info` per key so the keys are unrelated. */
const HKDF_SALT = utf8('hana-embed-ckd-v1');
const HKDF_INFO = { evm: utf8('hana-embed evm secp256k1 v1'), stellar: utf8('hana-embed stellar ed25519 v1') } as const;

export interface AppKey {
  /** The ephemeral scalar: decrypts the response. Keep in memory only. */
  a: bigint;
  /** What the contract and MPC see: `{ AppPublicKeyPV: { pk1, pk2 } }`. */
  publicKey: { AppPublicKeyPV: { pk1: string; pk2: string } };
}

export interface CkdResponse {
  big_y: string;
  big_c: string;
}

const encodeG1 = (p: InstanceType<typeof G1>) => `bls12381g1:${baseEncode(p.toRawBytes(true))}`;
const encodeG2 = (p: InstanceType<typeof G2>) => `bls12381g2:${baseEncode(p.toRawBytes(true))}`;
function decodePoint(text: string, prefix: 'bls12381g1:' | 'bls12381g2:'): Uint8Array {
  if (!text.startsWith(prefix)) throw new Error(`Expected a ${prefix} point`);
  return baseDecode(text.slice(prefix.length));
}

/** A fresh ephemeral BLS12-381 key (publicly verifiable form, so the MPC contract can check it). */
export function newAppKey(): AppKey {
  const a = bls.G1.normPrivateKeyToScalar(bls.utils.randomPrivateKey());
  return { a, publicKey: { AppPublicKeyPV: { pk1: encodeG1(G1.BASE.multiply(a)), pk2: encodeG2(G2.BASE.multiply(a)) } } };
}

/** The CKD app id the MPC uses for a caller account and derivation path. */
export const ckdAppId = (account: string, path: string): Uint8Array => sha3_256(utf8(`${APP_ID_PREFIX}${account},${path}`));

/**
 * Decrypts the MPC response with the ephemeral key and checks it really is the network's BLS signature on H(pk, app_id).
 * Returns the 48-byte secret. Throws if the check fails (wrong key, tampered response, wrong app id or network key).
 */
export function decryptCkd(response: CkdResponse, a: bigint, appId: Uint8Array, networkPublicKey: string): Uint8Array {
  const bigY = G1.fromHex(decodePoint(response.big_y, 'bls12381g1:'));
  const bigC = G1.fromHex(decodePoint(response.big_c, 'bls12381g1:'));
  const pkBytes = decodePoint(networkPublicKey, 'bls12381g2:');
  const pk = G2.fromHex(pkBytes);
  const sig = bigC.subtract(bigY.multiply(a));
  if (sig.equals(G1.ZERO)) throw new Error('CKD response decrypts to the identity point');
  const hashPoint = bls.G1.hashToCurve(Uint8Array.from([...pkBytes, ...appId]), { DST: CKD_DST });
  const lhs = bls.pairing(G1.fromAffine(hashPoint.toAffine()), pk);
  const rhs = bls.pairing(sig, G2.BASE);
  if (!bls.fields.Fp12.eql(lhs, rhs)) throw new Error('CKD response failed the pairing check');
  return sig.toRawBytes(true);
}

export interface DerivedKeys {
  /** secp256k1 private key, 0x-hex (EVM). */
  evmPrivateKey: `0x${string}`;
  /** Ed25519 seed (Stellar `Keypair.fromRawEd25519Seed`). */
  stellarSeed: Uint8Array;
}

/** HKDF-SHA256 the CKD secret into one key per chain family. */
export function deriveChainKeys(secret: Uint8Array): DerivedKeys {
  const evm = hkdf(sha256, secret, HKDF_SALT, HKDF_INFO.evm, 32);
  if (!secp256k1.utils.isValidPrivateKey(evm)) throw new Error('Derived EVM key is out of range');
  const hex = Array.from(evm, (b) => b.toString(16).padStart(2, '0')).join('');
  return { evmPrivateKey: `0x${hex}`, stellarSeed: hkdf(sha256, secret, HKDF_SALT, HKDF_INFO.stellar, 32) };
}
