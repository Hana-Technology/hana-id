// Checks of the browser's ephemeral BLS12-381 app key `(pk1, pk2) = (a·G1, a·G2)` before a CKD request is relayed.
// The MPC verifies e(pk1, g2) = e(g1, pk2) itself and rejects a bad key; but by then the transaction has been paid
// for, and on /v1/login the session has been committed with its only use spent. These checks stop such keys first.
import { baseDecode } from '@near-js/utils';

export const G1_PREFIX = 'bls12381g1:';
export const G2_PREFIX = 'bls12381g2:';
/** Compressed point sizes (ZCash serialization, as the MPC's `bls12381g1:`/`bls12381g2:` base58 strings carry). */
const G1_BYTES = 48;
const G2_BYTES = 96;

function decode(text: string, prefix: string): Uint8Array | null {
  if (!text.startsWith(prefix)) return null;
  try {
    return new Uint8Array(baseDecode(text.slice(prefix.length)));
  } catch {
    return null;
  }
}

/** Compressed (flag 0x80) and not the point at infinity (flag 0x40): a = 0 would leave the CKD unencrypted. */
const compressedFinite = (bytes: Uint8Array, size: number): boolean => bytes.length === size && (bytes[0]! & 0xc0) === 0x80;

/**
 * Why `(pk1, pk2)` can't be an app key, or null: each must carry its prefix and base58-decode to one compressed,
 * non-identity point of the right size. Cheap (no curve arithmetic), so it always runs.
 */
export function appKeyProblem(pk1: string, pk2: string): string | null {
  const p1 = decode(pk1, G1_PREFIX);
  if (!p1 || !compressedFinite(p1, G1_BYTES)) return `pk1 must be ${G1_PREFIX} and a compressed G1 point (${G1_BYTES} bytes)`;
  const p2 = decode(pk2, G2_PREFIX);
  if (!p2 || !compressedFinite(p2, G2_BYTES)) return `pk2 must be ${G2_PREFIX} and a compressed G2 point (${G2_BYTES} bytes)`;
  return null;
}

/**
 * The pairing check the MPC runs, as one multi-pairing with a single final exponentiation:
 * e(pk1, −g2) · e(g1, pk2) = 1, with both points on their curves and in their subgroups. False for anything else.
 * Costly in pure JS (behind BLS_PRECHECK: Workers Paid plan only, after measuring), so the curve library is only
 * loaded when it runs.
 */
export async function appKeyPairs(pk1: string, pk2: string): Promise<boolean> {
  const p1 = decode(pk1, G1_PREFIX);
  const p2 = decode(pk2, G2_PREFIX);
  if (!p1 || !p2) return false;
  const { bls12_381: bls } = await import('@noble/curves/bls12-381');
  try {
    // fromHex checks the point is on the curve and in the prime-order subgroup; pairingBatch refuses the identity.
    const a1 = bls.G1.ProjectivePoint.fromHex(p1);
    const a2 = bls.G2.ProjectivePoint.fromHex(p2);
    const product = bls.pairingBatch([
      { g1: a1, g2: bls.G2.ProjectivePoint.BASE.negate() },
      { g1: bls.G1.ProjectivePoint.BASE, g2: a2 },
    ]);
    return bls.fields.Fp12.eql(product, bls.fields.Fp12.ONE);
  } catch {
    return false;
  }
}
