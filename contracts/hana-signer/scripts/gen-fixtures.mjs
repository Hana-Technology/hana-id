#!/usr/bin/env node
// Generates src/test_fixture.json: RS256 ID tokens signed by a throwaway test RSA key (generated here, kept only in
// memory, never written anywhere), for the contract's unit tests. It never touches a real Google key.
//
// It is also an independent JS implementation of the byte layouts in docs/contract-interface.md (session nonce,
// register proof, client proof, owner-action nonce). The Rust tests check their own nonces against the `nonces`
// written here, so the two implementations must agree byte for byte.
//
//   node contracts/hana-signer/scripts/gen-fixtures.mjs
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

const ISS = 'https://accounts.google.com';
const KID = 'test-kid';
const OTHER_ISS = 'https://other.example'; // a second issuer ("other") with its own key, for cross-issuer tests
const OTHER_KID = 'test-kid2';
const APP = (name) => `${name}.apps.googleusercontent.com`;
const [A, A2, B, C, D, E, X, CONSOLE] = ['app-a', 'app-a2', 'app-b', 'app-c', 'app-d', 'app-e', 'app-x', 'console'].map(APP);
const USER = '1098765432';
const OWNER = 'owner-111';
const MALLORY = 'mallory-999';

// ---- encodings (docs/contract-interface.md) ----

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (buf) => createHash('sha256').update(buf).digest();
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s) => { const bytes = Buffer.from(s, 'utf8'); return Buffer.concat([u32(bytes.length), bytes]); };
const optStr = (s) => (s == null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), str(s)]));
const owner = (o) => ('Near' in o
  ? Buffer.concat([Buffer.from([0]), str(o.Near.account_id)])
  : Buffer.concat([Buffer.from([1]), str(o.Oidc.provider), str(o.Oidc.sub)]));
const owners = (list) => Buffer.concat([u32(list.length), ...list.map(owner)]);
const change = (c) => ('AddClient' in c
  ? Buffer.concat([Buffer.from([0]), str(c.AddClient.provider), str(c.AddClient.aud)])
  : Buffer.concat([Buffer.from([1]), owners(c.SetOwners.owners)]));

const sessionNonce = (pk, expiresAtMs, keyIndex, salt) => b64url(sha256(Buffer.concat([pk, u64(expiresAtMs), u32(keyIndex), salt])));
const registerNonce = (list) => b64url(sha256(Buffer.concat([Buffer.from('hana-id/register/v1'), owners(list)])));
const clientProofNonce = (scopeId, actionNonce) => b64url(sha256(Buffer.concat([Buffer.from('hana-id/client-proof/v1'), Buffer.from(scopeId), u64(actionNonce)])));
const ownerActionNonce = (scopeId, method, args, actionNonce) =>
  b64url(sha256(Buffer.concat([Buffer.from('hana-id/owner-action/v1'), Buffer.from(scopeId), Buffer.from(method), args, u64(actionNonce)])));
const proposeArgs = (scopeId, c, proof) => Buffer.concat([str(scopeId), change(c), optStr(proof)]);
const cancelArgs = (scopeId, changeId) => Buffer.concat([str(scopeId), u64(changeId)]);
const removeArgs = (scopeId, provider, aud) => Buffer.concat([str(scopeId), str(provider), str(aud)]);

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

const jwt = ({ aud, sub = USER, nonce, iss = ISS, exp = TOKEN_EXP, kid = KID, alg = 'RS256', key = testKey }) => {
  const header = b64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const claims = { iss, azp: aud, aud, sub, iat: NOW_S - 60, exp };
  if (nonce !== undefined) claims.nonce = nonce;
  const input = `${header}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${b64url(sign('sha256', Buffer.from(input), key))}`;
};

// ---- scenario (mirrors src/tests.rs) ----

const S1 = 's1'; // admin-registered: owners [alice.testnet, Oidc owner-111], clients [A, A2]
const S2 = 's2'; // admin-registered: owners [bob.testnet], clients [B]
const REG_OWNERS = [{ Oidc: { provider: 'google', sub: OWNER } }, { Near: { account_id: 'carol.testnet' } }];
const MALLORY_OWNERS = [{ Near: { account_id: 'mallory.testnet' } }];
const ADD_E = { AddClient: { provider: 'google', aud: E } };
const SET_OWNER_ONLY = { SetOwners: { owners: [{ Oidc: { provider: 'google', sub: OWNER } }] } };

const n7 = sessionNonce(PK7, EXPIRES_MS, 0, SALT);
const n8 = sessionNonce(PK8, EXPIRES_MS, 0, SALT);
const nonces = {
  session_pk7_k0: n7,
  session_pk8_k0: n8,
  session_pk8_k1: sessionNonce(PK8, EXPIRES_MS, 1, SALT),
  session_pk7_late_k0: sessionNonce(PK7, EXPIRES_LATE_MS, 0, SALT),
  register_reg_owners: registerNonce(REG_OWNERS),
  register_mallory: registerNonce(MALLORY_OWNERS),
  client_s1_0: clientProofNonce(S1, 0),
  client_s1_1: clientProofNonce(S1, 1),
  client_s2_0: clientProofNonce(S2, 0),
};

const tokens = {
  // sessions
  session_a: jwt({ aud: A, nonce: n7 }),
  session_a2: jwt({ aud: A2, nonce: n8 }),
  session_b: jwt({ aud: B, nonce: n8 }),
  session_a_k1: jwt({ aud: A, nonce: nonces.session_pk8_k1 }),
  session_alt_iss: jwt({ aud: A, nonce: n7, iss: 'accounts.google.com' }),
  session_expired: jwt({ aud: A, nonce: n7, exp: EXPIRED }),
  session_unknown_iss: jwt({ aud: A, nonce: n7, iss: 'https://evil.example' }),
  session_unknown_kid: jwt({ aud: A, nonce: n7, kid: 'other-kid' }),
  session_wrong_key: jwt({ aud: A, nonce: n7, key: otherKey }),
  session_es256: jwt({ aud: A, nonce: n7, alg: 'ES256' }),
  session_unregistered: jwt({ aud: X, nonce: n7 }),
  session_hash_sub: jwt({ aud: A, nonce: n7, sub: 'a#b' }),
  session_no_nonce: jwt({ aud: A }),
  session_e_late: jwt({ aud: E, nonce: nonces.session_pk7_late_k0 }),
  session_console: jwt({ aud: CONSOLE, nonce: n7 }),
  // issuer isolation: issuer "other" (OTHER_ISS) holds OTHER_KID = otherKey; google holds KID = testKey
  session_google_iss_other_kid: jwt({ aud: A, nonce: n7, kid: OTHER_KID, key: otherKey }),
  session_other_iss_google_kid: jwt({ aud: A, nonce: n7, iss: OTHER_ISS }),
  session_other_issuer: jwt({ aud: A, nonce: n7, iss: OTHER_ISS, kid: OTHER_KID, key: otherKey }),
  // register_scope proofs
  reg_c: jwt({ aud: C, sub: OWNER, nonce: nonces.register_reg_owners }),
  reg_d: jwt({ aud: D, sub: OWNER, nonce: nonces.register_reg_owners }),
  reg_a: jwt({ aud: A, sub: OWNER, nonce: nonces.register_reg_owners }),
  reg_c_mallory: jwt({ aud: C, sub: MALLORY, nonce: nonces.register_mallory }),
  reg_a2_mallory: jwt({ aud: A2, sub: MALLORY, nonce: nonces.register_mallory }),
  // client proofs (propose_change AddClient)
  cp_e_s1_0: jwt({ aud: E, sub: OWNER, nonce: nonces.client_s1_0 }),
  cp_e_s1_1: jwt({ aud: E, sub: OWNER, nonce: nonces.client_s1_1 }),
  cp_e_s2_0: jwt({ aud: E, sub: MALLORY, nonce: nonces.client_s2_0 }),
  cp_b_s1_0: jwt({ aud: B, sub: OWNER, nonce: nonces.client_s1_0 }),
  cp_c_s1_1: jwt({ aud: C, sub: OWNER, nonce: nonces.client_s1_1 }),
  cp_a2_s1_1: jwt({ aud: A2, sub: OWNER, nonce: nonces.client_s1_1 }),
  cp_a2_s2_0: jwt({ aud: A2, sub: MALLORY, nonce: nonces.client_s2_0 }),
};

// owner actions (OwnerAuth::Oidc): need the client-proof JWT first, since propose_change's args include it
nonces.owner_propose_e_s1_0 = ownerActionNonce(S1, 'propose_change', proposeArgs(S1, ADD_E, tokens.cp_e_s1_0), 0);
nonces.owner_cancel_s1_0_at_1 = ownerActionNonce(S1, 'cancel_change', cancelArgs(S1, 0), 1);
nonces.owner_remove_a2_s1_0 = ownerActionNonce(S1, 'remove_client', removeArgs(S1, 'google', A2), 0);
nonces.owner_set_owners_s1_0 = ownerActionNonce(S1, 'propose_change', proposeArgs(S1, SET_OWNER_ONLY, null), 0);
// Same scope, args and action_nonce as owner_remove_a2_s1_0; only the method name differs.
nonces.owner_cancel_method_remove_args_s1_0 = ownerActionNonce(S1, 'cancel_change', removeArgs(S1, 'google', A2), 0);
Object.assign(tokens, {
  oa_propose_e: jwt({ aud: CONSOLE, sub: OWNER, nonce: nonces.owner_propose_e_s1_0 }),
  oa_cancel_0: jwt({ aud: CONSOLE, sub: OWNER, nonce: nonces.owner_cancel_s1_0_at_1 }),
  oa_remove_a2: jwt({ aud: CONSOLE, sub: OWNER, nonce: nonces.owner_remove_a2_s1_0 }),
  oa_remove_a2_wrong_aud: jwt({ aud: A, sub: OWNER, nonce: nonces.owner_remove_a2_s1_0 }),
  oa_remove_a2_mallory: jwt({ aud: CONSOLE, sub: MALLORY, nonce: nonces.owner_remove_a2_s1_0 }),
  oa_set_owners: jwt({ aud: CONSOLE, sub: OWNER, nonce: nonces.owner_set_owners_s1_0 }),
  oa_remove_a2_wrong_method: jwt({ aud: CONSOLE, sub: OWNER, nonce: nonces.owner_cancel_method_remove_args_s1_0 }),
});

const fixture = {
  _comment: 'Generated by scripts/gen-fixtures.mjs. Test-only RSA key (private half discarded); not a Google key.',
  kid: KID,
  n: jwk.n,
  e: jwk.e,
  other_kid: OTHER_KID,
  other_n: otherJwk.n,
  other_e: otherJwk.e,
  session_pk7_hex: PK7.toString('hex'),
  session_pk8_hex: PK8.toString('hex'),
  nonces,
  tokens,
};
writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${Object.keys(tokens).length} tokens and ${Object.keys(nonces).length} nonces to ${OUT}`);
