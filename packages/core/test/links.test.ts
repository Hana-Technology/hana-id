// Accounts and links (src/links.ts): every layout against the contract's worked examples
// (contracts/hana-signer/src/email_fixture.json, written by scripts/gen-email-fixtures.mjs, an independent
// implementation), the views' parsing, the path rule (batch 7) and the auto_link judgement (D133), whose order and
// outcomes follow contracts/hana-signer/src/links.rs.
import { describe, expect, it } from 'vitest';
import emailFixture from '../../../contracts/hana-signer/src/email_fixture.json';
import testFixture from '../../../contracts/hana-signer/src/test_fixture.json';
import { fromHex, toHex } from '../src/bytes.ts';
import {
  type AccountView,
  type IdentityView,
  type LinkSide,
  FOLLOW_SLOTS,
  ViewShapeError,
  autoLinkNonce,
  followSlot,
  identityKey,
  identityKeyHex,
  judgeAutoLink,
  linkAccountNonce,
  linkChangeNonce,
  linkNewNonce,
  linkedCkdPayload,
  parseAccountView,
  parseIdentityView,
  pathIdentity,
  sessionHashOf,
} from '../src/links.ts';
import { relayIdFor } from '../src/layouts.ts';

type Example = { parts: [string, string][]; preimage_hex: string; nonce?: string; ik?: string };
const L = emailFixture.layouts as unknown as Record<string, Example>;
const signer = emailFixture.signer;
const salt = new Uint8Array(16).fill(9);
const gIk = fromHex(L.identity_key_google!.ik!);
const eIk = fromHex(L.identity_key_email!.ik!);
const session = {
  signer: testFixture.signer,
  scopeId: 's1',
  sessionPublicKey: fromHex(testFixture.session_pk7_hex),
  expiresAtMs: 1_800_000_000_000 + 3_600_000,
  keyIndex: 0,
  maxUses: 3,
  salt: new Uint8Array(16).fill(9),
};

describe('layouts against the contract fixture', () => {
  it('identity keys', () => {
    expect(toHex(identityKey('s1', 'google', '1098765432'))).toBe(L.identity_key_google!.ik);
    expect(identityKeyHex('s1', 'email', emailFixture.email_sub)).toBe(L.identity_key_email!.ik);
  });

  it('link_new, link_account and link_change nonces', () => {
    expect(linkNewNonce(signer, 's1', gIk, 'email', 7, salt)).toBe(L.link_new!.nonce);
    expect(linkAccountNonce(signer, 's1', gIk, eIk, 7, salt)).toBe(L.link_account!.nonce);
    expect(linkChangeNonce(signer, 's1', 'cancel', gIk, eIk, 8, salt)).toBe(L.link_change_cancel!.nonce);
    expect(linkChangeNonce(signer, 's1', 'unlink', gIk, eIk, 8, salt)).toBe(L.link_change_unlink!.nonce);
  });

  it('auto_link nonces (case A immediate, case B delayed) and the session hash', () => {
    const sessionHash = sessionHashOf(session);
    expect(toHex(sessionHash)).toBe(L.auto_link_immediate!.parts[3]![1]);
    const base = { signer, scopeId: 's1', sessionHash, sessionIk: gIk, targetEpoch: 3 };
    expect(autoLinkNonce({ ...base, join: 1, joinerIk: gIk, targetRootIk: eIk, immediate: true })).toBe(L.auto_link_immediate!.nonce);
    expect(autoLinkNonce({ ...base, join: 2, joinerIk: eIk, targetRootIk: gIk, immediate: false })).toBe(L.auto_link_delayed!.nonce);
  });

  it('the linked CKD payload', () => {
    expect(toHex(linkedCkdPayload('bls12381g1:A', 'bls12381g2:B', '{"payload":"e30","signatures":[]}', true))).toBe(L.ckd_link_payload!.preimage_hex);
  });
});

const G = { provider: 'google', sub: '1098765432' };
const E = { provider: 'email', sub: emailFixture.email_sub };
const gHex = L.identity_key_google!.ik!;
const eHex = L.identity_key_email!.ik!;
const own = (key: string, opened: boolean, epoch = 0): IdentityView => ({ key, status: 'own', opened, root: null, effectiveAtMs: null, accountEpoch: epoch });
const member = (key: string, root: { provider: string; sub: string }, epoch: number, pending = false): IdentityView => ({
  key,
  status: pending ? 'pending' : 'member',
  opened: false,
  root,
  effectiveAtMs: 5,
  accountEpoch: epoch,
});
const account = (root: { provider: string; sub: string }, members: AccountView['members'], epoch: number, unlinked: string[] = []): AccountView => ({ root, members, epoch, unlinked });

describe('views', () => {
  it('parses get_identity and get_account, and refuses other shapes', () => {
    expect(parseIdentityView({ key: gHex, status: 'own', opened: true, account_epoch: 0 })).toEqual(own(gHex, true));
    expect(parseIdentityView({ key: gHex, status: 'member', opened: false, root: E, effective_at_ms: 9, account_epoch: 2 })).toEqual({ ...member(gHex, E, 2), effectiveAtMs: 9 });
    expect(() => parseIdentityView({ key: gHex, status: 'member', opened: false, account_epoch: 2 })).toThrow(ViewShapeError);
    expect(() => parseIdentityView({ key: gHex, status: 'own', opened: true, root: E, account_epoch: 0 })).toThrow(ViewShapeError);
    expect(() => parseIdentityView({ key: 'zz', status: 'own', opened: true, account_epoch: 0 })).toThrow(ViewShapeError);
    expect(() => parseIdentityView({ key: gHex, status: 'member', opened: false, root: { provider: 'email', sub: 'a#b' }, account_epoch: 0 })).toThrow(ViewShapeError);
    expect(parseAccountView(null)).toBeNull();
    const raw = { root: E, members: [{ key: gHex, provider: 'google', effective_at_ms: 3, active: true, auto: true }], epoch: 4, unlinked: [] };
    expect(parseAccountView(raw)).toEqual(account(E, [{ key: gHex, provider: 'google', effectiveAtMs: 3, active: true, auto: true }], 4));
    expect(() => parseAccountView({ ...raw, members: [1] })).toThrow(ViewShapeError);
    expect(() => parseAccountView({ ...raw, unlinked: ['x'] })).toThrow(ViewShapeError);
  });
});

describe('pathIdentity (batch 7)', () => {
  it('an unlinked identity derives its own path, a member its root’s, a pending one nothing', () => {
    expect(pathIdentity('s1', G, own(gHex, false))).toEqual({ kind: 'path', identity: G, linked: false });
    expect(pathIdentity('s1', G, member(gHex, E, 1))).toEqual({ kind: 'path', identity: E, linked: true });
    expect(pathIdentity('s1', G, member(gHex, E, 1, true))).toEqual({ kind: 'pending', effectiveAtMs: 5 });
  });

  it('refuses a view whose key isn’t this identity’s', () => {
    expect(() => pathIdentity('s1', G, own(eHex, false))).toThrow(ViewShapeError);
    expect(() => pathIdentity('s2', G, own(gHex, false))).toThrow(ViewShapeError);
  });
});

describe('judgeAutoLink (D133)', () => {
  const sessionHash = sessionHashOf(session);
  const side = (ref: { provider: string; sub: string }, identity: IdentityView, acct: AccountView | null = null): LinkSide => ({ ref, identity, account: acct });
  const judge = (x: LinkSide, e: LinkSide, immediate: boolean) => judgeAutoLink({ signer, scopeId: 's1', sessionHash, session: x, link: e, immediate });

  it('case A: the Google identity joins the email wallet’s account, immediate only', () => {
    const r = judge(side(G, own(gHex, false)), side(E, own(eHex, true, 3)), true);
    expect(r).toEqual({ ok: true, join: 1, nonce: autoLinkNonce({ signer, scopeId: 's1', sessionHash, sessionIk: gIk, join: 1, joinerIk: gIk, targetRootIk: eIk, targetEpoch: 3, immediate: true }), pathIdentity: E });
    expect(r.ok && r.nonce).toBe(L.auto_link_immediate!.nonce);
    expect(judge(side(G, own(gHex, false)), side(E, own(eHex, true, 3)), false)).toEqual({ ok: false, reason: 'not_immediate' });
  });

  it('case B and C: the email identity joins the Google identity’s account, in either mode', () => {
    const delayed = judge(side(G, own(gHex, true, 3)), side(E, own(eHex, false)), false);
    expect(delayed).toEqual({ ok: true, join: 2, nonce: L.auto_link_delayed!.nonce, pathIdentity: G });
    const now = judge(side(G, own(gHex, true, 3)), side(E, own(eHex, false)), true);
    expect(now.ok && now.join).toBe(2);
    // C: neither has a wallet: the link identity joins (the session opens the Google identity's path now).
    expect(judge(side(G, own(gHex, false)), side(E, own(eHex, false)), true)).toMatchObject({ ok: true, join: 2, pathIdentity: G });
  });

  it('case A into an account the email identity is a member of targets its root', () => {
    const R = { provider: 'google', sub: '777' };
    const rHex = identityKeyHex('s1', R.provider, R.sub);
    // E is an active member of R's account (R is a Google root: then a second Google identity can't join).
    const e = side(E, member(eHex, R, 6), account(R, [{ key: eHex, provider: 'email', effectiveAtMs: 1, active: true, auto: true }], 6));
    expect(judge(side(G, own(gHex, false)), e, true)).toEqual({ ok: false, reason: 'provider_taken' });
    expect(rHex).toHaveLength(64);
  });

  it('refuses in the contract’s order', () => {
    expect(judge(side(G, member(gHex, E, 1, true)), side(E, own(eHex, true)), true)).toEqual({ ok: false, reason: 'pending' });
    expect(judge(side(G, own(gHex, true)), side(E, own(eHex, true)), true)).toEqual({ ok: false, reason: 'both_wallets' });
    expect(judge(side(G, member(gHex, E, 1)), side(E, own(eHex, true, 1), account(E, [{ key: gHex, provider: 'google', effectiveAtMs: 1, active: true, auto: true }], 1)), true)).toEqual({
      ok: false,
      reason: 'already_linked',
    });
    expect(judge(side(G, own(gHex, false)), side(E, own(eHex, true, 2), account(E, [], 2, [gHex])), true)).toEqual({ ok: false, reason: 'unlinked' });
    const full = account(E, [1, 2, 3].map((i) => ({ key: identityKeyHex('s1', 'x', String(i)), provider: `p${i}`, effectiveAtMs: 1, active: true, auto: false })), 2);
    expect(judge(side(G, own(gHex, false)), side(E, own(eHex, true, 2), full), true)).toEqual({ ok: false, reason: 'account_full' });
  });

  it('checks the views’ keys', () => {
    expect(() => judge(side(G, own(eHex, false)), side(E, own(eHex, true)), true)).toThrow(ViewShapeError);
  });
});

describe('follow-up slots', () => {
  it('are distinct, derived from the key, and relay ids of their read keys', () => {
    const key = new Uint8Array(32).fill(4);
    const ids = new Set<string>();
    for (let n = 1; n <= FOLLOW_SLOTS; n++) {
      const s = followSlot(key, n);
      expect(s.id).toBe(relayIdFor(s.readKey));
      ids.add(s.id);
    }
    expect(ids.size).toBe(FOLLOW_SLOTS);
    expect(followSlot(new Uint8Array(32).fill(5), 1).id).not.toBe(followSlot(key, 1).id);
    expect(() => followSlot(key, 0)).toThrow(RangeError);
    expect(() => followSlot(key, FOLLOW_SLOTS + 1)).toThrow(RangeError);
    expect(() => followSlot(new Uint8Array(16), 1)).toThrow();
  });
});
