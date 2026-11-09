// Email sharing's port method, event and window messages (D411; src/protocol.ts), the relay's sealed address and the
// app config's setting (src/relay.ts, src/api-types.ts).
import { describe, expect, it } from 'vitest';
import { isAppConfig } from '../src/api-types.ts';
import { EMAIL_CONSENT_ACTIONS, isEmailConsentStateResponse, isIdentityEmailSetting } from '../src/identity.ts';
import { EMAIL_SHARING_SDK_MIN, PORT_METHODS, STRING_ERROR_CODES, parsePortEvent, parsePortReply, parsePortRequest, parseWindowMessage } from '../src/protocol.ts';
import { isRelayPayload, isSealedEmailText } from '../src/relay.ts';

const SEALED = `se1.${'A'.repeat(60)}`;
const PK = 'pk_test_1111111111111111';
const proof = { sessionPublicKey: new Uint8Array(32), issuedAtMs: 1, nonce: new Uint8Array(16), signature: new Uint8Array(64) };
const request = (over: Record<string, unknown> = {}) => ({
  v: 1,
  t: 'hana:email-share-request',
  pk: PK,
  appName: 'Partner',
  parentOrigin: 'https://partner.example',
  ownGoogleClient: false,
  state: 'not_asked',
  sealedEmail: SEALED,
  proof,
  ...over,
});

describe('hana_requestEmailSharing', () => {
  it('is a port method with an optional popupBlocked, never popupOpened', () => {
    expect(PORT_METHODS).toContain('hana_requestEmailSharing');
    expect(parsePortRequest({ v: 1, id: '1', method: 'hana_requestEmailSharing' })).not.toBeNull();
    expect(parsePortRequest({ v: 1, id: '1', method: 'hana_requestEmailSharing', params: { popupBlocked: true } })?.params).toEqual({ popupBlocked: true });
    expect(parsePortRequest({ v: 1, id: '1', method: 'hana_requestEmailSharing', params: { popupBlocked: 'yes' } })).toBeNull();
    expect(parsePortRequest({ v: 1, id: '1', method: 'hana_requestEmailSharing', params: { email: 'x' } })).toBeNull();
    expect(parsePortRequest({ v: 1, id: '1', method: 'hana_requestEmailSharing', popupOpened: true })).toBeNull();
  });

  it('answers granted, declined or dismissed; its error code is a known one', () => {
    for (const state of ['granted', 'declined', 'dismissed']) expect(parsePortReply({ v: 1, id: '1', result: { state } }, 'hana_requestEmailSharing')).not.toBeNull();
    for (const result of [{ state: 'maybe' }, { state: 'granted', email: 'a@b' }, null]) expect(parsePortReply({ v: 1, id: '1', result }, 'hana_requestEmailSharing')).toBeNull();
    expect(STRING_ERROR_CODES).toContain('email_sharing_unavailable');
    expect(EMAIL_SHARING_SDK_MIN).toBe('0.3.0');
  });

  it('emailSharingChanged carries the state only', () => {
    expect(parsePortEvent({ v: 1, event: 'emailSharingChanged', data: { state: 'granted' } })).not.toBeNull();
    expect(parsePortEvent({ v: 1, event: 'emailSharingChanged', data: { state: 'declined' } })).not.toBeNull();
    for (const data of [{ state: 'dismissed' }, { state: 'granted', email: 'a@b' }, null]) expect(parsePortEvent({ v: 1, event: 'emailSharingChanged', data })).toBeNull();
  });
});

describe('the sheet’s window messages', () => {
  const all = ['hana:email-share-hello', 'hana:email-share-request', 'hana:email-share-close', 'hana:email-share-answer', 'hana:email-share-done', 'hana:email-revoke', 'hana:email-revoked'] as const;
  it('take exactly their fields, never an address', () => {
    expect(parseWindowMessage(request(), all)).not.toBeNull();
    expect(parseWindowMessage(request({ logoUrl: 'not a logo' }), all)).toBeNull();
    expect(parseWindowMessage(request({ email: 'ada@example.com' }), all)).toBeNull();
    expect(parseWindowMessage(request({ state: 'unavailable' }), all)).toBeNull();
    expect(parseWindowMessage(request({ sealedEmail: 'ada@example.com' }), all)).toBeNull();
    expect(parseWindowMessage(request({ proof: { ...proof, nonce: new Uint8Array(15) } }), all)).toBeNull();
    expect(parseWindowMessage(request({ ownGoogleClient: 'no' }), all)).toBeNull();
    for (const answer of ['granted', 'declined', 'revoke', 'keep']) expect(parseWindowMessage({ v: 1, t: 'hana:email-share-answer', answer }, all)).not.toBeNull();
    expect(parseWindowMessage({ v: 1, t: 'hana:email-share-answer', answer: 'yes' }, all)).toBeNull();
    for (const state of ['granted', 'declined', 'failed']) expect(parseWindowMessage({ v: 1, t: 'hana:email-share-done', state }, all)).not.toBeNull();
    expect(parseWindowMessage({ v: 1, t: 'hana:email-revoked', ok: true }, all)).not.toBeNull();
    expect(parseWindowMessage({ v: 1, t: 'hana:email-revoked', ok: 1 }, all)).toBeNull();
    expect(parseWindowMessage({ v: 1, t: 'hana:email-share-hello', x: 1 }, all)).toBeNull();
  });
});

describe('the sealed address and the setting elsewhere', () => {
  it('rides beside an email token in the relay (well formed only); the app config names the setting', () => {
    expect(isSealedEmailText(SEALED)).toBe(true);
    for (const bad of ['se1.', 'se2.AAAA', 'se1.a b', 'x'.repeat(2000), 5]) expect(isSealedEmailText(bad)).toBe(false);
    expect(isRelayPayload({ idToken: '{"x":1}', as: 'session', sealedEmail: SEALED })).toBe(true);
    expect(isRelayPayload({ idToken: '{"x":1}', sealedEmail: 'ada@example.com' })).toBe(false);
    const app = { scopeId: 's1', signer: 'signer.testnet', google: { clientId: 'c', mode: 'shared' } };
    for (const identityEmail of [undefined, 'off', 'on_request', 'at_login']) expect(isAppConfig({ ...app, ...(identityEmail ? { identityEmail } : {}) })).toBe(true);
    expect(isAppConfig({ ...app, identityEmail: 'on' })).toBe(false);
    expect(EMAIL_CONSENT_ACTIONS).toEqual(['state', 'granted', 'declined', 'revoke', 'preview']);
    expect(isIdentityEmailSetting('at_login')).toBe(true);
    expect(isIdentityEmailSetting('on')).toBe(false);
    expect(isEmailConsentStateResponse({ setting: 'on_request', state: 'not_asked' })).toBe(true);
    expect(isEmailConsentStateResponse({ setting: 'on', state: 'not_asked' })).toBe(false);
  });
});
