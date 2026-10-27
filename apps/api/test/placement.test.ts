import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ipSubject } from '../src/ip.ts';
import { doLocation, placedName } from '../src/placement.ts';
import { appHeaders, call, chain, seedApp, sessionBody, uid } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

const limiterKeys = (name: string): Promise<string[]> =>
  runInDurableObject(env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name)), (_i, state) => [...state.storage.kv.list()].map(([k]) => k));

describe('Durable Object placement', () => {
  it('accepts only Cloudflare location hints', () => {
    expect(doLocation({ DO_LOCATION_HINT: 'apac' })).toBe('apac');
    expect(doLocation({ DO_LOCATION_HINT: 'weur' })).toBe('weur');
    expect(doLocation({})).toBeUndefined();
    expect(doLocation({ DO_LOCATION_HINT: 'APAC' })).toBeUndefined();
    expect(doLocation({ DO_LOCATION_HINT: 'asia' })).toBeUndefined();
  });

  it('names a placed object after its region, and leaves names alone without one', () => {
    expect(placedName('relayer-key-0', 'apac')).toBe('relayer-key-0@apac');
    expect(placedName('relayer-key-0', undefined)).toBe('relayer-key-0');
  });

  it('places the app limiter in the configured region; the per-IP limiter stays near its client', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    chain({ [aud]: app.scope });
    const ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const res = await call('/v1/sessions', { headers: { ...appHeaders(app), 'cf-connecting-ip': ip }, body: await sessionBody(app.scope, aud), env: { DO_LOCATION_HINT: 'apac' } });
    expect(res.status).toBe(200);
    expect((await limiterKeys(`app:${app.id}@apac`)).some((k) => k.startsWith('minute@'))).toBe(true);
    expect(await limiterKeys(`app:${app.id}`)).toEqual([]);
    expect((await limiterKeys(`ip:${ipSubject(ip)}`)).some((k) => k.startsWith(`${app.id}:minute@`))).toBe(true);
    expect(await limiterKeys(`ip:${ipSubject(ip)}@apac`)).toEqual([]);
  });
});
