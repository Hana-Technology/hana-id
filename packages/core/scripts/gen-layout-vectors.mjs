#!/usr/bin/env node
// Writes test/vectors/layouts-v1.json: worked examples of the off-chain byte layouts in docs/batch-b-spec.md (vault
// message, vault record AAD, approval digest, relay id and relay AAD), each with its parts, the whole preimage and the
// digest. It is an independent implementation (node:crypto and Buffer only) that src/layouts.ts must agree with byte
// for byte (test/layouts.test.ts). The on-chain layouts' examples stay in contracts/hana-signer/src/test_fixture.json.
//
//   node packages/core/scripts/gen-layout-vectors.mjs

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'vectors', 'layouts-v1.json');

const SIGNER = 'hana-signer.testnet';
const APP_ID = 'app_0123456789abcdef';
const PARENT = 'https://partner.example';
const PATH = 's1#google#110248495921238986420#0';
const SHARE_ID = Buffer.from(Array.from({ length: 16 }, (_, i) => i + 1));
// Session key: Ed25519 from the 32-byte seed [7; 32], as contracts/hana-signer/scripts/gen-fixtures.mjs uses.
const SEED7 = Buffer.alloc(32, 7);

const hex = (b) => Buffer.from(b).toString('hex');
const sha256 = (b) => createHash('sha256').update(b).digest();
const ascii = (s) => Buffer.from(s, 'utf8');
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const str = (s) => Buffer.concat([u32(Buffer.byteLength(s, 'utf8')), ascii(s)]);
const concat = (parts) => Buffer.concat(parts.map(([, b]) => b));
const seedKey = (seed) => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const PK7 = Buffer.from(createPublicKey(seedKey(SEED7)).export({ format: 'jwk' }).x, 'base64url');

const example = (title, parts, extra = {}) => ({ title, parts: parts.map(([label, b]) => [label, hex(b)]), preimage_hex: hex(concat(parts)), ...extra });

// ---- vault message ----
const vaultParts = (shareId, counter, payload) => [
  ['"hana-id-vault-v1:"', ascii('hana-id-vault-v1:')],
  [`borsh(signer "${SIGNER}")`, str(SIGNER)],
  [`borsh(appId "${APP_ID}")`, str(APP_ID)],
  ['shareId (16)', shareId],
  [`counter ${counter} (u64 LE)`, u64(counter)],
  ['sha256(payload)', sha256(payload)],
];
const vault = (title, shareId, counter, payload) => {
  const parts = vaultParts(shareId, counter, payload);
  return example(title, parts, { payload_hex: hex(payload), signature_seed7_hex: hex(sign(null, concat(parts), seedKey(SEED7))) });
};
const createPayload = Buffer.concat([ascii('share'), str(PARENT)]);

// ---- record AAD ----
const CKD_KEY_HASH = sha256(Buffer.alloc(96, 0xab));
const EXPIRES = 1_800_003_600_000;
const recordParts = [
  ['"hana-id/vault/v1"', ascii('hana-id/vault/v1')],
  [`borsh(signer "${SIGNER}")`, str(SIGNER)],
  [`borsh(appId "${APP_ID}")`, str(APP_ID)],
  [`borsh(path "${PATH}")`, str(PATH)],
  ['sessionPk (32)', PK7],
  ['derivationVersion 1 (u32 LE)', u32(1)],
  ['ckdKeyHash (32) = sha256([0xab; 96])', CKD_KEY_HASH],
  [`borsh(parentOrigin "${PARENT}")`, str(PARENT)],
  [`expiresAtMs ${EXPIRES} (u64 LE)`, u64(EXPIRES)],
];

// ---- approval digest ----
const approvalParts = ({ id, kind, chain, address, context, bytes }) => [
  ['"hana-id/approve/v1"', ascii('hana-id/approve/v1')],
  [`borsh(id "${id}")`, str(id)],
  [`borsh(kind "${kind}")`, str(kind)],
  [`borsh(chain "${chain}")`, str(chain)],
  [`borsh(address "${address}")`, str(address)],
  [`borsh(parentOrigin "${PARENT}")`, str(PARENT)],
  [`borsh(contextString "${context}")`, str(context)],
  [`len(bytes) ${bytes.length} (u32 LE)`, u32(bytes.length)],
  ['bytes', bytes],
];
const approval = (title, input) => {
  const parts = approvalParts(input);
  return example(title, parts, { input: { ...input, parentOrigin: PARENT, bytes: hex(input.bytes) }, digest_hex: hex(sha256(concat(parts))) });
};

// ---- relay ----
const READ_KEY = Buffer.alloc(32, 5);
const RELAY_ID = sha256(READ_KEY).toString('base64url');

const layouts = {
  vault_message_create_share: vault(`Vault message, create share: shareId 16 zero bytes, counter 0, payload "share" ‖ borsh("${PARENT}")`, Buffer.alloc(16), 0, createPayload),
  vault_message_unlock: vault('Vault message, unlock: shareId 01..10, counter 5, payload "unlock"', SHARE_ID, 5, ascii('unlock')),
  vault_message_touch: vault('Vault message, touch: shareId 01..10, counter 6, payload "touch"', SHARE_ID, 6, ascii('touch')),
  vault_message_revoke: vault('Vault message, revoke: shareId 01..10, counter 7, payload "revoke"', SHARE_ID, 7, ascii('revoke')),
  vault_message_revoke_all: vault('Vault message, revoke-all: shareId 01..10, counter 8, payload "revoke-all"', SHARE_ID, 8, ascii('revoke-all')),
  record_aad: example('Vault record AAD', recordParts),
  approval_stellar: approval('Approval digest: Stellar transaction on testnet', {
    id: '00112233445566778899aabbccddeeff',
    kind: 'stellar_signTransaction',
    chain: 'stellar',
    address: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    context: 'Test SDF Network ; September 2015',
    bytes: Buffer.from('0000000200000000', 'hex'),
  }),
  approval_evm: approval('Approval digest: EVM transaction on chain 11155111', {
    id: 'ffeeddccbbaa99887766554433221100',
    kind: 'eth_signTransaction',
    chain: 'evm',
    address: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
    context: '11155111',
    bytes: Buffer.from('02c0', 'hex'),
  }),
  approval_raw_no_context: approval('Approval digest: raw EVM digest, empty context', {
    id: '0123456789abcdef0123456789abcdef',
    kind: 'hana_signRaw',
    chain: 'evm',
    address: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
    context: '',
    bytes: Buffer.alloc(32, 0x11),
  }),
  relay_aad: example(`Relay AAD: relayId = b64url(sha256([5; 32])) = ${RELAY_ID}`, [
    ['"hana-id/relay/v1"', ascii('hana-id/relay/v1')],
    [`relayId "${RELAY_ID}"`, ascii(RELAY_ID)],
  ]),
};
layouts.relay_aad.relay_read_key_hex = hex(READ_KEY);
layouts.relay_aad.relay_id = RELAY_ID;

const fixture = {
  _comment: 'Generated by packages/core/scripts/gen-layout-vectors.mjs (independent of src/layouts.ts). Test-only values.',
  signer: SIGNER,
  app_id: APP_ID,
  parent_origin: PARENT,
  path: PATH,
  session_pk7_hex: hex(PK7),
  layouts,
};
writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${Object.keys(layouts).length} layout examples to ${OUT}`);
