// NEAR Confidential Key Derivation (CKD), client side. Moved from apps/smoke/src/ckd.ts (ported from
// legacy/client/ckd.ts, itself ported from near/mpc @ a7ae426: crates/ckd-example-cli/src/ckd.rs,
// crates/near-mpc-crypto-types/src/kdf.rs, crates/contract/src/primitives/ckd.rs). The pinned-key checks
// (`isValidNetworkKey`, `ckdKeyProblem`) moved here from apps/smoke/src/config.ts.
//
// - app key: random scalar a; publicly verifiable form (a·G1, a·G2), checked on-chain by a pairing.
// - response (big_y, big_c) = (y·G1, msk·H + y·a·G1), so the secret sig = big_c − a·big_y = msk·H.
// - H = hash_to_curve_G1(network_pk_G2_compressed ‖ app_id, DST "NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_").
// - app_id = SHA3-256("near-mpc v0.1.0 app_id derivation:" ‖ account ‖ "," ‖ path); account = the contract that called
//   the MPC (hana-signer, the pinned SIGNER).
// - verify e(H, pk) = e(sig, G2) against the pinned network key; the secret bytes are sig's 48-byte compressed form.
// SECURITY: the output of decryptCkd is a full private key (S, the IKM of derivation v1). Never log, display, persist
// or send it; derivation.ts extractPrk consumes and zeroes it.
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { sha3_256 } from '@noble/hashes/sha3';
import { base58 } from '@scure/base';
import { type Bytes, concatBytes, sha256, toBytes, utf8 } from './bytes.ts';

const G1 = bls.G1.ProjectivePoint;
const G2 = bls.G2.ProjectivePoint;
export const CKD_DST = 'NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_';
const APP_ID_PREFIX = 'near-mpc v0.1.0 app_id derivation:';
export const G1_PREFIX = 'bls12381g1:';
export const G2_PREFIX = 'bls12381g2:';
/** Length of S, the compressed G1 point decryptCkd returns. */
export const CKD_SECRET_BYTES = 48;

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

/** The pinned network key as a validated G2 point plus its 96-byte compressed encoding. Throws if invalid. */
export function parseNetworkKey(key: string): { point: InstanceType<typeof G2>; bytes: Bytes } {
  const bytes = toBytes(decodePoint(key, G2_PREFIX));
  if (bytes.length !== 96) throw new Error('CKD network key must be a 96-byte compressed G2 point');
  const point = G2.fromHex(bytes);
  point.assertValidity();
  if (point.equals(G2.ZERO)) throw new Error('CKD network key is the identity point');
  return { point, bytes };
}

/** True if `key` is a usable pinned CKD network key (`bls12381g2:<base58 of a valid compressed G2 point>`). */
export function isValidNetworkKey(key: string): boolean {
  try {
    parseNetworkKey(key);
    return true;
  } catch {
    return false;
  }
}

/** Why the pinned CKD key of `envs/<name>.json` can't be used, or null. The web build and smoke refuse to run on one. */
export function ckdKeyProblem(env: { name: string; ckdNetworkKey: string }, isValidKey: (key: string) => boolean = isValidNetworkKey): string | null {
  if (env.ckdNetworkKey.includes('UNSET')) {
    return `envs/${env.name}.json ckdNetworkKey is still the UNSET placeholder. Pin it with \`pnpm --filter @hana-id/scripts fetch-ckd-key ${env.name}\` and restart the dev server.`;
  }
  if (!isValidKey(env.ckdNetworkKey)) return `envs/${env.name}.json ckdNetworkKey is not a valid bls12381g2 point.`;
  return null;
}

/** sha256 of the pinned key's 96-byte compressed G2 (the vault record's `ckdKeyHash`). */
export const ckdKeyHash = (networkKey: string): Bytes => sha256(parseNetworkKey(networkKey).bytes);

/** A fresh ephemeral BLS12-381 key (publicly verifiable form, so the MPC contract can check it). */
export function newAppKey(): AppKey {
  const a = bls.G1.normPrivateKeyToScalar(bls.utils.randomPrivateKey());
  return { a, publicKey: { AppPublicKeyPV: { pk1: encodeG1(G1.BASE.multiply(a)), pk2: encodeG2(G2.BASE.multiply(a)) } } };
}

/** The CKD app id the MPC uses for a caller account (the pinned SIGNER) and derivation path. */
export const ckdAppId = (account: string, path: string): Bytes => toBytes(sha3_256(utf8(`${APP_ID_PREFIX}${account},${path}`)));

/**
 * Decrypts the MPC response with the ephemeral key and checks it really is the network's BLS signature on
 * H(pk, app_id). Returns the 48-byte secret S. Throws if the check fails (wrong key, tampered response, wrong app id or
 * network key, identity point). The thrown messages never contain key material.
 */
export function decryptCkd(response: CkdResponse, a: bigint, appId: Uint8Array, networkPublicKey: string): Bytes {
  if (appId.length !== 32) throw new Error('CKD app id must be 32 bytes');
  const bigY = G1.fromHex(decodePoint(response.big_y, G1_PREFIX));
  const bigC = G1.fromHex(decodePoint(response.big_c, G1_PREFIX));
  bigY.assertValidity();
  bigC.assertValidity();
  const { point: pk, bytes: pkBytes } = parseNetworkKey(networkPublicKey);
  const sig = bigC.subtract(bigY.multiply(a));
  if (sig.equals(G1.ZERO)) throw new Error('CKD response decrypts to the identity point');
  const hashPoint = bls.G1.hashToCurve(concatBytes(pkBytes, appId), { DST: CKD_DST });
  const lhs = bls.pairing(G1.fromAffine(hashPoint.toAffine()), pk);
  const rhs = bls.pairing(sig, G2.BASE);
  if (!bls.fields.Fp12.eql(lhs, rhs)) throw new Error('CKD response failed the pairing check');
  // Returned in place (no copy), so the caller's zeroing reaches the only buffer.
  return sig.toRawBytes(true) as Bytes;
}
