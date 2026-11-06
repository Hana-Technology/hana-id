// IssuerRpc (src/rpc/issuer.ts, D432): the email issuer's three read-only app lookups, by the gate's model, with strict
// inputs and no caller clock; before migration 0010 no app has email on. Moved from the issuer's own tests of its
// APP_DB readers (apps/email-issuer/test/codes.test.ts), which the issuer's suite now covers end to end over the real
// service binding (apps/email-issuer/vitest.config.ts). That it only reads is a source check
// (scripts/test/issuer-rpc-source.test.ts).
import { ISSUER_RPC_METHODS } from '@hana-id/console-core';
import { applyD1Migrations, createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { issuerAppByKey } from '../src/issuer-apps.ts';
import { IssuerRpc } from '../src/rpc/issuer.ts';
import { forgeKeyEnvironment, newKey, seedApp, uid } from './helpers.ts';

const rpc = (e: typeof env = env): IssuerRpc => new IssuerRpc(createExecutionContext(), e);
const emailOn = (id: string) => env.DB.prepare("UPDATE apps SET login_methods = 'google,email' WHERE id = ?1").bind(id).run();

describe('IssuerRpc', () => {
  it('has exactly the three reads (no other public method a compromised issuer could call)', () => {
    const own = Object.getOwnPropertyNames(IssuerRpc.prototype).filter((n) => n !== 'constructor');
    expect(own.sort()).toEqual([...ISSUER_RPC_METHODS].sort());
  });

  it('appByKey answers the app’s issuer view only, active and with email on', async () => {
    const app = await seedApp({ plan: 'free' });
    await emailOn(app.id);
    const r = await rpc().appByKey({ pk: app.key });
    expect(r).toEqual({
      ok: true,
      app: { id: app.id, name: `Test ${app.id}`, scopeId: app.scope, active: true, emailOn: true, perMinute: expect.any(Number), perDay: expect.any(Number), googleWebClientId: null },
    });
    // Nothing else of the app crosses: no key, origin, setting or version.
    expect(Object.keys((r as { app: object }).app).sort()).toEqual(['active', 'emailOn', 'googleWebClientId', 'id', 'name', 'perDay', 'perMinute', 'scopeId']);
    const plan = await env.DB.prepare('SELECT per_minute, per_day FROM plans WHERE id = ?1').bind('free').first<{ per_minute: number; per_day: number }>();
    expect(r).toMatchObject({ app: { perMinute: plan!.per_minute, perDay: plan!.per_day } });
    // Google-only by default.
    const google = await seedApp();
    expect(await rpc().appByKey({ pk: google.key })).toMatchObject({ ok: true, app: { emailOn: false } });
    expect(await rpc().appByKey({ pk: newKey() })).toEqual({ ok: true, app: null });
  });

  it('finds apps by the gate’s model: app_keys (revoked, or in its grace), deleted_at, suspended_by; never the legacy column', async () => {
    const app = await seedApp();
    await emailOn(app.id);
    const now = Date.now();
    // A rotated key: the new one works, the old one through its grace only (judged on the API's clock).
    const next = newKey();
    await env.DB.prepare("INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES (?1, ?2, ?3, 'test', 0)").bind(`key_${uid()}`, app.id, next).run();
    await env.DB.prepare('UPDATE app_keys SET revoked_at = ?2 WHERE key = ?1').bind(app.key, now + 60_000).run();
    expect(await rpc().appByKey({ pk: next })).toMatchObject({ app: { id: app.id } });
    expect(await rpc().appByKey({ pk: app.key })).toMatchObject({ app: { id: app.id } });
    expect(await issuerAppByKey(env.DB, app.key, now + 60_000)).toBeNull();
    await env.DB.prepare('UPDATE app_keys SET revoked_at = ?2 WHERE key = ?1').bind(app.key, now - 1).run();
    expect(await rpc().appByKey({ pk: app.key })).toEqual({ ok: true, app: null });
    // The legacy column is never read: a key only it holds finds nothing.
    const legacyOnly = newKey();
    await env.DB.prepare('UPDATE apps SET publishable_key = ?2 WHERE id = ?1').bind(app.id, legacyOnly).run();
    expect(await rpc().appByKey({ pk: legacyOnly })).toEqual({ ok: true, app: null });
    // Any suspension bit, or the legacy status, makes it inactive (start then answers app_suspended).
    await env.DB.prepare('UPDATE apps SET suspended_by = 4 WHERE id = ?1').bind(app.id).run();
    expect(await rpc().appByKey({ pk: next })).toMatchObject({ app: { active: false } });
    expect(await rpc().appById({ appId: app.id })).toMatchObject({ app: { active: false } });
    expect(await rpc().scopeHasEmailApp({ scopeId: app.scope })).toEqual({ ok: true, hasEmailApp: false });
    await env.DB.prepare('UPDATE apps SET suspended_by = 0 WHERE id = ?1').bind(app.id).run();
    expect(await rpc().scopeHasEmailApp({ scopeId: app.scope })).toEqual({ ok: true, hasEmailApp: true });
    await env.DB.prepare("UPDATE apps SET status = 'suspended' WHERE id = ?1").bind(app.id).run();
    expect(await rpc().appById({ appId: app.id })).toMatchObject({ app: { active: false } });
    expect(await rpc().scopeHasEmailApp({ scopeId: app.scope })).toEqual({ ok: true, hasEmailApp: false });
    await env.DB.prepare("UPDATE apps SET status = 'active' WHERE id = ?1").bind(app.id).run();
    // A deleted app is unknown everywhere.
    await env.DB.prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind(app.id, now).run();
    expect(await rpc().appByKey({ pk: next })).toEqual({ ok: true, app: null });
    expect(await rpc().appById({ appId: app.id })).toEqual({ ok: true, app: null });
    expect(await rpc().scopeHasEmailApp({ scopeId: app.scope })).toEqual({ ok: true, hasEmailApp: false });
  });

  it('a key whose prefix names the other environment than its scope is inactive (the gate’s scope_conflict)', async () => {
    const forged = await forgeKeyEnvironment(await seedApp());
    const r = await rpc().appByKey({ pk: forged.key });
    expect(r.ok && r.app).toMatchObject({ id: forged.id, active: false });
  });

  it('scopeHasEmailApp: only an app with email on counts; an unknown scope has none', async () => {
    const app = await seedApp();
    expect(await rpc().scopeHasEmailApp({ scopeId: app.scope })).toEqual({ ok: true, hasEmailApp: false });
    await emailOn(app.id);
    expect(await rpc().scopeHasEmailApp({ scopeId: app.scope })).toEqual({ ok: true, hasEmailApp: true });
    expect(await rpc().scopeHasEmailApp({ scopeId: 'snone' })).toEqual({ ok: true, hasEmailApp: false });
  });

  it('refuses malformed or extra input (bad_request) and never reads with it', async () => {
    const app = await seedApp();
    for (const bad of [undefined, null, 'pk', {}, { pk: 'x' }, { pk: app.key, now: 0 }, { pk: app.key, appId: app.id }]) {
      expect(await rpc().appByKey(bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: 'bad_request' });
    }
    for (const bad of [{}, { appId: "app_x' OR 1=1" }, { appId: 'a'.repeat(97) }, { appId: app.id, extra: 1 }]) expect(await rpc().appById(bad)).toMatchObject({ ok: false, code: 'bad_request' });
    for (const bad of [{}, { scopeId: 'S-1' }, { scopeId: app.scope, limit: 100 }]) expect(await rpc().scopeHasEmailApp(bad)).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('a D1 failure is `internal`, and nothing it throws escapes', async () => {
    const down = { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error('D1_ERROR: network')), all: () => Promise.reject(new Error('D1_ERROR: network')) }) }) } as unknown as D1Database;
    const broken = rpc({ ...env, DB: down });
    expect(await broken.appByKey({ pk: newKey() })).toEqual({ ok: false, code: 'internal' });
    expect(await broken.appById({ appId: 'app_x' })).toEqual({ ok: false, code: 'internal' });
    expect(await broken.scopeHasEmailApp({ scopeId: 's1' })).toEqual({ ok: false, code: 'internal' });
  });
});

describe('IssuerRpc before migration 0010 (no login_methods column)', () => {
  it('finds the app with email off, and the scope has no email app; 0010 then turns it on', async () => {
    const db = env.PRE_0010_ISSUER_DB;
    await applyD1Migrations(db, env.TEST_MIGRATIONS.filter((m) => m.name < '0010'));
    const app = await seedApp({ db });
    const old = rpc({ ...env, DB: db });
    expect(await old.appByKey({ pk: app.key })).toMatchObject({ ok: true, app: { id: app.id, emailOn: false, active: true } });
    expect(await old.appById({ appId: app.id })).toMatchObject({ ok: true, app: { id: app.id, emailOn: false } });
    expect(await old.scopeHasEmailApp({ scopeId: app.scope })).toEqual({ ok: true, hasEmailApp: false });
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    await db.prepare("UPDATE apps SET login_methods = 'google,email' WHERE id = ?1").bind(app.id).run();
    expect(await old.appByKey({ pk: app.key })).toMatchObject({ ok: true, app: { emailOn: true } });
    expect(await old.scopeHasEmailApp({ scopeId: app.scope })).toEqual({ ok: true, hasEmailApp: true });
  });
});
