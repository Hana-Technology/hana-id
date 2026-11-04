#!/usr/bin/env node
// Writes test/vectors/identity-v1.json: worked examples of the partner identity token's layouts
// (docs/identity-token-spec.md): the session proof message and its payload, the wallet-proof message, the wallet
// proofs hash, `sub` and `sid`, the sealed-email AAD, an RFC 7638 thumbprint and a claims set with its JWS signing
// input. It is an independent implementation (node:crypto and Buffer only) that src/identity.ts must agree with byte
// for byte (test/identity.test.ts). Test-only keys: never a real one.
//
//   node packages/core/scripts/gen-identity-vectors.mjs

import { createECDH, createHash, createHmac, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'vectors', 'identity-v1.json');

const SIGNER = 'hana-signer.testnet';
const APP_ID = 'app_0123456789abcdef';
const OTHER_APP_ID = 'app_fedcba9876543210';
const PARENT = 'https://partner.example';
const SCOPE = 's1';
const GOOGLE_SUB = '110248495921238986420';
const SUB_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const ISSUED_AT_MS = 1_800_000_000_000;
const NONCE = Buffer.from(Array.from({ length: 16 }, (_, i) => 0xa0 + i));
const SEED7 = Buffer.alloc(32, 7);
const STELLAR_SEED = Buffer.alloc(32, 0x11);
// The EIP-55 spec's own example address (any well-formed address will do for the layouts).
const EVM_ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
// Stands in for an EVM r‖s‖v in the proofs-hash example (the hash doesn't verify signatures).
const EVM_SIG = Buffer.concat([Buffer.alloc(64, 0x42), Buffer.from([27])]);

const hex = (b) => Buffer.from(b).toString('hex');
const b64url = (b) => Buffer.from(b).toString('base64url');
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
const vec = (b) => Buffer.concat([u32(b.length), b]);
const concat = (parts) => Buffer.concat(parts.map(([, b]) => b));
const seedKey = (seed) => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const pubOf = (seed) => Buffer.from(createPublicKey(seedKey(seed)).export({ format: 'jwk' }).x, 'base64url');
const PK7 = pubOf(SEED7);

// SEP-23 strkey: base32(version ‖ payload ‖ crc16-xmodem LE), RFC 4648 alphabet, no padding.
function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
function base32(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function strkey(pk) {
  const raw = Buffer.concat([Buffer.from([6 << 3]), pk]);
  const crc = crc16(raw);
  return base32(Buffer.concat([raw, Buffer.from([crc & 0xff, crc >> 8])]));
}
const STELLAR_ADDRESS = strkey(pubOf(STELLAR_SEED));

const example = (title, parts, extra = {}) => ({ title, parts: parts.map(([label, b]) => [label, hex(b)]), preimage_hex: hex(concat(parts)), ...extra });

// ---- wallet proofs ----
const walletParts = (chain, address, appId = APP_ID) => [
  ['"hana-id/identity-wallet/v1"', ascii('hana-id/identity-wallet/v1')],
  ['0x00', Buffer.from([0])],
  [`borsh(signer "${SIGNER}")`, str(SIGNER)],
  [`borsh(appId "${appId}")`, str(appId)],
  ['sessionPk (32), seed [7; 32]', PK7],
  [`borsh(chain "${chain}")`, str(chain)],
  [`borsh(address "${address}")`, str(address)],
];
const stellarWallet = walletParts('stellar', STELLAR_ADDRESS);
const STELLAR_SIG = sign(null, concat(stellarWallet), seedKey(STELLAR_SEED));
const evmWallet = walletParts('evm', EVM_ADDRESS);

const proofsParts = [
  ['"hana-id/identity-wallet-proofs/v1"', ascii('hana-id/identity-wallet-proofs/v1')],
  ['0x00', Buffer.from([0])],
  ['borsh("stellar")', str('stellar')],
  [`borsh(address "${STELLAR_ADDRESS}")`, str(STELLAR_ADDRESS)],
  ['borsh(Vec<u8> stellar signature, 64)', vec(STELLAR_SIG)],
  ['borsh("evm")', str('evm')],
  [`borsh(address "${EVM_ADDRESS}")`, str(EVM_ADDRESS)],
  ['borsh(Vec<u8> evm signature, 65)', vec(EVM_SIG)],
];
const PROOFS_HASH = sha256(concat(proofsParts));

// ---- session proof ----
const payloadParts = (sealedEmail) => [
  ['"identity-token"', ascii('identity-token')],
  [`borsh(parentOrigin "${PARENT}")`, str(PARENT)],
  ['walletProofsHash (32)', PROOFS_HASH],
  [`sha256(utf8(sealedEmail "${sealedEmail}"))`, sha256(ascii(sealedEmail))],
];
const messageParts = (payload) => [
  ['"hana-id-identity-v1:"', ascii('hana-id-identity-v1:')],
  [`borsh(signer "${SIGNER}")`, str(SIGNER)],
  [`borsh(appId "${APP_ID}")`, str(APP_ID)],
  ['sessionPk (32), seed [7; 32]', PK7],
  [`issuedAtMs ${ISSUED_AT_MS} (u64 LE)`, u64(ISSUED_AT_MS)],
  ['nonce (16) a0..af', NONCE],
  ['sha256(payload)', sha256(payload)],
];
const message = (title, sealedEmail) => {
  const payload = concat(payloadParts(sealedEmail));
  const parts = messageParts(payload);
  return example(title, parts, { sealed_email: sealedEmail, payload_hex: hex(payload), signature_seed7_hex: hex(sign(null, concat(parts), seedKey(SEED7))) });
};

// ---- sub, sid ----
const subParts = (scope, provider, sub) => [
  ['"hana-id/idt-sub/v1"', ascii('hana-id/idt-sub/v1')],
  ['0x00', Buffer.from([0])],
  [`borsh(scope "${scope}")`, str(scope)],
  [`borsh(provider "${provider}")`, str(provider)],
  [`borsh(sub "${sub}")`, str(sub)],
];
const mac16 = (input) => createHmac('sha256', SUB_KEY).update(input).digest().subarray(0, 16);
const subExample = (title, path, scope, provider, sub) => {
  const parts = subParts(scope, provider, sub);
  const bytes = mac16(concat(parts));
  return example(title, parts, { path, sub_bytes_hex: hex(bytes), sub: `u1_${b64url(bytes)}` });
};
const sidExample = (title, appId) => {
  const parts = [
    ['"hana-id/idt-sid/v1"', ascii('hana-id/idt-sid/v1')],
    ['0x00', Buffer.from([0])],
    [`borsh(appId "${appId}")`, str(appId)],
    ['sessionPk (32), seed [7; 32]', PK7],
  ];
  return example(title, parts, { app_id: appId, sid: `s1_${b64url(mac16(concat(parts)))}` });
};

// ---- sealed email AAD ----
const NOT_AFTER = 1_800_043_200_000;
const sealedAad = example('Sealed-email AAD', [
  ['"hana-id/sealed-email/v1"', ascii('hana-id/sealed-email/v1')],
  ['0x00', Buffer.from([0])],
  [`borsh(appId "${APP_ID}")`, str(APP_ID)],
  ['sessionPk (32), seed [7; 32]', PK7],
  [`notAfterMs ${NOT_AFTER} (u64 LE)`, u64(NOT_AFTER)],
]);
sealedAad.not_after_ms = NOT_AFTER;

// ---- thumbprint: a P-256 key from a fixed scalar ----
const ecdh = createECDH('prime256v1');
ecdh.setPrivateKey(Buffer.alloc(32, 0x24));
const pub = ecdh.getPublicKey(); // 0x04 ‖ x ‖ y
const P256 = { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) };
const THUMB_INPUT = `{"crv":"P-256","kty":"EC","x":"${P256.x}","y":"${P256.y}"}`;
const KID = b64url(sha256(ascii(THUMB_INPUT)));

// ---- claims and signing input ----
const SUB = subExample('', `${SCOPE}#google#${GOOGLE_SUB}#0`, SCOPE, 'google', GOOGLE_SUB).sub;
const SID = sidExample('', APP_ID).sid;
const JTI = Buffer.from(Array.from({ length: 16 }, (_, i) => 0x30 + i));
const CLAIMS_INPUT = {
  iss: 'https://api.example/v1/identity',
  aud: APP_ID,
  sub: SUB,
  sid: SID,
  iat: 1_800_000_000,
  exp: 1_800_003_600,
  jti_hex: hex(JTI),
  wallets: { stellar: STELLAR_ADDRESS, evm: EVM_ADDRESS },
  login_methods_unsorted: ['google', 'email', 'google'],
};
const CLAIMS = {
  iss: CLAIMS_INPUT.iss,
  aud: APP_ID,
  sub: SUB,
  sid: SID,
  iat: CLAIMS_INPUT.iat,
  exp: CLAIMS_INPUT.exp,
  jti: b64url(JTI),
  wallets: [
    { chain: 'stellar', address: STELLAR_ADDRESS },
    { chain: 'evm', address: EVM_ADDRESS },
  ],
  login_methods: ['email', 'google'],
};
const HEADER = { alg: 'ES256', kid: KID, typ: 'hana-identity+jwt' };
const SIGNING_INPUT = `${b64url(ascii(JSON.stringify(HEADER)))}.${b64url(ascii(JSON.stringify(CLAIMS)))}`;

const fixture = {
  _comment: 'Generated by packages/core/scripts/gen-identity-vectors.mjs (independent of src/identity.ts). Test-only keys.',
  signer: SIGNER,
  app_id: APP_ID,
  parent_origin: PARENT,
  scope_id: SCOPE,
  sub_key_hex: hex(SUB_KEY),
  session_pk7_hex: hex(PK7),
  issued_at_ms: ISSUED_AT_MS,
  nonce_hex: hex(NONCE),
  stellar_seed_hex: hex(STELLAR_SEED),
  stellar_address: STELLAR_ADDRESS,
  evm_address: EVM_ADDRESS,
  evm_signature_hex: hex(EVM_SIG),
  layouts: {
    wallet_proof_stellar: example('Wallet proof message, Stellar', stellarWallet, { signature_hex: hex(STELLAR_SIG) }),
    wallet_proof_evm: example('Wallet proof message, EVM (the key signs sha256 of it)', evmWallet, { digest_hex: hex(sha256(concat(evmWallet))) }),
    wallet_proof_evm_other_app: example('Wallet proof message, EVM, another app', walletParts('evm', EVM_ADDRESS, OTHER_APP_ID)),
    wallet_proofs_hash: example('Wallet proofs hash (stellar, then evm)', proofsParts, { hash_hex: hex(PROOFS_HASH) }),
    identity_message: message('Session proof: no sealed email', ''),
    identity_message_sealed: message('Session proof: with a sealed email blob', 'se1.AAAA'),
    sealed_email_aad: sealedAad,
  },
  subs: {
    google_k0: subExample('sub: Google root, key_index 0', `${SCOPE}#google#${GOOGLE_SUB}#0`, SCOPE, 'google', GOOGLE_SUB),
    google_k1: subExample('sub: Google root, key_index 1 (the same sub)', `${SCOPE}#google#${GOOGLE_SUB}#1`, SCOPE, 'google', GOOGLE_SUB),
    google_other_scope: subExample('sub: the same Google user in scope s2', `s2#google#${GOOGLE_SUB}#0`, 's2', 'google', GOOGLE_SUB),
    email_root: subExample('sub: an email-login root', `${SCOPE}#email#Zx9yW8v7U6t5S4r3Q2p1Ow#0`, SCOPE, 'email', 'Zx9yW8v7U6t5S4r3Q2p1Ow'),
  },
  sids: {
    app: sidExample('sid: app_0123456789abcdef, session key seed 7', APP_ID),
    other_app: sidExample('sid: another app, the same session key', OTHER_APP_ID),
  },
  thumbprint: { scalar_hex: hex(Buffer.alloc(32, 0x24)), jwk: P256, input: THUMB_INPUT, kid: KID },
  claims: { input: CLAIMS_INPUT, json: JSON.stringify(CLAIMS), header_json: JSON.stringify(HEADER), signing_input: SIGNING_INPUT },
};
writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote identity vectors to ${OUT}`);
