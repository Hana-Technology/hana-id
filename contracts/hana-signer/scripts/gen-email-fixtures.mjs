#!/usr/bin/env node
// Generates src/email_fixture.json for the contract's email-login unit tests (docs/email-login-spec.md): an
// independent JS implementation of the identity key and of the link_new, link_account, link_change and auto_link
// nonces (worked examples the Rust tests compare byte for byte, and docs/contract-interface.md quotes), plus email
// tokens in the JWS General JSON Serialization signed by two throwaway RSA keys (generated here, private halves kept
// only in memory, never written anywhere): one for signer "hana" and one for a co-signer.
//
// It is separate from gen-fixtures.mjs on purpose: regenerating test_fixture.json changes its Google test key, which
// v2_state_fixture.json embeds (its migrate tests verify fixture tokens after the
// migration). This file has no such dependency and may be regenerated at any time.
//
//   node contracts/hana-signer/scripts/gen-email-fixtures.mjs           # writes src/email_fixture.json
//   node contracts/hana-signer/scripts/gen-email-fixtures.mjs --doc     # also prints the worked examples as Markdown
//
// Scenario constants must match src/tests.rs (and gen-fixtures.mjs for the session nonce inputs).

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'email_fixture.json');

const NOW_MS = 1_800_000_000_000n;
const NOW_S = Number(NOW_MS / 1000n);
const TOKEN_EXP = NOW_S + 3 * 3600;
const EXPIRES_MS = NOW_MS + 3_600_000n;
const SALT = Buffer.alloc(16, 9);
const MAX_USES = 3;
const SIGNER = 'hana-signer.testnet';
const USER = '1098765432';
const S1 = 's1';

const EMAIL_ISS = 'https://api.sandbox.hana-id.test/v1/email';
const EMAIL_KID = 'hana-email-1';
const COSIGN_KID = 'cosign-1';

// ---- encodings (docs/contract-interface.md "Borsh encodings used above") ----

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (buf) => createHash('sha256').update(buf).digest();
const hex = (buf) => Buffer.from(buf).toString('hex');
const u8 = (n) => Buffer.from([n]);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s) => { const bytes = Buffer.from(s, 'utf8'); return Buffer.concat([u32(bytes.length), bytes]); };
const ascii = (s) => Buffer.from(s, 'utf8');
const concat = (parts) => Buffer.concat(parts.map(([, bytes]) => bytes));
const nonceOf = (parts) => b64url(sha256(concat(parts)));

const ed25519Public = (seedByte) => {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seedByte)]);
  return Buffer.from(createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x, 'base64url');
};
const PK7 = ed25519Public(7);

// The session nonce (as gen-fixtures.mjs): the auto_link nonce commits to the hash of this preimage.
const sessionParts = ({ scopeId, pk, expiresAtMs, keyIndex = 0, maxUses = MAX_USES, salt = SALT }) => [
  ['domain "hana-id/session/v1"', ascii('hana-id/session/v1')],
  [`borsh(signer) "${SIGNER}"`, str(SIGNER)],
  [`borsh(scope_id) "${scopeId}"`, str(scopeId)],
  ['session_public_key (32 bytes)', pk],
  [`expires_at_ms u64 LE (${expiresAtMs})`, u64(expiresAtMs)],
  [`key_index u32 LE (${keyIndex})`, u32(keyIndex)],
  [`max_uses u32 LE (${maxUses})`, u32(maxUses)],
  [`salt (${salt.length} bytes)`, salt],
];
const identityParts = (scopeId, provider, sub) => [
  ['domain "hana-id/identity/v1"', ascii('hana-id/identity/v1')],
  [`borsh(scope_id) "${scopeId}"`, str(scopeId)],
  [`borsh(provider) "${provider}"`, str(provider)],
  [`borsh(sub) "${sub}"`, str(sub)],
];
const identityKey = (scopeId, provider, sub) => sha256(concat(identityParts(scopeId, provider, sub)));
const linkNewParts = ({ scopeId, root, provider, epoch, salt = SALT }) => [
  ['domain "hana-id/link-new/v1"', ascii('hana-id/link-new/v1')],
  [`borsh(signer) "${SIGNER}"`, str(SIGNER)],
  [`borsh(scope_id) "${scopeId}"`, str(scopeId)],
  ['root_ik (32 bytes)', root],
  [`borsh(new provider) "${provider}"`, str(provider)],
  [`epoch u64 LE (${epoch})`, u64(epoch)],
  [`salt (${salt.length} bytes)`, salt],
];
const linkAccountParts = ({ scopeId, root, newIk, epoch, salt = SALT }) => [
  ['domain "hana-id/link-account/v1"', ascii('hana-id/link-account/v1')],
  [`borsh(signer) "${SIGNER}"`, str(SIGNER)],
  [`borsh(scope_id) "${scopeId}"`, str(scopeId)],
  ['root_ik (32 bytes)', root],
  ['new_ik (32 bytes)', newIk],
  [`epoch u64 LE (${epoch})`, u64(epoch)],
  [`salt (${salt.length} bytes)`, salt],
];
const linkChangeParts = ({ scopeId, action, root, member, epoch, salt = SALT }) => [
  ['domain "hana-id/link-change/v1"', ascii('hana-id/link-change/v1')],
  [`borsh(signer) "${SIGNER}"`, str(SIGNER)],
  [`borsh(scope_id) "${scopeId}"`, str(scopeId)],
  [`borsh(action) "${action}"`, str(action)],
  ['root_ik (32 bytes)', root],
  ['member_ik (32 bytes)', member],
  [`epoch u64 LE (${epoch})`, u64(epoch)],
  [`salt (${salt.length} bytes)`, salt],
];
// join: 1 = the session identity joins the link identity's account (case A), 2 = the link identity joins the
// session identity's account (cases B, C).
const autoLinkParts = ({ scopeId, sessionHash, sessionIk, join, joiner, targetRoot, epoch, immediate }) => [
  ['domain "hana-id/auto-link/v1"', ascii('hana-id/auto-link/v1')],
  [`borsh(signer) "${SIGNER}"`, str(SIGNER)],
  [`borsh(scope_id) "${scopeId}"`, str(scopeId)],
  ['sha256(session nonce preimage) (32 bytes)', sessionHash],
  ['session_ik (32 bytes)', sessionIk],
  [`join u8 (${join})`, u8(join)],
  ['joiner_ik (32 bytes)', joiner],
  ['target_root_ik (32 bytes)', targetRoot],
  [`target epoch u64 LE (${epoch})`, u64(epoch)],
  [`mode u8 (${immediate ? 1 : 0})`, u8(immediate ? 1 : 0)],
];
// The CKD payload the session key signs for a combined login that carries a link (D133).
const linkedCkdParts = ({ pk1, pk2, linkJwt, immediate }) => [
  ['domain "hana-id-ckd-link-v1:"', ascii('hana-id-ckd-link-v1:')],
  ['sha256(link_jwt) (32 bytes)', sha256(ascii(linkJwt))],
  [`mode u8 (${immediate ? 1 : 0})`, u8(immediate ? 1 : 0)],
  [`pk1 "${pk1}"`, ascii(pk1)],
  ['":"', ascii(':')],
  [`pk2 "${pk2}"`, ascii(pk2)],
];
const LINK_JWT_EXAMPLE = '{"payload":"e30","signatures":[]}';
// The session message a bare create_session's proof of possession signs (D137): counter 0, payload
// "hana-id-create-v1:" ‖ sha256(session nonce preimage), binding the proof to the session's parameters.
const sessionMessageParts = (counter, payload) => [
  ['domain "hana-id-session-v1:"', ascii('hana-id-session-v1:')],
  [`counter u64 LE (${counter})`, u64(counter)],
  ['sha256(payload)', sha256(payload)],
];

// ---- tokens: the JWS General JSON Serialization (RFC 7515 §7.2.1) ----

const emailKey = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 }).privateKey;
const cosignKey = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 }).privateKey;
const emailJwk = createPublicKey(emailKey).export({ format: 'jwk' });
const cosignJwk = createPublicKey(cosignKey).export({ format: 'jwk' });
const HANA = { kid: EMAIL_KID, key: emailKey };
const COSIGN = { kid: COSIGN_KID, key: cosignKey };

// Each entry signs `protected.payload` (ASCII) with its own key; no header is shared between signers.
const jws = (claims, signers) => {
  const payload = b64url(JSON.stringify(claims));
  const signatures = signers.map(({ kid, key }) => {
    const prot = b64url(JSON.stringify({ alg: 'RS256', kid }));
    return { protected: prot, signature: b64url(sign('sha256', Buffer.from(`${prot}.${payload}`), key)) };
  });
  return JSON.stringify({ payload, signatures });
};

const EMAIL_SUB = `e1.${b64url(sha256(ascii('hana-id test email sub')))}`; // 46 characters, the issuer's shape
const sessionPreimage = concat(sessionParts({ scopeId: S1, pk: PK7, expiresAtMs: EXPIRES_MS }));
const N7 = b64url(sha256(sessionPreimage));
const claims = (nonce) => ({ iss: EMAIL_ISS, aud: `email:${S1}`, sub: EMAIL_SUB, iat: NOW_S - 60, exp: TOKEN_EXP, nonce, jti: 'AAECAwQFBgcICQoLDA0ODw' });
const tokens = {
  // A session in s1 for session key 7 (expiry EXPIRES_MS, key_index 0, max_uses 3, salt [9; 16]).
  email_session_s1: jws(claims(N7), [HANA]),
  email_session_s1_cosigned: jws(claims(N7), [HANA, COSIGN]),
  email_session_s1_cosign_only: jws(claims(N7), [COSIGN]),
};

// ---- worked examples ----

const example = (title, parts, { nonce = true } = {}) => ({
  title,
  parts: parts.map(([label, bytes]) => [label, hex(bytes)]),
  preimage_hex: hex(concat(parts)),
  ...(nonce ? { nonce: nonceOf(parts) } : {}),
});
const GOOGLE_IK = identityKey(S1, 'google', USER);
const EMAIL_IK = identityKey(S1, 'email', EMAIL_SUB);
const SESSION_HASH = sha256(sessionPreimage);
const layouts = {
  identity_key_google: example(`Identity key: scope s1, provider "google", sub "${USER}" (the key is sha256 of the preimage)`,
    identityParts(S1, 'google', USER), { nonce: false }),
  identity_key_email: example(`Identity key: scope s1, provider "email", sub "${EMAIL_SUB}"`, identityParts(S1, 'email', EMAIL_SUB), { nonce: false }),
  link_new: example('link_new: scope s1, root = the google identity key above, new provider "email", epoch 7, salt [9; 16]',
    linkNewParts({ scopeId: S1, root: GOOGLE_IK, provider: 'email', epoch: 7 })),
  link_account: example('link_account: scope s1, root = the google identity key, new = the email identity key, epoch 7, salt [9; 16]',
    linkAccountParts({ scopeId: S1, root: GOOGLE_IK, newIk: EMAIL_IK, epoch: 7 })),
  link_change_cancel: example('link_change "cancel": scope s1, root = the google identity key, member = the email identity key, epoch 8, salt [9; 16]',
    linkChangeParts({ scopeId: S1, action: 'cancel', root: GOOGLE_IK, member: EMAIL_IK, epoch: 8 })),
  link_change_unlink: example('link_change "unlink": as above with action "unlink"',
    linkChangeParts({ scopeId: S1, action: 'unlink', root: GOOGLE_IK, member: EMAIL_IK, epoch: 8 })),
  auto_link_immediate: example('auto_link, case A: scope s1, the session nonce preimage of the session nonce example (key 7), session identity = the google identity key, join 1 (the session identity joins), joiner = the google key, target root = the email key, target epoch 3, mode 1 (link_immediate)',
    autoLinkParts({ scopeId: S1, sessionHash: SESSION_HASH, sessionIk: GOOGLE_IK, join: 1, joiner: GOOGLE_IK, targetRoot: EMAIL_IK, epoch: 3, immediate: true })),
  auto_link_delayed: example('auto_link, case B: as above with join 2 (the link identity joins), joiner = the email key, target root = the google key, mode 0 (after change_delay_ms)',
    autoLinkParts({ scopeId: S1, sessionHash: SESSION_HASH, sessionIk: GOOGLE_IK, join: 2, joiner: EMAIL_IK, targetRoot: GOOGLE_IK, epoch: 3, immediate: false })),
  session_message_create: example('Session message for a bare create_session (proof of possession): counter 0, payload "hana-id-create-v1:" ‖ sha256(the session nonce preimage of the session nonce example, key 7)',
    sessionMessageParts(0, Buffer.concat([ascii('hana-id-create-v1:'), SESSION_HASH])), { nonce: false }),
  ckd_link_payload: example(`Linked CKD payload: link_jwt ${LINK_JWT_EXAMPLE}, mode 1, pk1 "bls12381g1:A", pk2 "bls12381g2:B"`,
    linkedCkdParts({ pk1: 'bls12381g1:A', pk2: 'bls12381g2:B', linkJwt: LINK_JWT_EXAMPLE, immediate: true }), { nonce: false }),
};
layouts.identity_key_google.ik = hex(GOOGLE_IK);
layouts.identity_key_email.ik = hex(EMAIL_IK);

const fixture = {
  _comment: 'Generated by scripts/gen-email-fixtures.mjs. Test-only RSA keys (private halves discarded); not Hana keys.',
  signer: SIGNER,
  email_iss: EMAIL_ISS,
  email_sub: EMAIL_SUB,
  email_kid: EMAIL_KID,
  email_n: emailJwk.n,
  email_e: emailJwk.e,
  cosign_kid: COSIGN_KID,
  cosign_n: cosignJwk.n,
  cosign_e: cosignJwk.e,
  layouts,
  tokens,
};
writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${Object.keys(tokens).length} tokens and ${Object.keys(layouts).length} layout examples to ${OUT}`);

if (process.argv.includes('--doc')) {
  const out = [];
  for (const ex of Object.values(layouts)) {
    out.push(`**${ex.title}**`, '', '```');
    const width = Math.max(...ex.parts.map(([label]) => label.length));
    for (const [label, h] of ex.parts) out.push(`${label.padEnd(width)}  ${h}`);
    if (ex.nonce) out.push(`${'nonce'.padEnd(width)}  ${ex.nonce}`);
    if (ex.ik) out.push(`${"ik = sha256".padEnd(width)}  ${ex.ik}`);
    out.push('```', '');
  }
  console.log(out.join('\n'));
}
