// The mainnet demo's API side and the key export event (D428, D430; docs/mainnet-demo-and-key-export-spec.md): GET
// /v1/app serves `mainnetDemo` only for a test app with the switch on in a dev testnet env; migration 0013's triggers
// refuse the switch on a live app; POST /v1/mainnet-demo/events stores the vault's report (vault page only, the demo
// on, exact fields, within the cap); the export window's /v1/login records `key_exported` without key material.
import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AdminRpc } from '../src/rpc/admin.ts';
import { consoleRpc, hana, member, orgApp } from './rpc-helpers.ts';
import { MAINNET_DEMO_EVENTS_PER_HOUR, toMainnetDemoEvent } from '../src/mainnet-demo.ts';
import { appHeaders, call, chain, newKey, seedApp, uid } from './helpers.ts';
import { AUTH, hanaHeaders, loginBody, withCombinedCall } from './login-helpers.ts';

const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const newAud = (): string => `${uid()}.apps.googleusercontent.com`;
const setDemo = (appId: string, on: boolean) => env.DB.prepare('UPDATE apps SET mainnet_demo = ?2 WHERE id = ?1').bind(appId, on ? 1 : 0).run();
const EVM = '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826';
const G = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const event = (over: Record<string, unknown> = {}) => ({ chain: 'evm', network: '8453', kind: 'evm_tx', address: EVM, usdMicros: '8000001', ...over });
const report = (app: { key: string }, b: unknown, headers: Record<string, string> = hanaHeaders(app), bindings?: Partial<typeof env>) =>
  call('/v1/mainnet-demo/events', { headers, body: b, env: bindings });
const rows = (appId: string) =>
  env.DB.prepare('SELECT kind, app_id, scope_id, user_id, chain, network, address, usd_micros FROM user_events WHERE app_id = ?1 ORDER BY id').bind(appId).all().then((r) => r.results);

async function demoApp(on = true) {
  const app = await seedApp();
  const aud = newAud();
  chain({ [aud]: app.scope });
  if (on) await setDemo(app.id, true);
  return { app, aud };
}

describe('GET /v1/app: mainnetDemo (D428)', () => {
  const get = (app: { key: string }, bindings?: Partial<typeof env>) => call('/v1/app', { headers: appHeaders(app), env: bindings });

  it('is false by default and true once Hana staff set the switch, for a test app in a dev testnet env', async () => {
    const { app } = await demoApp(false);
    expect((await body(await get(app))).mainnetDemo).toBe(false);
    await setDemo(app.id, true);
    expect((await body(await get(app))).mainnetDemo).toBe(true);
    await setDemo(app.id, false);
    expect((await body(await get(app))).mainnetDemo).toBe(false);
  });

  it('is never true in a production env or on another network, whatever D1 says', async () => {
    const { app } = await demoApp();
    for (const bindings of [{ ENV_NAME: 'testnet' }, { ENV_NAME: 'production' }, { NETWORK: 'mainnet' }]) {
      expect((await body(await get(app, bindings))).mainnetDemo, JSON.stringify(bindings)).toBe(false);
    }
  });
});

describe('migration 0013', () => {
  it('refuses the switch on an app of a live scope, by insert or update', async () => {
    const live = await seedApp({ key: newKey('pk_live_') });
    await expect(setDemo(live.id, true)).rejects.toThrow(/mainnet_demo is for test apps only/u);
    await expect(
      env.DB.prepare("INSERT INTO apps (id, name, scope_id, publishable_key, status, plan, mainnet_demo) VALUES (?1, 'x', ?2, ?3, 'active', 'free', 1)").bind(`app_${uid()}`, live.scope, newKey('pk_live_')).run(),
    ).rejects.toThrow(/mainnet_demo is for test apps only/u);
    const test = await seedApp();
    await setDemo(test.id, true);
    // Moving a demo app into a live scope is refused too.
    await expect(env.DB.prepare('UPDATE apps SET scope_id = ?2 WHERE id = ?1').bind(test.id, live.scope).run()).rejects.toThrow(/mainnet_demo is for test apps only/u);
  });

  it('keeps key material out of user_events by shape: no column for a key, signature, token or path', async () => {
    const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info('user_events')").all<{ name: string }>();
    expect(results.map((r) => r.name).sort()).toEqual(['address', 'app_id', 'at', 'chain', 'id', 'kind', 'network', 'request_id', 'scope_id', 'usd_micros', 'user_id']);
  });
});

describe('POST /v1/mainnet-demo/events (D428)', () => {
  it('stores the vault’s report of a demo signature, and nothing else', async () => {
    const { app } = await demoApp();
    const res = await report(app, event());
    expect([res.status, (await body(res)).recorded]).toEqual([200, true]);
    const stellar = await report(app, event({ chain: 'stellar', network: 'pubnet', kind: 'stellar_tx', address: G, usdMicros: '5010500' }));
    expect(stellar.status).toBe(200);
    expect(await rows(app.id)).toEqual([
      { kind: 'mainnet_signature', app_id: app.id, scope_id: app.scope, user_id: null, chain: 'evm', network: '8453', address: EVM, usd_micros: 8000001 },
      { kind: 'mainnet_signature', app_id: app.id, scope_id: app.scope, user_id: null, chain: 'stellar', network: 'pubnet', address: G, usd_micros: 5010500 },
    ]);
  });

  it('is refused when the demo is off, outside a dev testnet env, or from anything but the vault page', async () => {
    const { app } = await demoApp(false);
    expect([(await report(app, event())).status]).toEqual([409]);
    await setDemo(app.id, true);
    expect((await report(app, event(), hanaHeaders(app), { ENV_NAME: 'production' })).status).toBe(409);
    // The partner page (its own origin) and the auth origin are refused.
    expect((await report(app, event(), appHeaders(app))).status).toBe(403);
    expect((await report(app, event(), hanaHeaders(app, AUTH))).status).toBe(403);
    expect(await rows(app.id)).toEqual([]);
  });

  it('accepts exactly the five fields, a demo network, the chain’s address form and a value within the cap', async () => {
    expect(toMainnetDemoEvent(event())).toEqual({ chain: 'evm', network: '8453', kind: 'evm_tx', address: EVM, usdMicros: 8000001 });
    for (const bad of [
      event({ signature: '0x00' }),
      event({ rawTx: '0x02' }),
      event({ network: '146' }),
      event({ network: '1' }),
      event({ usdMicros: '9990001' }),
      event({ usdMicros: '-1' }),
      event({ usdMicros: 1 }),
      event({ address: G }),
      event({ chain: 'stellar', network: 'testnet', kind: 'stellar_tx', address: G }),
      event({ chain: 'stellar', network: 'pubnet', kind: 'stellar_tx', address: EVM }),
      event({ kind: 'eip712' }),
      [],
      null,
    ]) {
      expect(toMainnetDemoEvent(bad), JSON.stringify(bad)).toBeNull();
    }
    const { app } = await demoApp();
    expect((await report(app, event({ network: '146' }))).status).toBe(400);
  });

  it(`is limited to ${MAINNET_DEMO_EVENTS_PER_HOUR} reports per app per hour`, async () => {
    expect(MAINNET_DEMO_EVENTS_PER_HOUR).toBe(120);
  });
});

describe('AdminRpc.setMainnetDemo (D428)', () => {
  const staffRpc = (bindings: Partial<typeof env> = {}) => new AdminRpc(createExecutionContext(), { ...env, ...bindings });
  const version = async (appId: string) => (await env.DB.prepare('SELECT settings_version AS v FROM apps WHERE id = ?1').bind(appId).first<{ v: number }>())!.v;
  const stored = async (appId: string) => (await env.DB.prepare('SELECT mainnet_demo AS m FROM apps WHERE id = ?1').bind(appId).first<{ m: number }>())!.m;

  it('Hana staff turn it on and off at once, each a settings_version bump and an app_changes row; the staff view shows it', async () => {
    const app = await orgApp();
    const v = await version(app.id);
    expect(await staffRpc().setMainnetDemo({ ...hana(), orgId: app.org, appId: app.id, on: true, expectedVersion: v })).toEqual({ ok: true, version: v + 1 });
    expect(await stored(app.id)).toBe(1);
    // Already on: no write.
    expect(await staffRpc().setMainnetDemo({ ...hana(), orgId: app.org, appId: app.id, on: true, expectedVersion: v + 1 })).toEqual({ ok: true, version: v + 1 });
    const detail = (await staffRpc().getApp({ ...hana(), orgId: app.org, appId: app.id })) as { ok: true; app: { settings: Record<string, unknown> } };
    expect(detail.app.settings.mainnetDemo).toBe(true);
    // A partner's view of the same app leaves the switch out.
    const partner = (await consoleRpc().getApp({ ...member(), orgId: app.org, appId: app.id })) as { ok: boolean; app?: { settings: Record<string, unknown> } };
    if (partner.ok) expect(partner.app!.settings).not.toHaveProperty('mainnetDemo');
    expect(await staffRpc().setMainnetDemo({ ...hana(), orgId: app.org, appId: app.id, on: false, expectedVersion: v + 1 })).toEqual({ ok: true, version: v + 2 });
    expect(await stored(app.id)).toBe(0);
    const kinds = await env.DB.prepare("SELECT kind FROM app_changes WHERE app_id = ?1 AND kind LIKE 'mainnet_demo.%' ORDER BY seq").bind(app.id).all<{ kind: string }>();
    expect(kinds.results.map((r) => r.kind)).toEqual(['mainnet_demo.on', 'mainnet_demo.off']);
  });

  it('is refused in a production env, on another network, and for a live app', async () => {
    const app = await orgApp();
    for (const bindings of [{ ENV_NAME: 'testnet' }, { ENV_NAME: 'production' }, { NETWORK: 'mainnet' }]) {
      const r = (await staffRpc(bindings).setMainnetDemo({ ...hana(), orgId: app.org, appId: app.id, on: true, expectedVersion: await version(app.id) })) as { ok: boolean; code?: string };
      expect([r.ok, r.code], JSON.stringify(bindings)).toEqual([false, 'env_mismatch']);
    }
    const live = await orgApp({ live: true });
    const r = (await staffRpc().setMainnetDemo({ ...hana(), orgId: live.org, appId: live.id, on: true, expectedVersion: await version(live.id) })) as { ok: boolean; code?: string };
    expect([r.ok, r.code]).toEqual([false, 'env_mismatch']);
    expect(await stored(app.id)).toBe(0);
    expect(await stored(live.id)).toBe(0);
  });

  it('a partner has no way to set it: ConsoleRpc has no such method, and a member actor is refused by AdminRpc', async () => {
    expect('setMainnetDemo' in consoleRpc()).toBe(false);
    const app = await orgApp();
    const r = (await staffRpc().setMainnetDemo({ ...member(), orgId: app.org, appId: app.id, on: true, expectedVersion: await version(app.id) })) as { ok: boolean };
    expect(r.ok).toBe(false);
    expect(await stored(app.id)).toBe(0);
  });
});

describe('key_exported (D430)', () => {
  it('the export window’s login records the event for the account’s user, with its chain, and no key, token or path', async () => {
    const { app, aud } = await demoApp(false);
    withCombinedCall(chain({ [aud]: app.scope }));
    const res = await call('/v1/login', { headers: hanaHeaders(app, AUTH), body: { ...(await loginBody(app.scope, aud)), exportChain: 'stellar' } });
    expect(res.status).toBe(200);
    const [row, ...more] = (await rows(app.id)) as Record<string, unknown>[];
    expect(more).toEqual([]);
    expect(row).toMatchObject({ kind: 'key_exported', app_id: app.id, scope_id: app.scope, chain: 'stellar', network: null, address: null, usd_micros: null });
    expect(row!.user_id).toMatch(/^hu_[0-9a-hjkmnp-tv-z]{26}$/u);
    const all = JSON.stringify(await env.DB.prepare('SELECT * FROM user_events WHERE app_id = ?1').bind(app.id).all());
    expect(all).not.toMatch(/eyJ|#google#|bls12381/u);
  });

  it('staff see the export and the user’s wallets’ demo signatures on the user’s detail and in a Support ID lookup', async () => {
    const { app, aud } = await demoApp();
    withCombinedCall(chain({ [aud]: app.scope }));
    const login = await call('/v1/login', { headers: hanaHeaders(app, AUTH), body: { ...(await loginBody(app.scope, aud)), exportChain: 'evm' } });
    expect(login.status).toBe(200);
    const supportId = (await body(login)).supportId as string;
    const internalId = ((await rows(app.id)) as { user_id: string }[])[0]!.user_id;
    const now = Date.now();
    // This user's own wallet (the directory matches demo signatures by address, across apps).
    const mine = `0x${[...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    await env.DB.prepare("INSERT INTO end_user_wallets (user_id, chain, address, key_index, first_seen_at, last_used_at) VALUES (?1, 'evm', ?2, 0, ?3, ?3)").bind(internalId, mine, now).run();
    expect((await report(app, event({ address: mine }))).status).toBe(200);
    // Another user's wallet: not this user's event.
    expect((await report(app, event({ address: '0x1111111111111111111111111111111111111111' }))).status).toBe(200);
    const staff = new AdminRpc(createExecutionContext(), env);
    const got = (await staff.getUser({ ...hana(), internalId })) as unknown as { ok: true; user: { events: Record<string, unknown>[] } };
    expect(got.user.events).toEqual([
      { kind: 'mainnet_signature', appId: app.id, chain: 'evm', network: '8453', address: mine, usdMicros: 8000001, at: expect.any(Number) },
      { kind: 'key_exported', appId: app.id, chain: 'evm', network: null, address: null, usdMicros: null, at: expect.any(Number) },
    ]);
    const lookup = (await staff.supportLookup({ ...hana(), query: supportId })) as { ok: true; matches: { user: { events: unknown[] } }[] };
    expect(lookup.matches[0]!.user.events).toHaveLength(2);
  });

  it('a plain login records nothing, and only the export window may label its login', async () => {
    const { app, aud } = await demoApp(false);
    withCombinedCall(chain({ [aud]: app.scope }));
    expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) })).status).toBe(200);
    const labelled = await call('/v1/login', { headers: hanaHeaders(app), body: { ...(await loginBody(app.scope, aud)), exportChain: 'evm' } });
    expect([labelled.status, (await body(labelled)).code]).toEqual([400, 'bad_request']);
    const wrong = await call('/v1/login', { headers: hanaHeaders(app, AUTH), body: { ...(await loginBody(app.scope, aud)), exportChain: 'btc' } });
    expect(wrong.status).toBe(400);
    expect(await rows(app.id)).toEqual([]);
  });

  it('an older export window without the label still records the event, with no chain', async () => {
    const { app, aud } = await demoApp(false);
    withCombinedCall(chain({ [aud]: app.scope }));
    expect((await call('/v1/login', { headers: hanaHeaders(app, AUTH), body: await loginBody(app.scope, aud) })).status).toBe(200);
    expect(await rows(app.id)).toMatchObject([{ kind: 'key_exported', chain: null }]);
  });
});
