// Test helpers: JSON fixtures (read with node:fs so the vectors' exact bytes can also be hashed) and keys.
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { base58 } from '@scure/base';
import { readFileSync } from 'node:fs';
import { concatBytes, fromHex } from '../src/bytes.ts';
import { CKD_DST } from '../src/ckd.ts';

export const readText = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');
export const readJson = <T>(relative: string): T => JSON.parse(readText(relative)) as T;

export interface Example {
  title: string;
  parts: [string, string][];
  preimage_hex: string;
  nonce?: string;
  [extra: string]: unknown;
}

export interface ContractFixture {
  signer: string;
  other_signer: string;
  kid: string;
  n: string;
  e: string;
  session_pk7_hex: string;
  session_pk8_hex: string;
  layouts: Record<string, Example & { pk1?: string; pk2?: string }>;
  nonces: Record<string, string>;
  tokens: Record<string, string>;
}

/** contracts/hana-signer/src/test_fixture.json (written by contracts/hana-signer/scripts/gen-fixtures.mjs). */
export const contractFixture = (): ContractFixture => readJson('../../../contracts/hana-signer/src/test_fixture.json');

/** A WebCrypto Ed25519 private key from a 32-byte seed (PKCS#8 wrapping, as the fixture generators do). */
export function ed25519KeyFromSeed(seed: Uint8Array): Promise<CryptoKey> {
  const pkcs8 = concatBytes(fromHex('302e020100300506032b657004220420'), seed);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

// ---- simulated MPC (ported from apps/smoke/test/ckd.test.ts) ----

const G1 = bls.G1.ProjectivePoint;
const G2 = bls.G2.ProjectivePoint;
export const g1 = (p: InstanceType<typeof G1>): string => `bls12381g1:${base58.encode(p.toRawBytes(true))}`;

/** A fixed MPC master key so a network key can be pinned across calls. */
export function mpcNetwork(msk = bls.G1.normPrivateKeyToScalar(bls.utils.randomPrivateKey())) {
  const pkBytes = G2.BASE.multiply(msk).toRawBytes(true);
  return { msk, pkBytes, networkKey: `bls12381g2:${base58.encode(pkBytes)}` };
}

/** Plays the MPC side, as near/mpc's ckd-example-cli test does: (Y, C) = (y·G1, msk·H + y·A). */
export function simulateMpc(appPk1: string, appId: Uint8Array, net = mpcNetwork()) {
  const h = G1.fromAffine(bls.G1.hashToCurve(Uint8Array.from([...net.pkBytes, ...appId]), { DST: CKD_DST }).toAffine());
  const y = bls.G1.normPrivateKeyToScalar(bls.utils.randomPrivateKey());
  const a1 = G1.fromHex(base58.decode(appPk1.slice('bls12381g1:'.length)));
  const response = { big_y: g1(G1.BASE.multiply(y)), big_c: g1(h.multiply(net.msk).add(a1.multiply(y))) };
  return { response, networkKey: net.networkKey, expected: h.multiply(net.msk).toRawBytes(true) };
}
