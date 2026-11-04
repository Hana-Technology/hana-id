// The batch 7 and 8b protocol additions: auth-params' follow-up key and link task, the relay payload's new forms
// (access token, case B's proof, the answer kinds), the vault's follow-up notices, and the port's hana_account,
// hana_linkAccount and linkChanged shapes.
import { describe, expect, it } from 'vitest';
import { RELAY_MAX_BODY_BYTES, RELAY_MAX_PLAINTEXT_BYTES, decryptRelayPayload, encryptRelayPayload, encryptRelayValue, isFollowNotice, isRelayPayload } from '../src/relay.ts';
import { parsePortEvent, parsePortReply, parsePortRequest, parseWindowMessage } from '../src/protocol.ts';
import { relayIdFor, sessionNonce } from '../src/layouts.ts';

const params = (over: Record<string, unknown> = {}) => {
  const sessionPublicKey = new Uint8Array(32).fill(1);
  const salt = new Uint8Array(32).fill(2);
  return {
    v: 1,
    t: 'hana:auth-params',
    pk: 'pk_test_1111111111111111',
    appName: 'App',
    parentOrigin: 'https://partner.example',
    scopeId: 's1',
    signer: 'hana-signer.testnet',
    clientId: 'c.apps.googleusercontent.com',
    mode: 'shared',
    sessionPublicKey,
    expiresAtMs: 1_900_000_000_000,
    salt,
    keyIndex: 0,
    maxUses: 1,
    nonce: sessionNonce({ signer: 'hana-signer.testnet', scopeId: 's1', sessionPublicKey, expiresAtMs: 1_900_000_000_000, keyIndex: 0, maxUses: 1, salt }),
    relayId: relayIdFor(new Uint8Array(32).fill(3)),
    relayKey: new Uint8Array(32).fill(4),
    ...over,
  };
};

describe('auth-params (batch 8b)', () => {
  it('takes a follow-up key only with email offered or a link task', () => {
    const followKey = new Uint8Array(32).fill(5);
    expect(parseWindowMessage(params({ methods: ['google', 'email'], followKey }), ['hana:auth-params'])).not.toBeNull();
    expect(parseWindowMessage(params({ followKey }), ['hana:auth-params'])).toBeNull();
    expect(parseWindowMessage(params({ methods: ['google', 'email'], followKey: new Uint8Array(16) }), ['hana:auth-params'])).toBeNull();
  });

  it('a link task needs the follow-up key and a proof of its own provider, and no method or hint', () => {
    const followKey = new Uint8Array(32).fill(5);
    const task = { kind: 'link', provider: 'google', prove: { method: 'google', nonce: 'N'.repeat(43), loginHint: null } };
    expect(parseWindowMessage(params({ followKey, task }), ['hana:auth-params'])).not.toBeNull();
    expect(parseWindowMessage(params({ task }), ['hana:auth-params'])).toBeNull();
    expect(parseWindowMessage(params({ followKey, task: { ...task, provider: 'email' } }), ['hana:auth-params'])).toBeNull();
    expect(parseWindowMessage(params({ followKey, task, methods: ['google', 'email'], method: 'google' }), ['hana:auth-params'])).toBeNull();
  });

  it('token_first’s record-only login (D270): `emailRecord: true` with the follow-up key, never with methods or a task', () => {
    const followKey = new Uint8Array(32).fill(5);
    const task = { kind: 'link', provider: 'google', prove: { method: 'google', nonce: 'N'.repeat(43), loginHint: null } };
    expect(parseWindowMessage(params({ followKey, emailRecord: true }), ['hana:auth-params'])).not.toBeNull();
    expect(parseWindowMessage(params({ emailRecord: true }), ['hana:auth-params'])).toBeNull();
    expect(parseWindowMessage(params({ followKey, emailRecord: false }), ['hana:auth-params'])).toBeNull();
    expect(parseWindowMessage(params({ followKey, emailRecord: 1 }), ['hana:auth-params'])).toBeNull();
    expect(parseWindowMessage(params({ followKey, emailRecord: true, methods: ['google', 'email'] }), ['hana:auth-params'])).toBeNull();
    expect(parseWindowMessage(params({ followKey, emailRecord: true, task }), ['hana:auth-params'])).toBeNull();
  });
});

describe('relay payloads', () => {
  const caseB = { linkTicket: 'T'.repeat(43), emailSub: `e1.${'Q'.repeat(43)}` };
  it('accepts the new forms', () => {
    for (const p of [
      { idToken: 'a.b.c', accessToken: 'ya29.x' },
      { idToken: 'a.b.c', access: 'follow' },
      { idToken: 'a.b.c', access: 'follow', caseB },
      { idToken: '{"payload":"e30"}', as: 'link' },
      { idToken: 'a.b.c', as: 'proof' },
      { accessToken: 'ya29.x' },
    ]) {
      expect(isRelayPayload(p), JSON.stringify(p)).toBe(true);
    }
  });

  it('refuses mixed or malformed ones', () => {
    for (const p of [
      { idToken: 'a.b.c', accessToken: 'ya29.x', access: 'follow' },
      { idToken: 'a.b.c', access: 'now' },
      { idToken: 'a.b.c', caseB: { linkTicket: 'short', emailSub: 'x' } },
      { idToken: 'a.b.c', as: 'other' },
      { idToken: 'a.b.c', email: 'ada@example.com' },
      { accessToken: 'has space' },
      { accessToken: 'x', error: 'y' },
    ]) {
      expect(isRelayPayload(p), JSON.stringify(p)).toBe(false);
    }
  });
});

describe('follow-up notices', () => {
  it('accepts every notice the vault writes', () => {
    for (const n of [
      { t: 'link_code', challengeId: 'C'.repeat(43), expiresAtMs: 1, to: 'a…@example.com' },
      { t: 'use_email', reason: 'provider_taken' },
      { t: 'prove', why: 'link_account', provider: 'google', prove: { method: 'google', nonce: 'N'.repeat(43), loginHint: '1' } },
      { t: 'prove', why: 'link_new', provider: 'email', prove: { method: 'email', purpose: 'link_new', commitment: { scopeId: 's1' } } },
      { t: 'done', banners: [] },
      { t: 'done', banners: [{ provider: 'email', status: 'pending', effectiveAtMs: 5, fresh: true, action: { kind: 'cancel', prove: { method: 'google', nonce: 'N'.repeat(43), loginHint: null } } }] },
      { t: 'stop', code: 'link_pending', effectiveAtMs: 9 },
      { t: 'email_consent', reason: 'declined', loginHint: '110248495921238986420' },
      { t: 'email_consent', reason: 'account_mismatch', loginHint: '1' },
    ]) {
      expect(isFollowNotice(n), JSON.stringify(n)).toBe(true);
    }
  });

  it('refuses others', () => {
    for (const n of [
      { t: 'done' },
      { t: 'done', banners: [{ provider: 'apple', status: 'pending', effectiveAtMs: 5, fresh: true }] },
      { t: 'stop', code: 'Bad Code' },
      { t: 'prove', why: 'other', provider: 'google', prove: { method: 'google', nonce: 'N'.repeat(43), loginHint: null } },
      { t: 'prove', why: 'link_new', provider: 'google', prove: { method: 'email', purpose: 'session', commitment: 'x' } },
      { t: 'link_code', challengeId: 'C', expiresAtMs: 1, to: 'x' },
      { t: 'email_consent', reason: 'other', loginHint: '1' },
      { t: 'email_consent', reason: 'declined' },
      { t: 'email_consent', reason: 'declined', loginHint: 'a b' },
      { t: 'email_consent', reason: 'declined', loginHint: '1', extra: 1 },
      { t: 'whatever' },
    ]) {
      expect(isFollowNotice(n), JSON.stringify(n)).toBe(false);
    }
  });
});

describe('port: hana_account, hana_linkAccount, linkChanged', () => {
  it('parses the requests', () => {
    expect(parsePortRequest({ v: 1, id: '1', method: 'hana_account' })).not.toBeNull();
    expect(parsePortRequest({ v: 1, id: '1', method: 'hana_account', params: { x: 1 } })).toBeNull();
    expect(parsePortRequest({ v: 1, id: '1', method: 'hana_linkAccount', params: { method: 'email', popupBlocked: true } })).not.toBeNull();
    expect(parsePortRequest({ v: 1, id: '1', method: 'hana_linkAccount', params: { method: 'apple' } })).toBeNull();
  });

  it('parses the replies and the event', () => {
    const account = { methods: [{ provider: 'google', status: 'active', effectiveAtMs: null, root: true }, { provider: 'email', status: 'pending', effectiveAtMs: 5, root: false }] };
    expect(parsePortReply({ v: 1, id: '1', result: account }, 'hana_account')).not.toBeNull();
    expect(parsePortReply({ v: 1, id: '1', result: { methods: [] } }, 'hana_account')).toBeNull();
    expect(parsePortReply({ v: 1, id: '1', result: { methods: [{ ...account.methods[0], sub: '1' }] } }, 'hana_account')).toBeNull();
    expect(parsePortReply({ v: 1, id: '1', result: { provider: 'email', status: 'pending', effectiveAtMs: 5 } }, 'hana_linkAccount')).not.toBeNull();
    expect(parsePortReply({ v: 1, id: '1', result: { provider: 'email', status: 'removed', effectiveAtMs: null } }, 'hana_linkAccount')).toBeNull();
    expect(parsePortEvent({ v: 1, event: 'linkChanged', data: { provider: 'email', status: 'removed', effectiveAtMs: null } })).not.toBeNull();
    expect(parsePortEvent({ v: 1, event: 'linkChanged', data: { provider: 'email', status: 'gone', effectiveAtMs: null } })).toBeNull();
    expect(parsePortReply({ v: 1, id: '1', error: { code: 'link_refused', message: 'x', data: { reason: 'provider_taken' } } }, 'hana_linkAccount')).not.toBeNull();
  });
});

describe('relay value size (G-L7)', () => {
  const key = new Uint8Array(32).fill(7);
  const id = relayIdFor(new Uint8Array(32).fill(8));
  const bodyBytes = (v: { iv: string; ct: string }) => new TextEncoder().encode(JSON.stringify(v)).length;

  it('the largest one-request payload the field caps allow encrypts, fits the body cap and decrypts', async () => {
    const timings = Object.fromEntries(['authCheck', 'choose', 'callbackRedirect', 'callbackFetch', 'callbackBoot', 'callbackPrep', 'emailLoad', 'emailEntry'].map((k) => [k, 9_999_999_999]));
    const payload = {
      idToken: `${'h'.repeat(1000)}.${'p'.repeat(2000)}.${'s'.repeat(1094)}`,
      accessToken: 'y'.repeat(2048),
      caseB: { linkTicket: 'T'.repeat(64), emailSub: `e1.${'Z'.repeat(43)}` },
      as: 'session' as const,
      timings,
    };
    expect(payload.idToken).toHaveLength(4096);
    expect(isRelayPayload(payload)).toBe(true);
    const value = await encryptRelayPayload(key, id, payload);
    expect(bodyBytes(value)).toBeLessThanOrEqual(RELAY_MAX_BODY_BYTES);
    expect(await decryptRelayPayload(key, id, value)).toEqual(payload);
  });

  it('any value at the plaintext cap fits the body cap; a larger one is refused before encrypting', async () => {
    const at = await encryptRelayValue(key, id, 'x'.repeat(RELAY_MAX_PLAINTEXT_BYTES - 2));
    expect(bodyBytes(at)).toBeLessThanOrEqual(RELAY_MAX_BODY_BYTES);
    await expect(encryptRelayValue(key, id, 'x'.repeat(RELAY_MAX_PLAINTEXT_BYTES - 1))).rejects.toThrow(/too large/u);
  });
});
