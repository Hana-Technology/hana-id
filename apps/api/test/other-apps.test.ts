// GET /v1/app's `otherApps` (D912): on the vault's own read only, the other apps that use the app's wallet (its scope),
// counted by the rule in other-apps.ts (not deleted, not suspended, a web address in force), with the first
// OTHER_APPS_NAMES_MAX names, oldest first; `count` 0 for an app alone. A partner page's read, the export window's
// (the auth origin) and a failed read never carry it.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OTHER_APPS_NAMES_MAX, readOtherApps } from '../src/other-apps.ts';
import { ORIGIN, appHeaders, call, chain, seedApp, uid } from './helpers.ts';
import { AUTH, VAULT, hanaHeaders } from './login-helpers.ts';

afterEach(() => vi.restoreAllMocks());

type Seeded = Awaited<ReturnType<typeof seedApp>>;
const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const read = async (app: Seeded, origin: string | null = VAULT): Promise<Record<string, unknown>> => {
  chain({ [`${uid()}.apps.googleusercontent.com`]: app.scope });
  const res = await call('/v1/app', { method: 'GET', headers: origin === null ? appHeaders(app) : hanaHeaders(app, origin) });
  expect(res.status).toBe(200);
  return body(res);
};
const nameOf = (app: Seeded) => `Test ${app.id}`;
/** Apps on one scope, created in order (created_at a millisecond apart, so the order is the creation order). */
async function onScope(scope: string, n: number, opts: Parameters<typeof seedApp>[0] = {}): Promise<Seeded[]> {
  const out: Seeded[] = [];
  for (let i = 0; i < n; i++) {
    const a = await seedApp({ scope, ...opts });
    await env.DB.prepare('UPDATE apps SET created_at = ?1 WHERE id = ?2').bind(1_700_000_000_000 + out.length + i, a.id).run();
    out.push(a);
  }
  return out;
}

describe('GET /v1/app otherApps (D912)', () => {
  it('an app alone on its scope: count 0, no names, on the vault’s read', async () => {
    const app = await seedApp();
    expect((await read(app)).otherApps).toEqual({ count: 0, names: [] });
  });

  it('two apps on one scope: each names the other', async () => {
    const scope = `s${uid()}`;
    const [a, b] = await onScope(scope, 2);
    expect((await read(a!)).otherApps).toEqual({ count: 1, names: [nameOf(b!)] });
    expect((await read(b!)).otherApps).toEqual({ count: 1, names: [nameOf(a!)] });
  });

  it('counts every other app but names only the first OTHER_APPS_NAMES_MAX, oldest first', async () => {
    const scope = `s${uid()}`;
    const apps = await onScope(scope, 8);
    const me = apps[3]!;
    const others = apps.filter((x) => x !== me);
    expect((await read(me)).otherApps).toEqual({ count: 7, names: others.slice(0, OTHER_APPS_NAMES_MAX).map(nameOf) });
  });

  it('who counts: not a deleted app, not a suspended one (any bit, or the legacy status), not one with no web address in force', async () => {
    const scope = `s${uid()}`;
    const [me, counted] = await onScope(scope, 2);
    const [deleted] = await onScope(scope, 1);
    await env.DB.prepare('UPDATE apps SET deleted_at = ?1 WHERE id = ?2').bind(Date.now(), deleted!.id).run();
    await onScope(scope, 1, { suspendedBy: 1 });
    await onScope(scope, 1, { suspendedBy: 4 });
    await onScope(scope, 1, { status: 'suspended' });
    // No web address at all, and one whose only address is still in its waiting period (or not announced yet).
    await onScope(scope, 1, { origins: [] });
    const [waiting] = await onScope(scope, 1, { origins: [] });
    await env.DB.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, ?2, ?3)').bind(waiting!.id, 'https://soon.example', Date.now() + 86_400_000).run();
    const [unannounced] = await onScope(scope, 1, { origins: [] });
    await env.DB.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, ?2, NULL)').bind(unannounced!.id, 'https://later.example').run();
    // An app of another scope never counts.
    await seedApp();
    expect((await read(me!)).otherApps).toEqual({ count: 1, names: [nameOf(counted!)] });
    // The waiting address takes effect: that app counts from the next read.
    await env.DB.prepare('UPDATE app_origins SET active_from = ?1 WHERE app_id = ?2').bind(Date.now() - 1, waiting!.id).run();
    expect(((await read(me!)).otherApps as { count: number }).count).toBe(2);
    // A suspension or a deletion is in the next read too.
    await env.DB.prepare('UPDATE apps SET suspended_by = 2 WHERE id = ?1').bind(counted!.id).run();
    expect((await read(me!)).otherApps).toEqual({ count: 1, names: [nameOf(waiting!)] });
  });

  it('a suspended app still sees no answer at all (the gate refuses it), and the others no longer count it', async () => {
    const scope = `s${uid()}`;
    const [a, b] = await onScope(scope, 2);
    await env.DB.prepare('UPDATE apps SET suspended_by = 1 WHERE id = ?1').bind(b!.id).run();
    expect((await read(a!)).otherApps).toEqual({ count: 0, names: [] });
  });

  it('the names go out as stored (JSON data): the vault and the windows hold them to the display rule', async () => {
    const scope = `s${uid()}`;
    const [me, other] = await onScope(scope, 2);
    const odd = 'Pay‮gnp <b>exe</b>';
    await env.DB.prepare('UPDATE apps SET name = ?1 WHERE id = ?2').bind(odd, other!.id).run();
    expect((await read(me!)).otherApps).toEqual({ count: 1, names: [odd] });
  });

  it('never on a partner page’s read, nor on the export window’s (the auth origin): the partner page must not learn them', async () => {
    const scope = `s${uid()}`;
    const [me, other] = await onScope(scope, 2);
    for (const origin of [null, AUTH]) {
      const b = await read(me!, origin);
      expect(b).not.toHaveProperty('otherApps');
      expect(JSON.stringify(b)).not.toContain(nameOf(other!));
    }
    // A partner page's own Origin, with the vault's headers otherwise: still none.
    const res = await call('/v1/app', { method: 'GET', headers: { ...hanaHeaders(me!, ORIGIN) } });
    expect(JSON.stringify(await body(res))).not.toContain(nameOf(other!));
  });

  it('a failed read leaves the field out (no answer, never “alone”), and the rest of the answer stands', async () => {
    const scope = `s${uid()}`;
    const [me] = await onScope(scope, 2);
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('COUNT(*) OVER ()')) throw new Error('D1 down');
      return prepare(sql);
    });
    const b = await read(me!);
    expect(b).not.toHaveProperty('otherApps');
    expect(b.name).toBe(nameOf(me!));
  });

  it('readOtherApps: one statement, from D1 only', async () => {
    const scope = `s${uid()}`;
    const [me, other] = await onScope(scope, 2);
    const spy = vi.spyOn(env.DB, 'prepare');
    expect(await readOtherApps(env.DB, { id: me!.id, scope_id: scope }, Date.now())).toEqual({ count: 1, names: [nameOf(other!)] });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
