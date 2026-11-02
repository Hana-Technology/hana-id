import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORIGIN, appHeaders, call, chain, deriveBody, newKey, newSessionKey, seedApp, sessionBody, uid } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

/** Stages logged for a relayed request (sorted): handler stages, then the relayer key object's split of `relay`. */
const RELAY_PHASES = ['app', 'checks', 'limits', 'relay', 'relayChainRead', 'relayDispatch', 'relayOutcome', 'relayPersist', 'relayQueue', 'relaySign'];

const preflight = (path: string, origin: string | null): Promise<Response> =>
  call(path, {
    method: 'OPTIONS',
    headers: { ...(origin ? { origin } : {}), 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-hana-key' },
  });

describe('routing', () => {
  it('GET /v1/health', async () => {
    const res = await call('/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, env: 'sandbox-test', signer: 'signer.test.near', hotDb: 6 });
  });

  it('404s unknown paths and 405s wrong methods', async () => {
    expect((await call('/v1/nope')).status).toBe(404);
    expect((await call('/v1/sign', { body: {} })).status).toBe(404);
    expect((await call('/v1/sessions')).status).toBe(405);
    expect((await call('/v1/derive', { method: 'PUT', rawBody: '{}' })).status).toBe(405);
    expect((await call('/v1/owner-actions')).status).toBe(405);
    expect((await call('/v1/health', { body: {} })).status).toBe(405);
  });

  it('the router’s own 404 and 405 carry x-request-id, matching the body', async () => {
    for (const res of [await call('/v1/nope'), await call('/v1/sessions')]) {
      const id = res.headers.get('x-request-id');
      expect(id).toBeTruthy();
      expect(((await res.json()) as { requestId: string }).requestId).toBe(id);
    }
  });
});

describe('CORS', () => {
  it('answers preflight with the Origin when an active app allows it', async () => {
    const origin = `https://${uid()}.example.com`;
    await seedApp({ origins: [origin] });
    const res = await preflight('/v1/sessions', origin);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    expect(res.headers.get('access-control-allow-headers')).toContain('x-hana-key');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('vary')).toBe('Origin');
    for (const path of ['/v1/derive', '/v1/sessions/revoke']) expect((await preflight(path, origin)).headers.get('access-control-allow-origin')).toBe(origin);
  });

  it('refuses preflight for unknown origins, suspended apps, and no Origin', async () => {
    const suspendedOrigin = `https://${uid()}.example.com`;
    await seedApp({ origins: [suspendedOrigin], status: 'suspended' });
    for (const origin of ['https://unknown.example', suspendedOrigin, null]) {
      const res = await preflight('/v1/sessions', origin);
      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('preflight: http://localhost:* wildcard only via pk_test_ apps', async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const origin = `http://localhost:${port}`;
    await seedApp({ key: newKey('pk_live_'), origins: ['http://localhost:*', origin] });
    expect((await preflight('/v1/sessions', origin)).status).toBe(403);
    await seedApp({ origins: ['http://localhost:*'] });
    const res = await preflight('/v1/sessions', origin);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
  });

  it('echoes the Origin only for the request’s own app', async () => {
    const otherOrigin = `https://${uid()}.example.com`;
    await seedApp({ origins: [otherOrigin] });
    const app = await seedApp();
    // Allowed for some app (so preflight passes) but not for this key: no CORS header, 403.
    const res = await call('/v1/sessions', { headers: appHeaders(app, otherOrigin), body: {} });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const own = await call('/v1/sessions', { headers: appHeaders(app), body: {} });
    expect(own.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(own.headers.get('access-control-expose-headers')).toContain('x-request-id');
  });

  it('includes CORS on successful relays and contract errors', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    chain({ [aud]: app.scope });
    const ok = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const unknown = await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(newSessionKey()) });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('owner actions and health are open (no credentials, proof in the args)', async () => {
    const res = await preflight('/v1/owner-actions', 'https://console.example');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect((await call('/v1/health', { headers: { origin: 'https://x.example' } })).headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('logging', () => {
  it('never logs tokens, signatures, keys or bodies', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    const near = chain({ [aud]: app.scope });
    const req = await sessionBody(app.scope, aud);
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: req })).status).toBe(200);
    const spk = req.sessionPublicKey as number[];
    expect((await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk) })).status).toBe(200);
    near.contract.derive_key = () => {
      throw new Error(`echo ${String(req.jwt)}`);
    };
    expect((await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk, { counter: 2 }) })).status).toBe(422);

    const all = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    const jwt = String(req.jwt);
    for (const secret of [jwt, jwt.split('.')[1]!, app.key, 'bls12381g1:Y', 'bls12381g1:C', JSON.stringify((await deriveBody(spk)).signature), JSON.stringify(spk)]) {
      expect(all).not.toContain(secret);
    }
    const request = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === 'request' && l.endpoint === '/v1/sessions');
    expect(request).toMatchObject({ appId: app.id, outcome: 'ok', status: 200 });
    expect(typeof request?.requestId).toBe('string');
    expect(typeof request?.nearTx).toBe('string');
    expect(typeof request?.latencyMs).toBe('number');
  });

  it('logs each request’s stages and the data center that ran it', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    chain({ [aud]: app.scope });
    const req = await sessionBody(app.scope, aud);
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: req, cf: { colo: 'SIN' } })).status).toBe(200);
    expect((await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(req.sessionPublicKey as number[]) })).status).toBe(200);
    const requests = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === 'request');
    const session = requests.find((l) => l.endpoint === '/v1/sessions');
    expect(session?.colo).toBe('SIN');
    expect(Object.keys(session?.phases as object).sort()).toEqual(RELAY_PHASES);
    for (const ms of Object.values(session?.phases as Record<string, number>)) expect(ms).toBeGreaterThanOrEqual(0);
    const derive = requests.find((l) => l.endpoint === '/v1/derive');
    expect(derive?.colo).toBeUndefined();
    expect(Object.keys(derive?.phases as object).sort()).toEqual(RELAY_PHASES);
    for (const r of [session, derive]) {
      expect(r?.relayInstance).toEqual({ cold: expect.any(Boolean), coldChainRead: expect.any(Boolean), blockRefresh: expect.any(Boolean), served: expect.any(Number), ageMs: expect.any(Number) });
    }
  });
});
