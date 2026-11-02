// Relay payload encryption (AES-GCM under relayKey, AAD bound to relayId) and the API response types and guards.
import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  badCounterExpected,
  isAppConfig,
  isCreateShareResponse,
  isLoginResponse,
  isRelayReadResponse,
  isRevokeAllResponse,
  isRevokeShareResponse,
  isTouchResponse,
  isUnlockResponse,
  parseApiResponse,
} from '../src/api-types.ts';
import { base64UrlDecode, base64UrlEncode } from '../src/bytes.ts';
import { relayIdFor } from '../src/layouts.ts';
import { decryptRelayPayload, encryptRelayPayload, isRelayPayload } from '../src/relay.ts';

const key = () => crypto.getRandomValues(new Uint8Array(32));
const relayId = relayIdFor(new Uint8Array(32).fill(5));
const TOKEN = 'aaa.bbb.ccc';

describe('relay payload', () => {
  it('round-trips a token and a Google error', async () => {
    const k = key();
    const ct = await encryptRelayPayload(k, relayId, { idToken: TOKEN });
    expect(ct.ct).not.toContain('aaa');
    expect(base64UrlDecode(ct.iv)).toHaveLength(12);
    expect(await decryptRelayPayload(k, relayId, ct)).toEqual({ idToken: TOKEN });
    expect(await decryptRelayPayload(k, relayId, await encryptRelayPayload(k, relayId, { error: 'access_denied' }))).toEqual({ error: 'access_denied' });
  });

  it('zeroes the copy of relayKey it imports (the caller keeps its own)', async () => {
    const k = key();
    const before = k.slice();
    const imported: Uint8Array[] = [];
    const importKey = crypto.subtle.importKey.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'importKey').mockImplementation(((format: 'raw', data: Uint8Array, ...rest: never[]) => {
      if (format === 'raw') imported.push(data);
      return (importKey as (...a: unknown[]) => Promise<CryptoKey>)(format, data, ...rest);
    }) as never);
    try {
      await decryptRelayPayload(k, relayId, await encryptRelayPayload(k, relayId, { idToken: TOKEN }));
    } finally {
      spy.mockRestore();
    }
    expect(imported).toHaveLength(2);
    for (const raw of imported) {
      expect(raw).not.toBe(k);
      expect(raw.every((b) => b === 0)).toBe(true);
    }
    expect(k).toEqual(before);
  });

  it('uses a fresh IV each time', async () => {
    const k = key();
    const a = await encryptRelayPayload(k, relayId, { idToken: TOKEN });
    const b = await encryptRelayPayload(k, relayId, { idToken: TOKEN });
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('refuses another key, another relayId (AAD), a tampered ciphertext or IV', async () => {
    const k = key();
    const ct = await encryptRelayPayload(k, relayId, { idToken: TOKEN });
    await expect(decryptRelayPayload(key(), relayId, ct)).rejects.toThrow(/does not decrypt/);
    await expect(decryptRelayPayload(k, relayIdFor(new Uint8Array(32).fill(6)), ct)).rejects.toThrow(/does not decrypt/);
    const bytes = base64UrlDecode(ct.ct);
    bytes[0] = bytes[0]! ^ 1;
    await expect(decryptRelayPayload(k, relayId, { ...ct, ct: base64UrlEncode(bytes) })).rejects.toThrow(/does not decrypt/);
    await expect(decryptRelayPayload(k, relayId, { ...ct, iv: base64UrlEncode(new Uint8Array(11)) })).rejects.toThrow(/does not decrypt/);
    await expect(decryptRelayPayload(k, relayId, { ...ct, iv: '!!' })).rejects.toThrow(/does not decrypt/);
  });

  it('refuses a validly encrypted payload of the wrong shape', async () => {
    const k = key();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await crypto.subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt']);
    const aad = new TextEncoder().encode(`hana-id/relay/v1${relayId}`);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, cryptoKey, new TextEncoder().encode('{"idToken":"x","path":"evil"}')));
    await expect(decryptRelayPayload(k, relayId, { iv: base64UrlEncode(iv), ct: base64UrlEncode(ct) })).rejects.toThrow(/Malformed/);
  });

  it('validates payload shapes', () => {
    expect(isRelayPayload({ idToken: TOKEN })).toBe(true);
    expect(isRelayPayload({ error: 'interaction_required' })).toBe(true);
    expect(isRelayPayload({ error: 'Bad Code' })).toBe(false);
    expect(isRelayPayload({ idToken: '' })).toBe(false);
    expect(isRelayPayload({ idToken: TOKEN, error: 'x' })).toBe(false);
    expect(isRelayPayload([])).toBe(false);
  });

  it('refuses a wrong-length relay key', async () => {
    await expect(encryptRelayPayload(new Uint8Array(16), relayId, { idToken: TOKEN })).rejects.toThrow(/32 bytes/);
  });
});

describe('API responses', () => {
  it('parseApiResponse returns the body of a 2xx and throws ApiError with details otherwise', async () => {
    expect(await parseApiResponse(Response.json({ result: 1 }))).toEqual({ result: 1 });
    const err = await parseApiResponse(Response.json({ error: 'Stale counter', code: 'bad_counter', expected: 7, requestId: 'r1' }, { status: 409 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'bad_counter', requestId: 'r1', details: { expected: 7 } });
    expect(badCounterExpected(err as ApiError)).toBe(7);
    const pii = await parseApiResponse(Response.json({ error: 'x', code: 'token_has_pii', claim: 'email' }, { status: 400 })).catch((e: unknown) => e);
    expect((pii as ApiError).details).toEqual({ claim: 'email' });
    expect(badCounterExpected(pii as ApiError)).toBeNull();
    await expect(parseApiResponse(new Response('<html>', { status: 502, headers: { 'x-request-id': 'h1' } }))).rejects.toMatchObject({ code: 'non_json_response', requestId: 'h1' });
    await expect(parseApiResponse(Response.json([1]))).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('guards the batch B response shapes', () => {
    const b = (n: number) => new Array(n).fill(1);
    expect(isAppConfig({ scopeId: 's1', signer: 'x', google: { clientId: 'c', mode: 'shared' }, name: 'App', serverTimeMs: 5, requestId: 'r' })).toBe(true);
    expect(isAppConfig({ scopeId: 's1', signer: 'x', google: { clientId: 'c', mode: 'shared' }, serverTimeMs: -1 })).toBe(false);
    expect(isAppConfig({ scopeId: 's1', signer: 'x', google: { clientId: 'c', mode: 'shared' }, autoApprovePolicy: null, requestId: 'r' })).toBe(true);
    expect(isAppConfig({ scopeId: 's1', signer: 'x', google: { clientId: 'c', mode: 'shared' }, autoApprovePolicy: { v: 1 }, requestId: 'r' })).toBe(true);
    expect(isAppConfig({ scopeId: 's1', signer: 'x', google: { clientId: 'c', mode: 'shared' }, autoApprovePolicy: [1], requestId: 'r' })).toBe(false);
    expect(isAppConfig({ scopeId: 's1', signer: 'x', google: { clientId: 'c', mode: 'shared' }, autoApprovePolicy: 'off', requestId: 'r' })).toBe(false);
    // Email login (D231): loginMethods in its fixed order, `email` exactly with the email method and naming this scope.
    const g = { scopeId: 's1', signer: 'x', google: { clientId: 'c', mode: 'shared' }, requestId: 'r' };
    expect(isAppConfig({ ...g, loginMethods: ['google'] })).toBe(true);
    expect(isAppConfig({ ...g, loginMethods: ['google', 'email'], email: { aud: 'email:s1' } })).toBe(true);
    expect(isAppConfig({ ...g, loginMethods: ['google', 'email'] })).toBe(false);
    expect(isAppConfig({ ...g, loginMethods: ['google', 'email'], email: { aud: 'email:s2' } })).toBe(false);
    expect(isAppConfig({ ...g, loginMethods: ['google'], email: { aud: 'email:s1' } })).toBe(false);
    expect(isAppConfig({ ...g, loginMethods: ['email', 'google'], email: { aud: 'email:s1' } })).toBe(false);
    expect(isAppConfig({ ...g, loginMethods: ['google', 'apple'] })).toBe(false);
    // An email-only app (google: null) is not supported by this vault yet (D247).
    expect(isAppConfig({ ...g, google: null, loginMethods: ['email'], email: { aud: 'email:s1' } })).toBe(false);
    expect(isLoginResponse({ result: { big_y: 'y', big_c: 'c' }, session: { scope_id: 's1', expires_at_ms: 1, max_uses: 1, used: 1 }, nearTx: 'tx', requestId: 'r' })).toBe(true);
    expect(isLoginResponse({ result: { big_y: 'y', big_c: 'c' }, session: { scope_id: 's1', expires_at_ms: 1, max_uses: 1, used: 2 }, nearTx: 'tx' })).toBe(false);
    expect(isRelayReadResponse({ iv: 'a', ct: 'b', serverTimeMs: 1 })).toBe(true);
    expect(isRelayReadResponse({ iv: 'a', ct: 'b' })).toBe(false);
    expect(isCreateShareResponse({ shareId: b(16), ks: b(32), absExpiresAtMs: 1, idleUntilMs: 1 })).toBe(true);
    expect(isCreateShareResponse({ shareId: b(15), ks: b(32), absExpiresAtMs: 1, idleUntilMs: 1 })).toBe(false);
    expect(isUnlockResponse({ ks: b(32), counter: 2, idleUntilMs: 1, absExpiresAtMs: 1 })).toBe(true);
    expect(isUnlockResponse({ ks: [...b(31), 256], counter: 2, idleUntilMs: 1, absExpiresAtMs: 1 })).toBe(false);
    expect(isTouchResponse({ counter: 3, idleUntilMs: 1 })).toBe(true);
    expect(isRevokeShareResponse({ revoked: true })).toBe(true);
    expect(isRevokeShareResponse({ revoked: 1 })).toBe(false);
    expect(isRevokeAllResponse({ revoked: 2 })).toBe(true);
  });
});
