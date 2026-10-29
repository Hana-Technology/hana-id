#!/usr/bin/env node
// Generates src/test_fixture.json: RS256 ID tokens signed by a throwaway test RSA key (generated here, kept only in
// memory, never written anywhere), for the contract's unit tests. It never touches a real Google key.
//
// It is also an independent JS implementation of every byte layout in docs/contract-interface.md (session nonce,
// register proof, client proof, owner-action nonce, session message, CKD payload) plus the off-chain vault message
// (batch B, which the contract must never accept as a session message). It writes worked examples
// (`layouts`: each part, the whole preimage and the nonce) that the Rust tests compare with their own bytes, and that
// docs/contract-interface.md quotes. The two implementations must agree byte for byte.
//
//   node contracts/hana-signer/scripts/gen-fixtures.mjs           # writes src/test_fixture.json
//   node contracts/hana-signer/scripts/gen-fixtures.mjs --doc     # also prints the worked examples as Markdown
//
// Scenario constants must match src/tests.rs.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'test_fixture.json');

const NOW_MS = 1_800_000_000_000n;
const NOW_S = Number(NOW_MS / 1000n);
const TOKEN_EXP = NOW_S + 3 * 3600; // valid tokens outlive every timelock used in the tests
const EXPIRED = NOW_S - 1000;
const EXPIRES_MS = NOW_MS + 3_600_000n;
const EXPIRES_LATE_MS = NOW_MS + 2n * 3_600_000n;
const SALT = Buffer.alloc(16, 9);
const MAX_USES = 3;

const SIGNER = 'hana-signer.testnet'; // env::current_account_id() in the tests
const OTHER_SIGNER = 'hana-signer-other.testnet'; // a second deployment, for cross-deployment replay tests
const ISS = 'https://accounts.google.com';
const KID = 'test-kid';
const OTHER_ISS = 'https://other.example'; // a second issuer ("other") with its own key, for cross-issuer tests
const OTHER_KID = 'test-kid2';
const APP = (name) => `${name}.apps.googleusercontent.com`;
const [A, A2, B, C, D, E, X, CONSOLE, SHARED] = ['app-a', 'app-a2', 'app-b', 'app-c', 'app-d', 'app-e', 'app-x', 'console', 'hana-shared'].map(APP);
const USER = '1098765432';
const OWNER = 'owner-111';
const MALLORY = 'mallory-999';

// ---- encodings (docs/contract-interface.md) ----
// Each layout is built as a list of [label, bytes] parts so the worked examples can show every field.

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (buf) => createHash('sha256').update(buf).digest();
const u8 = (n) => Buffer.from([n]);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s) => { const bytes = Buffer.from(s, 'utf8'); return Buffer.concat([u32(bytes.length), bytes]); };
const optStr = (s) => (s == null ? u8(0) : Buffer.concat([u8(1), str(s)]));
const owner = (o) => ('Near' in o
  ? Buffer.concat([u8(0), str(o.Near.account_id)])
  : Buffer.concat([u8(1), str(o.Oidc.provider), str(o.Oidc.sub)]));
const vec = (list, enc) => Buffer.concat([u32(list.length), ...list.map(enc)]);
const owners = (list) => vec(list, owner);
const clientPairs = (list) => vec(list, ([provider, aud]) => Buffer.concat([str(provider), str(aud)]));
const change = (c) => {
  if ('AddClient' in c) return Buffer.concat([u8(0), str(c.AddClient.provider), str(c.AddClient.aud)]);
  if ('SetOwners' in c) return Buffer.concat([u8(1), owners(c.SetOwners.owners)]);
  if ('SetAllowShared' in c) return Buffer.concat([u8(2), u8(c.SetAllowShared.allow ? 1 : 0)]);
  throw new Error('unknown change');
};
const ascii = (s) => Buffer.from(s, 'utf8');

const sessionParts = ({ signer = SIGNER, scopeId, pk, expiresAtMs, keyIndex = 0, maxUses = MAX_USES, salt = SALT }) => [
  ['domain "hana-id/session/v1"', ascii('hana-id/session/v1')],
  [`borsh(signer) "${signer}"`, str(signer)],
  [`borsh(scope_id) "${scopeId}"`, str(scopeId)],
  ['session_public_key (32 bytes)', pk],
  [`expires_at_ms u64 LE (${expiresAtMs})`, u64(expiresAtMs)],
  [`key_index u32 LE (${keyIndex})`, u32(keyIndex)],
  [`max_uses u32 LE (${maxUses})`, u32(maxUses)],
  [`salt (${salt.length} bytes)`, salt],
];
const registerParts = ({ signer = SIGNER, ownerList, clients, allowShared = false }) => [
  ['domain "hana-id/register/v1"', ascii('hana-id/register/v1')],
  [`borsh(signer) "${signer}"`, str(signer)],
  [`borsh(owners) (${ownerList.length})`, owners(ownerList)],
  [`borsh(clients) (${clients.length})`, clientPairs(clients)],
  [`allow_shared u8 (${allowShared})`, u8(allowShared ? 1 : 0)],
];
const clientProofParts = ({ signer = SIGNER, scopeId, actionNonce }) => [
  ['domain "hana-id/client-proof/v1"', ascii('hana-id/client-proof/v1')],
  [`borsh(signer) "${signer}"`, str(signer)],
  [`borsh(scope_id) "${scopeId}"`, str(scopeId)],
  [`action_nonce u64 LE (${actionNonce})`, u64(actionNonce)],
];
const ownerActionParts = ({ signer = SIGNER, scopeId, method, args, actionNonce }) => [
  ['domain "hana-id/owner-action/v1"', ascii('hana-id/owner-action/v1')],
  [`borsh(signer) "${signer}"`, str(signer)],
  [`borsh(scope_id) "${scopeId}"`, str(scopeId)],
  [`borsh(method) "${method}"`, str(method)],
  ['borsh(args without auth)', args],
  [`action_nonce u64 LE (${actionNonce})`, u64(actionNonce)],
];
const proposeArgs = (scopeId, c, proof) => Buffer.concat([str(scopeId), change(c), optStr(proof)]);
const cancelArgs = (scopeId, changeId) => Buffer.concat([str(scopeId), u64(changeId)]);
const removeArgs = (scopeId, provider, aud) => Buffer.concat([str(scopeId), str(provider), str(aud)]);
const disableArgs = (scopeId) => str(scopeId);
const ckdPayload = (pk1, pk2) => ascii(`hana-id-ckd-v1:${pk1}:${pk2}`);
const sessionMessageParts = (counter, payload) => [
  ['domain "hana-id-session-v1:"', ascii('hana-id-session-v1:')],
  [`counter u64 LE (${counter})`, u64(counter)],
  ['sha256(payload)', sha256(payload)],
];
// Off-chain only (docs/batch-b-spec.md "Vault message layout"): what the session key signs for the API's vault
// endpoints. Its domain differs from the session message's, so the contract must reject it as a derive or a revoke.
const vaultMessageParts = ({ signer = SIGNER, appId, shareId, counter, payload }) => [
  ['domain "hana-id-vault-v1:"', ascii('hana-id-vault-v1:')],
  [`borsh(signer) "${signer}"`, str(signer)],
  [`borsh(appId) "${appId}"`, str(appId)],
  ['shareId (16 bytes)', shareId],
  [`counter u64 LE (${counter})`, u64(counter)],
  ['sha256(payload)', sha256(payload)],
];

const concat = (parts) => Buffer.concat(parts.map(([, bytes]) => bytes));
const nonceOf = (parts) => b64url(sha256(concat(parts)));
const sessionNonce = (o) => nonceOf(sessionParts(o));
const registerNonce = (o) => nonceOf(registerParts(o));
const clientProofNonce = (o) => nonceOf(clientProofParts(o));
const ownerActionNonce = (o) => nonceOf(ownerActionParts(o));

// ---- keys ----

const ed25519Public = (seedByte) => {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seedByte)]);
  return Buffer.from(createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x, 'base64url');
};
const PK7 = ed25519Public(7);
const PK8 = ed25519Public(8);

const testKey = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 }).privateKey;
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 }).privateKey;
const jwk = createPublicKey(testKey).export({ format: 'jwk' });
const otherJwk = createPublicKey(otherKey).export({ format: 'jwk' });

const jwt = ({ aud, sub = USER, nonce, iss = ISS, exp = TOKEN_EXP, kid = KID, alg = 'RS256', key = testKey, extra = {} }) => {
  const header = b64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const claims = { iss, azp: aud, aud, sub, iat: NOW_S - 60, exp, ...extra };
  if (nonce !== undefined) claims.nonce = nonce;
  const input = `${header}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${b64url(sign('sha256', Buffer.from(input), key))}`;
};

// ---- scenario (mirrors src/tests.rs) ----

const S1 = 's1'; // admin-registered: owners [alice.testnet, Oidc owner-111], clients [A, A2]
const S2 = 's2'; // admin-registered: owners [bob.testnet], clients [B]
const S3 = 's3'; // shared_setup(): shared-only (no clients, allow_shared), owners [carol.testnet]
const S4 = 's4'; // shared_setup(): clients [C], allow_shared, owners [carol.testnet]
const REG_OWNERS = [{ Oidc: { provider: 'google', sub: OWNER } }, { Near: { account_id: 'carol.testnet' } }];
const MALLORY_OWNERS = [{ Near: { account_id: 'mallory.testnet' } }];
const ADD_E = { AddClient: { provider: 'google', aud: E } };
const SET_OWNER_ONLY = { SetOwners: { owners: [{ Oidc: { provider: 'google', sub: OWNER } }] } };
const ALLOW_SHARED = { SetAllowShared: { allow: true } };
const g = (aud) => ['google', aud];

const sess = (scopeId, pk, extra = {}) => sessionNonce({ scopeId, pk, expiresAtMs: EXPIRES_MS, ...extra });
const n7 = sess(S1, PK7);
const nonces = {
  session_s1_pk7_k0: n7,
  session_s1_pk8_k0: sess(S1, PK8),
  session_s2_pk8_k0: sess(S2, PK8),
  session_s1_pk8_k1: sess(S1, PK8, { keyIndex: 1 }),
  session_s1_pk7_late_k0: sess(S1, PK7, { expiresAtMs: EXPIRES_LATE_MS }),
  session_s1_pk7_other_signer: sess(S1, PK7, { signer: OTHER_SIGNER }),
  session_s3_pk7_k0: sess(S3, PK7),
  session_s2_pk8_shared: sess(S2, PK8),
  session_s4_pk7_k0: sess(S4, PK7),
  session_s4_pk8_k0: sess(S4, PK8),
  session_s1_pk8_late_k0: sess(S1, PK8, { expiresAtMs: EXPIRES_LATE_MS }),
  // create_session_and_derive (batch B): max_uses 1 and 2, and key_index at and above the reserved bound 2^31
  session_s1_pk7_k0_m1: sess(S1, PK7, { maxUses: 1 }),
  session_s1_pk7_k0_m2: sess(S1, PK7, { maxUses: 2 }),
  session_s1_pk7_k7fffffff: sess(S1, PK7, { keyIndex: 0x7fff_ffff }),
  session_s1_pk7_k80000000: sess(S1, PK7, { keyIndex: 0x8000_0000 }),
  session_s1_pk7_kffffffff: sess(S1, PK7, { keyIndex: 0xffff_ffff }),
  register_reg_c: registerNonce({ ownerList: REG_OWNERS, clients: [g(C)] }),
  register_reg_cd: registerNonce({ ownerList: REG_OWNERS, clients: [g(C), g(D)] }),
  register_reg_a: registerNonce({ ownerList: REG_OWNERS, clients: [g(A)] }),
  register_reg_c_shared: registerNonce({ ownerList: REG_OWNERS, clients: [g(C)], allowShared: true }),
  register_reg_shared_client: registerNonce({ ownerList: REG_OWNERS, clients: [g(SHARED)] }),
  register_mallory_c: registerNonce({ ownerList: MALLORY_OWNERS, clients: [g(C)] }),
  register_mallory_a2: registerNonce({ ownerList: MALLORY_OWNERS, clients: [g(A2)] }),
  client_s1_0: clientProofNonce({ scopeId: S1, actionNonce: 0 }),
  client_s1_1: clientProofNonce({ scopeId: S1, actionNonce: 1 }),
  client_s2_0: clientProofNonce({ scopeId: S2, actionNonce: 0 }),
};

const tokens = {
  // sessions
  session_a: jwt({ aud: A, nonce: n7 }),
  session_a2: jwt({ aud: A2, nonce: nonces.session_s1_pk8_k0 }),
  session_b: jwt({ aud: B, nonce: nonces.session_s2_pk8_k0 }),
  session_a_k1: jwt({ aud: A, nonce: nonces.session_s1_pk8_k1 }),
  session_alt_iss: jwt({ aud: A, nonce: n7, iss: 'accounts.google.com' }),
  session_expired: jwt({ aud: A, nonce: n7, exp: EXPIRED }),
  session_unknown_iss: jwt({ aud: A, nonce: n7, iss: 'https://evil.example' }),
  session_unknown_kid: jwt({ aud: A, nonce: n7, kid: 'other-kid' }),
  session_wrong_key: jwt({ aud: A, nonce: n7, key: otherKey }),
  session_es256: jwt({ aud: A, nonce: n7, alg: 'ES256' }),
  session_unregistered: jwt({ aud: X, nonce: n7 }),
  session_hash_sub: jwt({ aud: A, nonce: n7, sub: 'a#b' }),
  session_no_nonce: jwt({ aud: A }),
  session_e_late: jwt({ aud: E, nonce: nonces.session_s1_pk7_late_k0 }),
  session_console: jwt({ aud: CONSOLE, nonce: n7 }),
  session_a_other_signer: jwt({ aud: A, nonce: nonces.session_s1_pk7_other_signer }),
  // issuer isolation: issuer "other" (OTHER_ISS) holds OTHER_KID = otherKey; google holds KID = testKey
  session_google_iss_other_kid: jwt({ aud: A, nonce: n7, kid: OTHER_KID, key: otherKey }),
  session_other_iss_google_kid: jwt({ aud: A, nonce: n7, iss: OTHER_ISS }),
  session_other_issuer: jwt({ aud: A, nonce: n7, iss: OTHER_ISS, kid: OTHER_KID, key: otherKey }),
  // shared client (Hana's login page): the scope comes from the nonce
  shared_s3: jwt({ aud: SHARED, nonce: nonces.session_s3_pk7_k0 }),
  shared_s2: jwt({ aud: SHARED, nonce: nonces.session_s2_pk8_shared }),
  shared_s4: jwt({ aud: SHARED, nonce: nonces.session_s4_pk8_k0 }),
  session_c_s4: jwt({ aud: C, nonce: nonces.session_s4_pk7_k0 }),
  shared_s1_late: jwt({ aud: SHARED, nonce: nonces.session_s1_pk8_late_k0 }),
  session_a_m1: jwt({ aud: A, nonce: nonces.session_s1_pk7_k0_m1 }),
  session_a_m2: jwt({ aud: A, nonce: nonces.session_s1_pk7_k0_m2 }),
  session_a_k_last: jwt({ aud: A, nonce: nonces.session_s1_pk7_k7fffffff }),
  session_a_k_reserved: jwt({ aud: A, nonce: nonces.session_s1_pk7_k80000000 }),
  session_a_k_max: jwt({ aud: A, nonce: nonces.session_s1_pk7_kffffffff }),
  // claims the API and vault refuse (batch B allow-list) but the contract ignores
  session_a_pii: jwt({ aud: A, nonce: n7, extra: { email: 'user@example.com', email_verified: true, name: 'A User', hd: 'example.com', picture: 'https://example.com/u.png' } }),
  // register_scope proofs
  reg_c: jwt({ aud: C, sub: OWNER, nonce: nonces.register_reg_c }),
  reg_cd_c: jwt({ aud: C, sub: OWNER, nonce: nonces.register_reg_cd }),
  reg_cd_d: jwt({ aud: D, sub: OWNER, nonce: nonces.register_reg_cd }),
  reg_a: jwt({ aud: A, sub: OWNER, nonce: nonces.register_reg_a }),
  reg_c_shared: jwt({ aud: C, sub: OWNER, nonce: nonces.register_reg_c_shared }),
  reg_shared_client: jwt({ aud: SHARED, sub: OWNER, nonce: nonces.register_reg_shared_client }),
  reg_c_mallory: jwt({ aud: C, sub: MALLORY, nonce: nonces.register_mallory_c }),
  reg_a2_mallory: jwt({ aud: A2, sub: MALLORY, nonce: nonces.register_mallory_a2 }),
  // client proofs (propose_change AddClient)
  cp_e_s1_0: jwt({ aud: E, sub: OWNER, nonce: nonces.client_s1_0 }),
  cp_e_s1_1: jwt({ aud: E, sub: OWNER, nonce: nonces.client_s1_1 }),
  cp_e_s2_0: jwt({ aud: E, sub: MALLORY, nonce: nonces.client_s2_0 }),
  cp_b_s1_0: jwt({ aud: B, sub: OWNER, nonce: nonces.client_s1_0 }),
  cp_c_s1_1: jwt({ aud: C, sub: OWNER, nonce: nonces.client_s1_1 }),
  cp_a2_s1_1: jwt({ aud: A2, sub: OWNER, nonce: nonces.client_s1_1 }),
  cp_a2_s2_0: jwt({ aud: A2, sub: MALLORY, nonce: nonces.client_s2_0 }),
  cp_shared_s1_0: jwt({ aud: SHARED, sub: OWNER, nonce: nonces.client_s1_0 }),
};

// owner actions (OwnerAuth::Oidc): need the client-proof JWT first, since propose_change's args include it
const oa = (scopeId, method, args, actionNonce) => ownerActionNonce({ scopeId, method, args, actionNonce });
nonces.owner_propose_e_s1_0 = oa(S1, 'propose_change', proposeArgs(S1, ADD_E, tokens.cp_e_s1_0), 0);
nonces.owner_cancel_s1_0_at_1 = oa(S1, 'cancel_change', cancelArgs(S1, 0), 1);
nonces.owner_remove_a2_s1_0 = oa(S1, 'remove_client', removeArgs(S1, 'google', A2), 0);
nonces.owner_set_owners_s1_0 = oa(S1, 'propose_change', proposeArgs(S1, SET_OWNER_ONLY, null), 0);
// Same scope, args and action_nonce as owner_remove_a2_s1_0; only the method name differs.
nonces.owner_cancel_method_remove_args_s1_0 = oa(S1, 'cancel_change', removeArgs(S1, 'google', A2), 0);
nonces.owner_allow_shared_s1_0 = oa(S1, 'propose_change', proposeArgs(S1, ALLOW_SHARED, null), 0);
nonces.owner_disable_shared_s1_1 = oa(S1, 'disable_shared_login', disableArgs(S1), 1);
// After propose (0 → 1) and execute_change (1 → 2) of SetAllowShared.
nonces.owner_disable_shared_s1_2 = oa(S1, 'disable_shared_login', disableArgs(S1), 2);
Object.assign(tokens, {
  oa_propose_e: jwt({ aud: CONSOLE, sub: OWNER, nonce: nonces.owner_propose_e_s1_0 }),
  oa_cancel_0: jwt({ aud: CONSOLE, sub: OWNER, nonce: nonces.owner_cancel_s1_0_at_1 }),
  oa_remove_a2: jwt({ aud: CONSOLE, sub: OWNER, nonce: nonces.owner_remove_a2_s1_0 }),
  oa_remove_a2_wrong_aud: jwt({ aud: A, sub: OWNER, nonce: nonces.owner_remove_a2_s1_0 }),
  oa_remove_a2_mallory: jwt({ aud: CONSOLE, sub: MALLORY, nonce: nonces.owner_remove_a2_s1_0 }),
  oa_set_owners: jwt({ aud: CONSOLE, sub: OWNER, nonce: nonces.owner_set_owners_s1_0 }),
  oa_remove_a2_wrong_method: jwt({ aud: CONSOLE, sub: OWNER, nonce: nonces.owner_cancel_method_remove_args_s1_0 }),
  oa_allow_shared: jwt({ aud: CONSOLE, sub: OWNER, nonce: nonces.owner_allow_shared_s1_0 }),
  oa_disable_shared: jwt({ aud: CONSOLE, sub: OWNER, nonce: nonces.owner_disable_shared_s1_1 }),
  oa_disable_shared_2: jwt({ aud: CONSOLE, sub: OWNER, nonce: nonces.owner_disable_shared_s1_2 }),
});

// ---- worked examples (docs/contract-interface.md "Worked examples"; checked by the Rust tests) ----

const hex = (buf) => Buffer.from(buf).toString('hex');
const example = (title, parts, { nonce = true } = {}) => ({
  title,
  parts: parts.map(([label, bytes]) => [label, hex(bytes)]),
  preimage_hex: hex(concat(parts)),
  ...(nonce ? { nonce: nonceOf(parts) } : {}),
});
const VAULT_APP_ID = 'app_test';
const VAULT_SHARE_ID = Buffer.from(Array.from({ length: 16 }, (_, i) => i + 1));
const CKD_PK1 = 'bls12381g1:A';
const CKD_PK2 = 'bls12381g2:B';
const ckd = ckdPayload(CKD_PK1, CKD_PK2);
const layouts = {
  session_nonce: example('Session nonce: scope s1, session key = Ed25519 public key of seed [7; 32], expires 1800003600000, key_index 0, max_uses 3, salt [9; 16]',
    sessionParts({ scopeId: S1, pk: PK7, expiresAtMs: EXPIRES_MS })),
  register_proof: example('Register proof: owners [Oidc google/owner-111, Near carol.testnet], clients [google app-c], allow_shared false',
    registerParts({ ownerList: REG_OWNERS, clients: [g(C)] })),
  client_proof: example('Client proof: scope s1, action_nonce 0', clientProofParts({ scopeId: S1, actionNonce: 0 })),
  owner_action_remove_client: example('Owner action: remove_client(s1, google, app-a2), action_nonce 0',
    ownerActionParts({ scopeId: S1, method: 'remove_client', args: removeArgs(S1, 'google', A2), actionNonce: 0 })),
  owner_action_allow_shared: example('Owner action: propose_change(s1, {"SetAllowShared":{"allow":true}}, null), action_nonce 0',
    ownerActionParts({ scopeId: S1, method: 'propose_change', args: proposeArgs(S1, ALLOW_SHARED, null), actionNonce: 0 })),
  owner_action_disable_shared: example('Owner action: disable_shared_login(s1), action_nonce 1',
    ownerActionParts({ scopeId: S1, method: 'disable_shared_login', args: disableArgs(S1), actionNonce: 1 })),
  ckd_payload: example(`CKD payload: pk1 "${CKD_PK1}", pk2 "${CKD_PK2}"`, [['"hana-id-ckd-v1:" ‖ pk1 ‖ ":" ‖ pk2', ckd]], { nonce: false }),
  session_message_ckd: example('Session message for derive_key: counter 1, payload = the CKD payload above', sessionMessageParts(1, ckd), { nonce: false }),
  session_message_revoke: example('Session message for revoke_session: counter 2, payload "revoke"', sessionMessageParts(2, ascii('revoke')), { nonce: false }),
  vault_message_unlock: example('Vault message (off-chain only, never a session message): app "app_test", shareId 01…10, counter 1, payload "unlock"',
    vaultMessageParts({ appId: VAULT_APP_ID, shareId: VAULT_SHARE_ID, counter: 1, payload: ascii('unlock') }), { nonce: false }),
};
layouts.ckd_payload.pk1 = CKD_PK1;
layouts.ckd_payload.pk2 = CKD_PK2;

const fixture = {
  _comment: 'Generated by scripts/gen-fixtures.mjs. Test-only RSA key (private half discarded); not a Google key.',
  signer: SIGNER,
  other_signer: OTHER_SIGNER,
  kid: KID,
  n: jwk.n,
  e: jwk.e,
  other_kid: OTHER_KID,
  other_n: otherJwk.n,
  other_e: otherJwk.e,
  session_pk7_hex: PK7.toString('hex'),
  session_pk8_hex: PK8.toString('hex'),
  layouts,
  nonces,
  tokens,
};
writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${Object.keys(tokens).length} tokens, ${Object.keys(nonces).length} nonces and ${Object.keys(layouts).length} layout examples to ${OUT}`);

if (process.argv.includes('--doc')) {
  const out = [];
  for (const ex of Object.values(layouts)) {
    out.push(`**${ex.title}**`, '', '```');
    const width = Math.max(...ex.parts.map(([label]) => label.length));
    for (const [label, h] of ex.parts) out.push(`${label.padEnd(width)}  ${h}`);
    if (ex.nonce) out.push(`${'nonce'.padEnd(width)}  ${ex.nonce}`);
    out.push('```', '');
  }
  console.log(out.join('\n'));
}
