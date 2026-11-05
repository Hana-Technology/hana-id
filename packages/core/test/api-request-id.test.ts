// The API request ID on the client side (D405, api-request-id.ts): exactly the shapes apps/api sends, within what the
// Support ID lookup takes; the drop-if-malformed read; the SDK version gate; and the port error that carries it
// (`data` is free-form, so an older SDK would parse it: the gate is D393's rule, not its parser).
import { describe, expect, it } from 'vitest';
import { API_REQUEST_ID_RE, API_REQUEST_ID_SDK_MIN, apiRequestIdOf, isApiRequestId } from '../src/api-request-id.ts';
import { parsePortReply } from '../src/protocol.ts';
import { SUPPORT_ID_SDK_MIN, sdkAtLeast } from '../src/support-id.ts';
import { VERSION } from '../src/index.ts';

const RAY = '8d1f2c3a4b5e6f70-SIN';
const UUID = '3f2a9c1e-7b4d-4e8f-9a6b-0c1d2e3f4a5b';
/** console-core's `requestId` (the lookup's input), copied here: core doesn't depend on console-core. */
const LOOKUP_RE = /^[A-Za-z0-9_-]{8,128}$/u;
const BAD = ['', 'rq', '1234567', 'a'.repeat(65), 'has_underscore', `${RAY} `, ` ${RAY}`, `${RAY}\n`, 'a.b.c.d.e.f', 'ünïcode1', '../../etc', 42, null, undefined, {}, [RAY]];

describe('isApiRequestId', () => {
  it('takes what apps/api sends (a cf-ray or a UUID), and every value is one the lookup takes', () => {
    for (const ok of [RAY, UUID, UUID.toUpperCase(), '12345678', 'A'.repeat(64)]) {
      expect(isApiRequestId(ok), ok).toBe(true);
      expect(LOOKUP_RE.test(ok), ok).toBe(true);
    }
    expect(isApiRequestId(crypto.randomUUID())).toBe(true);
  });

  it('refuses anything else', () => {
    for (const bad of BAD) expect(isApiRequestId(bad), String(bad)).toBe(false);
    expect(API_REQUEST_ID_RE.test(`${RAY}\n`)).toBe(false);
  });

  it('apiRequestIdOf: the value, or null (never throws)', () => {
    expect(apiRequestIdOf(RAY)).toBe(RAY);
    for (const bad of BAD) expect(apiRequestIdOf(bad)).toBeNull();
  });
});

describe('the SDK gate', () => {
  it('is 0.2.0, the release with supportId, and this SDK version is at least it', () => {
    expect(API_REQUEST_ID_SDK_MIN).toBe('0.2.0');
    expect(API_REQUEST_ID_SDK_MIN).toBe(SUPPORT_ID_SDK_MIN);
    expect(sdkAtLeast(VERSION, API_REQUEST_ID_SDK_MIN)).toBe(true);
    for (const old of ['0.1.0', '0.2.0-rc.1', 'dev', '']) expect(sdkAtLeast(old, API_REQUEST_ID_SDK_MIN), old).toBe(false);
  });

  it('a port error with data.requestId parses, alone or beside other data', () => {
    for (const data of [{ requestId: RAY }, { reason: 'share_not_fresh', requestId: UUID }]) {
      expect(parsePortReply({ v: 1, id: 'r1', error: { code: 'rate_limited', message: 'm', data } }, 'hana_login')).toEqual({ v: 1, id: 'r1', error: { code: 'rate_limited', message: 'm', data } });
    }
  });
});
