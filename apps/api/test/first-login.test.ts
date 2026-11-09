// The per-app first-login marker (`apps.first_login_at`, D462): set once by the first successful login, never slowing or
// failing one, and backfilled by migration 0016 only from what existing rows prove.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { panic } from './near-mock.ts';
import { appHeaders, call, chain, seedApp, sessionBody, uid } from './helpers.ts';
import { hanaHeaders, loginBody, withCombinedCall } from './login-helpers.ts';

afterEach(() => vi.restoreAllMocks());

const newAud = (): string => `${uid()}.apps.googleusercontent.com`;
const marker = async (id: string): Promise<number | null> => (await env.DB.prepare('SELECT first_login_at FROM apps WHERE id = ?1').bind(id).first<{ first_login_at: number | null }>())!.first_login_at;
const MARK_SQL = 'UPDATE apps SET first_login_at';

/** The DB binding with a count of marker writes; `fail` makes them refuse. */
function watchedDb(fail = false): { db: D1Database; writes: () => number } {
  let writes = 0;
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop !== 'prepare') return Reflect.get(target, prop);
      return (q: string) => {
        if (!q.startsWith(MARK_SQL)) return target.prepare(q);
        writes += 1;
        return fail ? { bind: () => ({ run: () => Promise.reject(new Error('D1 down')) }) } : target.prepare(q);
      };
    },
  });
  return { db, writes: () => writes };
}

describe('apps.first_login_at', () => {
  it('is set by the first successful /v1/login and not touched by a second, which sends no write at all', async () => {
    const app = await seedApp({ firstLogin: null });
    const aud = newAud();
    withCombinedCall(chain({ [aud]: app.scope }));
    const { db, writes } = watchedDb();
    const before = Date.now();
    expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud), env: { DB: db } })).status).toBe(200);
    const first = (await marker(app.id))!;
    expect(first).toBeGreaterThanOrEqual(before);
    expect(writes()).toBe(1);
    expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud), env: { DB: db } })).status).toBe(200);
    expect(await marker(app.id)).toBe(first);
    expect(writes()).toBe(1);
  });

  it('is set by a successful /v1/sessions, per app: a sibling in the scope stays unmarked', async () => {
    const app = await seedApp({ firstLogin: null });
    const sibling = await seedApp({ scope: app.scope, firstLogin: null });
    const aud = newAud();
    chain({ [aud]: app.scope });
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) })).status).toBe(200);
    expect(await marker(app.id)).not.toBeNull();
    expect(await marker(sibling.id)).toBeNull();
  });

  it('a login that fails sets nothing, unlike the scope’s first_session_at (written at the attempt)', async () => {
    const app = await seedApp({ firstLogin: null });
    const aud = newAud();
    const near = chain({ [aud]: app.scope });
    near.contract.create_session = () => panic('Nonce mismatch');
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) })).status).not.toBe(200);
    expect(await marker(app.id)).toBeNull();
  });

  it('a failed write is logged, never fails the login, and the next login writes it', async () => {
    const app = await seedApp({ firstLogin: null });
    const aud = newAud();
    withCombinedCall(chain({ [aud]: app.scope }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud), env: { DB: watchedDb(true).db } });
    expect(res.status).toBe(200);
    expect(errors.mock.calls.some(([line]) => String(line).includes('first_login_write_failed'))).toBe(true);
    expect(await marker(app.id)).toBeNull();
    expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) })).status).toBe(200);
    expect(await marker(app.id)).not.toBeNull();
  });
});

describe('migration 0016’s backfill', () => {
  it('sets the earliest time existing rows prove for that app, and leaves an app with no evidence null', async () => {
    const db = env.BACKFILL_DB;
    await applyD1Migrations(db, env.TEST_MIGRATIONS.filter((m) => m.name < '0016'));
    const seed = async (id: string): Promise<void> => {
      await db.prepare("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES (?1, 'org_legacy', 'test', 1, 1, 1)").bind(`s${id}`).run();
      await db.prepare('INSERT INTO apps (id, name, scope_id, publishable_key) VALUES (?1, ?1, ?2, ?3)').bind(id, `s${id}`, `pk_test_${id}abcdefghijkmnopqrs`).run();
    };
    for (const id of ['mark', 'share', 'event', 'token', 'email', 'both', 'nothing', 'zero']) await seed(id);
    const share = (app: string, at: number) =>
      db.prepare("INSERT INTO vault_shares (share_id, app_id, session_pk, path_hash, partner_origin, share_enc, kek_id, created_at, idle_until, abs_expires_at) VALUES (?1, ?2, ?3, x'00', 'https://a.test', x'00', 1, ?4, 1, 1)").bind(crypto.getRandomValues(new Uint8Array(16)), app, crypto.getRandomValues(new Uint8Array(32)), at).run();
    const day = '2026-01-02';
    const dayMs = Date.UTC(2026, 0, 2);
    await db.prepare('INSERT INTO session_markers (app_id, first_at) VALUES (?1, 11)').bind('mark').run();
    await share('share', 22);
    await db.prepare("INSERT INTO user_events (kind, app_id, scope_id, user_id, request_id, at) VALUES ('key_exported', ?1, ?2, ?3, 'r', 33)").bind('event', 'sevent', `hu_${'a'.repeat(26)}`).run();
    await db.prepare('INSERT INTO identity_usage (app_id, day, tokens) VALUES (?1, ?2, 3)').bind('token', day).run();
    await db.prepare('INSERT INTO email_usage (app_id, day, email_sessions) VALUES (?1, ?2, 1)').bind('email', day).run();
    await db.prepare('INSERT INTO identity_usage (app_id, day, tokens) VALUES (?1, ?2, 1)').bind('both', day).run();
    await share('both', 44);
    // Counted links and no email sessions prove nothing here.
    await db.prepare('INSERT INTO email_usage (app_id, day, email_sessions, links) VALUES (?1, ?2, 0, 1)').bind('zero', day).run();

    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    const { results } = await db.prepare('SELECT id, first_login_at FROM apps ORDER BY id').all<{ id: string; first_login_at: number | null }>();
    expect(Object.fromEntries(results.map((r) => [r.id, r.first_login_at]))).toEqual({ both: 44, email: dayMs, event: 33, mark: 11, nothing: null, share: 22, token: dayMs, zero: null });
  });
});
