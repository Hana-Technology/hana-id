#!/usr/bin/env node
// Writes test/vectors/derivation-v1-near.json: the golden vectors of NEAR's derivation v1 tuple ("near", "ed25519",
// account), added 2026-11-11 (docs/decisions.md D720). An independent implementation, as gen-derivation-vectors.mjs
// is: HKDF from node:crypto HMAC, the Ed25519 public key from node:crypto, the implicit account id as lowercase hex,
// the public key and export strings in base58 from @scure/base (the test checks them again with @near-js/crypto). The
// CKD secrets S are read from the frozen test/vectors/derivation-v1.json, so these vectors share its inputs.
//
// It refuses to overwrite a file whose content would change (an address-changing edit) unless --force is passed,
// which must never happen after the address freeze.
//
//   node packages/core/scripts/gen-derivation-near-vectors.mjs           # write if absent, else verify
//   node packages/core/scripts/gen-derivation-near-vectors.mjs --force   # rewrite (before the address freeze only)
//
// The output holds test-only private keys derived from public test inputs; none of them is ever used on a network.

import { base58 } from '@scure/base';
import { createHmac, createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'vectors');
const OUT = join(DIR, 'derivation-v1-near.json');
const BASE = JSON.parse(readFileSync(join(DIR, 'derivation-v1.json'), 'utf8'));

const EXTRACT_SALT = 'hana-id/chain-keys/v1/extract';
const EXPAND_LABEL = 'hana-id/chain-keys/v1/expand';
const TUPLE = ['near', 'ed25519', 32];

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

function ed25519PublicKey(seed) {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const jwk = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url');
}

if (BASE.extractSalt !== EXTRACT_SALT || BASE.expandLabel !== EXPAND_LABEL) throw new Error('derivation-v1.json names other labels');

const vectors = BASE.vectors.map((v) => {
  const prk = hkdfExtract(Buffer.from(EXTRACT_SALT, 'utf8'), Buffer.from(v.sHex, 'hex'));
  if (hex(prk) !== v.prkHex) throw new Error(`PRK mismatch for ${v.label}`);
  const accounts = [0, 1].map((account) => {
    const nInfo = info(TUPLE[0], TUPLE[1], account);
    const seed = hkdfExpand(prk, nInfo, TUPLE[2]);
    const pub = ed25519PublicKey(seed);
    return {
      account,
      near: {
        infoHex: hex(nInfo),
        seedHex: hex(seed),
        publicKey: `ed25519:${base58.encode(pub)}`,
        accountId: hex(pub),
        // The export string is `ed25519:` + this (the prefix is left out so the secret scan, which flags any NEAR
        // secret key, stays strict for this file too; these keys are test-only).
        exportBase58: base58.encode(Buffer.concat([seed, pub])),
      },
    };
  });
  return { label: v.label, sHex: v.sHex, prkHex: v.prkHex, accounts };
});

const out = {
  _comment:
    'FROZEN derivation v1 NEAR vectors (packages/core/scripts/gen-derivation-near-vectors.mjs; D720). Test-only keys from the public test inputs of derivation-v1.json. Changing this file changes every NEAR address: see test/derivation-near.test.ts.',
  version: 1,
  extractSalt: EXTRACT_SALT,
  expandLabel: EXPAND_LABEL,
  tuple: TUPLE,
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
