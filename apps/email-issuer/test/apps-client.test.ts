// src/apps.ts, the issuer's client of the API's IssuerRpc (D434): the answer is checked, not trusted; anything but a
// well-formed `ok` answer is ApiUnavailable (the request answers 503 api_unavailable), with a reason naming the
// method and the code only.
import type { IssuerApp, IssuerRpcClient } from '@hana-id/console-core';
import { describe, expect, it } from 'vitest';
import { ApiUnavailable, appById, appByKey, scopeHasEmailApp } from '../src/apps.ts';
import { env, harness, seedApp } from './helpers.ts';

const APP: IssuerApp = { id: 'app_x', name: 'X', scopeId: 's1', active: true, emailOn: true, perMinute: 60, perDay: 1000, googleWebClientId: null };
const fake = (over: Partial<Record<keyof IssuerRpcClient, unknown>>): IssuerRpcClient =>
  ({
    appByKey: async () => over.appByKey,
    appById: async () => over.appById,
    scopeHasEmailApp: async () => over.scopeHasEmailApp,
  }) as unknown as IssuerRpcClient;
const reason = async (p: Promise<unknown>): Promise<string> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiUnavailable);
  return (err as ApiUnavailable).reason;
};

describe('the IssuerRpc client', () => {
  it('passes a well-formed answer through', async () => {
    const api = fake({ appByKey: { ok: true, app: APP }, appById: { ok: true, app: null }, scopeHasEmailApp: { ok: true, hasEmailApp: true } });
    expect(await appByKey(api, 'pk_test_1111111111111111111111111111111a')).toEqual(APP);
    expect(await appById(api, 'app_x')).toBeNull();
    expect(await scopeHasEmailApp(api, 's1')).toBe(true);
  });

  it('a refusal, a throw, a missing binding or a malformed answer is ApiUnavailable', async () => {
    expect(await reason(appByKey(fake({ appByKey: { ok: false, code: 'bad_request' } }), 'pk_test_1111111111111111111111111111111a'))).toBe('appByKey:bad_request');
    expect(await reason(appById(fake({ appById: { ok: false, code: 'internal' } }), 'app_x'))).toBe('appById:internal');
    expect(await reason(appByKey(undefined, 'pk_test_1111111111111111111111111111111a'))).toBe('appByKey:unreachable');
    const throwing = { appByKey: () => Promise.reject(new Error('boom')) } as unknown as IssuerRpcClient;
    expect(await reason(appByKey(throwing, 'pk_test_1111111111111111111111111111111a'))).toBe('appByKey:unreachable');
    for (const bad of [undefined, null, 'ok', { ok: true, app: { ...APP, active: 'yes' } }, { ok: true, app: { ...APP, perDay: 1.5 } }, { ok: true, app: { id: 'app_x' } }]) {
      expect(await reason(appByKey(fake({ appByKey: bad }), 'pk_test_1111111111111111111111111111111a')), JSON.stringify(bad)).toMatch(/^appByKey:/u);
    }
    expect(await reason(scopeHasEmailApp(fake({ scopeHasEmailApp: { ok: true, hasEmailApp: 'true' } }), 's1'))).toBe('scopeHasEmailApp:malformed');
  });

  it('reaches the real IssuerRpc over the API service binding', async () => {
    const app = await seedApp(await harness());
    expect(await appByKey(env.API, app.pk)).toMatchObject({ id: app.id, scopeId: app.scope, active: true, emailOn: true });
    expect(await appById(env.API, app.id)).toMatchObject({ id: app.id, name: app.name });
    expect(await scopeHasEmailApp(env.API, app.scope)).toBe(true);
    expect(await appByKey(env.API, 'pk_test_1111111111111111111111111111111z')).toBeNull();
  });
});
