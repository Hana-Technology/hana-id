// Every nonce the issuer computes, byte for byte against the contract's worked examples (D14: the contract's Rust and
// gen-email-fixtures.mjs agree on them), and `sub` through the issuer's keys against packages/email's frozen vectors.
import { describe, expect, it } from 'vitest';
import emailFixture from '../../../contracts/hana-signer/src/email_fixture.json';
import testFixture from '../../../contracts/hana-signer/src/test_fixture.json';
import vectors from '../../../packages/email/vectors/email-v1.json';
import { emailSub, normalizeEmail } from '@hana-id/email';
import { fromHex, sha256, toHex, utf8 } from '../src/bytes.ts';
import { commitmentNonce } from '../src/commitment.ts';
import { importKeys } from '../src/keys.ts';
import {
  autoLinkPreimage,
  clientProofPreimage,
  identityKey,
  linkAccountPreimage,
  linkChangePreimage,
  linkNewPreimage,
  nonceOf,
  sessionPreimage,
} from '../src/layouts.ts';

type Layout = { preimage_hex: string; nonce?: string; ik?: string };
const L = emailFixture.layouts as unknown as Record<string, Layout>;
const T = testFixture.layouts as unknown as Record<string, Layout>;
const signer = emailFixture.signer;
const GOOGLE_SUB = '1098765432';
const EMAIL_SUB = emailFixture.email_sub;
const gIk = identityKey('s1', 'google', GOOGLE_SUB);
const eIk = identityKey('s1', 'email', EMAIL_SUB);
const salt = new Uint8Array(16).fill(9);
const sessionPk = fromHex(testFixture.session_pk7_hex);
const session = { scopeId: 's1', sessionPublicKey: sessionPk, expiresAtMs: 1800003600000, keyIndex: 0, maxUses: 3, salt };

describe('layouts against the contract fixtures', () => {
  it('identity keys', () => {
    expect(toHex(gIk)).toBe(L.identity_key_google!.ik);
    expect(toHex(eIk)).toBe(L.identity_key_email!.ik);
  });

  it('session nonce and client proof (test_fixture.json)', () => {
    expect(toHex(sessionPreimage(signer, session))).toBe(T.session_nonce!.preimage_hex);
    expect(nonceOf(sessionPreimage(signer, session))).toBe(T.session_nonce!.nonce);
    expect(toHex(clientProofPreimage(signer, 's1', 0))).toBe(T.client_proof!.preimage_hex);
    expect(nonceOf(clientProofPreimage(signer, 's1', 0))).toBe(T.client_proof!.nonce);
  });

  it('link_new, link_account, link_change', () => {
    const ln = linkNewPreimage(signer, 's1', gIk, 'email', 7, salt);
    expect(toHex(ln)).toBe(L.link_new!.preimage_hex);
    expect(nonceOf(ln)).toBe(L.link_new!.nonce);
    const la = linkAccountPreimage(signer, 's1', gIk, eIk, 7, salt);
    expect(toHex(la)).toBe(L.link_account!.preimage_hex);
    expect(nonceOf(la)).toBe(L.link_account!.nonce);
    const lc = linkChangePreimage(signer, 's1', 'cancel', gIk, eIk, 8, salt);
    expect(toHex(lc)).toBe(L.link_change_cancel!.preimage_hex);
    expect(nonceOf(lc)).toBe(L.link_change_cancel!.nonce);
    const lu = linkChangePreimage(signer, 's1', 'unlink', gIk, eIk, 8, salt);
    expect(toHex(lu)).toBe(L.link_change_unlink!.preimage_hex);
    expect(nonceOf(lu)).toBe(L.link_change_unlink!.nonce);
  });

  it('auto_link, case A (join 1, mode 1) and case B (join 2, mode 0): D133', () => {
    const hash = sha256(sessionPreimage(signer, session));
    const a = autoLinkPreimage(signer, 's1', hash, gIk, { join: 1, joinerIk: gIk, targetRootIk: eIk, targetEpoch: 3, mode: 1 });
    expect(toHex(a)).toBe(L.auto_link_immediate!.preimage_hex);
    expect(nonceOf(a)).toBe(L.auto_link_immediate!.nonce);
    const b = autoLinkPreimage(signer, 's1', hash, gIk, { join: 2, joinerIk: eIk, targetRootIk: gIk, targetEpoch: 3, mode: 0 });
    expect(toHex(b)).toBe(L.auto_link_delayed!.preimage_hex);
    expect(nonceOf(b)).toBe(L.auto_link_delayed!.nonce);
  });

  it('the commitment parser computes the same nonces from JSON', () => {
    const now = 1800000000000;
    const hex = (b: Uint8Array) => toHex(b);
    const s = commitmentNonce(signer, 'session', { scopeId: 's1', sessionPublicKey: [...sessionPk], expiresAtMs: 1800003600000, keyIndex: 0, maxUses: 3, salt: [...salt] }, now);
    expect(s.ok && s.value.nonce).toBe(T.session_nonce!.nonce);
    const ln = commitmentNonce(signer, 'link_new', { scopeId: 's1', rootIk: hex(gIk), epoch: 7, salt: [...salt] }, now);
    expect(ln.ok && ln.value.nonce).toBe(L.link_new!.nonce);
    const la = commitmentNonce(signer, 'link_account', { scopeId: 's1', rootIk: hex(gIk), newIk: hex(eIk), epoch: 7, salt: [...salt] }, now);
    expect(la.ok && la.value.nonce).toBe(L.link_account!.nonce);
    const lc = commitmentNonce(signer, 'link_change', { scopeId: 's1', action: 'unlink', rootIk: hex(gIk), memberIk: hex(eIk), epoch: 8, salt: [...salt] }, now);
    expect(lc.ok && lc.value.nonce).toBe(L.link_change_unlink!.nonce);
  });

  it('the commitment parser refuses malformed input and auto_link', () => {
    const now = 1800000000000;
    expect(commitmentNonce(signer, 'auto_link', {}, now).ok).toBe(false);
    expect(commitmentNonce(signer, 'nonce', {}, now).ok).toBe(false);
    const base = { scopeId: 's1', sessionPublicKey: [...sessionPk], expiresAtMs: now + 60_000, keyIndex: 0, maxUses: 3, salt: [...salt] };
    expect(commitmentNonce(signer, 'session', base, now).ok).toBe(true);
    expect(commitmentNonce(signer, 'session', { ...base, nonce: 'x' }, now).ok).toBe(false);
    expect(commitmentNonce(signer, 'session', { ...base, salt: [1, 2] }, now).ok).toBe(false);
    expect(commitmentNonce(signer, 'session', { ...base, expiresAtMs: now - 1 }, now).ok).toBe(false);
    expect(commitmentNonce(signer, 'session', { ...base, expiresAtMs: now + 2 * 86_400_000 }, now).ok).toBe(false);
    expect(commitmentNonce(signer, 'session', { ...base, keyIndex: 2 ** 31 }, now).ok).toBe(false);
    expect(commitmentNonce(signer, 'session', { ...base, maxUses: 501 }, now).ok).toBe(false);
    expect(commitmentNonce(signer, 'link_new', { scopeId: 's1', rootIk: 'AB'.repeat(32), epoch: 0, salt: [...salt] }, now).ok).toBe(false);
    expect(commitmentNonce(signer, 'link_change', { scopeId: 's1', action: 'merge', rootIk: '00'.repeat(32), memberIk: '00'.repeat(32), epoch: 0, salt: [...salt] }, now).ok).toBe(false);
  });
});

describe('sub through the issuer’s keys (packages/email vectors, frozen)', () => {
  it('matches every sub vector with the vectors’ public test key', async () => {
    const testKey = btoa(String.fromCharCode(...sha256(utf8(vectors.testKey.preimage))));
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
    const other2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
    const keys = await importKeys({ EMAIL_SUB_KEY: testKey, EMAIL_CODE_KEY: other, EMAIL_RL_KEY: other2 });
    for (const v of vectors.sub) expect(await emailSub(keys.sub, v.email)).toBe(v.sub);
  });

  it('a Gmail +tag is its own identity; dots are not (D159 as amended)', async () => {
    const keys = await importKeys({ EMAIL_SUB_KEY: btoa('k'.repeat(32)), EMAIL_CODE_KEY: btoa('c'.repeat(32)), EMAIL_RL_KEY: btoa('r'.repeat(32)) });
    const n = (s: string) => {
      const r = normalizeEmail(s);
      if (!r.ok) throw new Error(s);
      return r.email;
    };
    expect(n('Na.Me+1@GoogleMail.com')).toBe('name+1@gmail.com');
    const tagged = await emailSub(keys.sub, n('name+1@gmail.com'));
    expect(tagged).toBe(await emailSub(keys.sub, n('n.a.m.e+1@gmail.com')));
    expect(tagged).not.toBe(await emailSub(keys.sub, n('name@gmail.com')));
  });

  it('refuses identical or missing HMAC keys', async () => {
    const k = btoa('k'.repeat(32));
    await expect(importKeys({ EMAIL_SUB_KEY: k, EMAIL_CODE_KEY: k, EMAIL_RL_KEY: btoa('r'.repeat(32)) })).rejects.toThrow('differ');
    await expect(importKeys({ EMAIL_SUB_KEY: k, EMAIL_CODE_KEY: btoa('c'.repeat(32)) })).rejects.toThrow('EMAIL_RL_KEY');
  });
});
