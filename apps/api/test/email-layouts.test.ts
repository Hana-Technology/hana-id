// The email-login byte layouts the API recomputes (session-crypto.ts) against the contract's worked examples
// (contracts/hana-signer/src/email_fixture.json, written by gen-email-fixtures.mjs, an independent implementation), and
// the API's email-token check (email-token.ts) against the fixture's tokens, which the contract's own tests verify.
import { describe, expect, it } from 'vitest';
import emailFixture from '../../../contracts/hana-signer/src/email_fixture.json';
import testFixture from '../../../contracts/hana-signer/src/test_fixture.json';
import { base64UrlDecode, fromHex, hex, sha256 } from '../src/bytes.ts';
import { EMAIL_CLAIMS, policyAccepts, verifyEmailToken } from '../src/email-token.ts';
import { clearLinkViewCaches } from '../src/link-views.ts';
import {
  autoLinkNonce,
  createProofPayload,
  identityKey,
  linkAccountNonce,
  linkChangeNonce,
  linkNewNonce,
  linkedCkdPayload,
  sessionMessage,
  sessionNoncePreimage,
} from '../src/session-crypto.ts';
import { NearMock } from './near-mock.ts';
import { env } from 'cloudflare:workers';
import type { Env } from '../src/env.ts';

type Example = { parts: [string, string][]; preimage_hex: string; nonce?: string; ik?: string };
const L = emailFixture.layouts as unknown as Record<string, Example>;
const signer = emailFixture.signer;
const salt = new Uint8Array(16).fill(9);
const gIk = fromHex(L.identity_key_google!.ik!);
const eIk = fromHex(L.identity_key_email!.ik!);
/** The session nonce example of test_fixture.json: scope s1, key 7, the fixture's expiry, key_index 0, max_uses 3. */
const session = {
  signer: testFixture.signer,
  scopeId: 's1',
  sessionPublicKey: fromHex(testFixture.session_pk7_hex),
  expiresAtMs: 1_800_000_000_000 + 3_600_000,
  keyIndex: 0,
  maxUses: 3,
  salt: new Uint8Array(16).fill(9),
};

describe('email-login layouts against the contract fixture', () => {
  it('identity keys', async () => {
    expect(hex(await identityKey('s1', 'google', '1098765432'))).toBe(L.identity_key_google!.ik);
    expect(hex(await identityKey('s1', 'email', emailFixture.email_sub))).toBe(L.identity_key_email!.ik);
  });

  it('link_new, link_account and link_change nonces', async () => {
    expect(await linkNewNonce(signer, 's1', gIk, 'email', 7, salt)).toBe(L.link_new!.nonce);
    expect(await linkAccountNonce(signer, 's1', gIk, eIk, 7, salt)).toBe(L.link_account!.nonce);
    expect(await linkChangeNonce(signer, 's1', 'cancel', gIk, eIk, 8, salt)).toBe(L.link_change_cancel!.nonce);
    expect(await linkChangeNonce(signer, 's1', 'unlink', gIk, eIk, 8, salt)).toBe(L.link_change_unlink!.nonce);
  });

  it('auto_link nonces (case A immediate, case B delayed)', async () => {
    const sessionHash = await sha256(sessionNoncePreimage(session));
    expect(hex(sessionHash)).toBe(L.auto_link_immediate!.parts[3]![1]);
    const base = { signer, scopeId: 's1', sessionHash, sessionIk: gIk, targetEpoch: 3 };
    expect(await autoLinkNonce({ ...base, join: 1, joinerIk: gIk, targetRootIk: eIk, immediate: true })).toBe(L.auto_link_immediate!.nonce);
    expect(await autoLinkNonce({ ...base, join: 2, joinerIk: eIk, targetRootIk: gIk, immediate: false })).toBe(L.auto_link_delayed!.nonce);
  });

  it("create_session's proof message and the linked CKD payload", async () => {
    expect(hex(await sessionMessage(0, await createProofPayload(session)))).toBe(L.session_message_create!.preimage_hex);
    expect(hex(await linkedCkdPayload('bls12381g1:A', 'bls12381g2:B', '{"payload":"e30","signatures":[]}', true))).toBe(L.ckd_link_payload!.preimage_hex);
  });
});

describe('email tokens against the fixture tokens', () => {
  const keys = [
    { kty: 'RSA', kid: emailFixture.email_kid, n: emailFixture.email_n, e: emailFixture.email_e, use: 'sig', alg: 'RS256' },
    { kty: 'RSA', kid: emailFixture.cosign_kid, n: emailFixture.cosign_n, e: emailFixture.cosign_e, use: 'sig', alg: 'RS256' },
  ];
  const tok = emailFixture.tokens;
  const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(JSON.parse(tok.email_session_s1).payload as string))) as { exp: number };
  const NOW = (claims.exp - 600) * 1000;
  const testEnv = (): Env => ({ ...env, EMAIL_ISS: emailFixture.email_iss, EMAIL_PUBLIC_KEYS: JSON.stringify(keys) }) as Env;
  /** get_self_issued("email") as the chain answers it. */
  const policy = (signers: { id: string; kids: string[] }[], required: number): NearMock => {
    clearLinkViewCaches();
    const near = new NearMock();
    near.views.get_self_issued = (a) => (a.provider === 'email' ? { provider: 'email', signers, required, overlap_until_ms: null } : null);
    near.install();
    return near;
  };

  it('accepts the 1-of-1 token and the co-signed one, as the contract does', async () => {
    policy([{ id: 'hana', kids: [emailFixture.email_kid] }], 1);
    const one = await verifyEmailToken(testEnv(), tok.email_session_s1, NOW, 60_000);
    expect(one).toMatchObject({ ok: true, token: { provider: 'email', sub: emailFixture.email_sub, aud: 'email:s1', kids: [emailFixture.email_kid] } });
    policy([{ id: 'hana', kids: [emailFixture.email_kid] }, { id: 'cosign', kids: [emailFixture.cosign_kid] }], 2);
    expect((await verifyEmailToken(testEnv(), tok.email_session_s1_cosigned, NOW, 60_000)).ok).toBe(true);
    // 2-of-2: one signature isn't enough, whichever signer made it.
    expect(await verifyEmailToken(testEnv(), tok.email_session_s1, NOW, 60_000)).toMatchObject({ ok: false, code: 'invalid_token', error: 'Not enough signatures' });
    expect(await verifyEmailToken(testEnv(), tok.email_session_s1_cosign_only, NOW, 60_000)).toMatchObject({ ok: false, code: 'invalid_token' });
  });

  it('a key the policy does not list yet is pending; no email issuer on chain is unsupported', async () => {
    policy([{ id: 'hana', kids: [] }], 1);
    expect(await verifyEmailToken(testEnv(), tok.email_session_s1, NOW, 60_000)).toMatchObject({ ok: false, code: 'issuer_key_pending' });
    policy([], 1);
    clearLinkViewCaches();
    const near = new NearMock();
    near.views.get_self_issued = () => null;
    near.install();
    expect(await verifyEmailToken(testEnv(), tok.email_session_s1, NOW, 60_000)).toMatchObject({ ok: false, code: 'unsupported_issuer' });
  });

  it('refuses what the contract refuses, and anything not in the issuer’s exact form', async () => {
    policy([{ id: 'hana', kids: [emailFixture.email_kid] }], 1);
    const parsed = JSON.parse(tok.email_session_s1) as { payload: string; signatures: { protected: string; signature: string }[] };
    const sig = parsed.signatures[0]!;
    const cases: [string, string, string][] = [
      // Not the issuer's serialization: whitespace, an unprotected header, the flattened form, a duplicate member.
      [JSON.stringify(parsed, null, 1), 'invalid_token', 'Malformed token'],
      [JSON.stringify({ ...parsed, signatures: [{ ...sig, header: { kid: 'x' } }] }), 'invalid_token', 'Malformed token'],
      [JSON.stringify({ payload: parsed.payload, protected: sig.protected, signature: sig.signature }), 'invalid_token', 'Malformed token'],
      [`{"payload":"${parsed.payload}","payload":"${parsed.payload}","signatures":${JSON.stringify(parsed.signatures)}}`, 'invalid_token', 'Malformed token'],
      [JSON.stringify({ payload: parsed.payload, signatures: [] }), 'invalid_token', 'Malformed token'],
      [JSON.stringify({ payload: parsed.payload, signatures: [sig, sig] }), 'invalid_token', 'Duplicate signature kid'],
      [JSON.stringify({ payload: parsed.payload, signatures: [sig, sig, sig, sig] }), 'invalid_token', 'Too many signatures'],
      [JSON.stringify({ payload: parsed.payload, signatures: [{ ...sig, signature: sig.signature.slice(0, -4) + 'AAAA' }] }), 'invalid_token', 'Invalid token signature'],
    ];
    for (const [token, code, error] of cases) expect(await verifyEmailToken(testEnv(), token, NOW, 60_000), token.slice(0, 60)).toMatchObject({ ok: false, code, error });
    // Expired, another env's issuer, an unknown key.
    expect(await verifyEmailToken(testEnv(), tok.email_session_s1, (claims.exp + 120) * 1000, 60_000)).toMatchObject({ ok: false, code: 'token_expired' });
    expect(await verifyEmailToken({ ...testEnv(), EMAIL_ISS: 'https://other.example/v1/email' }, tok.email_session_s1, NOW, 60_000)).toMatchObject({ ok: false, code: 'unsupported_issuer' });
    expect(await verifyEmailToken({ ...testEnv(), EMAIL_PUBLIC_KEYS: JSON.stringify([keys[1]]) }, tok.email_session_s1, NOW, 60_000)).toMatchObject({ ok: false, code: 'invalid_token', error: 'Unknown token signing key' });
    expect(await verifyEmailToken({ ...testEnv(), EMAIL_ISS: undefined }, tok.email_session_s1, NOW, 60_000)).toMatchObject({ ok: false, code: 'unsupported_issuer' });
  });

  it('the policy rule: each kid a listed signer’s, distinct signers counted', () => {
    const p = { signers: [{ id: 'hana', kids: ['a', 'b'] }, { id: 'cosign', kids: ['c'] }], required: 2, overlapUntilMs: null };
    expect(policyAccepts(p, ['a', 'c'])).toBe('ok');
    // Two keys of one signer count once.
    expect(policyAccepts(p, ['a', 'b'])).toBe('not_enough');
    expect(policyAccepts(p, ['a', 'z'])).toBe('pending');
    expect([...EMAIL_CLAIMS].sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'nonce', 'sub']);
  });
});
