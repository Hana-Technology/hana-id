// The partner console's linking view (D925; docs/partner-platform-spec.md piece P7, B6): `POST /api/orgs/:org/users/
// link`, through the console Worker's real fetch (CSRF, the session, the membership, the route matrix) with the Users
// screen on, over the real API's ConsoleRpc (the API half is apps/api test/user-linking.test.ts). Owners only; every
// lookup audited before it answers (`users.link_view`, the owner rule read again in the insert); an audit row that
// can't be written means no answer; the answer rebuilt field by field.
import { newId } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.ts';
import { type UserLinkOut, userLinkView } from '../src/users.ts';
import { type Member, cookieOf, member } from './c10.ts';
import { CSRF, ORIGIN, auditRows, db, uid } from './helpers.ts';

const hot = env.HOT_DB;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const code = () => Array.from({ length: 8 }, () => CROCKFORD[Math.floor(Math.random() * 32)]).join('');
const sub = () => `u1_${(uid() + 'a'.repeat(21)).slice(0, 21)}A`;
const fmt = (c: string) => `HANA-${c.slice(0, 4)}-${c.slice(4)}`;

interface Seeded {
  scope: string;
  before: string;
  own: string;
  person: { userId: string; code: string; ownSub: string; ownCode: string };
}

/** A marked scope of `org` with an app of before and one made after the mark, and one person signed in on both. */
async function seedNetwork(org: string): Promise<Seeded> {
  const scope = `s${uid().toLowerCase()}`;
  const now = Date.now();
  await hot.prepare("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES (?1, ?2, 'test', ?3, ?3, ?3)").bind(scope, org, now).run();
  const before = `app_${uid()}`;
  const own = `app_${uid()}`;
  await hot.prepare("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, status, plan, user_ids) VALUES (?1, 'Coffee Club', ?2, ?3, ?4, 'active', 'free', 'scope')").bind(before, scope, org, `pk_test_${uid()}`).run();
  await hot.prepare('UPDATE scopes SET app_user_ids = 1 WHERE scope_id = ?1').bind(scope).run();
  await hot.prepare("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, status, plan, user_ids) VALUES (?1, 'Stamp Rally', ?2, ?3, ?4, 'active', 'free', 'app')").bind(own, scope, org, `pk_test_${uid()}`).run();
  const internal = `hu_${(uid() + 'b'.repeat(26)).slice(0, 26)}`;
  const person = { userId: sub(), code: code(), ownSub: sub(), ownCode: code() };
  await hot.prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)').bind(internal, person.userId, person.code, scope, now).run();
  const row = hot.prepare('INSERT INTO end_user_apps (user_id, app_id, app_sub, support_code, first_seen_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)');
  await row.bind(internal, before, person.userId, person.code, now - 1000).run();
  await row.bind(internal, own, person.ownSub, person.ownCode, now).run();
  return { scope, before, own, person };
}

const ON = { ...env, USERS_SCREEN: '1' } as typeof env;

/** The console's real fetch with the Users screen on (the test config has it off), as the SPA sends a POST. */
async function linkAs(m: Pick<Member, 'cs' | 'org'>, body: unknown, e: typeof env = ON): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/orgs/${m.org}/users/link`, { method: 'POST', headers: { ...CSRF, cookie: cookieOf(m), 'cf-connecting-ip': '203.0.113.9' }, body: JSON.stringify(body) }), e);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const linkRows = (org: string) => auditRows("org_id = ? AND action = 'users.link_view'", org);

describe('POST /api/orgs/:org/users/link', () => {
  it('an owner: the person’s apps with each app’s own IDs, audited first (target the scope-level User ID, what opened it, the kind of code)', async () => {
    const m = await member('owner');
    const n = await seedNetwork(m.org);
    const r = await linkAs(m, { query: n.person.userId, purpose: 'panel' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const view = r.body.link as UserLinkOut;
    expect(view).toEqual({
      userId: n.person.userId,
      supportId: fmt(n.person.code),
      scopeId: n.scope,
      match: { kind: 'userId', of: 'scope', appId: null },
      apps: [
        { appId: n.own, appName: 'Stamp Rally', userId: n.person.ownSub, supportId: fmt(n.person.ownCode), firstSeenAt: expect.any(Number), lastSeenAt: expect.any(Number) },
        { appId: n.before, appName: 'Coffee Club', userId: n.person.userId, supportId: fmt(n.person.code), firstSeenAt: expect.any(Number), lastSeenAt: expect.any(Number) },
      ],
      truncated: false,
    });
    const rows = await linkRows(m.org);
    expect(rows).toEqual([{ action: 'users.link_view', actor_kind: 'member', actor_id: m.userId, target: n.person.userId, org_id: m.org, details_json: JSON.stringify({ by: 'panel', kind: 'userId', of: 'scope' }), outcome: 'ok' }]);
  });

  it('the per-app search: an app’s own Support ID finds the person; the row names that app, never the code typed', async () => {
    const m = await member('owner');
    const n = await seedNetwork(m.org);
    const r = await linkAs(m, { query: fmt(n.person.ownCode).toLowerCase(), purpose: 'search' });
    expect(r.status).toBe(200);
    expect((r.body.link as UserLinkOut).match).toEqual({ kind: 'supportId', of: 'app', appId: n.own });
    const row = (await db.prepare("SELECT app_id, target, details_json FROM audit_log WHERE org_id = ? AND action = 'users.link_view'").bind(m.org).first<{ app_id: string; target: string; details_json: string }>())!;
    expect(row).toEqual({ app_id: n.own, target: n.person.userId, details_json: JSON.stringify({ by: 'search', kind: 'supportId', of: 'app' }) });
    const all = JSON.stringify(await db.prepare('SELECT * FROM audit_log WHERE org_id = ?').bind(m.org).all());
    for (const s of [n.person.ownCode, n.person.ownSub, fmt(n.person.ownCode)]) expect(all).not.toContain(s);
  });

  it('a viewer is refused (403 forbidden) before anything is counted, read or recorded', async () => {
    const v = await member('viewer');
    const n = await seedNetwork(v.org);
    expect(await linkAs(v, { query: n.person.userId, purpose: 'panel' })).toEqual({ status: 403, body: { error: { code: 'forbidden', message: 'Only an owner of the organisation can do this' } } });
    expect(await linkRows(v.org)).toEqual([]);
  });

  it('another org’s person is not_found (404), recorded with no target; the same as a code nobody holds', async () => {
    const m = await member('owner');
    const other = await seedNetwork(newId('org'));
    const a = await linkAs(m, { query: other.person.userId, purpose: 'search' });
    const b = await linkAs(m, { query: 'HANA-ZZZZ-ZZZZ', purpose: 'search' });
    expect(a).toEqual({ status: 404, body: { error: { code: 'not_found', message: 'Not found' } } });
    expect(b).toEqual(a);
    expect((await linkRows(m.org)).map((r) => [r.target, r.details_json, r.outcome])).toEqual([
      [null, JSON.stringify({ by: 'search', code: 'not_found' }), 'failed'],
      [null, JSON.stringify({ by: 'search', code: 'not_found' }), 'failed'],
    ]);
  });

  it('an ambiguous Support ID: 409 ambiguous with the plain words, recorded; no person named', async () => {
    const m = await member('owner');
    const n = await seedNetwork(m.org);
    const twin = `hu_${(uid() + 'c'.repeat(26)).slice(0, 26)}`;
    await hot.prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, 1, 1)').bind(twin, sub(), n.person.ownCode, n.scope).run();
    const r = await linkAs(m, { query: fmt(n.person.ownCode), purpose: 'search' });
    expect(r).toEqual({ status: 409, body: { error: { code: 'ambiguous', message: 'More than one person has this Support ID: ask for their User ID' } } });
    expect(JSON.stringify(r)).not.toContain(n.person.userId);
    expect((await linkRows(m.org)).map((x) => x.details_json)).toEqual([JSON.stringify({ by: 'search', code: 'ambiguous' })]);
  });

  it('an audit row that can’t be written means no answer (500, no IDs in the body)', async () => {
    const m = await member('owner');
    const n = await seedNetwork(m.org);
    const failing = new Proxy(env.CONSOLE_DB, {
      get(t, p) {
        if (p === 'prepare') return (sql: string) => (sql.startsWith('INSERT INTO audit_log') ? { bind: () => ({ run: async () => Promise.reject(new Error('D1_ERROR: disk full')) }) } : t.prepare(sql));
        const v = Reflect.get(t, p) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const r = await linkAs(m, { query: n.person.userId, purpose: 'panel' }, { ...ON, CONSOLE_DB: failing } as typeof env);
    expect(r.status).toBe(500);
    expect((r.body.error as { code: string }).code).toBe('internal');
    for (const s of [n.person.userId, n.person.ownSub, n.person.ownCode]) expect(JSON.stringify(r.body)).not.toContain(s);
    expect(await linkRows(m.org)).toEqual([]);
  });

  it('a member demoted (or disabled) after the request was let in gets no row and no answer: the owner rule is read again in the insert', async () => {
    const m = await member('owner');
    const n = await seedNetwork(m.org);
    // Demote the member the moment the API has answered, before the console writes its row.
    const api = new Proxy(env.API, {
      get(t, p) {
        if (p === 'linkUser')
          return async (c: unknown) => {
            const r = await (t as unknown as { linkUser: (c: unknown) => Promise<unknown> }).linkUser(c);
            await db.prepare("UPDATE members SET role = 'viewer' WHERE org_id = ? AND user_id = ?").bind(m.org, m.userId).run();
            return r;
          };
        const v = Reflect.get(t, p) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const r = await linkAs(m, { query: n.person.userId, purpose: 'panel' }, { ...ON, API: api } as typeof env);
    expect(r).toEqual({ status: 403, body: { error: { code: 'forbidden', message: 'Only an owner of the organisation can do this' } } });
    expect(JSON.stringify(r)).not.toContain(n.person.ownSub);
    expect(await linkRows(m.org)).toEqual([]);
  });

  it('refuses a body of another shape, and is 404 with the Users screen off (the test config’s default)', async () => {
    const m = await member('owner');
    const n = await seedNetwork(m.org);
    for (const body of [{ query: n.person.userId }, { query: n.person.userId, purpose: 'other' }, { query: n.person.userId, purpose: 'panel', extra: 1 }, { query: 'x'.repeat(65), purpose: 'panel' }])
      expect((await linkAs(m, body)).status, JSON.stringify(body)).toBe(400);
    expect((await linkAs(m, { query: n.person.userId, purpose: 'panel' }, env)).status).toBe(404);
    // A GET is not this route (no code in a URL): it is the user detail's, for which `link` is no User ID.
    const get = await worker.fetch(new Request(`${ORIGIN}/api/orgs/${m.org}/users/link`, { headers: { cookie: cookieOf(m), 'cf-connecting-ip': '203.0.113.9' } }), ON);
    expect(get.status).toBe(404);
    expect(await linkRows(m.org)).toEqual([]);
  });
});

describe('userLinkView: the allowlist', () => {
  const good = () => ({
    userId: 'u1_AbCdEfGhIjKlMnOpQrStUA',
    supportId: 'HANA-ABCD-EFGH',
    scopeId: 's1a2',
    match: { kind: 'supportId', of: 'app', appId: 'app_one1', internalId: 'hu_x' },
    apps: [{ appId: 'app_one1', appName: 'Partner Wallet', userId: 'u1_ZyXwVuTsRqPoNmLkJiHgFA', supportId: 'HANA-1234-5678', firstSeenAt: 1, lastSeenAt: 2, sub: '110248495921238986420', email: 'p@x.example' }],
    truncated: false,
    internalId: 'hu_0123456789abcdefghjkmnpqrs',
    wallets: [{ chain: 'evm', address: '0x52908400098527886E0F7030069857D2E4169EE7' }],
  });

  it('keeps exactly the listed fields, at every level', () => {
    const v = userLinkView(good())!;
    expect(v).toEqual({
      userId: 'u1_AbCdEfGhIjKlMnOpQrStUA',
      supportId: 'HANA-ABCD-EFGH',
      scopeId: 's1a2',
      match: { kind: 'supportId', of: 'app', appId: 'app_one1' },
      apps: [{ appId: 'app_one1', appName: 'Partner Wallet', userId: 'u1_ZyXwVuTsRqPoNmLkJiHgFA', supportId: 'HANA-1234-5678', firstSeenAt: 1, lastSeenAt: 2 }],
      truncated: false,
    });
    for (const s of ['hu_', '110248495921238986420', '@', '0x5290']) expect(JSON.stringify(v)).not.toContain(s);
  });

  it('drops an answer of any other form rather than pass it on; a name that isn’t one display-safe line reads “Unnamed app”', () => {
    const bad: ((x: ReturnType<typeof good>) => unknown)[] = [
      (x) => ({ ...x, userId: 'hu_0123456789abcdefghjkmnpqrs' }),
      (x) => ({ ...x, supportId: 'HANA-ABCD' }),
      (x) => ({ ...x, match: { kind: 'sub', of: 'app', appId: 'app_one1' } }),
      (x) => ({ ...x, match: { kind: 'userId', of: 'app', appId: null } }),
      (x) => ({ ...x, match: { kind: 'userId', of: 'scope', appId: 'app_one1' } }),
      (x) => ({ ...x, apps: [{ ...x.apps[0]!, userId: '110248495921238986420' }] }),
      (x) => ({ ...x, apps: [{ ...x.apps[0]!, firstSeenAt: -1 }] }),
      (x) => ({ ...x, apps: Array.from({ length: 101 }, () => x.apps[0]) }),
      (x) => ({ ...x, truncated: 'no' }),
    ];
    for (const f of bad) expect(userLinkView(f(good())), JSON.stringify(f(good())).slice(0, 120)).toBeNull();
    const odd = good();
    odd.apps[0]!.appName = 'Evil‮name';
    expect(userLinkView(odd)!.apps[0]!.appName).toBe('Unnamed app');
  });
});

describe('the console table the lookup writes, as the schema has it (sqlite_schema)', () => {
  it('audit_log’s triggers and views are the known set: append-only, kept 60 months; the row is a plain insert', async () => {
    const r = await db.prepare("SELECT type, name FROM sqlite_schema WHERE type IN ('trigger', 'view') AND (tbl_name = 'audit_log' OR sql LIKE '%audit_log%') ORDER BY type, name").all<{ type: string; name: string }>();
    expect(r.results.map((x) => `${x.type}:${x.name}`)).toMatchInlineSnapshot(`
      [
        "trigger:audit_log_no_early_delete",
        "trigger:audit_log_no_update",
      ]
    `);
  });
});
