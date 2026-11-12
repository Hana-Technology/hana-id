// The mainnet demo's API side and the key export event (D428, D430; docs/mainnet-demo-and-key-export-spec.md): GET
// /v1/app serves `mainnetDemo` only for a test app with the switch on in a dev testnet env; migration 0013's triggers
// refuse the switch on a live app; POST /v1/mainnet-demo/events stores the vault's report (vault page only, the demo
// on, exact fields, within the cap); the export window's /v1/login records `key_exported` without key material.
import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AdminRpc } from '../src/rpc/admin.ts';
import { consoleRpc, hana, member, orgApp, system } from './rpc-helpers.ts';
import { STAFF_USER_EVENTS_MAX } from '@hana-id/console-core';
import { identityMessage, mainnetDemoEventPayload } from '@hana-id/core/identity';
import { MAINNET_DEMO_EVENTS_PER_HOUR, toMainnetDemoEvent, toMainnetDemoReport } from '../src/mainnet-demo.ts';
import { appHeaders, call, chain, newKey, newSessionKey, seedApp, sessionKeyPair, uid } from './helpers.ts';
import { randomPrk, walletProofs } from './identity-helpers.ts';
import { spentSession, vaultSetup } from './vault-helpers.ts';
import { AUTH, hanaHeaders, loginBody, withCombinedCall } from './login-helpers.ts';

const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const newAud = (): string => `${uid()}.apps.googleusercontent.com`;
const setDemo = (appId: string, on: boolean) => env.DB.prepare('UPDATE apps SET mainnet_demo = ?2 WHERE id = ?1').bind(appId, on ? 1 : 0).run();
const EVM = '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826';

/** A report as the vault signs it: the session key over the event, with the session's wallet proof of the address. */
async function reportBody(
  app: { id: string },
  spk: number[],
  o: { event?: Record<string, string>; signWith?: number[]; proofSpk?: number[]; proofApp?: string; issuedAtMs?: number; mutate?: (b: Record<string, unknown>) => void } = {},
): Promise<{ body: Record<string, unknown>; address: string }> {
  const prk = randomPrk();
  const proofs = walletProofs(prk, { signer: env.SIGNER_ACCOUNT, appId: o.proofApp ?? app.id, sessionPublicKey: Uint8Array.from(o.proofSpk ?? spk) });
  const ev = { chain: 'evm', network: '8453', kind: 'evm_tx', usdMicros: '8000001', ...o.event } as { chain: 'evm' | 'stellar'; network: string; kind: string; usdMicros: string };
  const proof = proofs[ev.chain];
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const issuedAtMs = o.issuedAtMs ?? Date.now();
  const payload = mainnetDemoEventPayload({ ...ev, walletProof: { address: proof.address, signature: Uint8Array.from(proof.signature) } });
  const message = identityMessage({ signer: env.SIGNER_ACCOUNT, appId: app.id, sessionPublicKey: Uint8Array.from(spk), issuedAtMs, nonce, payload });
  const signature = [...sessionKeyPair(o.signWith ?? spk).sign(message).signature];
  const b: Record<string, unknown> = { sessionPublicKey: spk, issuedAtMs, nonce: [...nonce], signature, walletProof: proof, ...ev };
  o.mutate?.(b);
  return { body: b, address: proof.address };
}
const report = (app: { key: string }, b: unknown, headers: Record<string, string> = hanaHeaders(app), bindings?: Partial<typeof env>) =>
  call('/v1/mainnet-demo/events', { headers, body: b, env: bindings });
const rows = (appId: string) =>
  env.DB.prepare('SELECT kind, app_id, scope_id, user_id, chain, network, address, usd_micros FROM user_events WHERE app_id = ?1 ORDER BY id').bind(appId).all().then((r) => r.results);

/** A demo app on a mock chain whose sessions the test makes (spentSession). */
async function demoSession(on = true) {
  const { app, near } = await vaultSetup();
  if (on) await setDemo(app.id, true);
  return { app, near };
}

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

describe('POST /v1/mainnet-demo/events (D428, as reviewed)', () => {
  it('stores a report proven by a live session and the address’s own wallet proof, naming the session’s user', async () => {
    const { app, near } = await demoSession();
    const spk = spentSession(near, app.scope, { sub: 'demo-user-1' });
    const { body: b, address } = await reportBody(app, spk);
    const res = await report(app, b);
    expect([res.status, (await body(res)).recorded]).toEqual([200, true]);
    const stellar = await reportBody(app, spk, { event: { chain: 'stellar', network: 'pubnet', kind: 'stellar_tx', usdMicros: '5010500' } });
    expect((await report(app, stellar.body)).status).toBe(200);
    const stored = (await rows(app.id)) as Record<string, unknown>[];
    expect(stored).toEqual([
      { kind: 'mainnet_signature', app_id: app.id, scope_id: app.scope, user_id: expect.stringMatching(/^hu_[0-9a-hjkmnp-tv-z]{26}$/u), chain: 'evm', network: '8453', address, usd_micros: 8000001 },
      { kind: 'mainnet_signature', app_id: app.id, scope_id: app.scope, user_id: stored[0]!.user_id, chain: 'stellar', network: 'pubnet', address: stellar.address, usd_micros: 5010500 },
    ]);
  });

  it('refuses a forged report: no or a wrong session signature, a session not on chain, a replayed proof', async () => {
    const { app, near } = await demoSession();
    const spk = spentSession(near, app.scope);
    // Not signed by the session key (another key signed it), or the signature altered.
    const other = newSessionKey();
    expect((await report(app, (await reportBody(app, spk, { signWith: other })).body)).status).toBe(401);
    expect((await report(app, (await reportBody(app, spk, { mutate: (b) => { const sig = b.signature as number[]; sig[0] = (sig[0] ?? 0) ^ 1; } })).body)).status).toBe(401);
    // The event changed after signing (a bigger value): the session signature covers every field.
    expect((await report(app, (await reportBody(app, spk, { mutate: (b) => (b.usdMicros = '9000000') })).body)).status).toBe(401);
    // A key with no session on chain (anyone can make a key pair).
    const res = await report(app, (await reportBody(app, other)).body);
    expect([res.status, (await body(res)).code]).toEqual([410, 'session_ended']);
    // The same proof twice.
    const once = (await reportBody(app, spk)).body;
    expect((await report(app, once)).status).toBe(200);
    expect([(await report(app, once)).status]).toEqual([409]);
    // Too old.
    expect((await report(app, (await reportBody(app, spk, { issuedAtMs: Date.now() - 120_000 })).body)).status).toBe(400);
    expect((await rows(app.id)).length).toBe(1);
  });

  it('refuses another user’s address: a wallet proof made for another session, or for another app', async () => {
    const { app, near } = await demoSession();
    const mine = spentSession(near, app.scope, { sub: 'attacker' });
    const victim = spentSession(near, app.scope, { sub: 'victim' });
    // The victim's wallet proof (bound to the victim's session key), sent with the attacker's session.
    let res = await report(app, (await reportBody(app, mine, { proofSpk: victim })).body);
    expect([res.status, (await body(res)).code]).toEqual([400, 'bad_wallet_proof']);
    const otherApp = await seedApp({ scope: app.scope });
    res = await report(app, (await reportBody(app, mine, { proofApp: otherApp.id })).body);
    expect([res.status, (await body(res)).code]).toEqual([400, 'bad_wallet_proof']);
    expect(await rows(app.id)).toEqual([]);
  });

  it('is refused when the demo is off, outside a dev testnet env, or from anything but the vault page', async () => {
    const { app, near } = await demoSession(false);
    const spk = spentSession(near, app.scope);
    expect((await report(app, (await reportBody(app, spk)).body)).status).toBe(409);
    await setDemo(app.id, true);
    expect((await report(app, (await reportBody(app, spk)).body, hanaHeaders(app), { ENV_NAME: 'production' })).status).toBe(409);
    expect((await report(app, (await reportBody(app, spk)).body, appHeaders(app))).status).toBe(403);
    expect((await report(app, (await reportBody(app, spk)).body, hanaHeaders(app, AUTH))).status).toBe(403);
    expect(await rows(app.id)).toEqual([]);
  });

  it('accepts exactly its fields, a demo network and a value within the cap', async () => {
    const ev = { chain: 'evm', network: '8453', kind: 'evm_tx', usdMicros: '8000001' };
    expect(toMainnetDemoEvent(ev)).toEqual({ chain: 'evm', network: '8453', kind: 'evm_tx', usdMicros: 8000001 });
    for (const bad of [{ ...ev, network: '146' }, { ...ev, network: '1' }, { ...ev, usdMicros: '9990001' }, { ...ev, usdMicros: '-1' }, { ...ev, usdMicros: 1 }, { ...ev, kind: 'eip712' }, { ...ev, chain: 'stellar', network: 'testnet', kind: 'stellar_tx' }]) {
      expect(toMainnetDemoEvent(bad), JSON.stringify(bad)).toBeNull();
    }
    const { app, near } = await demoSession();
    const spk = spentSession(near, app.scope);
    const good = (await reportBody(app, spk)).body;
    expect(toMainnetDemoReport(good)).not.toBeNull();
    for (const mutate of [(b: Record<string, unknown>) => (b.rawTx = '0x02'), (b: Record<string, unknown>) => (b.address = '0x1'), (b: Record<string, unknown>) => delete b.walletProof, (b: Record<string, unknown>) => (b.nonce = [1, 2])]) {
      const b = structuredClone(good);
      mutate(b);
      expect(toMainnetDemoReport(b)).toBeNull();
    }
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

  it('staff see the export and the user’s demo signatures on the user’s detail and in a Support ID lookup', async () => {
    const { app, aud } = await demoApp();
    const near = withCombinedCall(chain({ [aud]: app.scope }));
    const login = await call('/v1/login', { headers: hanaHeaders(app, AUTH), body: { ...(await loginBody(app.scope, aud, {}, { sub: 'staff-view-1' })), exportChain: 'evm' } });
    expect(login.status).toBe(200);
    const supportId = (await body(login)).supportId as string;
    const internalId = ((await rows(app.id)) as { user_id: string }[])[0]!.user_id;
    // A demo signature from this user's session (the same account root), and one from another user's.
    const { body: mineBody, address } = await reportBody(app, spentSession(near, app.scope, { sub: 'staff-view-1' }));
    expect((await report(app, mineBody)).status).toBe(200);
    expect((await report(app, (await reportBody(app, spentSession(near, app.scope, { sub: 'someone-else' }))).body)).status).toBe(200);
    const staff = new AdminRpc(createExecutionContext(), env);
    const got = (await staff.getUser({ ...hana(), internalId })) as unknown as { ok: true; user: { events: Record<string, unknown>[] } };
    expect(got.user.events).toEqual([
      { kind: 'mainnet_signature', appId: app.id, chain: 'evm', network: '8453', address, usdMicros: 8000001, at: expect.any(Number) },
      { kind: 'key_exported', appId: app.id, chain: 'evm', network: null, address: null, usdMicros: null, at: expect.any(Number) },
    ]);
    const lookup = (await staff.supportLookup({ ...hana(), query: supportId })) as { ok: true; matches: { user: { events: unknown[] } }[] };
    expect(lookup.matches[0]!.user.events).toHaveLength(2);
  });

  it('a flood of signature rows never pushes a key export out of the staff view (each kind capped on its own)', async () => {
    const { app, aud } = await demoApp();
    withCombinedCall(chain({ [aud]: app.scope }));
    expect((await call('/v1/login', { headers: hanaHeaders(app, AUTH), body: { ...(await loginBody(app.scope, aud, {}, { sub: 'flooded-1' })), exportChain: 'stellar' } })).status).toBe(200);
    const internalId = ((await rows(app.id)) as { user_id: string }[])[0]!.user_id;
    const now = Date.now();
    const insert = env.DB.prepare(
      "INSERT INTO user_events (kind, app_id, scope_id, user_id, chain, network, address, usd_micros, request_id, at) VALUES ('mainnet_signature', ?1, ?2, ?3, 'evm', '8453', ?4, 1, ?5, ?6)",
    );
    await env.DB.batch(Array.from({ length: 60 }, (_, i) => insert.bind(app.id, app.scope, internalId, EVM, `rq_flood_${uid()}_${i}`, now + 1000 + i)));
    const got = (await new AdminRpc(createExecutionContext(), env).getUser({ ...hana(), internalId })) as unknown as { ok: true; user: { events: { kind: string }[] } };
    const kinds = got.user.events.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'mainnet_signature')).toHaveLength(STAFF_USER_EVENTS_MAX);
    expect(kinds.filter((k) => k === 'key_exported')).toHaveLength(1);
  });

  it('after the retention purge (24 months, readiness 7.17) the user’s detail and the Support ID lookup show what is left, or nothing', async () => {
    const { app, aud } = await demoApp();
    withCombinedCall(chain({ [aud]: app.scope }));
    const login = await call('/v1/login', { headers: hanaHeaders(app, AUTH), body: { ...(await loginBody(app.scope, aud, {}, { sub: 'purged-1' })), exportChain: 'stellar' } });
    expect(login.status).toBe(200);
    const supportId = (await body(login)).supportId as string;
    const internalId = ((await rows(app.id)) as { user_id: string }[])[0]!.user_id;
    // An export and a demo signature from 25 months ago, besides today's export.
    const old = Date.now() - 25 * 30.44 * 86_400_000;
    const insert = env.DB.prepare('INSERT INTO user_events (kind, app_id, scope_id, user_id, chain, network, address, usd_micros, request_id, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)');
    await env.DB.batch([
      insert.bind('key_exported', app.id, app.scope, internalId, 'evm', null, null, null, `rq_old_${uid()}`, old),
      insert.bind('mainnet_signature', app.id, app.scope, internalId, 'evm', '8453', EVM, 1, `rq_old_${uid()}`, old + 1),
    ]);
    const staff = new AdminRpc(createExecutionContext(), env);
    const view = async () => ((await staff.getUser({ ...hana(), internalId })) as unknown as { ok: true; user: { events: { kind: string; at: number }[] } }).user.events;
    expect(await view()).toHaveLength(3);
    expect(await staff.purgeUserEvents({ ...system(), before: Date.now(), deletedBefore: Date.now(), limit: 500 })).toMatchObject({ ok: true, expired: 2 });
    expect(await view()).toEqual([expect.objectContaining({ kind: 'key_exported', chain: 'stellar' })]);
    const lookup = (await staff.supportLookup({ ...hana(), query: supportId })) as { ok: true; matches: { user: { internalId: string; events: unknown[] } }[] };
    expect(lookup.matches.map((m) => [m.user.internalId, m.user.events.length])).toEqual([[internalId, 1]]);
    // Every row gone: the user and the lookup still answer, with no events.
    await env.DB.prepare('DELETE FROM user_events WHERE user_id = ?1').bind(internalId).run();
    expect(await view()).toEqual([]);
    const after = (await staff.supportLookup({ ...hana(), query: supportId })) as { ok: true; matches: { user: { events: unknown[] } }[] };
    expect(after.matches.map((m) => m.user.events)).toEqual([[]]);
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

  it('a NEAR export is labelled near (D755), and staff see it so', async () => {
    const { app, aud } = await demoApp(false);
    withCombinedCall(chain({ [aud]: app.scope }));
    const res = await call('/v1/login', { headers: hanaHeaders(app, AUTH), body: { ...(await loginBody(app.scope, aud, {}, { sub: 'near-export-1' })), exportChain: 'near' } });
    expect(res.status).toBe(200);
    const [row] = (await rows(app.id)) as { chain: string; user_id: string }[];
    expect(row).toMatchObject({ kind: 'key_exported', chain: 'near', network: null, address: null });
    const got = (await new AdminRpc(createExecutionContext(), env).getUser({ ...hana(), internalId: row!.user_id })) as unknown as { ok: true; user: { events: Record<string, unknown>[] } };
    expect(got.user.events).toEqual([expect.objectContaining({ kind: 'key_exported', chain: 'near' })]);
  });

  it('the database refuses near on a mainnet demo signature (the demo is Stellar and EVM only)', async () => {
    const { app } = await demoApp(false);
    await expect(
      env.DB.prepare("INSERT INTO user_events (kind, app_id, scope_id, user_id, chain, network, address, usd_micros, request_id, at) VALUES ('mainnet_signature', ?1, ?2, ?3, 'near', 'mainnet', ?4, 1, 'r', 1)")
        .bind(app.id, app.scope, `hu_${'a'.repeat(26)}`, EVM)
        .run(),
    ).rejects.toThrow(/CHECK/u);
  });

  it('an older export window without the label still records the event, with no chain', async () => {
    const { app, aud } = await demoApp(false);
    withCombinedCall(chain({ [aud]: app.scope }));
    expect((await call('/v1/login', { headers: hanaHeaders(app, AUTH), body: await loginBody(app.scope, aud) })).status).toBe(200);
    expect(await rows(app.id)).toMatchObject([{ kind: 'key_exported', chain: null }]);
  });
});
