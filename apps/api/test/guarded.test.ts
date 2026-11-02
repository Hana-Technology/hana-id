// Batch C3 on the API (docs/batch-c-spec.md "Hot DB and gate", "Guarded changes" rows that need no RPC): the gate on
// app_keys and scopes (revoked and future-revoked keys, deleted apps, suspension bits), pending origins refused by the
// gate, the vault page and the preflight until `active_from` and allowed by predicate after it with no executor, a
// pending policy or raw-signing value not served until effective, first_session_at, the hourly guarded-change job
// (activation recorded once, promotion, the replaced policy ended, 7-day expiry) and the guarded-change config.
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAppByKey } from '../src/apps.ts';
import { ANNOUNCE_WITHIN_MS, guardedChangesMaintenance } from '../src/guarded/cron.ts';
import { MAX_APP_CHANGE_DELAY_MS, MIN_APP_CHANGE_DELAY_MS, changeConfig } from '../src/guarded/config.ts';
import worker from '../src/index.ts';
import { preflightAllows } from '../src/origins.ts';
import { ORIGIN, type SeededApp, appHeaders, call, chain, newKey, seedApp, sessionBody, uid } from './helpers.ts';
import { hanaHeaders, loginBody, withCombinedCall } from './login-helpers.ts';
import { autoApprovePolicy, vaultHeaders } from './vault-helpers.ts';

afterEach(() => vi.restoreAllMocks());

const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const newAud = (): string => `${uid()}.apps.googleusercontent.com`;
const getApp = (headers: Record<string, string>) => call('/v1/app', { method: 'GET', headers });
const at = (ms: number) => vi.spyOn(Date, 'now').mockImplementation(() => ms);

async function vaultPage(key: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${env.VAULT_ORIGIN}/vault?pk=${encodeURIComponent(key)}`) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const frameAncestors = (res: Response) => /frame-ancestors ([^;]*)/u.exec(res.headers.get('content-security-policy') ?? '')?.[1];

/** A guarded change and, for an origin, its app_origins row, as the CLI or AdminRpc write them. */
async function propose(
  app: SeededApp,
  c: { kind: 'origin_add' | 'policy_set' | 'raw_sign_on'; origin?: string; policy?: unknown; proposedAt?: number; activeFrom?: number | null },
): Promise<string> {
  const id = `gc_${uid()}`;
  const policyJson = c.policy === undefined ? null : JSON.stringify(c.policy);
  const activeFrom = c.activeFrom ?? null;
  await env.DB.prepare(
    `INSERT INTO guarded_changes (id, app_id, kind, origin, policy_json, policy_id, status, proposed_by_kind, proposed_by, proposed_at, notified_at, active_from, request_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 'hana', 'cli:test', ?7, ?8, ?9, ?10)`,
  )
    .bind(id, app.id, c.kind, c.origin ?? null, policyJson, policyJson === null ? null : 'pid', c.proposedAt ?? Date.now(), activeFrom === null ? null : activeFrom, activeFrom, `r_${id}`)
    .run();
  if (c.kind === 'origin_add') await env.DB.prepare('INSERT INTO app_origins (app_id, origin, active_from, change_id) VALUES (?1, ?2, ?3, ?4)').bind(app.id, c.origin, activeFrom, id).run();
  if (c.kind === 'policy_set' && activeFrom !== null) {
    await env.DB.prepare('UPDATE apps SET auto_approve_pending = ?2, auto_approve_effective_at = ?3 WHERE id = ?1').bind(app.id, policyJson, activeFrom).run();
  }
  if (c.kind === 'raw_sign_on' && activeFrom !== null) {
    await env.DB.prepare("UPDATE apps SET raw_sign_pending = 'approval', raw_sign_effective_at = ?2 WHERE id = ?1").bind(app.id, activeFrom).run();
  }
  return id;
}

const changeRow = (id: string) => env.DB.prepare('SELECT status, activated_recorded_at, cancelled_by, cancelled_at, ended_at FROM guarded_changes WHERE id = ?1').bind(id).first();
const ledger = async (appId: string) =>
  (await env.DB.prepare("SELECT kind, detail_json, actor_kind, actor_id FROM app_changes WHERE app_id = ?1 ORDER BY seq").bind(appId).all<{ kind: string; detail_json: string; actor_kind: string; actor_id: string }>()).results;

describe('the gate on app_keys, scopes and the suspension bits', () => {
  it('a revoked key is 401 unknown_app everywhere; a key in its rotation grace (revoked_at in the future) still works', async () => {
    const app = await seedApp();
    chain({ [newAud()]: app.scope });
    const second = { ...app, key: newKey() };
    await env.DB.prepare("INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES (?1, ?2, ?3, 't', 1)").bind(`key_${uid()}`, app.id, second.key).run();
    expect((await getApp(appHeaders(second))).status).toBe(200);
    await env.DB.prepare('UPDATE app_keys SET revoked_at = ?2 WHERE key = ?1').bind(app.key, Date.now() + 60_000).run();
    expect((await getApp(appHeaders(app))).status).toBe(200);
    await env.DB.prepare('UPDATE app_keys SET revoked_at = ?2 WHERE key = ?1').bind(app.key, Date.now() - 1).run();
    for (const res of [await getApp(appHeaders(app)), await call('/v1/login', { headers: hanaHeaders(app), body: {} }), await call('/v1/vault/unlock', { headers: vaultHeaders(app), body: {} })]) {
      expect([res.status, (await body(res)).code]).toEqual([401, 'unknown_app']);
    }
    expect((await vaultPage(app.key)).status).toBe(403);
    // The app's other key is unaffected, and its publishable_key column is never read.
    expect((await getApp(appHeaders(second))).status).toBe(200);
  });

  it('a deleted app is unknown', async () => {
    const app = await seedApp();
    await env.DB.prepare('UPDATE apps SET deleted_at = 1 WHERE id = ?1').bind(app.id).run();
    expect(await body(await getApp(appHeaders(app)))).toMatchObject({ code: 'unknown_app' });
    const own = `https://${uid()}.example.com`;
    const lone = await seedApp({ origins: [own] });
    await env.DB.prepare('UPDATE apps SET deleted_at = 1 WHERE id = ?1').bind(lone.id).run();
    expect(await preflightAllows(env.DB, env, own)).toBe(false);
  });

  it('every suspension bit is 403 app_suspended (gate, vault page, vault endpoints) and closes the preflight; status follows by trigger', async () => {
    for (const bit of [1, 2, 4, 6]) {
      const origin = `https://${uid()}.example.com`;
      const app = await seedApp({ suspendedBy: bit, origins: [origin] });
      chain({ [newAud()]: app.scope });
      expect(await env.DB.prepare('SELECT status FROM apps WHERE id = ?1').bind(app.id).first()).toEqual({ status: 'suspended' });
      expect(await body(await getApp(appHeaders(app, origin)))).toMatchObject({ code: 'app_suspended' });
      expect(await body(await call('/v1/vault/unlock', { headers: vaultHeaders(app, origin), body: {} }))).toMatchObject({ code: 'app_suspended' });
      expect((await vaultPage(app.key)).status).toBe(403);
      expect(await preflightAllows(env.DB, env, origin)).toBe(false);
      await env.DB.prepare('UPDATE apps SET suspended_by = 0 WHERE id = ?1').bind(app.id).run();
      expect((await getApp(appHeaders(app, origin))).status).toBe(200);
      expect(await preflightAllows(env.DB, env, origin)).toBe(true);
    }
  });

  it('loopback origins count only for test scopes in a dev env (scopes.environment), in the gate and the preflight', async () => {
    const test = await seedApp({ origins: ['http://localhost:*'] });
    const live = await seedApp({ key: newKey('pk_live_'), origins: ['http://localhost:*', 'http://127.0.0.1:4000'] });
    expect((await getAppByKey(env.DB, test.key))!.environment).toBe('test');
    expect((await getAppByKey(env.DB, live.key))!.environment).toBe('live');
    chain({ [newAud()]: test.scope, [newAud()]: live.scope });
    expect((await getApp(appHeaders(test, 'http://localhost:5173'))).status).toBe(200);
    expect(await body(await getApp(appHeaders(live, 'http://localhost:5173')))).toMatchObject({ code: 'origin_not_allowed' });
    expect(await preflightAllows(env.DB, env, 'http://127.0.0.1:4000')).toBe(false);
    expect(await preflightAllows(env.DB, env, 'http://localhost:5173')).toBe(true);
    expect(await preflightAllows(env.DB, { ENV_NAME: 'prod' }, 'http://localhost:5173')).toBe(false);
  });
});

describe('a pending origin is refused everywhere until active_from, then allowed by predicate', () => {
  it('not announced (NULL): never; announced: from active_from on, with no executor', async () => {
    const app = await seedApp();
    chain({ [newAud()]: app.scope });
    const pending = `https://${uid()}.example.com`;
    const changeId = await propose(app, { kind: 'origin_add', origin: pending });
    const refusedEverywhere = async () => {
      expect(await body(await getApp(appHeaders(app, pending)))).toMatchObject({ code: 'origin_not_allowed' });
      expect(await body(await call('/v1/login', { headers: hanaHeaders(app, env.VAULT_ORIGIN!, pending), body: {} }))).toMatchObject({ code: 'origin_not_allowed' });
      expect(await body(await call('/v1/vault/unlock', { headers: vaultHeaders(app, pending), body: {} }))).toMatchObject({ code: 'origin_not_allowed' });
      expect(frameAncestors(await vaultPage(app.key))).toBe(ORIGIN);
      expect(await preflightAllows(env.DB, env, pending)).toBe(false);
    };
    await refusedEverywhere();
    // Announced: the clock starts.
    const start = Date.now();
    const activeFrom = start + 60_000;
    await env.DB.prepare('UPDATE guarded_changes SET notified_at = ?2, active_from = ?3 WHERE id = ?1').bind(changeId, start, activeFrom).run();
    await env.DB.prepare('UPDATE app_origins SET active_from = ?2 WHERE change_id = ?1').bind(changeId, activeFrom).run();
    await refusedEverywhere();
    at(activeFrom - 1);
    expect(await preflightAllows(env.DB, env, pending)).toBe(false);
    at(activeFrom);
    expect((await getApp(appHeaders(app, pending))).status).toBe(200);
    expect(await body(await call('/v1/login', { headers: hanaHeaders(app, env.VAULT_ORIGIN!, pending), body: {} }))).toMatchObject({ code: 'bad_request' });
    expect(await preflightAllows(env.DB, env, pending)).toBe(true);
    expect(frameAncestors(await vaultPage(app.key))).toBe([ORIGIN, pending].sort().join(' '));
    // Nothing ran: the change is still pending until the hourly job records it.
    expect(await changeRow(changeId)).toMatchObject({ status: 'pending', activated_recorded_at: null });
  });
});

describe('a pending policy or raw-signing value is not served until effective', () => {
  it('GET /v1/app answers no policy until auto_approve_effective_at, then the new one', async () => {
    const app = await seedApp();
    chain({ [newAud()]: app.scope });
    const start = Date.now();
    await propose(app, { kind: 'policy_set', policy: autoApprovePolicy('Pending'), activeFrom: start + 60_000 });
    expect(await body(await getApp(appHeaders(app)))).toMatchObject({ autoApprovePolicy: null });
    at(start + 60_000);
    expect(await body(await getApp(appHeaders(app)))).toMatchObject({ autoApprovePolicy: { label: 'Pending' } });
  });

  it('raw signing stays off until raw_sign_effective_at', async () => {
    const app = await seedApp({ key: newKey('pk_live_') });
    chain({ [newAud()]: app.scope });
    const start = Date.now();
    await propose(app, { kind: 'raw_sign_on', activeFrom: start + 60_000 });
    expect(await body(await getApp(appHeaders(app)))).toMatchObject({ rawSign: 'off' });
    at(start + 60_000);
    expect(await body(await getApp(appHeaders(app)))).toMatchObject({ rawSign: 'approval' });
  });

  it('an unannounced proposal writes nothing the API serves', async () => {
    const app = await seedApp({ key: newKey('pk_live_') });
    chain({ [newAud()]: app.scope });
    await propose(app, { kind: 'policy_set', policy: autoApprovePolicy('Unannounced') });
    await propose(app, { kind: 'raw_sign_on' });
    at(Date.now() + 30 * 86_400_000);
    expect(await body(await getApp(appHeaders(app)))).toMatchObject({ autoApprovePolicy: null, rawSign: 'off' });
  });
});

describe('first_session_at', () => {
  const scopeRow = (scope: string) => env.DB.prepare('SELECT first_session_at FROM scopes WHERE scope_id = ?1').bind(scope).first<{ first_session_at: number | null }>();

  it('is set once by the first successful /v1/login on the scope (after the response), never by a failed one', async () => {
    const app = await seedApp({ firstSession: null });
    const aud = newAud();
    withCombinedCall(chain({ [aud]: app.scope }));
    expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud, {}, { nonce: 'wrong' }) })).status).toBe(400);
    expect(await scopeRow(app.scope)).toEqual({ first_session_at: null });
    const before = Date.now();
    expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) })).status).toBe(200);
    const first = (await scopeRow(app.scope))!.first_session_at!;
    expect(first).toBeGreaterThanOrEqual(before);
    expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) })).status).toBe(200);
    expect(await scopeRow(app.scope)).toEqual({ first_session_at: first });
  });

  it('is set by a successful /v1/sessions too', async () => {
    const app = await seedApp({ firstSession: null });
    const aud = newAud();
    chain({ [aud]: app.scope });
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) })).status).toBe(200);
    expect((await scopeRow(app.scope))!.first_session_at).not.toBeNull();
  });

  it('a failed write is logged and never fails the login', async () => {
    const app = await seedApp({ firstSession: null });
    const aud = newAud();
    withCombinedCall(chain({ [aud]: app.scope }));
    // D1 refuses the scopes UPDATE (and only it): the login still answers 200.
    const real = env.DB;
    const failing = new Proxy(real, {
      get(target, prop) {
        if (prop !== 'prepare') return Reflect.get(target, prop);
        return (q: string) => (q.startsWith('UPDATE scopes SET first_session_at') ? { bind: () => ({ run: () => Promise.reject(new Error('D1 down')) }) } : target.prepare(q));
      },
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud), env: { DB: failing } });
    expect(res.status).toBe(200);
    expect(errors.mock.calls.some(([line]) => String(line).includes('first_session_write_failed'))).toBe(true);
    expect(await scopeRow(app.scope)).toEqual({ first_session_at: null });
  });
});

describe('the hourly guarded-change job', () => {
  it('records an announced origin once its clock has passed, once (two runs, even at the same time)', async () => {
    const app = await seedApp();
    const now = Date.now();
    const id = await propose(app, { kind: 'origin_add', origin: `https://${uid()}.example.com`, activeFrom: now - 1 });
    const later = await propose(app, { kind: 'origin_add', origin: `https://${uid()}.example.com`, activeFrom: now + 60_000 });
    await guardedChangesMaintenance(env, now);
    await guardedChangesMaintenance(env, now);
    await guardedChangesMaintenance(env, now + 1);
    expect(await changeRow(id)).toMatchObject({ status: 'active', activated_recorded_at: now });
    expect(await changeRow(later)).toMatchObject({ status: 'pending', activated_recorded_at: null });
    const rows = (await ledger(app.id)).filter((r) => r.kind === 'origin.activated');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_kind: 'system', actor_id: 'cron' });
    expect(JSON.parse(rows[0]!.detail_json)).toMatchObject({ changeId: id, kind: 'origin_add', activeFrom: now - 1 });
  });

  it('promotes a matured policy, ends the policy_set it replaced, and changes no answer GET /v1/app gives', async () => {
    const app = await seedApp();
    chain({ [newAud()]: app.scope });
    const now = Date.now();
    const first = await propose(app, { kind: 'policy_set', policy: autoApprovePolicy('First'), activeFrom: now - 2 });
    await guardedChangesMaintenance(env, now);
    const second = await propose(app, { kind: 'policy_set', policy: autoApprovePolicy('Second'), activeFrom: now + 1 });
    at(now + 1);
    const served = await body(await getApp(appHeaders(app)));
    expect(served).toMatchObject({ autoApprovePolicy: { label: 'Second' } });
    await guardedChangesMaintenance(env, now + 1);
    expect(await env.DB.prepare('SELECT auto_approve_policy, auto_approve_pending, auto_approve_effective_at FROM apps WHERE id = ?1').bind(app.id).first()).toEqual({
      auto_approve_policy: JSON.stringify(autoApprovePolicy('Second')),
      auto_approve_pending: null,
      auto_approve_effective_at: null,
    });
    expect(await changeRow(first)).toMatchObject({ status: 'ended', ended_at: now + 1 });
    expect(await changeRow(second)).toMatchObject({ status: 'active', activated_recorded_at: now + 1 });
    expect((await ledger(app.id)).map((r) => r.kind)).toEqual(['policy.activated', 'policy.ended', 'policy.activated']);
    const after = await body(await getApp(appHeaders(app)));
    expect({ ...after, serverTimeMs: 0, requestId: '' }).toEqual({ ...served, serverTimeMs: 0, requestId: '' });
  });

  it('promotes matured raw signing', async () => {
    const app = await seedApp({ key: newKey('pk_live_') });
    const now = Date.now();
    const id = await propose(app, { kind: 'raw_sign_on', activeFrom: now - 1 });
    await guardedChangesMaintenance(env, now);
    expect(await env.DB.prepare('SELECT raw_sign, raw_sign_pending, raw_sign_effective_at FROM apps WHERE id = ?1').bind(app.id).first()).toEqual({ raw_sign: 'approval', raw_sign_pending: null, raw_sign_effective_at: null });
    expect(await changeRow(id)).toMatchObject({ status: 'active' });
    expect((await ledger(app.id)).map((r) => r.kind)).toEqual(['raw_sign.activated']);
  });

  it('cancels a due change whose value is no longer pending in apps (cleared by a direct write): it never took effect', async () => {
    const app = await seedApp({ key: newKey('pk_live_') });
    const now = Date.now();
    const id = await propose(app, { kind: 'raw_sign_on', activeFrom: now - 1 });
    await env.DB.prepare('UPDATE apps SET raw_sign_pending = NULL, raw_sign_effective_at = NULL WHERE id = ?1').bind(app.id).run();
    expect(await guardedChangesMaintenance(env, now)).toMatchObject({ superseded: 1 });
    expect(await changeRow(id)).toMatchObject({ status: 'cancelled', cancelled_by: 'system' });
    expect(await env.DB.prepare('SELECT raw_sign FROM apps WHERE id = ?1').bind(app.id).first()).toEqual({ raw_sign: 'off' });
  });

  it('cancels a change not announced within 7 days: its origin row goes, the version bumps', async () => {
    const app = await seedApp();
    const now = Date.now();
    const stale = await propose(app, { kind: 'origin_add', origin: `https://${uid()}.example.com`, proposedAt: now - ANNOUNCE_WITHIN_MS });
    const young = await propose(app, { kind: 'origin_add', origin: `https://${uid()}.example.com`, proposedAt: now - ANNOUNCE_WITHIN_MS + 1 });
    const stalePolicy = await propose(app, { kind: 'policy_set', policy: autoApprovePolicy('Stale'), proposedAt: now - ANNOUNCE_WITHIN_MS - 5 });
    const announced = await propose(app, { kind: 'origin_add', origin: `https://${uid()}.example.com`, proposedAt: now - 2 * ANNOUNCE_WITHIN_MS, activeFrom: now + 60_000 });
    expect(await guardedChangesMaintenance(env, now)).toMatchObject({ expired: 2 });
    expect(await changeRow(stale)).toMatchObject({ status: 'cancelled', cancelled_by: 'system', cancelled_at: now });
    expect(await changeRow(stalePolicy)).toMatchObject({ status: 'cancelled', cancelled_by: 'system' });
    expect(await changeRow(young)).toMatchObject({ status: 'pending' });
    expect(await changeRow(announced)).toMatchObject({ status: 'pending' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM app_origins WHERE change_id = ?1').bind(stale).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT origins_version, settings_version FROM apps WHERE id = ?1').bind(app.id).first()).toEqual({ origins_version: 1, settings_version: 1 });
    const cancelled = (await ledger(app.id)).filter((r) => r.kind === 'change.cancelled').map((r) => JSON.parse(r.detail_json) as Record<string, unknown>);
    expect(cancelled.map((d) => [d.changeId, d.reason])).toEqual(expect.arrayContaining([[stale, 'not_announced'], [stalePolicy, 'not_announced']]));
    // Once: a second run finds nothing.
    expect(await guardedChangesMaintenance(env, now)).toMatchObject({ expired: 0 });
  });

  it('runs on the hourly cron run, beside the other jobs', async () => {
    chain({});
    const app = await seedApp();
    const T0 = Date.UTC(2026, 10, 2, 10, 0, 30);
    const id = await propose(app, { kind: 'origin_add', origin: `https://${uid()}.example.com`, activeFrom: T0 - 1 });
    at(T0);
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '*/15 * * * *', scheduledTime: T0 }), env, ctx).catch(() => undefined);
    await waitOnExecutionContext(ctx);
    expect(await changeRow(id)).toMatchObject({ status: 'active' });
  });
});

describe('the guarded-change configuration (APP_CHANGE_DELAY_MS, NETWORK, REFUSED_ORIGINS)', () => {
  const good = { APP_CHANGE_DELAY_MS: '60000', NETWORK: 'testnet', REFUSED_ORIGINS: '["https://api.test"]' };

  it('reads the test bindings gen-wrangler emits', () => {
    expect(changeConfig(env)).toMatchObject({ ok: true, config: { delayMs: 60_000, network: 'testnet' } });
    expect(changeConfig(good)).toEqual({ ok: true, config: { delayMs: 60_000, network: 'testnet', refusedOrigins: ['https://api.test'] } });
  });

  it('refuses with internal when the delay is missing or out of range, or the other vars are missing or malformed', () => {
    for (const bad of [
      { ...good, APP_CHANGE_DELAY_MS: undefined },
      { ...good, APP_CHANGE_DELAY_MS: '' },
      { ...good, APP_CHANGE_DELAY_MS: '1.5e5' },
      { ...good, APP_CHANGE_DELAY_MS: String(MIN_APP_CHANGE_DELAY_MS - 1) },
      { ...good, APP_CHANGE_DELAY_MS: String(MAX_APP_CHANGE_DELAY_MS + 1) },
      { ...good, NETWORK: 'mainnet', APP_CHANGE_DELAY_MS: String(86_400_000 - 1) },
      { ...good, NETWORK: undefined },
      { ...good, REFUSED_ORIGINS: undefined },
      { ...good, REFUSED_ORIGINS: '{"a":1}' },
      { ...good, REFUSED_ORIGINS: '[1]' },
    ]) {
      expect(changeConfig(bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: 'internal' });
    }
    expect(changeConfig({ ...good, APP_CHANGE_DELAY_MS: String(MAX_APP_CHANGE_DELAY_MS) })).toMatchObject({ ok: true });
    expect(changeConfig({ ...good, NETWORK: 'mainnet', APP_CHANGE_DELAY_MS: '86400000' })).toMatchObject({ ok: true });
  });
});
