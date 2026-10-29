// The vault's NEAR reads at login (docs/batch-b-spec.md Q7, Q9): the scope check against the on-chain registry before
// anything is relayed, and the manifest's rpcFallback when the primary RPC fails.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Browser, ENV, type Google, RPC_FALLBACK, SCOPE, type Tab, apiError, deliverToken, google, login, makeConfig, popupHello, readyTab } from './harness.ts';

let g: Google;
const tabs: Tab[] = [];
beforeAll(async () => {
  g = await google();
});
afterEach(() => {
  for (const t of tabs.splice(0)) {
    t.close();
    t.browser.timers.dispose();
  }
});

async function tab(browser = new Browser(), o: Parameters<typeof readyTab>[1] = {}): Promise<Tab> {
  const t = await readyTab(browser, { googleJwk: g.jwk, ...o });
  tabs.push(t);
  return t;
}

const views = (b: Browser, name: string) => b.backend.rpcCalls.filter((c) => c.method === 'query' && c.params.method_name === name);
const relayed = (b: Browser) => b.backend.count('/v1/login') + b.backend.count('/v1/sessions') + b.backend.count('/v1/derive');
const OWN = { scopeId: SCOPE, signer: ENV.signer, google: { clientId: 'own.apps.googleusercontent.com', mode: 'own' }, name: 'Partner' };

describe('the scope check at login (Q7)', () => {
  it('shared client: get_scope must exist and allow shared login, and the client be a shared client in force; then the login goes on', async () => {
    const browser = new Browser();
    const t = await tab(browser);
    const { reply } = await login(t, g);
    expect(reply.error).toBeUndefined();
    expect(views(browser, 'get_scope')).toHaveLength(1);
    expect(views(browser, 'get_scope')[0]!.params).toMatchObject({ account_id: ENV.signer, finality: 'optimistic' });
    expect(views(browser, 'get_config')).toHaveLength(1);
    expect(views(browser, 'get_config')[0]!.params).toMatchObject({ account_id: ENV.signer, finality: 'optimistic' });
    expect(views(browser, 'scope_for_client')).toHaveLength(0);
    // pk_test_ apps see how long the view took and how long the login waited on it.
    expect((reply.result as { timings: Record<string, number> }).timings).toMatchObject({ scopeCheck: expect.any(Number), scopeWait: expect.any(Number) });
  });

  it.each([
    ['is not registered', (b: Browser) => b.backend.scopes.delete(SCOPE)],
    ['does not allow shared login', (b: Browser) => b.backend.scopes.set(SCOPE, { id: SCOPE, allow_shared: false })],
    // VAUL-4: the API named a client that isn't one of the contract's shared clients (a compromised API's own client).
    ['is fine, but the client is not a shared client', (b: Browser) => (b.backend.sharedClients = [['google', 'another.apps.googleusercontent.com']])],
    ['is fine, but no shared client is in force', (b: Browser) => (b.backend.sharedClients = [])],
  ])('shared client: a scope that %s refuses the login (config_mismatch) before anything is relayed', async (_, change) => {
    const browser = new Browser();
    change(browser);
    const t = await tab(browser);
    const { reply } = await login(t, g);
    expect(reply.error).toMatchObject({ code: 'config_mismatch', data: { reason: 'scope_mismatch' } });
    expect(relayed(browser)).toBe(0);
  });

  it('own client: scope_for_client(google, aud) must be the inlined scope', async () => {
    const browser = new Browser();
    browser.backend.app = { ...OWN };
    browser.backend.clientScopes.set('google|own.apps.googleusercontent.com', SCOPE);
    const t = await tab(browser);
    const { reply } = await login(t, g, { aud: 'own.apps.googleusercontent.com', azp: 'own.apps.googleusercontent.com' });
    expect(reply.error).toBeUndefined();
    expect(views(browser, 'scope_for_client')[0]!.params.args_base64).toBeTypeOf('string');
    expect(views(browser, 'get_scope')).toHaveLength(0);
  });

  it.each([
    ['another scope', 's9'],
    ['no scope', null],
  ])('own client: a client registered to %s refuses the login (a compromised API pointing the vault elsewhere)', async (_, owner) => {
    const browser = new Browser();
    browser.backend.app = { ...OWN };
    if (owner) browser.backend.clientScopes.set('google|own.apps.googleusercontent.com', owner);
    const t = await tab(browser);
    const { reply } = await login(t, g, { aud: 'own.apps.googleusercontent.com', azp: 'own.apps.googleusercontent.com' });
    expect(reply.error).toMatchObject({ code: 'config_mismatch', data: { reason: 'scope_mismatch' } });
    expect(relayed(browser)).toBe(0);
  });

  it('no answer from the RPC refuses the login (api_unavailable, scope_unchecked): it never derives unchecked', async () => {
    const browser = new Browser();
    browser.backend.rpcDown.add(ENV.rpc);
    const t = await tab(browser);
    const { reply } = await login(t, g);
    expect(reply.error).toMatchObject({ code: 'api_unavailable', data: { reason: 'scope_unchecked' } });
    expect(relayed(browser)).toBe(0);
  });

  it('runs while the user is at Google: the view is answered before the token arrives', async () => {
    const browser = new Browser();
    const t = await tab(browser);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    // The popup is open and no token exists yet: the check has already been asked.
    await t.waitUntil(() => views(browser, 'get_scope').length === 1, 'the get_scope view');
    await deliverToken(t, g, run);
    expect((await pending).error).toBeUndefined();
    expect(views(browser, 'get_scope')).toHaveLength(1);
  });
});

describe('rpcFallback (Q9)', () => {
  const env = { ...ENV, rpcFallback: RPC_FALLBACK };

  it('is used only when the primary fails, and the login completes through it', async () => {
    const browser = new Browser();
    browser.backend.rpcDown.add(ENV.rpc);
    const t = await tab(browser, { env });
    const { reply } = await login(t, g);
    expect(reply.error).toBeUndefined();
    expect(views(browser, 'get_scope').map((c) => c.endpoint)).toEqual([RPC_FALLBACK]);
  });

  it('a working primary answers alone: the fallback gets nothing', async () => {
    const browser = new Browser();
    const t = await tab(browser, { env });
    expect((await login(t, g)).reply.error).toBeUndefined();
    expect(browser.backend.rpcCalls.every((c) => c.endpoint === ENV.rpc)).toBe(true);
  });

  it('re-syncs a session through the fallback when the primary is down (failure handling)', async () => {
    const browser = new Browser();
    // Someone front-ran create_session with the vault's key ('none' mode: max_uses 2); the re-sync needs the RPC.
    browser.backend.overrides.set('/v1/login', (call) => {
      browser.backend.createSession({ ...(call.body as object), maxUses: 2 } as Record<string, unknown>, false);
      browser.backend.rpcDown.add(ENV.rpc);
      return apiError(409, 'session_exists');
    });
    const t = await tab(browser, { env, config: makeConfig({ settings: { persistence: 'none' } }) });
    const { reply } = await login(t, g);
    expect(reply.error).toBeUndefined();
    expect(views(browser, 'get_session').map((c) => c.endpoint)).toContain(RPC_FALLBACK);
  });

  it('both endpoints down: as no RPC at all', async () => {
    const browser = new Browser();
    browser.backend.rpcDown.add(ENV.rpc);
    browser.backend.rpcDown.add(RPC_FALLBACK);
    const t = await tab(browser, { env });
    expect((await login(t, g)).reply.error).toMatchObject({ code: 'api_unavailable', data: { reason: 'scope_unchecked' } });
  });
});
