// GET /v1/app, batch B additions: name, serverTimeMs, google_web_client_id, calls from the Hana pages.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORIGIN, appHeaders, call, chain, seedApp, uid } from './helpers.ts';
import { AUTH, VAULT, hanaHeaders } from './login-helpers.ts';

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
    expect(b).toEqual({ name: `Test ${app.id}`, scopeId: app.scope, signer: env.SIGNER_ACCOUNT, google: { clientId: aud, mode: 'own' }, serverTimeMs: expect.any(Number), autoApprovePolicy: null, requestId: expect.any(String) });
    expect(b.serverTimeMs as number).toBeGreaterThanOrEqual(before);
    expect(b.serverTimeMs as number).toBeLessThanOrEqual(Date.now());
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
    const policy = { v: 1, label: 'Swaps' };
    const setPolicy = (sql: string, ...args: unknown[]) => env.DB.prepare(`UPDATE apps SET ${sql} WHERE id = ?1`).bind(app.id, ...args).run();
    await setPolicy('auto_approve_policy = ?2', JSON.stringify(policy));
    expect(await body(await get(appHeaders(app)))).toMatchObject({ autoApprovePolicy: policy });
    // A pending change is served only once it is effective.
    const next = { v: 1, label: 'Swaps v2' };
    await setPolicy('auto_approve_pending = ?2, auto_approve_effective_at = ?3', JSON.stringify(next), Date.now() + 3_600_000);
    expect(await body(await get(appHeaders(app)))).toMatchObject({ autoApprovePolicy: policy });
    await setPolicy('auto_approve_effective_at = ?2', Date.now() - 1);
    expect(await body(await get(appHeaders(app)))).toMatchObject({ autoApprovePolicy: next });
    // Removal (the CLI clears the pending value too) is immediate.
    await setPolicy('auto_approve_policy = NULL, auto_approve_pending = NULL, auto_approve_effective_at = NULL');
    expect((await body(await get(appHeaders(app)))).autoApprovePolicy).toBeNull();
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
