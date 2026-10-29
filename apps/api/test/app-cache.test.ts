// The vault endpoints' in-isolate app cache (src/app-cache.ts, docs/decisions.md D78): one D1 read serves the
// vault gate for APP_CACHE_TTL_MS, so a suspension, a removed origin or a removed key reaches those endpoints within
// that bound; unknown keys and failed reads are never cached; the relay endpoints still read D1 every time.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_CACHE_MAX, APP_CACHE_TTL_MS, cachedAppCount, forgetCachedApps, getAppByKeyCached } from '../src/app-cache.ts';
import { ORIGIN, appHeaders, call, newKey, seedApp } from './helpers.ts';
import { act, createShare, vaultHeaders, vaultSetup } from './vault-helpers.ts';

beforeEach(() => forgetCachedApps());
afterEach(() => {
  vi.restoreAllMocks();
  forgetCachedApps();
});

/** env.DB, counting the statements prepared on it. */
function countingDb(): { db: D1Database; reads: () => number } {
  let n = 0;
  const db = { prepare: (sql: string) => (n++, env.DB.prepare(sql)) } as unknown as D1Database;
  return { db, reads: () => n };
}

const setStatus = (appId: string, status: string) => env.DB.prepare('UPDATE apps SET status = ?2 WHERE id = ?1').bind(appId, status).run();

describe('getAppByKeyCached', () => {
  it('serves one D1 read for APP_CACHE_TTL_MS, then reads again', async () => {
    const app = await seedApp();
    const { db, reads } = countingDb();
    let t = 1_000_000;
    const now = () => t;
    expect((await getAppByKeyCached(db, app.key, now))?.id).toBe(app.id);
    const first = reads();
    expect(first).toBe(2);
    t += APP_CACHE_TTL_MS - 1;
    expect((await getAppByKeyCached(db, app.key, now))?.id).toBe(app.id);
    expect(reads()).toBe(first);
    t += 1;
    await getAppByKeyCached(db, app.key, now);
    expect(reads()).toBe(2 * first);
  });

  it('a clock that went back reads again (an entry is never trusted from the future)', async () => {
    const app = await seedApp();
    const { db, reads } = countingDb();
    await getAppByKeyCached(db, app.key, () => 2_000_000);
    await getAppByKeyCached(db, app.key, () => 1_999_999);
    expect(reads()).toBe(4);
  });

  it('never caches an unknown key or a failed read', async () => {
    const key = newKey();
    const { db, reads } = countingDb();
    expect(await getAppByKeyCached(db, key)).toBeNull();
    expect(await getAppByKeyCached(db, key)).toBeNull();
    expect(reads()).toBe(2);
    expect(cachedAppCount()).toBe(0);
    const broken = { prepare: () => ({ bind: () => ({ first: async () => Promise.reject(new Error('D1 down')) }) }) } as unknown as D1Database;
    await expect(getAppByKeyCached(broken, key)).rejects.toThrow('D1 down');
    expect(cachedAppCount()).toBe(0);
  });

  it(`holds at most ${APP_CACHE_MAX} apps, dropping the oldest`, async () => {
    const apps = await Promise.all(Array.from({ length: APP_CACHE_MAX + 1 }, () => seedApp()));
    for (const a of apps) await getAppByKeyCached(env.DB, a.key);
    expect(cachedAppCount()).toBe(APP_CACHE_MAX);
    const { db, reads } = countingDb();
    await getAppByKeyCached(db, apps.at(-1)!.key);
    expect(reads()).toBe(0);
    await getAppByKeyCached(db, apps[0]!.key);
    expect(reads()).toBe(2);
  });

  it('hands out a frozen copy (no caller can change what the next request sees)', async () => {
    const app = await seedApp();
    const cached = (await getAppByKeyCached(env.DB, app.key))!;
    expect(Object.isFrozen(cached)).toBe(true);
    expect(Object.isFrozen(cached.origins)).toBe(true);
  });
});

describe('the vault gate', () => {
  it('a suspension reaches unlock within APP_CACHE_TTL_MS', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    const realNow = Date.now.bind(Date);
    const start = realNow();
    expect((await act(app, share, 'unlock', 1)).status).toBe(200);
    await setStatus(app.id, 'suspended');
    // Within the bound this isolate may still answer from the read before the suspension.
    vi.spyOn(Date, 'now').mockImplementation(() => start + APP_CACHE_TTL_MS - 1_000 + (realNow() - start) / 1000);
    expect((await act(app, share, 'unlock', 2)).status).toBe(200);
    // Past it, never.
    vi.spyOn(Date, 'now').mockImplementation(() => start + APP_CACHE_TTL_MS + 1 + (realNow() - start));
    const res = await act(app, share, 'unlock', 3);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'app_suspended' });
  });

  it('a removed origin and a removed key reach the vault endpoints within APP_CACHE_TTL_MS', async () => {
    const extra = `https://${crypto.randomUUID()}.example.com`;
    const { app, near } = await vaultSetup({ origins: [ORIGIN, extra] });
    const share = await createShare(app, near, { parent: extra });
    await env.DB.prepare('DELETE FROM app_origins WHERE app_id = ?1 AND origin = ?2').bind(app.id, extra).run();
    const start = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => start + APP_CACHE_TTL_MS + 1);
    expect(await (await act(app, share, 'unlock', 1)).json()).toMatchObject({ code: 'share_revoked' });

    const other = await vaultSetup();
    const kept = await createShare(other.app, other.near);
    await env.DB.prepare('UPDATE apps SET publishable_key = ?2 WHERE id = ?1').bind(other.app.id, newKey()).run();
    vi.spyOn(Date, 'now').mockImplementation(() => start + 2 * APP_CACHE_TTL_MS + 2);
    expect(await (await act(other.app, kept, 'unlock', 1)).json()).toMatchObject({ code: 'unknown_app' });
  });

  it('a new app works at once (unknown keys are not cached)', async () => {
    const key = newKey();
    expect(await (await call('/v1/vault/unlock', { headers: vaultHeaders({ key }), body: {} })).json()).toMatchObject({ code: 'unknown_app' });
    await seedApp({ key });
    expect((await call('/v1/vault/unlock', { headers: vaultHeaders({ key }), body: {} })).status).toBe(400);
  });

  it('the relay endpoints and GET /v1/app read D1 every time: a suspension stops them at once', async () => {
    const app = await seedApp();
    expect((await call('/v1/vault/unlock', { headers: vaultHeaders(app), body: {} })).status).toBe(400);
    expect(cachedAppCount()).toBe(1);
    await setStatus(app.id, 'suspended');
    for (const path of ['/v1/app', '/v1/derive']) {
      const res = await call(path, { headers: appHeaders(app), ...(path === '/v1/derive' ? { body: {} } : {}) });
      expect(res.status, path).toBe(403);
      expect(await res.json(), path).toMatchObject({ code: 'app_suspended' });
    }
  });
});
