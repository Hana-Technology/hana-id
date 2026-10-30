// The identity token's port method, event and BroadcastChannel message (src/protocol.ts).
import { describe, expect, it } from 'vitest';
import { IDENTITY_MAX_MAX_AGE_MS, IDENTITY_MIN_MAX_AGE_MS } from '../src/identity.ts';
import { PORT_METHODS, STRING_ERROR_CODES, parsePortEvent, parsePortReply, parsePortRequest, parseVaultBroadcast } from '../src/protocol.ts';

const TOKEN = `${'a'.repeat(40)}.${'b'.repeat(300)}.${'c'.repeat(86)}`;

describe('hana_identityToken', () => {
  it('is a port method with optional maxAgeMs in range', () => {
    expect(PORT_METHODS).toContain('hana_identityToken');
    expect(parsePortRequest({ v: 1, id: '1', method: 'hana_identityToken' })?.method).toBe('hana_identityToken');
    expect(parsePortRequest({ v: 1, id: '1', method: 'hana_identityToken', params: [] })).not.toBeNull();
    expect(parsePortRequest({ v: 1, id: '1', method: 'hana_identityToken', params: {} })).not.toBeNull();
    expect(parsePortRequest({ v: 1, id: '1', method: 'hana_identityToken', params: { maxAgeMs: IDENTITY_MIN_MAX_AGE_MS } })?.params).toEqual({ maxAgeMs: IDENTITY_MIN_MAX_AGE_MS });
    expect(parsePortRequest({ v: 1, id: '1', method: 'hana_identityToken', params: { maxAgeMs: IDENTITY_MAX_MAX_AGE_MS } })).not.toBeNull();
    for (const maxAgeMs of [IDENTITY_MIN_MAX_AGE_MS - 1, IDENTITY_MAX_MAX_AGE_MS + 1, 1.5e4 + 0.5, '60000', null]) {
      expect(parsePortRequest({ v: 1, id: '1', method: 'hana_identityToken', params: { maxAgeMs } })).toBeNull();
    }
    expect(parsePortRequest({ v: 1, id: '1', method: 'hana_identityToken', params: { maxAgeMs: 60_000, email: true } })).toBeNull();
    // Never with popupOpened: it shows no popup.
    expect(parsePortRequest({ v: 1, id: '1', method: 'hana_identityToken', popupOpened: true })).toBeNull();
  });

  it('answers a token with its expiry, or nulls while logged out', () => {
    expect(parsePortReply({ v: 1, id: '1', result: { identityToken: TOKEN, expiresAtMs: 1_800_003_600_000 } }, 'hana_identityToken')).not.toBeNull();
    expect(parsePortReply({ v: 1, id: '1', result: { identityToken: null, expiresAtMs: null } }, 'hana_identityToken')).not.toBeNull();
    for (const result of [{ identityToken: null, expiresAtMs: 1 }, { identityToken: TOKEN, expiresAtMs: null }, { identityToken: 'x.y.z', expiresAtMs: 1 }, { identityToken: TOKEN }, null]) {
      expect(parsePortReply({ v: 1, id: '1', result }, 'hana_identityToken')).toBeNull();
    }
    expect(parsePortReply({ v: 1, id: '1', error: { code: 'identity_unavailable', message: 'x' } }, 'hana_identityToken')).not.toBeNull();
    expect(parsePortReply({ v: 1, id: '1', error: { code: 'session_ended', message: 'x' } }, 'hana_identityToken')).not.toBeNull();
    expect(STRING_ERROR_CODES).toEqual(expect.arrayContaining(['identity_unavailable', 'session_ended', 'rate_limited']));
  });

  it('identityTokenChanged carries the same state', () => {
    expect(parsePortEvent({ v: 1, event: 'identityTokenChanged', data: { identityToken: TOKEN, expiresAtMs: 5 } })).not.toBeNull();
    expect(parsePortEvent({ v: 1, event: 'identityTokenChanged', data: { identityToken: null, expiresAtMs: null } })).not.toBeNull();
    expect(parsePortEvent({ v: 1, event: 'identityTokenChanged', data: { identityToken: TOKEN } })).toBeNull();
  });
});

describe("the 'identity' broadcast", () => {
  const ok = { v: 1, t: 'identity', sessionPk: new Uint8Array(32), identityToken: TOKEN, iatMs: 1_000, expiresAtMs: 2_000 };
  it('parses exactly', () => {
    expect(parseVaultBroadcast(ok)).not.toBeNull();
    expect(parseVaultBroadcast({ ...ok, sessionPk: new Uint8Array(31) })).toBeNull();
    expect(parseVaultBroadcast({ ...ok, iatMs: 3_000 })).toBeNull();
    expect(parseVaultBroadcast({ ...ok, identityToken: 'nope' })).toBeNull();
    expect(parseVaultBroadcast({ ...ok, prk: new Uint8Array(32) })).toBeNull();
  });
});
