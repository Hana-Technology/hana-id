// @vitest-environment happy-dom
// D405: the Hana API request ID in the SDK's errors. The vault puts it in a port error's `data.requestId` (for an SDK of
// API_REQUEST_ID_SDK_MIN or later: this one's hello names its version); `HanaError.requestId` reads it, the EIP-1193
// provider keeps it in `data.requestId` beside the Hana code, the SWK module in `ext[1]`. Only exactly a request ID is
// kept: anything else in that key is dropped from `data`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_REQUEST_ID_SDK_MIN, sdkAtLeast } from '@hana-id/core';
import { HanaError, ProviderRpcError, toProviderRpcError, toSwkError } from '../../src/client/errors.ts';
import { VERSION } from '../../src/version.ts';
import { LOGGED_IN, LOGGED_OUT, type Setup, flush, setup } from './harness.ts';

const RQ = '8d1f2c3a4b5e6f70-SIN';
const UUID = '3f2a9c1e-7b4d-4e8f-9a6b-0c1d2e3f4a5b';
const BAD = ['rq', 'a'.repeat(65), 'has_underscore_1', `${RQ} `, 42, null, { id: RQ }];

describe('HanaError.requestId', () => {
  it('the hello names a version the vault gives the field to', () => {
    expect(sdkAtLeast(VERSION, API_REQUEST_ID_SDK_MIN)).toBe(true);
  });

  it('reads data.requestId of a port error; null without one', () => {
    expect(HanaError.from({ code: 'rate_limited', message: 'm', data: { requestId: RQ } }).requestId).toBe(RQ);
    const withReason = HanaError.from({ code: 4100, message: 'm', data: { reason: 'share_not_fresh', requestId: UUID } });
    expect(withReason.requestId).toBe(UUID);
    expect(withReason.data).toEqual({ reason: 'share_not_fresh', requestId: UUID });
    expect(HanaError.from({ code: 'login_cancelled', message: 'm' }).requestId).toBeNull();
    expect(HanaError.from({ code: 'login_cancelled', message: 'm', data: { reason: 'popup_closed' } }).requestId).toBeNull();
    expect(new HanaError('api_unavailable', 'm', 'not an object').requestId).toBeNull();
  });

  for (const bad of BAD) {
    it(`a requestId of ${JSON.stringify(bad)} is dropped from data (the rest stays; nothing left: data undefined)`, () => {
      const alone = HanaError.from({ code: 'api_unavailable', message: 'm', data: { requestId: bad } });
      expect(alone.requestId).toBeNull();
      expect(alone.data).toBeUndefined();
      const beside = HanaError.from({ code: 'api_unavailable', message: 'm', data: { api: '503 x', requestId: bad } });
      expect(beside.requestId).toBeNull();
      expect(beside.data).toEqual({ api: '503 x' });
    });
  }
});

describe('the provider and SWK shapes', () => {
  it('EIP-1193: a string code keeps the Hana code and the request ID side by side in data', () => {
    const p = toProviderRpcError(new HanaError('rate_limited', 'slow down', { requestId: RQ }));
    expect(p).toBeInstanceOf(ProviderRpcError);
    expect({ code: p.code, data: p.data }).toEqual({ code: -32005, data: { code: 'rate_limited', requestId: RQ, data: { requestId: RQ } } });
    const none = toProviderRpcError(new HanaError('login_cancelled', 'm'));
    expect(none.data).toEqual({ code: 'login_cancelled' });
  });

  it('EIP-1193: a numeric code passes data through, request ID included', () => {
    const p = toProviderRpcError(new HanaError(4900, 'This session was revoked', { requestId: UUID }));
    expect({ code: p.code, data: p.data }).toEqual({ code: 4900, data: { requestId: UUID } });
  });

  it('SWK: ext is [hanaCode, requestId], or [hanaCode] without one', () => {
    expect(toSwkError(new HanaError('api_unavailable', 'm', { requestId: RQ }))).toEqual({ code: -32603, message: 'm', ext: ['api_unavailable', RQ] });
    expect(toSwkError(new HanaError('login_cancelled', 'm'))).toEqual({ code: 4001, message: 'm', ext: ['login_cancelled'] });
  });
});

describe('through the client', () => {
  let s: Setup;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    s?.client.destroy();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('a refused login rejects with the request ID, and hana.error has it', async () => {
    s = setup();
    await s.vault.connect(LOGGED_OUT);
    s.vault.handle('hana_login', () => 'manual');
    const p = s.client.login().catch((e: unknown) => e);
    await flush();
    s.vault.emit('loginProgress', { stage: 'popup_connected' });
    s.vault.replyError(s.vault.last('hana_login').id, 'no_google_client', 'This app has no usable Google client', { requestId: RQ });
    const e = (await p) as HanaError;
    expect(e).toBeInstanceOf(HanaError);
    expect(e.code).toBe('no_google_client');
    expect(e.requestId).toBe(RQ);
    expect(s.client.error?.requestId).toBe(RQ);
  });

  it('a refused hana_identityToken and revokeOtherDevices reject with it; a malformed one is dropped', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_identityToken', () => ({ error: { code: 'rate_limited', message: 'Too many identity token requests, try again later', data: { requestId: UUID } } }));
    const e1 = (await s.client.getIdentityToken().catch((e: unknown) => e)) as HanaError;
    expect(e1.requestId).toBe(UUID);
    s.vault.handle('hana_revokeOtherDevices', () => ({ error: { code: 4900, message: 'This session was revoked', data: { requestId: 'not one!' } } }));
    const e2 = (await s.client.revokeOtherDevices().catch((e: unknown) => e)) as HanaError;
    expect(e2.code).toBe(4900);
    expect(e2.requestId).toBeNull();
    expect(e2.data).toBeUndefined();
  });
});
