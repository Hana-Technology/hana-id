// GET /v1/app, batch B additions: name, serverTimeMs, google_web_client_id, calls from the Hana pages.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Rpc } from '../src/near/rpc.ts';
import { VIEW_TIMEOUT_MS, clearViewCaches } from '../src/views.ts';
import { ORIGIN, appHeaders, call, chain, newKey, seedApp, uid } from './helpers.ts';
import { AUTH, VAULT, hanaHeaders } from './login-helpers.ts';
import { autoApprovePolicy } from './vault-helpers.ts';

afterEach(() => vi.restoreAllMocks());

const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const newAud = (): string => `${uid()}.apps.googleusercontent.com`;
const get = (headers: Record<string, string>): Promise<Response> => call('/v1/app', { method: 'GET', headers });
const setWebClient = (appId: string, clientId: string | null): Promise<unknown> => env.DB.prepare('UPDATE apps SET google_web_client_id = ?1 WHERE id = ?2').bind(clientId, appId).run();

describe('GET /v1/app (batch B)', () => {
  it('answers the app’s name and the server clock', async () => {
    const app = await seedApp();
    const aud = newAud();
    chain({ [aud]: app.scope });
    const before = Date.now();
    const res = await get(appHeaders(app));
    const b = await body(res);
    expect(res.status).toBe(200);
    expect(b).toEqual({
      name: `Test ${app.id}`,
      scopeId: app.scope,
      signer: env.SIGNER_ACCOUNT,
      google: { clientId: aud, mode: 'own' },
      loginMethods: ['google'],
      serverTimeMs: expect.any(Number),
      autoApprovePolicy: null,
      rawSign: 'off',
      // A pk_test_ app's response carries the API's own time and phases (docs/api.md "Timings").
      timings: { totalMs: expect.any(Number), phases: { app: expect.any(Number), limits: expect.any(Number), settings: expect.any(Number), chain: expect.any(Number) } },
      requestId: expect.any(String),
    });
    expect(b.serverTimeMs as number).toBeGreaterThanOrEqual(before);
    expect(b.serverTimeMs as number).toBeLessThanOrEqual(Date.now());
  });

  it('a pk_live_ app gets no timings', async () => {
    const app = await seedApp({ key: newKey('pk_live_') });
    chain({ [newAud()]: app.scope });
    const res = await get(appHeaders(app));
    expect(res.status).toBe(200);
    expect(await body(res)).not.toHaveProperty('timings');
  });

  it('reads the settings rows and the registry side by side: get_config is asked while get_scope is still out', async () => {
    clearViewCaches();
    const app = await seedApp();
    const shared = newAud();
    const near = chain({}, { shared: [shared], allowShared: [app.scope] });
    let configAsked!: () => void;
    const configSeen = new Promise<void>((r) => (configAsked = r));
    near.onView = (method) => {
      if (method === 'get_config') configAsked();
      // get_scope answers only once get_config was asked (or after 2 s, and the test fails below).
      if (method === 'get_scope') return Promise.race([configSeen, new Promise<void>((r) => setTimeout(r, 2_000))]);
    };
    const started = Date.now();
    const res = await get(appHeaders(app));
    expect(await body(res)).toMatchObject({ google: { clientId: shared, mode: 'shared' } });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('a get_config that fails counts only when the shared client is needed', async () => {
    clearViewCaches();
    const app = await seedApp();
    const own = newAud();
    const near = chain({ [own]: app.scope });
    near.views.get_scope = (a) => ({ id: a.scope_id, owners: [], clients: [['google', own]], pending: [], action_nonce: 0, allow_shared: true });
    near.views.get_config = () => {
      throw new Error('config view down');
    };
    expect(await body(await get(appHeaders(app)))).toMatchObject({ google: { clientId: own, mode: 'own' } });
    clearViewCaches();
    near.views.get_scope = (a) => ({ id: a.scope_id, owners: [], clients: [], pending: [], action_nonce: 0, allow_shared: true });
    const res = await get(appHeaders(app));
    expect([res.status, (await body(res)).code]).toEqual([502, 'near_unavailable']);
  });

  it('the registry views give up after VIEW_TIMEOUT_MS (an Rpc with a timeout passes an abort signal)', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      seen.push(init?.signal);
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    await expect(new Rpc(env.NEAR_RPC, VIEW_TIMEOUT_MS).view('signer.test', 'get_scope', {})).rejects.toThrow(/NEAR RPC unreachable/u);
    await expect(new Rpc(env.NEAR_RPC).view('signer.test', 'get_scope', {})).rejects.toThrow(/NEAR RPC unreachable/u);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[1]).toBeUndefined();
    expect(VIEW_TIMEOUT_MS).toBe(8_000);
  });

  it('uses google_web_client_id when set, the scope’s first Google client when unset', async () => {
    const app = await seedApp();
    const ios = newAud();
    const web = newAud();
    const near = chain({});
    near.views.get_scope = (a) => ({ id: a.scope_id, owners: [], clients: [['google', ios], ['other', web], ['google', web]], pending: [], action_nonce: 0, allow_shared: false });
    expect(await body(await get(appHeaders(app)))).toMatchObject({ google: { clientId: ios, mode: 'own' } });
    await setWebClient(app.id, web);
    expect(await body(await get(appHeaders(app)))).toMatchObject({ google: { clientId: web, mode: 'own' } });
    await setWebClient(app.id, null);
    expect(await body(await get(appHeaders(app)))).toMatchObject({ google: { clientId: ios, mode: 'own' } });
  });

  it('409 no_google_client when google_web_client_id is no longer one of the scope’s Google clients (never another client)', async () => {
    const app = await seedApp();
    const aud = newAud();
    const near = chain({ [aud]: app.scope }, { shared: [newAud()], allowShared: [app.scope] });
    await setWebClient(app.id, newAud());
    const res = await get(appHeaders(app));
    expect([res.status, (await body(res)).code]).toEqual([409, 'no_google_client']);
    // A client of that id under another provider doesn't count either.
    const web = newAud();
    await setWebClient(app.id, web);
    near.views.get_scope = (a) => ({ id: a.scope_id, owners: [], clients: [['apple', web]], pending: [], action_nonce: 0, allow_shared: true });
    expect((await get(appHeaders(app))).status).toBe(409);
  });

  it('answers the auto-approve policy in force: a removal at once, a new one only after its effective time', async () => {
    const app = await seedApp();
    const aud = newAud();
    chain({ [aud]: app.scope });
    const policy = autoApprovePolicy('Swaps');
    const setPolicy = (sql: string, ...args: unknown[]) => env.DB.prepare(`UPDATE apps SET ${sql} WHERE id = ?1`).bind(app.id, ...args).run();
    await setPolicy('auto_approve_policy = ?2', JSON.stringify(policy));
    expect(await body(await get(appHeaders(app)))).toMatchObject({ autoApprovePolicy: policy });
    // A pending change is served only once it is effective.
    const next = autoApprovePolicy('Swaps v2', 50);
    await setPolicy('auto_approve_pending = ?2, auto_approve_effective_at = ?3', JSON.stringify(next), Date.now() + 3_600_000);
    expect(await body(await get(appHeaders(app)))).toMatchObject({ autoApprovePolicy: policy });
    await setPolicy('auto_approve_effective_at = ?2', Date.now() - 1);
    expect(await body(await get(appHeaders(app)))).toMatchObject({ autoApprovePolicy: next });
    // Removal (the CLI clears the pending value too) is immediate.
    await setPolicy('auto_approve_policy = NULL, auto_approve_pending = NULL, auto_approve_effective_at = NULL');
    expect((await body(await get(appHeaders(app)))).autoApprovePolicy).toBeNull();
  });

  it('answers the raw-signing setting in force: off at once, approval only after its effective time', async () => {
    const app = await seedApp();
    const aud = newAud();
    chain({ [aud]: app.scope });
    const set = (sql: string, ...args: unknown[]) => env.DB.prepare(`UPDATE apps SET ${sql} WHERE id = ?1`).bind(app.id, ...args).run();
    const rawSign = async () => (await body(await get(appHeaders(app)))).rawSign;
    expect(await rawSign()).toBe('off');
    // Enabling is delayed (the CLI writes the pending value): still off until it is effective.
    await set("raw_sign_pending = 'approval', raw_sign_effective_at = ?2", Date.now() + 3_600_000);
    expect(await rawSign()).toBe('off');
    await set('raw_sign_effective_at = ?2', Date.now() - 1);
    expect(await rawSign()).toBe('approval');
    await set("raw_sign = 'approval', raw_sign_pending = NULL, raw_sign_effective_at = NULL");
    expect(await rawSign()).toBe('approval');
    // Turning it off is immediate, and an open vault re-reads this before every raw request.
    await set("raw_sign = 'off'");
    expect(await rawSign()).toBe('off');
  });

  it('answers null for a stored policy @hana-id/core refuses (the same rule as the vault page), with a log line', async () => {
    const app = await seedApp();
    const aud = newAud();
    chain({ [aud]: app.scope });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await env.DB.prepare('UPDATE apps SET auto_approve_policy = ?2 WHERE id = ?1').bind(app.id, JSON.stringify({ v: 1, label: 'Swaps' })).run();
    const res = await get(appHeaders(app));
    expect(res.status).toBe(200);
    expect((await body(res)).autoApprovePolicy).toBeNull();
    expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)).event)).toContain('auto_approve_policy_invalid');
  });

  it('503 config_unavailable when the settings row cannot be read', async () => {
    const app = await seedApp();
    const aud = newAud();
    chain({ [aud]: app.scope });
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('auto_approve_policy')) throw new Error('D1 down');
      return prepare(sql);
    });
    const res = await get(appHeaders(app));
    expect([res.status, (await body(res)).code]).toEqual([503, 'config_unavailable']);
  });

  it('serves the vault and the login popup for an allowed parent origin', async () => {
    const app = await seedApp();
    const aud = newAud();
    chain({ [aud]: app.scope });
    for (const origin of [VAULT, AUTH]) {
      const res = await get(hanaHeaders(app, origin));
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
      expect(await body(res)).toMatchObject({ scopeId: app.scope, google: { clientId: aud } });
      const refused = await get(hanaHeaders(app, origin, 'https://evil.example'));
      expect([refused.status, (await body(refused)).code]).toEqual([403, 'origin_not_allowed']);
    }
    // A partner page still reads it directly.
    expect((await get(appHeaders(app, ORIGIN))).status).toBe(200);
  });
});
