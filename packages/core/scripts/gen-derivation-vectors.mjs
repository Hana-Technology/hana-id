#!/usr/bin/env node
// Writes test/vectors/derivation-v1.json: the FROZEN golden vectors of derivation v1 (docs/batch-b-spec.md
// "Derivation v1"). It is an independent implementation: HKDF from node:crypto HMAC, the EVM key by a BigInt
// FIPS 186-5 A.2.1 reduction, Ed25519 public keys from node:crypto, StrKeys from @stellar/stellar-base and EVM
// addresses from viem. Only S (the CKD secret) comes from @noble/curves, via a simulated MPC with a fixed TEST master
// key (not a real network key), so the vectors also cover path → app_id → S for key_index variants.
//
// Run once to create the file; afterwards it only re-checks: it refuses to overwrite a file whose content would
// change (an address-changing edit) unless --force is passed, which must never happen after the address freeze.
//
//   node packages/core/scripts/gen-derivation-vectors.mjs           # write if absent, else verify
//   node packages/core/scripts/gen-derivation-vectors.mjs --force   # rewrite (before the address freeze only)
//
// The output holds test-only private keys derived from public test inputs; none of them is ever used on a network.

import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { StrKey } from '@stellar/stellar-base';
import { base58 } from '@scure/base';
import { createHash, createHmac, createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'vectors', 'derivation-v1.json');

const EXTRACT_SALT = 'hana-id/chain-keys/v1/extract';
const EXPAND_LABEL = 'hana-id/chain-keys/v1/expand';
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SIGNER = 'hana-signer.testnet';
const SUB = '110248495921238986420';
const CKD_DST = 'NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_';

const hex = (b) => Buffer.from(b).toString('hex');
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const str = (s) => {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([u32(bytes.length), bytes]);
};
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** RFC 5869 HKDF-Extract and HKDF-Expand, written out. */
const hkdfExtract = (salt, ikm) => hmac(salt, ikm);
function hkdfExpand(prk, info, length) {
  const blocks = [];
  let t = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(blocks).length < length; i++) {
    t = hmac(prk, Buffer.concat([t, info, Buffer.from([i])]));
    blocks.push(t);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

const info = (ns, curve, account) => Buffer.concat([str(EXPAND_LABEL), str(ns), str(curve), u32(account)]);

function reduce(okm) {
  const d = (BigInt(`0x${hex(okm)}`) % (SECP256K1_N - 1n)) + 1n;
  return Buffer.from(d.toString(16).padStart(64, '0'), 'hex');
}

function ed25519PublicKey(seed) {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const jwk = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url');
}

// ---- simulated MPC with a fixed TEST master key ----
const G1 = bls.G1.ProjectivePoint;
const G2 = bls.G2.ProjectivePoint;
/** The TEST master scalar is sha256(MSK_PREIMAGE) mod r; the vectors record the preimage, not the scalar. */
const MSK_PREIMAGE = 'hana-id test mpc master key v1';
const msk = BigInt(`0x${createHash('sha256').update(MSK_PREIMAGE).digest('hex')}`) % bls.fields.Fr.ORDER;
const networkPkBytes = G2.BASE.multiply(msk).toRawBytes(true);
const networkKey = `bls12381g2:${base58.encode(networkPkBytes)}`;
const appId = (path) => createHash('sha3-256').update(`near-mpc v0.1.0 app_id derivation:${SIGNER},${path}`).digest();
function ckdSecret(path) {
  const h = G1.fromAffine(bls.G1.hashToCurve(Uint8Array.from([...networkPkBytes, ...appId(path)]), { DST: CKD_DST }).toAffine());
  return Buffer.from(h.multiply(msk).toRawBytes(true));
}

const sources = [
  { label: 's1, key_index 0', path: `s1#google#${SUB}#0` },
  { label: 's1, key_index 1', path: `s1#google#${SUB}#1` },
  { label: 's2 (other scope), key_index 0', path: `s2#google#${SUB}#0` },
  { label: 's1, other sub, key_index 0', path: 's1#google#987654321#0' },
  { label: 'S = G1 generator (synthetic)', s: Buffer.from(G1.BASE.toRawBytes(true)) },
  { label: 'S = 2·G1 generator (synthetic)', s: Buffer.from(G1.BASE.multiply(2n).toRawBytes(true)) },
];

const vectors = sources.map((src) => {
  const s = src.s ?? ckdSecret(src.path);
  const prk = hkdfExtract(Buffer.from(EXTRACT_SALT, 'utf8'), s);
  const accounts = [0, 1].map((account) => {
    const sInfo = info('stellar', 'ed25519', account);
    const seed = hkdfExpand(prk, sInfo, 32);
    const eInfo = info('eip155', 'secp256k1', account);
    const okm = hkdfExpand(prk, eInfo, 48);
    const d = reduce(okm);
    return {
      account,
      stellar: {
        infoHex: hex(sInfo),
        seedHex: hex(seed),
        address: StrKey.encodeEd25519PublicKey(ed25519PublicKey(seed)),
        export: StrKey.encodeEd25519SecretSeed(seed),
      },
      evm: {
        infoHex: hex(eInfo),
        okmHex: hex(okm),
        dHex: hex(d),
        address: privateKeyToAccount(`0x${hex(d)}`).address,
        export: `0x${hex(d)}`,
      },
    };
  });
  return {
    label: src.label,
    ...(src.path ? { path: src.path, appIdHex: hex(appId(src.path)) } : {}),
    sHex: hex(s),
    prkHex: hex(prk),
    accounts,
  };
});

const out = {
  _comment:
    'FROZEN derivation v1 vectors (packages/core/scripts/gen-derivation-vectors.mjs). Test-only keys from public test inputs. Changing this file changes every address: see test/derivation.test.ts.',
  version: 1,
  extractSalt: EXTRACT_SALT,
  expandLabel: EXPAND_LABEL,
  tuples: { stellar: ['stellar', 'ed25519', 32], evm: ['eip155', 'secp256k1', 48] },
  mpc: { signer: SIGNER, mskPreimage: MSK_PREIMAGE, networkKey },
  vectors,
};
const text = `${JSON.stringify(out, null, 2)}\n`;

if (existsSync(OUT) && !process.argv.includes('--force')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error(`${OUT} differs from what this generator computes: address-changing edit. Refusing to overwrite (use --force only before the address freeze).`);
    process.exit(1);
  }
  console.log(`${OUT} is up to date (${vectors.length} vectors)`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${vectors.length} vectors to ${OUT}`);
}
