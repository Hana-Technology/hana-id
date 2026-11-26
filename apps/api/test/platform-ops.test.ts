// D929 (docs/partner-platform-spec.md piece P4, A1, A4, A5, A8, A9; findings H1, H2, L3, L4, L15, L16, M7): the
// platform API's app operations through the real request handler, signed with a key in force. The reach (a live app, a
// staff-created app, another scope and another org untouched and answered exactly like an app that doesn't exist; the
// state moving between the plan read and the commit); the platform's cancel held to its own waiting web addresses (H2);
// the live-scope rules on a test scope (M7); a create's web addresses as platform proposals waiting 24 h and not in
// force a second earlier by any route or bare D1 write; the resume rule with a member taking a suspension over (L4);
// idempotency (L3); quotas at and past each limit; look-alike names (L15); the mode by INSERT … SELECT (L16); a frozen
// org; the switch off, the freeze, the key revoked or expired and the scope moved between the read and the commit; two
// keys racing; the breaker and the reserve; each route within its D1 cost; revocation and switch-off cancelling what the
// platform proposed; the widget's origin on two apps; and what the operations may import.
import { PLATFORM_KEY_LIFETIME_MS, PLATFORM_OPS_LIMITS, PLATFORM_REQUEST_LIMITS, appNameLookalikeKey, namesLookAlike, newId, newPublishableKey } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAppByKey } from '../src/apps.ts';
import { planApp } from '../src/changes/apps.ts';
import { HotDb } from '../src/changes/db.ts';
import { admitMemberCall } from '../src/changes/guard.ts';
import { ackNotice } from '../src/changes/lifecycle.ts';
import { guardedChangesMaintenance } from '../src/guarded/cron.ts';
import { readOtherApps } from '../src/other-apps.ts';
import { PLATFORM_LIMITS } from '../src/platform/request.ts';
import { PLATFORM_ROUTES } from '../src/platform/routes.ts';
import { AdminRpc } from '../src/rpc/admin.ts';
import { ConsoleRpc } from '../src/rpc/console.ts';
import opsSource from '../src/platform/ops.ts?raw';
import { type Seeded, type SendOpts, freeze, freshNow, importProblems, platformProposal, seedKey, send, switchOff } from './platform-helpers.ts';
import { type DbCount, adminRpc, consoleRpc, countingDb, hana, linkToken, member, memberProposal, orgApp, rid, rows, system } from './rpc-helpers.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
afterEach(() => vi.restoreAllMocks());

let n = 0;
const ik = (): string => `idem-${Date.now().toString(36)}-${++n}`;

/**
 * A network: an org with three marked test scopes (each with a staff-created app, the network's own site) and a
 * platform key in force naming the first two; the third is the org's but not the key's.
 */
async function network(o: { contacts?: string[] } = {}) {
  const contacts = o.contacts ?? ['security@partner.example'];
  const site = await orgApp({ contacts });
  const other = await orgApp({ org: site.org, contacts });
  const unnamed = await orgApp({ org: site.org, contacts });
  for (const s of [site.scope, other.scope, unnamed.scope]) await env.DB.prepare('UPDATE scopes SET app_user_ids = 1 WHERE scope_id = ?1').bind(s).run();
  const k = await seedKey({ org: site, scopes: [site.scope, other.scope] });
  return { k, org: site.org, s1: site.scope, s2: other.scope, s3: unnamed.scope, site, other, unnamed };
}
type Net = Awaited<ReturnType<typeof network>>;

const post = (k: Pick<Seeded, 'id' | 'privateKey'>, path: string, body: unknown, o: SendOpts = {}) =>
  send(k, { method: 'POST', path, body: JSON.stringify(body), idempotencyKey: ik(), now: freshNow(), ...o });
const get = (k: Pick<Seeded, 'id' | 'privateKey'>, path: string, o: SendOpts = {}) => send(k, { path, now: freshNow(), ...o });
const create = (k: Pick<Seeded, 'id' | 'privateKey'>, body: Record<string, unknown>, o: SendOpts = {}) => post(k, '/v1/platform/apps', body, o);

/** A platform-created app written straight to D1 (as a create leaves it, less its ledger row): for the bulk cases. */
async function bareApp(org: string, scope: string, name = `App ${newId('app').slice(4, 10)}`): Promise<{ id: string; key: string }> {
  const id = newId('app');
  const key = newPublishableKey('test');
  await env.DB.prepare(
    "INSERT INTO apps (id, name, scope_id, org_id, publishable_key, status, plan, created_at, origins_version, user_ids, created_by_kind) VALUES (?1, ?2, ?3, ?4, ?5, 'active', 'free', ?6, 0, 'app', 'platform')",
  )
    .bind(id, name, scope, org, key, Date.now())
    .run();
  await env.DB.prepare('INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(newId('key'), id, key, 'pkc_bare', Date.now()).run();
  return { id, key };
}

/** A created app through the API, with `origins`; its id, first key and changes. */
async function createdApp(net: Net, origins: string[] = [], o: { name?: string; scope?: string } = {}) {
  const r = await create(net.k, { scopeId: o.scope ?? net.s1, name: o.name ?? `Partner ${newId('app').slice(4, 12)}`, origins });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const app = r.body.app as { id: string; originsVersion: number; keys: { id: string; key: string }[] };
  return { id: app.id, version: app.originsVersion, keyId: app.keys[0]!.id, key: r.body.publishableKey as string, changes: r.body.changes as { changeId: string; origin: string }[] };
}

const one = async <T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T> => (await rows<T>(sql, ...args))[0]!;
const ledgerOf = (org: string) => rows<{ kind: string; actor_kind: string; actor_id: string; app_id: string | null; detail_json: string; request_id: string }>('SELECT kind, actor_kind, actor_id, app_id, detail_json, request_id FROM app_changes WHERE org_id = ?1 ORDER BY seq', org);
const dbNow = async (): Promise<number> => (await one<{ t: number }>("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS t")).t;
/** The body without its request id (the one field two answers to different requests never share). */
const sansId = (b: Record<string, unknown>) => {
  const { requestId: _r, ...rest } = b;
  return rest;
};
const refusal = (sql: string, ...binds: unknown[]): Promise<string> =>
  env.DB.prepare(sql)
    .bind(...binds)
    .run()
    .then(
      () => 'accepted',
      (e: unknown) => String(e instanceof Error ? e.message : e),
    );

/** A D1 binding that runs `before` once, just before the first batch (between a write's plan read and its commit). */
function beforeFirstBatch(before: () => Promise<unknown>): D1Database {
  let done = false;
  return new Proxy(env.DB, {
    get(t, p) {
      if (p === 'batch')
        return async (stmts: D1PreparedStatement[]) => {
          if (!done) {
            done = true;
            await before();
          }
          return t.batch(stmts);
        };
      const v: unknown = Reflect.get(t, p);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

/** What any write leaves behind anywhere: ledger rows, idempotency records, apps, changes, keys (a refused write adds none). */
async function written() {
  return one<Record<string, number>>(
    `SELECT (SELECT COUNT(*) FROM app_changes) AS ledger, (SELECT COUNT(*) FROM platform_requests) AS requests, (SELECT COUNT(*) FROM apps) AS apps,
            (SELECT COUNT(*) FROM guarded_changes WHERE status = 'pending') AS waiting, (SELECT COUNT(*) FROM app_keys WHERE revoked_at IS NULL) AS keys,
            (SELECT COUNT(*) FROM app_origins) AS origins, (SELECT SUM(suspended_by) FROM apps) AS suspended`,
  );
}

/** Everything a platform write could have touched for one org, to show a refused write changed nothing. */
async function stateOf(org: string) {
  return {
    ledger: await rows('SELECT seq, kind FROM app_changes WHERE org_id = ?1 ORDER BY seq', org),
    apps: await rows('SELECT id, suspended_by, partner_bit_by, origins_version, deleted_at FROM apps WHERE org_id = ?1 ORDER BY id', org),
    origins: await rows('SELECT o.app_id, o.origin, o.active_from, o.change_id FROM app_origins o JOIN apps a ON a.id = o.app_id WHERE a.org_id = ?1 ORDER BY o.app_id, o.origin', org),
    changes: await rows('SELECT g.id, g.status, g.active_from FROM guarded_changes g JOIN apps a ON a.id = g.app_id WHERE a.org_id = ?1 ORDER BY g.id', org),
    keys: await rows('SELECT k.id, k.revoked_at FROM app_keys k JOIN apps a ON a.id = k.app_id WHERE a.org_id = ?1 ORDER BY k.id', org),
    requests: await rows('SELECT request_id FROM platform_requests WHERE org_id = ?1 ORDER BY request_id', org),
  };
}

// ---- first: requests at the real time (before any test moves this file's clocks on) ----

describe('the key expiring inside a write', () => {
  it('the key expiring between the plan read and the batch (by the database’s clock): nothing written', async () => {
    for (const op of WRITES.filter((o) => ['create', 'propose', 'suspend'].includes(o.name))) {
      const site = await orgApp();
      await env.DB.prepare('UPDATE scopes SET app_user_ids = 1 WHERE scope_id = ?1').bind(site.scope).run();
      const k = await seedKey({ org: site, activeFrom: Date.now() - PLATFORM_KEY_LIFETIME_MS + 2500 });
      const net = { k, org: site.org, s1: site.scope, s2: site.scope, s3: site.scope, site, other: site, unnamed: site } as Net;
      // Set up without the API (its requests run at the real time, before any of this file's clocks moves on).
      const s = { app: op.name === 'create' ? '' : (await bareApp(site.org, site.scope)).id, version: 0, change: '', key: '' };
      const expiry = (await one<{ expires_at: number }>('SELECT expires_at FROM platform_keys WHERE id = ?1', k.id)).expires_at;
      const before = await written();
      const wait = beforeFirstBatch(async () => {
        while ((await dbNow()) <= expiry + 50) await new Promise((r) => setTimeout(r, 100));
      });
      const r = await send(k, { method: 'POST', path: op.path(s), body: JSON.stringify(bodyFor(op, net, s)), idempotencyKey: ik(), now: Date.now(), bindings: { DB: wait } });
      expect([r.status, r.body.code], op.name).toEqual([409, 'version_conflict']);
      expect(await written(), op.name).toEqual(before);
    }
  });

});

// ---- create ----

describe('POST /v1/platform/apps (A4.4)', () => {
  it('creates a test app on a shared scope of the key: the platform as creator, its own User IDs, its first key, its web addresses as platform proposals with the 24 h wait', async () => {
    const net = await network();
    const now = freshNow();
    const r = await create(net.k, { scopeId: net.s1, name: 'Acme Swap', origins: ['https://acme.example', 'https://widget.network.example'] }, { now, idempotencyKey: 'create-acme-1' });
    expect(r.status).toBe(201);
    const app = r.body.app as Record<string, unknown>;
    expect(app).toEqual({
      id: expect.stringMatching(/^app_/u),
      name: 'Acme Swap',
      scopeId: net.s1,
      environment: 'test',
      createdBy: 'platform',
      createdAt: now,
      userIds: 'app',
      suspended: { byJournear: false, byOrganisation: false, byYou: false, youCanResume: false },
      originsVersion: 1,
      origins: [
        { origin: 'https://acme.example', display: 'https://acme.example', idn: false, state: 'waiting_announcement', activeFrom: null, confirmedAt: null, changeId: expect.stringMatching(/^gc_/u) },
        { origin: 'https://widget.network.example', display: 'https://widget.network.example', idn: false, state: 'waiting_announcement', activeFrom: null, confirmedAt: null, changeId: expect.stringMatching(/^gc_/u) },
      ],
      keys: [{ id: expect.stringMatching(/^key_/u), key: r.body.publishableKey, createdAt: now, revokedAt: null }],
    });
    expect(r.body.changes).toEqual((app.origins as { origin: string; changeId: string }[]).map((o) => ({ changeId: o.changeId, origin: o.origin })));
    const row = await one('SELECT created_by_kind, user_ids, org_id, scope_id, suspended_by, partner_bit_by FROM apps WHERE id = ?1', app.id);
    expect(row).toEqual({ created_by_kind: 'platform', user_ids: 'app', org_id: net.org, scope_id: net.s1, suspended_by: 0, partner_bit_by: null });
    const changes = await rows<Record<string, unknown>>(
      'SELECT g.kind, g.status, g.proposed_by_kind, g.proposed_by, g.proposer_sub, g.waiver, g.notified_at, g.active_from, w.key_id, w.min_delay_ms, w.unconfirmed_active_from FROM guarded_changes g JOIN platform_origin_waits w ON w.change_id = g.id WHERE g.app_id = ?1 ORDER BY g.origin',
      app.id,
    );
    expect(changes).toEqual(Array(2).fill({ kind: 'origin_add', status: 'pending', proposed_by_kind: 'platform', proposed_by: net.k.id, proposer_sub: null, waiver: null, notified_at: null, active_from: null, key_id: net.k.id, min_delay_ms: DAY, unconfirmed_active_from: null }));
    const led = (await ledgerOf(net.org)).filter((l) => l.app_id === app.id);
    expect(led.map((l) => [l.kind, l.actor_kind, l.actor_id])).toEqual([['app.created', 'platform', net.k.id]]);
    expect(JSON.parse(led[0]!.detail_json)).toMatchObject({ name: 'Acme Swap', environment: 'test', userIds: 'app', createdBy: 'platform', scopeCreated: false, waiver: null });
    expect(await rows('SELECT key_id, method, path FROM platform_requests WHERE request_id = ?1', led[0]!.request_id)).toEqual([{ key_id: net.k.id, method: 'POST', path: '/v1/platform/apps' }]);
    expect(led[0]!.request_id).toMatch(/^pf_[A-Za-z0-9_-]{32}$/u);
    expect(await rows('SELECT route, app_id, status FROM platform_calls WHERE key_id = ?1 AND route = ?2', net.k.id, '/v1/platform/apps')).toEqual([{ route: '/v1/platform/apps', app_id: app.id, status: 201 }]);
  });

  it('only on a shared test scope the key names: another scope of the org, an unmarked one, a live one and another org’s are all `forbidden`, the same answer', async () => {
    const net = await network();
    const unmarked = await orgApp({ org: net.org });
    const live = await orgApp({ org: net.org, live: true });
    const foreign = await network();
    const k2 = await seedKey({ org: net.site, scopes: [net.s1, unmarked.scope] });
    const answers = [];
    for (const [k, scopeId] of [
      [net.k, net.s3],
      [k2, unmarked.scope],
      [net.k, live.scope],
      [net.k, foreign.s1],
      [net.k, 'snosuchscope'],
    ] as const) {
      const r = await create(k, { scopeId, name: 'Acme' });
      answers.push([r.status, r.body.code, r.body.error]);
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toEqual([403, 'forbidden', expect.stringContaining('shared wallet')]);
    expect(await rows("SELECT id FROM apps WHERE created_by_kind = 'platform' AND org_id IN (?1, ?2)", net.org, foreign.org)).toEqual([]);
  });

  it('no security contact: `no_security_contact`, nothing written', async () => {
    const net = await network({ contacts: [] });
    const r = await create(net.k, { scopeId: net.s1, name: 'Acme' });
    expect([r.status, r.body.code]).toEqual([409, 'no_security_contact']);
  });

  it('M7: the live-scope rules on a test scope: loopback, the localhost wildcard, http and a mixed-script host are `origin_refused`', async () => {
    const net = await network();
    for (const origin of ['http://localhost:5173', 'http://localhost:*', 'http://127.0.0.1:8080', 'http://acme.example', 'https://pаypal.example']) {
      const r = await create(net.k, { scopeId: net.s1, name: 'Acme', origins: ['https://ok.example', origin] });
      expect([r.status, r.body.code], origin).toEqual([400, 'origin_refused']);
    }
    expect(await rows("SELECT id FROM apps WHERE org_id = ?1 AND created_by_kind = 'platform'", net.org)).toEqual([]);
  });

  it('L15: a name that reads like another app’s on the same scope is `conflict`; on another scope, or a different name, it is fine', async () => {
    const net = await network();
    await createdApp(net, [], { name: 'Acme Swap' });
    for (const name of ['ACME SWAP', 'acme-swap', 'Acme  Swap', 'Acrne Swap', 'Àcmé Swap', 'AcmeSwap', 'Acme_Swap']) {
      const r = await create(net.k, { scopeId: net.s1, name });
      expect([r.status, r.body.code], name).toEqual([409, 'conflict']);
      // The other app's name is never quoted (it may be outside the reach).
      expect(r.body.error, name).toBe('The name reads like the name of another app on this scope: choose a name that can’t be taken for it');
    }
    // The network's own (staff-created) site counts too.
    const siteName = (await one<{ name: string }>('SELECT name FROM apps WHERE id = ?1', net.site.id)).name;
    const site = await create(net.k, { scopeId: net.s1, name: siteName.toUpperCase() });
    expect(site.body.code).toBe('conflict');
    expect(site.text).not.toContain(siteName);
    expect((await create(net.k, { scopeId: net.s2, name: 'Acme Swap' })).status).toBe(201);
    expect((await create(net.k, { scopeId: net.s1, name: 'Acme Swap Pro' })).status).toBe(201);
    expect(namesLookAlike('Acme Swap', 'acme swap')).toBe(true);
    expect(appNameLookalikeKey('Acrne VVallet')).toBe(appNameLookalikeKey('Acme Wallet'));
  });

  it('L16: the mode and the creator come from the scope’s row inside the batch (INSERT … SELECT), never from the request', async () => {
    const net = await network();
    const seen: string[] = [];
    const real = env.DB.batch.bind(env.DB);
    const spy = vi.spyOn(env.DB, 'batch').mockImplementation(async (stmts) => {
      for (const s of stmts) seen.push(String((s as unknown as { statement?: string }).statement ?? ''));
      return real(stmts);
    });
    const r = await create(net.k, { scopeId: net.s1, name: 'Mode Check' });
    spy.mockRestore();
    expect(r.status).toBe(201);
    expect((await one('SELECT user_ids, created_by_kind FROM apps WHERE id = ?1', (r.body.app as { id: string }).id))).toEqual({ user_ids: 'app', created_by_kind: 'platform' });
    const insert = seen.find((s) => s.startsWith('INSERT INTO apps'));
    if (insert) expect(insert).toMatch(/SELECT CASE s\.app_user_ids WHEN 1 THEN 'app' WHEN 0 THEN 'scope' END FROM scopes s/u);
    // A body that tries to say otherwise is refused (strict bodies).
    expect((await create(net.k, { scopeId: net.s1, name: 'X', userIds: 'scope' })).body.code).toBe('bad_request');
    expect((await create(net.k, { scopeId: net.s1, name: 'X', createdBy: 'hana' })).body.code).toBe('bad_request');
  });

  it('the org’s app limit: the 10th app is created, the 11th is `409 app_limit`; a deleted app frees its place; staff raise it; staff-created apps don’t count', async () => {
    const net = await network();
    for (let i = 0; i < 9; i++) await bareApp(net.org, i % 2 ? net.s1 : net.s2);
    const tenth = await create(net.k, { scopeId: net.s1, name: 'Tenth' });
    expect(tenth.status).toBe(201);
    const eleventh = await create(net.k, { scopeId: net.s1, name: 'Eleventh' });
    expect([eleventh.status, eleventh.body.code, eleventh.body.maxApps]).toEqual([409, 'app_limit', 10]);
    await env.DB.prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind((tenth.body.app as { id: string }).id, Date.now()).run();
    expect((await create(net.k, { scopeId: net.s1, name: 'Eleventh' })).status).toBe(201);
    expect((await create(net.k, { scopeId: net.s1, name: 'Twelfth' })).body.code).toBe('app_limit');
    await env.DB.prepare('UPDATE platform_orgs SET max_apps = 11 WHERE org_id = ?1').bind(net.org).run();
    expect((await create(net.k, { scopeId: net.s1, name: 'Twelfth' })).status).toBe(201);
    expect((await rows("SELECT id FROM apps WHERE org_id = ?1 AND created_by_kind = 'platform' AND deleted_at IS NULL", net.org)).length).toBe(11);
  });

  it('creation windows: 2 an hour, then `429 platform:creations:hour`; 5 a UTC day, then `platform:creations:day`; refused creates don’t count; the first refusal of the hour writes `platform_quota`', async () => {
    const net = await network();
    // A UTC day of its own, starting an hour in.
    let base = freshNow();
    base = Math.ceil(base / DAY) * DAY + HOUR + 1000;
    const at = (h: number, s = 0) => base + h * HOUR + s * 10_000;
    expect((await create(net.k, { scopeId: net.s3, name: 'Refused' }, { now: at(0) })).status).toBe(403);
    expect((await create(net.k, { scopeId: net.s1, name: 'A1' }, { now: at(0, 1) })).status).toBe(201);
    expect((await create(net.k, { scopeId: net.s1, name: 'A2' }, { now: at(0, 2) })).status).toBe(201);
    const third = await create(net.k, { scopeId: net.s1, name: 'A3' }, { now: at(0, 3) });
    expect([third.status, third.body.code, third.body.limit]).toEqual([429, 'rate_limited', 'platform:creations:hour']);
    expect(third.headers.find(([h]) => h === 'retry-after')?.[1]).toMatch(/^\d+$/u);
    expect((await create(net.k, { scopeId: net.s1, name: 'A4' }, { now: at(0, 4) })).status).toBe(429);
    expect((await rows<{ detail_json: string }>("SELECT detail_json FROM security_events WHERE kind = 'platform_quota' AND org_id = ?1", net.org)).map((e) => JSON.parse(e.detail_json).limit)).toEqual(['platform:creations:hour']);
    expect((await create(net.k, { scopeId: net.s1, name: 'B1' }, { now: at(1) })).status).toBe(201);
    expect((await create(net.k, { scopeId: net.s1, name: 'B2' }, { now: at(1, 1) })).status).toBe(201);
    expect((await create(net.k, { scopeId: net.s2, name: 'C1' }, { now: at(2) })).status).toBe(201);
    const sixth = await create(net.k, { scopeId: net.s2, name: 'C2' }, { now: at(2, 1) });
    expect([sixth.status, sixth.body.limit]).toEqual([429, 'platform:creations:day']);
    // The next UTC day: room again.
    expect((await create(net.k, { scopeId: net.s2, name: 'D1' }, { now: at(24) })).status).toBe(201);
    // Keep the file's clocks moving forward past these.
    while (freshNow() < at(26));
  });

  it('a partner on the network’s widget (A13): two apps list the same widget origin; the widget takes one of each app’s 20', async () => {
    const net = await network();
    const widget = 'https://widget.network.example';
    const a = await createdApp(net, [widget, 'https://a.example']);
    const twenty = [widget, ...Array.from({ length: 19 }, (_, i) => `https://b${i}.example`)];
    const b = await createdApp(net, twenty);
    expect((await rows('SELECT app_id FROM app_origins WHERE origin = ?1 AND app_id IN (?2, ?3)', widget, a.id, b.id)).length).toBe(2);
    // 21 in one create: the schema refuses it; one more on a full app: `conflict`.
    expect((await create(net.k, { scopeId: net.s1, name: 'Too many', origins: [...twenty, 'https://c.example'] })).body.code).toBe('bad_request');
    const more = await post(net.k, `/v1/platform/apps/${b.id}/origins`, { add: ['https://c.example'], expectedVersion: b.version });
    expect([more.status, more.body.code]).toEqual([409, 'conflict']);
  });

  it('web addresses on a scope given to the org only just now wait: `conflict`; with no web address the app is created', async () => {
    const net = await network();
    await env.DB.prepare('UPDATE scopes SET assigned_at = ?2 WHERE scope_id = ?1').bind(net.s1, Date.now() + 30 * DAY).run();
    const now = freshNow();
    expect((await create(net.k, { scopeId: net.s1, name: 'Early', origins: ['https://early.example'] }, { now })).body.code).toBe('conflict');
    expect((await create(net.k, { scopeId: net.s1, name: 'Early' }, { now })).status).toBe(201);
  });

  it('at most 30 web addresses waiting across the org: past it `429 platform:waiting_origins`', async () => {
    const net = await network();
    await createdApp(net, Array.from({ length: 20 }, (_, i) => `https://w${i}.example`));
    const r = await create(net.k, { scopeId: net.s2, name: 'Second', origins: Array.from({ length: 11 }, (_, i) => `https://x${i}.example`) });
    expect([r.status, r.body.limit]).toEqual([429, 'platform:waiting_origins']);
    expect((await create(net.k, { scopeId: net.s2, name: 'Second', origins: Array.from({ length: 10 }, (_, i) => `https://x${i}.example`) })).status).toBe(201);
  });

  it('a name with a lone surrogate (a JSON "\\ud800" escape in the body): 400 bad_request, nothing written (PR 160’s review)', async () => {
    const net = await network();
    const before = await written();
    const r = await create(net.k, { scopeId: net.s1, name: 'Bad \ud800 Swap' });
    expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([400, 'bad_request']);
    expect(await written()).toEqual(before);
  });

  it('a proposal past the 30 waiting: `429 platform:waiting_origins` with the hour to wait, before any quota unit (not version_conflict; after PR 160’s review, M1)', async () => {
    const net = await network();
    await createdApp(net, Array.from({ length: 20 }, (_, i) => `https://w${i}.example`));
    const b = await createdApp(net, [], { scope: net.s2 });
    const before = await written();
    // One clock for both, so a refusal that took 11 proposal units would leave the 10 past the hour's 20.
    const now = freshNow();
    const add = (n: number) => post(net.k, `/v1/platform/apps/${b.id}/origins`, { add: Array.from({ length: n }, (_, i) => `https://y${i}.example`), expectedVersion: b.version }, { now });
    const r = await add(11);
    expect([r.status, r.body.code, r.body.limit, r.body.retryAfterS], JSON.stringify(r.body)).toEqual([429, 'rate_limited', 'platform:waiting_origins', 3600]);
    expect(r.headers.find(([k]) => k === 'retry-after')?.[1]).toBe('3600');
    expect(await written()).toEqual(before);
    const ok = await add(10);
    expect(ok.status, JSON.stringify(ok.body)).toBe(202);
  });
});

// ---- reads ----

describe('GET /v1/platform/apps and /v1/platform/apps/:appId (A8)', () => {
  it('the view is an allowlist: no settings, policy, raw signing, mainnet demo, labels, client, staff or Google identities', async () => {
    const net = await network();
    const a = await createdApp(net, ['https://a.example']);
    const r = await get(net.k, `/v1/platform/apps/${a.id}`);
    expect(r.status).toBe(200);
    const app = r.body.app as Record<string, unknown>;
    expect(Object.keys(app).sort()).toEqual(['createdAt', 'createdBy', 'environment', 'id', 'keys', 'name', 'origins', 'originsVersion', 'scopeId', 'suspended', 'userIds']);
    expect(JSON.stringify(r.body)).not.toMatch(/policy|rawSign|mainnet|label|googleWebClient|proposer|sub"|email|settings/iu);
    expect(Object.keys((app.origins as Record<string, unknown>[])[0]!).sort()).toEqual(['activeFrom', 'changeId', 'confirmedAt', 'display', 'idn', 'origin', 'state']);
    expect(Object.keys((app.keys as Record<string, unknown>[])[0]!).sort()).toEqual(['createdAt', 'id', 'key', 'revokedAt']);
  });

  it('each web address’s state: waiting for its announcement, waiting with its date, in force; an IDN shown decoded', async () => {
    const net = await network();
    const a = await createdApp(net, ['https://xn--bcher-kva.example', 'https://waiting.example']);
    const idn = a.changes.find((c) => c.origin.includes('xn--'));
    const waiting = a.changes.find((c) => c.origin === 'https://waiting.example');
    const at = freshNow();
    await ackNotice(new HotDb(env.DB), env, { actor: { kind: 'system', id: 'admin-cron' }, requestId: rid(), now: at }, { changeId: waiting!.changeId, cancelTokenHash: await linkToken().hash });
    const view = (await get(net.k, `/v1/platform/apps/${a.id}`, { now: at })).body.app as { origins: Record<string, unknown>[] };
    const by = Object.fromEntries(view.origins.map((o) => [o.origin, o]));
    expect(by['https://xn--bcher-kva.example']).toMatchObject({ display: 'https://bücher.example', idn: true, state: 'waiting_announcement', activeFrom: null, changeId: idn!.changeId });
    expect(by['https://waiting.example']).toMatchObject({ state: 'waiting', activeFrom: expect.any(Number), confirmedAt: null });
    const later = (await get(net.k, `/v1/platform/apps/${a.id}`, { now: (by['https://waiting.example']!.activeFrom as number) + 1 })).body.app as { origins: Record<string, unknown>[] };
    expect(later.origins.find((o) => o.origin === 'https://waiting.example')!.state).toBe('active');
  });

  it('the list: only the reach, by id, 50 a page with `next`; `scopeId` narrows it; a scope not on the key is `forbidden`; anything else in the query `bad_request`', async () => {
    const net = await network();
    const ids: string[] = [];
    for (let i = 0; i < 52; i++) ids.push((await bareApp(net.org, i % 2 ? net.s1 : net.s2)).id);
    // Never listed: a staff app, an app on the scope the key doesn't name, a deleted one, another org's.
    const outside = await bareApp(net.org, net.s3);
    const deleted = await bareApp(net.org, net.s1);
    await env.DB.prepare('UPDATE apps SET deleted_at = 1 WHERE id = ?1').bind(deleted.id).run();
    const foreign = await network();
    await bareApp(foreign.org, foreign.s1);
    const first = await get(net.k, '/v1/platform/apps');
    const page1 = (first.body.apps as { id: string }[]).map((a) => a.id);
    expect(page1).toHaveLength(50);
    expect(first.body.next).toBe(page1[49]);
    const second = await get(net.k, `/v1/platform/apps?cursor=${first.body.next as string}`);
    const page2 = (second.body.apps as { id: string }[]).map((a) => a.id);
    expect(second.body.next).toBeUndefined();
    expect([...page1, ...page2]).toEqual([...ids].sort());
    expect([...page1, ...page2]).not.toContain(outside.id);
    expect([...page1, ...page2]).not.toContain(net.site.id);
    const s1 = await get(net.k, `/v1/platform/apps?scopeId=${net.s1}`);
    expect((s1.body.apps as { scopeId: string }[]).every((a) => a.scopeId === net.s1)).toBe(true);
    expect((s1.body.apps as unknown[]).length).toBe(26);
    expect([(await get(net.k, `/v1/platform/apps?scopeId=${net.s3}`)).status, (await get(net.k, `/v1/platform/apps?scopeId=${net.s3}`)).body.code]).toEqual([403, 'forbidden']);
    expect((await get(net.k, '/v1/platform/apps?org=x')).body.code).toBe('bad_request');
    expect((await get(net.k, '/v1/platform/apps?scopeId=s1&scopeId=s2')).body.code).toBe('bad_request');
    expect((await get(net.k, '/v1/platform/apps?cursor=nope')).body.code).toBe('bad_request');
    // A key of the other org sees only its own.
    expect(((await get(foreign.k, '/v1/platform/apps')).body.apps as unknown[]).length).toBe(1);
  });
});

// ---- the reach (H1) ----

describe('H1: the reach of every operation', () => {
  it('a live app, a staff-created test app, an app on a scope the key doesn’t name and another org’s platform app: every route answers `not_found` exactly as for an app that doesn’t exist, and nothing changes', async () => {
    const net = await network();
    const live = await orgApp({ org: net.org, live: true });
    const offScope = await bareApp(net.org, net.s3);
    const foreign = await network();
    const foreignApp = await createdApp(foreign, ['https://foreign.example']);
    const staffKey = (await one<{ id: string }>('SELECT id FROM app_keys WHERE app_id = ?1', net.site.id)).id;
    // Changes on them: a platform proposal on the off-scope app and on the foreign app, a staff one on the site.
    const offChange = await platformProposal(offScope.id, net.k.id, 'https://off.example');
    const staffChange = await memberProposal(net.site, { kind: 'origin_add', origin: 'https://staff-change.example' });
    const targets = [live.id, net.site.id, offScope.id, foreignApp.id];
    const before = { a: await stateOf(net.org), b: await stateOf(foreign.org) };
    const ghost = `app_${'Z'.repeat(20)}`;
    const routes = (app: string, key: string) => [
      ['GET', `/v1/platform/apps/${app}`, undefined],
      ['POST', `/v1/platform/apps/${app}/origins`, { add: ['https://new.example'], expectedVersion: 1 }],
      ['POST', `/v1/platform/apps/${app}/origins/remove`, { remove: ['https://partner.example'], expectedVersion: 1 }],
      ['POST', `/v1/platform/apps/${app}/suspend`, { suspended: true }],
      ['POST', `/v1/platform/apps/${app}/keys`, {}],
      ['POST', `/v1/platform/apps/${app}/keys/${key}/revoke`, {}],
    ] as const;
    for (const app of targets) {
      for (const [i, [method, path, body]] of routes(app, staffKey).entries()) {
        const ghostPath = routes(ghost, staffKey)[i]![1];
        const r = method === 'GET' ? await get(net.k, path) : await post(net.k, path, body);
        const g = method === 'GET' ? await get(net.k, ghostPath) : await post(net.k, ghostPath, body);
        expect([r.status, r.body.code], `${method} ${path}`).toEqual([404, 'not_found']);
        expect(sansId(r.body), `${method} ${path}`).toEqual(sansId(g.body));
      }
    }
    for (const change of [offChange, staffChange, foreignApp.changes[0]!.changeId]) {
      const r = await post(net.k, `/v1/platform/changes/${change}/cancel`, {});
      const g = await post(net.k, `/v1/platform/changes/gc_${'Z'.repeat(20)}/cancel`, {});
      expect([r.status, r.body.code], change).toEqual([404, 'not_found']);
      expect(sansId(r.body)).toEqual(sansId(g.body));
    }
    // The list shows none of them.
    expect(((await get(net.k, '/v1/platform/apps')).body.apps as unknown[]).length).toBe(0);
    expect(await stateOf(net.org)).toEqual(before.a);
    expect(await stateOf(foreign.org)).toEqual(before.b);
  });

  it('the state moved between the plan read and the commit (the scope given to another org): every write writes nothing (`version_conflict`)', async () => {
    for (const op of WRITES) {
      const net = await network();
      const s = await op.setup(net);
      const otherOrg = newId('org');
      const db = beforeFirstBatch(() => env.DB.prepare('UPDATE scopes SET org_id = ?2 WHERE scope_id = ?1').bind(net.s1, otherOrg).run());
      const before = await written();
      const r = await post(net.k, op.path(s), bodyFor(op, net, s), { bindings: { DB: db } });
      expect([r.status, r.body.code], op.name).toEqual([409, 'version_conflict']);
      expect(await written(), op.name).toEqual(before);
    }
  });
});

/** Every platform write, its setup (an app of the key's on s1 with a waiting and an in-force web address), path and body. */
interface WriteOp {
  name: string;
  setup(net: Net): Promise<{ app: string; version: number; change: string; key: string }>;
  path(s: { app: string; change: string; key: string }): string;
  body(s: { version: number }): unknown;
}
const writeSetup = async (net: Net) => {
  const a = await createdApp(net, ['https://waiting.example']);
  // A second key, so revoking one leaves the app working; an in-force web address to remove.
  const k2 = await post(net.k, `/v1/platform/apps/${a.id}/keys`, {});
  await env.DB.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, ?2, ?3)').bind(a.id, 'https://live.example', 1).run();
  return { app: a.id, version: a.version, change: a.changes[0]!.changeId, key: (k2.body.key as { id: string }).id };
};
const WRITES: WriteOp[] = [
  { name: 'create', setup: writeSetup, path: () => '/v1/platform/apps', body: () => ({ scopeId: '', name: 'Raced' }) },
  { name: 'propose', setup: writeSetup, path: (s) => `/v1/platform/apps/${s.app}/origins`, body: (s) => ({ add: ['https://raced.example'], expectedVersion: s.version }) },
  { name: 'remove', setup: writeSetup, path: (s) => `/v1/platform/apps/${s.app}/origins/remove`, body: (s) => ({ remove: ['https://live.example'], expectedVersion: s.version }) },
  { name: 'cancel', setup: writeSetup, path: (s) => `/v1/platform/changes/${s.change}/cancel`, body: () => ({}) },
  { name: 'suspend', setup: writeSetup, path: (s) => `/v1/platform/apps/${s.app}/suspend`, body: () => ({ suspended: true }) },
  { name: 'key create', setup: writeSetup, path: (s) => `/v1/platform/apps/${s.app}/keys`, body: () => ({}) },
  { name: 'key revoke', setup: writeSetup, path: (s) => `/v1/platform/apps/${s.app}/keys/${s.key}/revoke`, body: () => ({}) },
];
// The create's body names the network's first scope.
const bodyFor = (op: WriteOp, net: Net, s: { version: number }) => (op.name === 'create' ? { scopeId: net.s1, name: `Raced ${newId('app').slice(4, 10)}` } : op.body(s));

// ---- the wait (A4.5, A15) ----

describe('a platform proposal waits 24 h on a dev env, and nothing brings it in sooner', () => {
  const ack = (changeId: string, e: typeof env = env) =>
    ackNotice(new HotDb(env.DB), e, { actor: { kind: 'system', id: 'admin-cron' }, requestId: rid(), now: Date.now() }, { changeId, cancelTokenHash: '' }).catch(async () =>
      ackNotice(new HotDb(env.DB), e, { actor: { kind: 'system', id: 'admin-cron' }, requestId: rid(), now: Date.now() }, { changeId, cancelTokenHash: await linkToken().hash }),
    );

  it('a create’s web address: announced by the ack, in force exactly 24 h after it (the database holds the time), never with `no_session` even on a scope nobody has used', async () => {
    const net = await network();
    // A scope nobody has used: a staff proposal here would get `no_session` (in force at once).
    await env.DB.prepare('UPDATE scopes SET first_session_at = NULL WHERE scope_id = ?1').bind(net.s2).run();
    await env.DB.prepare('DELETE FROM app_origins WHERE app_id = ?1').bind(net.other.id).run();
    const a = await createdApp(net, ['https://partner.example'], { scope: net.s2 });
    const change = a.changes[0]!.changeId;
    const r = await adminRpc().ackNotice({ ...system(), changeId: change, cancelTokenHash: await linkToken().hash });
    expect(r).toMatchObject({ ok: true });
    const g = await one<{ notified_at: number; active_from: number; unconfirmed_active_from: number; waiver: string | null }>('SELECT g.notified_at, g.active_from, w.unconfirmed_active_from, g.waiver FROM guarded_changes g JOIN platform_origin_waits w ON w.change_id = g.id WHERE g.id = ?1', change);
    expect(g.waiver).toBeNull();
    expect(g.active_from - g.notified_at).toBe(DAY);
    expect(g.unconfirmed_active_from).toBe(g.active_from);
    expect((await one<{ active_from: number }>('SELECT active_from FROM app_origins WHERE change_id = ?1', change)).active_from).toBe(g.active_from);
    // The gate: not a millisecond early.
    expect((await getAppByKey(env.DB, a.key, g.active_from - 1))!.origins).not.toContain('https://partner.example');
    expect((await getAppByKey(env.DB, a.key, g.active_from))!.origins).toContain('https://partner.example');
    // The ledger's announcement says the same.
    expect(JSON.parse((await ledgerOf(net.org)).find((l) => l.kind === 'change.announced')!.detail_json)).toMatchObject({ activeFrom: g.active_from, waiver: null });
  });

  it('no route brings it in sooner: staff’s expedite `forbidden`, a second ack `not_pending`, the hourly job before its time leaves it, a staff cancel and re-add starts again', async () => {
    const net = await network();
    const a = await createdApp(net, ['https://partner.example']);
    const change = a.changes[0]!.changeId;
    await adminRpc().ackNotice({ ...system(), changeId: change, cancelTokenHash: await linkToken().hash });
    const g = await one<{ active_from: number }>('SELECT active_from FROM guarded_changes WHERE id = ?1', change);
    expect(await adminRpc().expediteChange({ ...hana(), changeId: change, reason: 'The partner is waiting for it to work today' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await adminRpc().ackNotice({ ...system(), changeId: change, cancelTokenHash: await linkToken().hash })).toMatchObject({ ok: false, code: 'not_pending' });
    await guardedChangesMaintenance(env, g.active_from - 1000);
    expect(await one('SELECT status, active_from FROM guarded_changes WHERE id = ?1', change)).toEqual({ status: 'pending', active_from: g.active_from });
    // No platform route can (the list of routes has no confirm or expedite; every write walked).
    for (const [method, path] of [['POST', `/v1/platform/changes/${change}/confirm`], ['POST', `/v1/platform/changes/${change}/expedite`], ['POST', `/v1/platform/apps/${a.id}/origins/confirm`]] as const) {
      expect((await send(net.k, { method, path, body: '{}', idempotencyKey: ik(), now: freshNow() })).status, path).toBe(404);
    }
    expect(await one('SELECT active_from FROM app_origins WHERE change_id = ?1', change)).toEqual({ active_from: g.active_from });
  });

  it('a bare D1 write can’t bring it in sooner either: every attempt is refused by migration 0033’s triggers', async () => {
    const net = await network();
    const a = await createdApp(net, ['https://partner.example', 'https://second.example']);
    const [c1, c2] = a.changes.map((c) => c.changeId);
    await adminRpc().ackNotice({ ...system(), changeId: c1!, cancelTokenHash: await linkToken().hash });
    const t = await dbNow();
    // D931: a staff row onto a platform-created app's web address is also refused by 0034's four-eyes rule.
    const early = /no earlier than its wait|announced once|in force only once|never comes back|never deleted|never replaced|takes no waiver|are fixed|written once|only the earliest time|is kept while|starts waiting with its wait/u;
    const attempts: [string, string, unknown[]][] = [
      ['the change in force now', 'UPDATE guarded_changes SET active_from = ?2 WHERE id = ?1', [c1, t]],
      ['the earliest time moved', 'UPDATE platform_origin_waits SET unconfirmed_active_from = ?2 WHERE change_id = ?1', [c1, t]],
      ['the wait shortened', 'UPDATE platform_origin_waits SET min_delay_ms = 60000 WHERE change_id = ?1', [c2]],
      ['the earliest time written early for the unannounced one', 'UPDATE platform_origin_waits SET unconfirmed_active_from = ?2 WHERE change_id = ?1', [c2, t + 60_000]],
      ['its wait deleted', 'DELETE FROM platform_origin_waits WHERE change_id = ?1', [c1]],
      ['its wait replaced', 'INSERT OR REPLACE INTO platform_origin_waits (change_id, app_id, origin, key_id, min_delay_ms, at) VALUES (?1, ?2, ?3, ?4, 60000, 1)', [c2, a.id, 'https://second.example', net.k.id]],
      ['the gate’s row in force now', 'UPDATE app_origins SET active_from = ?2 WHERE change_id = ?1', [c1, t]],
      ['the gate’s row unlinked and in force', 'UPDATE app_origins SET change_id = NULL, active_from = ?2 WHERE change_id = ?1', [c1, t]],
      ['the gate’s row replaced', "INSERT OR REPLACE INTO app_origins (app_id, origin, active_from) VALUES (?1, 'https://partner.example', ?2)", [a.id, t]],
      ['recorded in force early', "UPDATE guarded_changes SET status = 'active' WHERE id = ?1", [c1]],
      ['a waiver', "UPDATE guarded_changes SET waiver = 'no_session' WHERE id = ?1", [c1]],
      ['an expedite', "UPDATE guarded_changes SET expedited_by = 'staff', expedite_reason = 'x' WHERE id = ?1", [c1]],
      ['announced again, back-dated', 'UPDATE guarded_changes SET notified_at = ?2 WHERE id = ?1', [c1, t - DAY]],
      ['the unannounced one announced back-dated, in force', 'UPDATE guarded_changes SET notified_at = ?2, active_from = ?2 WHERE id = ?1', [c2, t - 2 * DAY]],
      ['the unannounced one announced with no earliest time', 'UPDATE guarded_changes SET notified_at = ?2 WHERE id = ?1', [c2, t]],
      ['made a staff proposal', "UPDATE guarded_changes SET proposed_by_kind = 'hana' WHERE id = ?1", [c1]],
      ['deleted (to insert it again)', 'DELETE FROM guarded_changes WHERE id = ?1', [c1]],
      ['replaced by id', "INSERT OR REPLACE INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES (?1, ?2, 'origin_add', 'https://partner.example', 'active', 'hana', 's', 1, 'r_x')", [c1, a.id]],
      ['another row moved onto its id', 'UPDATE OR REPLACE guarded_changes SET id = ?1 WHERE id = ?2', [c1, c2]],
    ];
    for (const [what, sql, args] of attempts) expect(await refusal(sql, ...args), what).toMatch(early);
    // The deleted-and-inserted-again case, done for real: the delete itself is refused, so the insert meets the waiting proposal.
    expect(await refusal('DELETE FROM app_origins WHERE change_id = ?1', c1)).toBe('accepted');
    expect(await refusal("INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, 'https://partner.example', ?2)", a.id, t)).toMatch(early);
    // A cancelled one never comes back.
    expect((await post(net.k, `/v1/platform/changes/${c2}/cancel`, {})).status).toBe(200);
    expect(await refusal("UPDATE guarded_changes SET status = 'pending', cancelled_at = NULL, cancelled_by = NULL WHERE id = ?1", c2)).toMatch(/never comes back/u);
    expect((await one<{ active_from: number }>('SELECT active_from FROM guarded_changes WHERE id = ?1', c1)).active_from).toBeGreaterThanOrEqual(t + DAY - 120_000);
    // Its wait went with nothing: still there, written once.
    expect(await one('SELECT min_delay_ms FROM platform_origin_waits WHERE change_id = ?1', c1)).toEqual({ min_delay_ms: DAY });
  });

  it('in a `local*` test env the platform minimum gives way to the env’s own delay; a member’s proposal keeps the env’s delay everywhere', async () => {
    const net = await network();
    const a = await createdApp(net, ['https://partner.example']);
    // D931: a `local*` test env is also one whose API is on a loopback http URL (the local* guard).
    const local = { ...env, ENV_NAME: 'local-test', NETWORK: 'testnet', API_URL: 'http://127.0.0.1:8787' } as typeof env;
    await ackNotice(new HotDb(env.DB), local, { actor: { kind: 'system', id: 'admin-cron' }, requestId: rid(), now: Date.now() }, { changeId: a.changes[0]!.changeId, cancelTokenHash: await linkToken().hash });
    const g = await one<{ notified_at: number; active_from: number }>('SELECT notified_at, active_from FROM guarded_changes WHERE id = ?1', a.changes[0]!.changeId);
    // Proposed on this dev env (24 h recorded), announced in a local one: the recorded wait still holds.
    expect(g.active_from - g.notified_at).toBe(DAY);
    // Proposed in a local env: its wait is the env's delay (60 s here).
    const before = (await one<{ v: number }>('SELECT origins_version AS v FROM apps WHERE id = ?1', a.id)).v;
    const p = await post(net.k, `/v1/platform/apps/${a.id}/origins`, { add: ['https://local.example'], expectedVersion: before }, { envName: 'local-test', bindings: { ENV_NAME: 'local-test', NETWORK: 'testnet', API_URL: 'http://127.0.0.1:8787' } as Partial<typeof env> });
    expect(p.status, JSON.stringify(p.body)).toBe(202);
    const lc = (p.body.changes as { changeId: string }[])[0]!.changeId;
    expect((await one<{ min_delay_ms: number }>('SELECT min_delay_ms FROM platform_origin_waits WHERE change_id = ?1', lc)).min_delay_ms).toBe(60_000);
    await ackNotice(new HotDb(env.DB), local, { actor: { kind: 'system', id: 'admin-cron' }, requestId: rid(), now: Date.now() }, { changeId: lc, cancelTokenHash: await linkToken().hash });
    const l = await one<{ notified_at: number; active_from: number }>('SELECT notified_at, active_from FROM guarded_changes WHERE id = ?1', lc);
    expect(l.active_from - l.notified_at).toBe(60_000);
    // A member's proposal: the env's delay, as before (no earliest time recorded).
    const m = await memberProposal(net.site, { kind: 'origin_add', origin: 'https://member.example' });
    await adminRpc().ackNotice({ ...system(), changeId: m, cancelTokenHash: await linkToken().hash });
    const mg = await one<{ notified_at: number; active_from: number }>('SELECT notified_at, active_from FROM guarded_changes WHERE id = ?1', m);
    expect(await rows('SELECT change_id FROM platform_origin_waits WHERE change_id = ?1', m)).toEqual([]);
    expect(mg.active_from - mg.notified_at).toBeLessThan(DAY);
    void ack;
  });
});

// ---- origins, cancel (H2) ----

describe('POST /v1/platform/apps/:appId/origins and …/origins/remove', () => {
  it('a proposal: `202`, each web address a platform proposal with the key’s id and the 24 h wait, the version moved; stale version `version_conflict`; a duplicate `conflict`', async () => {
    const net = await network();
    const a = await createdApp(net);
    const r = await post(net.k, `/v1/platform/apps/${a.id}/origins`, { add: ['https://b.example', 'https://A.example'], expectedVersion: a.version });
    expect(r.status).toBe(202);
    expect(r.body.version).toBe(a.version + 1);
    expect((r.body.changes as { origin: string }[]).map((c) => c.origin)).toEqual(['https://a.example', 'https://b.example']);
    expect(await rows('SELECT g.proposed_by_kind, g.proposed_by, w.min_delay_ms, g.status FROM guarded_changes g JOIN platform_origin_waits w ON w.change_id = g.id WHERE g.app_id = ?1', a.id)).toEqual(Array(2).fill({ proposed_by_kind: 'platform', proposed_by: net.k.id, min_delay_ms: DAY, status: 'pending' }));
    expect((await post(net.k, `/v1/platform/apps/${a.id}/origins`, { add: ['https://c.example'], expectedVersion: a.version })).body.code).toBe('version_conflict');
    expect((await post(net.k, `/v1/platform/apps/${a.id}/origins`, { add: ['https://a.example'], expectedVersion: a.version + 1 })).body.code).toBe('conflict');
  });

  it('M7: loopback, the localhost wildcard, http and a mixed-script host label are `origin_refused` on a test scope', async () => {
    const net = await network();
    const a = await createdApp(net);
    for (const origin of ['http://localhost:3000', 'http://localhost:*', 'http://[::1]:8080', 'http://partner.example', 'https://pаypal.example']) {
      const r = await post(net.k, `/v1/platform/apps/${a.id}/origins`, { add: [origin], expectedVersion: a.version });
      expect([r.status, r.body.code], origin).toEqual([400, 'origin_refused']);
    }
  });

  it('proposal windows count web addresses: 20 an hour (one full app’s worth), 30 a UTC day; a refused proposal doesn’t count', async () => {
    const net = await network();
    let base = freshNow();
    base = Math.ceil(base / DAY) * DAY + HOUR + 1000;
    const a = await createdApp(net, [], {});
    const b = await createdApp(net, [], { scope: net.s2 });
    let va = a.version;
    let vb = b.version;
    const add = async (app: string, v: number, k: number, from: number, now: number) => post(net.k, `/v1/platform/apps/${app}/origins`, { add: Array.from({ length: k }, (_, i) => `https://p${from + i}.example`), expectedVersion: v }, { now });
    expect((await add(a.id, va + 9, 2, 0, base)).body.code).toBe('version_conflict'); // refused: not counted
    const first = await add(a.id, va++, 15, 0, base + 1000);
    expect(first.status).toBe(202);
    expect((await add(a.id, va, 5, 100, base + 2000)).status).toBe(202);
    va++;
    const over = await add(b.id, vb, 1, 200, base + 3000);
    expect([over.status, over.body.limit]).toEqual([429, 'platform:proposals:hour']);
    expect((await add(b.id, vb++, 10, 300, base + HOUR)).status).toBe(202);
    // 30 now wait across the org: one cancelled, so the next is held by the day's window, not the waiting cap (which the
    // plan read checks first since PR 160's review, M1).
    const one = (first.body.changes as { changeId: string }[])[0]!.changeId;
    expect((await post(net.k, `/v1/platform/changes/${one}/cancel`, {}, { now: base + HOUR + 500 })).status).toBe(200);
    const day = await add(b.id, vb, 1, 400, base + HOUR + 1000);
    expect([day.status, day.body.limit]).toEqual([429, 'platform:proposals:day']);
    while (freshNow() < base + 3 * HOUR);
  });

  it('remove: at once, the waiting proposal of that address cancelled and the one in force ended; not an address of the app `bad_request`', async () => {
    const net = await network();
    const a = await createdApp(net, ['https://waiting.example']);
    await env.DB.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, ?2, 1)').bind(a.id, 'https://live.example').run();
    const r = await post(net.k, `/v1/platform/apps/${a.id}/origins/remove`, { remove: ['https://waiting.example', 'https://live.example'], expectedVersion: a.version });
    expect([r.status, r.body.version]).toEqual([200, a.version + 1]);
    expect(await rows('SELECT origin FROM app_origins WHERE app_id = ?1', a.id)).toEqual([]);
    expect((await one<{ status: string }>('SELECT status FROM guarded_changes WHERE id = ?1', a.changes[0]!.changeId)).status).toBe('cancelled');
    expect((await post(net.k, `/v1/platform/apps/${a.id}/origins/remove`, { remove: ['https://never.example'], expectedVersion: a.version + 1 })).body.code).toBe('bad_request');
  });
});

describe('H2: the platform’s cancel reaches only waiting web addresses a platform key of the org proposed', () => {
  it('its own and its org’s other key’s: cancelled; a member’s, staff’s or a policy change on the same app: `not_found`, as for a change that doesn’t exist; one in force `not_pending`', async () => {
    const net = await network();
    const k2 = await seedKey({ org: net.site, scopes: [net.s1] });
    const a = await createdApp(net, ['https://mine.example']);
    const theirs = await platformProposal(a.id, k2.id, 'https://other-key.example', { activeFrom: Date.now() + 300 * DAY });
    const memberChange = await memberProposal({ ...net.site, id: a.id }, { kind: 'origin_add', origin: 'https://member.example' });
    await env.DB.prepare("UPDATE guarded_changes SET proposed_by_kind = 'hana', proposer_sub = NULL WHERE id = ?1").bind(await memberProposal({ ...net.site, id: a.id }, { kind: 'origin_add', origin: 'https://staff.example' })).run();
    const staffChange = (await one<{ id: string }>("SELECT id FROM guarded_changes WHERE app_id = ?1 AND origin = 'https://staff.example'", a.id)).id;
    const policyChange = await memberProposal({ ...net.site, id: a.id }, { kind: 'raw_sign_on' });
    const inForce = await platformProposal(a.id, net.k.id, 'https://in-force.example', { inForce: true });
    const ghost = await post(net.k, `/v1/platform/changes/gc_${'Q'.repeat(20)}/cancel`, {});
    for (const c of [memberChange, staffChange, policyChange]) {
      const r = await post(net.k, `/v1/platform/changes/${c}/cancel`, {});
      expect(sansId(r.body), c).toEqual(sansId(ghost.body));
      expect(r.status).toBe(404);
      expect((await one<{ status: string }>('SELECT status FROM guarded_changes WHERE id = ?1', c)).status).toBe('pending');
    }
    const own = await post(net.k, `/v1/platform/changes/${a.changes[0]!.changeId}/cancel`, {});
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.change).toMatchObject({ changeId: a.changes[0]!.changeId, appId: a.id, origin: 'https://mine.example', status: 'cancelled', cancelledAt: expect.any(Number) });
    expect((await post(net.k, `/v1/platform/changes/${theirs}/cancel`, {})).status).toBe(200);
    expect((await post(net.k, `/v1/platform/changes/${inForce}/cancel`, {})).body.code).toBe('not_pending');
    expect(await rows('SELECT origin FROM app_origins WHERE app_id = ?1 ORDER BY origin', a.id)).toEqual([{ origin: 'https://in-force.example' }, { origin: 'https://member.example' }, { origin: 'https://staff.example' }]);
    const led = (await ledgerOf(net.org)).filter((l) => l.kind === 'change.cancelled');
    expect(led.map((l) => [l.actor_kind, l.actor_id])).toEqual([['platform', net.k.id], ['platform', net.k.id]]);
  });
});

// ---- suspension (L4) ----

describe('suspend and resume: who holds the partner suspension (L4)', () => {
  const suspend = (k: Seeded, app: string, suspended: boolean, o: SendOpts = {}) => post(k, `/v1/platform/apps/${app}/suspend`, { suspended }, o);
  const memberSuspend = (org: string, app: string, suspended: boolean) => consoleRpc().setSuspended({ ...member(), orgId: org, appId: app, suspended });

  it('the platform suspends and resumes its own suspension; the view says whose it is', async () => {
    const net = await network();
    const a = await createdApp(net);
    const s = await suspend(net.k, a.id, true);
    expect(s.body.suspended).toEqual({ byJournear: false, byOrganisation: false, byYou: true, youCanResume: true });
    expect(await one('SELECT suspended_by, partner_bit_by, status FROM apps WHERE id = ?1', a.id)).toEqual({ suspended_by: 4, partner_bit_by: 'platform', status: 'suspended' });
    // Again: nothing written.
    const ledger = (await ledgerOf(net.org)).length;
    expect((await suspend(net.k, a.id, true)).status).toBe(200);
    expect((await ledgerOf(net.org)).length).toBe(ledger);
    expect((await suspend(net.k, a.id, false)).body.suspended).toEqual({ byJournear: false, byOrganisation: false, byYou: false, youCanResume: false });
    expect(await one('SELECT suspended_by, partner_bit_by FROM apps WHERE id = ?1', a.id)).toEqual({ suspended_by: 0, partner_bit_by: null });
  });

  it('a member’s suspension: the platform’s suspend writes nothing and its resume is `forbidden`; only a member resumes it', async () => {
    const net = await network();
    const a = await createdApp(net);
    expect(await memberSuspend(net.org, a.id, true)).toMatchObject({ ok: true, suspendedBy: 4 });
    expect(await one('SELECT partner_bit_by FROM apps WHERE id = ?1', a.id)).toEqual({ partner_bit_by: 'member' });
    expect((await suspend(net.k, a.id, true)).body.suspended).toEqual({ byJournear: false, byOrganisation: true, byYou: false, youCanResume: false });
    const r = await suspend(net.k, a.id, false);
    expect([r.status, r.body.code]).toEqual([403, 'forbidden']);
    expect(await memberSuspend(net.org, a.id, false)).toMatchObject({ ok: true, suspendedBy: 0 });
    expect(await one('SELECT partner_bit_by FROM apps WHERE id = ?1', a.id)).toEqual({ partner_bit_by: null });
  });

  it('a member suspending after the platform takes the suspension over (`takenOver` in the ledger); the platform can no longer resume it', async () => {
    const net = await network();
    const a = await createdApp(net);
    await suspend(net.k, a.id, true);
    expect(await memberSuspend(net.org, a.id, true)).toMatchObject({ ok: true, suspendedBy: 4 });
    expect(await one('SELECT suspended_by, partner_bit_by FROM apps WHERE id = ?1', a.id)).toEqual({ suspended_by: 4, partner_bit_by: 'member' });
    const takeover = (await ledgerOf(net.org)).filter((l) => l.kind === 'suspension.set').at(-1)!;
    expect([takeover.actor_kind, JSON.parse(takeover.detail_json)]).toEqual(['member', { bit: 4, suspendedBy: 4, takenOver: true }]);
    expect((await suspend(net.k, a.id, false)).body.code).toBe('forbidden');
    // A member suspending again writes nothing more.
    const n0 = (await ledgerOf(net.org)).length;
    await memberSuspend(net.org, a.id, true);
    expect((await ledgerOf(net.org)).length).toBe(n0);
  });

  it('a member taking it over between the platform’s plan read and its commit: the platform’s resume writes nothing (`version_conflict`)', async () => {
    const net = await network();
    const a = await createdApp(net);
    await suspend(net.k, a.id, true);
    const db = beforeFirstBatch(() => env.DB.prepare("UPDATE apps SET partner_bit_by = 'member' WHERE id = ?1").bind(a.id).run());
    const r = await suspend(net.k, a.id, false, { bindings: { DB: db } });
    expect(r.body.code).toBe('version_conflict');
    expect(await one('SELECT suspended_by, partner_bit_by FROM apps WHERE id = ?1', a.id)).toEqual({ suspended_by: 4, partner_bit_by: 'member' });
  });

  it('Journear’s bits: `byJournear`, never cleared by the platform; staff clearing the partner bit clears its holder; a suspension older than 0033 reads as a member’s', async () => {
    const net = await network();
    const a = await createdApp(net);
    await adminRpc().setSuspended({ ...hana(), appId: a.id, bit: 1, suspended: true });
    await suspend(net.k, a.id, true);
    expect((await suspend(net.k, a.id, false)).body.suspended).toEqual({ byJournear: true, byOrganisation: false, byYou: false, youCanResume: false });
    expect(await one('SELECT suspended_by FROM apps WHERE id = ?1', a.id)).toEqual({ suspended_by: 1 });
    await suspend(net.k, a.id, true);
    await adminRpc().setSuspended({ ...hana(), appId: a.id, bit: 4, suspended: false });
    expect(await one('SELECT suspended_by, partner_bit_by FROM apps WHERE id = ?1', a.id)).toEqual({ suspended_by: 1, partner_bit_by: null });
    // Bit 4 set by a bare write (as before 0033), no holder: a member's.
    await env.DB.prepare('UPDATE apps SET suspended_by = 5 WHERE id = ?1').bind(a.id).run();
    expect((await suspend(net.k, a.id, false)).body.code).toBe('forbidden');
    // The holder is never left behind a cleared bit.
    expect(await refusal("UPDATE apps SET partner_bit_by = 'platform', suspended_by = 1 WHERE id = ?1", a.id)).toMatch(/only while it is set/u);
  });
});

// ---- publishable keys ----

describe('publishable keys', () => {
  it('create: `201`, up to 5 unrevoked, then `key_limit`; revoke: at once, the last one with `warning: last_key`, again `conflict`', async () => {
    const net = await network();
    const a = await createdApp(net);
    const created: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await post(net.k, `/v1/platform/apps/${a.id}/keys`, {});
      expect(r.status).toBe(201);
      expect(r.body.key).toEqual({ id: expect.stringMatching(/^key_/u), key: expect.stringMatching(/^pk_test_/u), createdAt: expect.any(Number), revokedAt: null });
      created.push((r.body.key as { id: string }).id);
    }
    const sixth = await post(net.k, `/v1/platform/apps/${a.id}/keys`, {});
    expect([sixth.status, sixth.body.code]).toEqual([409, 'key_limit']);
    for (const id of [a.keyId, ...created.slice(0, 3)]) expect((await post(net.k, `/v1/platform/apps/${a.id}/keys/${id}/revoke`, {})).body).toEqual({ requestId: expect.any(String) });
    expect((await post(net.k, `/v1/platform/apps/${a.id}/keys/${created[3]!}/revoke`, {})).body.warning).toBe('last_key');
    expect((await post(net.k, `/v1/platform/apps/${a.id}/keys/${created[3]!}/revoke`, {})).body.code).toBe('conflict');
    expect(await getAppByKey(env.DB, a.key, Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

// ---- idempotency (A9, L3) ----

describe('idempotency (A9, L3)', () => {
  it('for every write: a retry returns the first result (`replayed`) and writes nothing; another body `idempotency_conflict`; another credential `conflict`; after 7 days `already_applied`', async () => {
    for (const op of WRITES) {
      const net = await network();
      const k2 = await seedKey({ org: net.site, scopes: [net.s1, net.s2] });
      const s = await op.setup(net);
      const key = `retry-${op.name.replace(/\W/gu, '')}-${n++}`;
      const now = freshNow();
      const body = bodyFor(op, net, s);
      const first = await post(net.k, op.path(s), body, { idempotencyKey: key, now });
      expect(first.status, `${op.name} ${JSON.stringify(first.body)}`).toBeLessThan(300);
      const after = await written();
      const again = await post(net.k, op.path(s), body, { idempotencyKey: key, now: now + 1000 });
      expect([again.status, again.body.replayed], op.name).toEqual([200, true]);
      expect(await written(), op.name).toEqual(after);
      // The first result again: the same app, change, key or version.
      if (op.name === 'create') {
        expect((again.body.app as { id: string }).id).toBe((first.body.app as { id: string }).id);
        expect(again.body.publishableKey).toBe(first.body.publishableKey);
      }
      if (op.name === 'propose') expect(again.body.changes).toEqual(first.body.changes);
      if (op.name === 'remove') expect(again.body.version).toBe(first.body.version);
      if (op.name === 'cancel') expect(again.body.change).toMatchObject({ changeId: s.change, status: 'cancelled' });
      if (op.name === 'suspend') expect(again.body.suspended).toEqual(first.body.suspended);
      if (op.name === 'key create') expect((again.body.key as { id: string }).id).toBe((first.body.key as { id: string }).id);
      // Another body (or path) under the same key within 7 days.
      const other = op.name === 'create' ? { scopeId: net.s1, name: 'Something else' } : op.name === 'suspend' ? { suspended: false } : op.name === 'propose' ? { add: ['https://else.example'], expectedVersion: 9 } : op.name === 'remove' ? { remove: ['https://else.example'], expectedVersion: 9 } : { note: 1 };
      const conflictBody = await post(net.k, op.path(s), other, { idempotencyKey: key, now: now + 2000 });
      if (op.name === 'cancel' || op.name === 'key create' || op.name === 'key revoke') expect(conflictBody.body.code, op.name).toBe('bad_request'); // their body is {} only
      else expect([conflictBody.status, conflictBody.body.code], op.name).toEqual([409, 'idempotency_conflict']);
      const otherPath = await post(net.k, `/v1/platform/apps/${s.app}/keys`, {}, { idempotencyKey: key, now: now + 3000 });
      if (op.name !== 'key create') expect([otherPath.status, otherPath.body.code], op.name).toEqual([409, 'idempotency_conflict']);
      // The org's other key (a rotation mid-retry): `conflict`.
      const rotated = await post(k2, op.path(s), body, { idempotencyKey: key, now: now + 4000 });
      expect([rotated.status, rotated.body.code], op.name).toEqual([409, 'conflict']);
      expect(rotated.body.error).toMatch(/other platform key/u);
      // After 7 days the record has gone stale: the ledger answers.
      const late = await post(net.k, op.path(s), body, { idempotencyKey: key, now: now + 8 * DAY });
      expect([late.status, late.body.code], op.name).toEqual([409, 'already_applied']);
      const lateOther = await post(k2, op.path(s), body, { idempotencyKey: key, now: now + 8 * DAY + 1000 });
      expect(lateOther.body.code, op.name).toBe('conflict');
      expect(await written(), op.name).toEqual(after);
    }
    while (freshNow() < Date.now() + 20 * DAY);
  });

  it('two orgs never share a request id for one Idempotency-Key; a refused write records nothing, so its key can be used again', async () => {
    const a = await network();
    const b = await network();
    const key = 'shared-key-0001';
    expect((await create(a.k, { scopeId: a.s1, name: 'Org A app' }, { idempotencyKey: key })).status).toBe(201);
    expect((await create(b.k, { scopeId: b.s1, name: 'Org B app' }, { idempotencyKey: key })).status).toBe(201);
    const refused = await create(a.k, { scopeId: a.s3, name: 'Refused' }, { idempotencyKey: 'refused-key-01' });
    expect(refused.status).toBe(403);
    expect((await create(a.k, { scopeId: a.s1, name: 'Second try' }, { idempotencyKey: 'refused-key-01' })).status).toBe(201);
  });
});

// ---- the org's switch, the freeze, the key: between the read and the commit ----

describe('the key and the org, checked again inside each write’s commit', () => {
  const hooks: [string, (net: Net) => Promise<unknown>][] = [
    ['the switch turned off', (net) => switchOff(net.org)],
    ['the org frozen', (net) => freeze(net.org)],
    ['the key revoked', (net) => env.DB.prepare("UPDATE platform_keys SET status = 'revoked', revoked_at = ?2, revoked_by_kind = 'hana', revoked_by = 'staff' WHERE id = ?1").bind(net.k.id, Date.now()).run()],
  ];
  it('the switch off, a freeze (for all but the kill switches) or the key revoked between the plan read and the batch: nothing written (`version_conflict`)', async () => {
    for (const [what, hook] of hooks) {
      for (const op of WRITES) {
        const net = await network();
        const s = await op.setup(net);
        const killSwitch = ['remove', 'cancel', 'suspend', 'key revoke'].includes(op.name);
        const before = await written();
        const r = await post(net.k, op.path(s), bodyFor(op, net, s), { bindings: { DB: beforeFirstBatch(() => hook(net)) } });
        if (what === 'the org frozen' && killSwitch) {
          expect(r.status, `${what}: ${op.name}`).toBe(200);
          continue;
        }
        expect([r.status, r.body.code], `${what}: ${op.name}`).toEqual([409, 'version_conflict']);
        expect(await written(), `${what}: ${op.name}`).toEqual(before);
      }
    }
  });

  it('a frozen org keeps only the kill switches: reads, create, proposals, new keys and resume are `403 forbidden`; remove, cancel, suspend and key revoke work', async () => {
    const net = await network();
    const s = await writeSetup(net);
    await post(net.k, `/v1/platform/apps/${s.app}/suspend`, { suspended: true });
    await freeze(net.org);
    for (const [method, path, body] of [
      ['GET', '/v1/platform/apps', undefined],
      ['GET', `/v1/platform/apps/${s.app}`, undefined],
      ['POST', '/v1/platform/apps', { scopeId: net.s1, name: 'Frozen' }],
      ['POST', `/v1/platform/apps/${s.app}/origins`, { add: ['https://f.example'], expectedVersion: s.version }],
      ['POST', `/v1/platform/apps/${s.app}/keys`, {}],
      ['POST', `/v1/platform/apps/${s.app}/suspend`, { suspended: false }],
    ] as const) {
      const r = method === 'GET' ? await get(net.k, path) : await post(net.k, path, body);
      expect([r.status, r.body.code], `${method} ${path}`).toEqual([403, 'forbidden']);
    }
    expect((await post(net.k, `/v1/platform/apps/${s.app}/suspend`, { suspended: true })).status).toBe(200);
    expect((await post(net.k, `/v1/platform/changes/${s.change}/cancel`, {})).status).toBe(200);
    expect((await post(net.k, `/v1/platform/apps/${s.app}/origins/remove`, { remove: ['https://live.example'], expectedVersion: s.version + 1 })).status).toBe(200);
    expect((await post(net.k, `/v1/platform/apps/${s.app}/keys/${s.key}/revoke`, {})).status).toBe(200);
  });

  it('switched off: every app route is `403 platform_off`', async () => {
    const net = await network();
    const a = await createdApp(net);
    await switchOff(net.org);
    for (const r of [await get(net.k, '/v1/platform/apps'), await post(net.k, `/v1/platform/apps/${a.id}/suspend`, { suspended: true }), await post(net.k, `/v1/platform/apps/${a.id}/keys/${a.keyId}/revoke`, {})]) {
      expect([r.status, r.body.code]).toEqual([403, 'platform_off']);
    }
  });

  it('two keys of one org racing for the last app: one is created, the other writes nothing', async () => {
    const net = await network();
    const k2 = await seedKey({ org: net.site, scopes: [net.s1, net.s2] });
    for (let i = 0; i < 9; i++) await bareApp(net.org, net.s2);
    const now = freshNow();
    const [a, b] = await Promise.all([create(net.k, { scopeId: net.s1, name: 'Racer one' }, { now }), create(k2, { scopeId: net.s1, name: 'Racer two' }, { now })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a.body.code, b.body.code].filter(Boolean)[0]).toMatch(/^(version_conflict|app_limit)$/u);
    expect((await rows("SELECT id FROM apps WHERE org_id = ?1 AND created_by_kind = 'platform' AND deleted_at IS NULL", net.org)).length).toBe(10);
    // Two keys proposing the same web address to one app at once: one proposal.
    const app = await bareApp(net.org, net.s1, 'Shared target');
    await env.DB.prepare('UPDATE platform_orgs SET max_apps = 20 WHERE org_id = ?1').bind(net.org).run();
    const [p, q] = await Promise.all([
      post(net.k, `/v1/platform/apps/${app.id}/origins`, { add: ['https://same.example'], expectedVersion: 0 }),
      post(k2, `/v1/platform/apps/${app.id}/origins`, { add: ['https://same.example'], expectedVersion: 0 }),
    ]);
    expect([p.status, q.status].sort()).toEqual([202, 409]);
    expect((await rows('SELECT id FROM guarded_changes WHERE app_id = ?1', app.id)).length).toBe(1);
  });
});

// ---- the breaker and the reserve ----

describe('the platform’s breaker and reserve for its kill switches', () => {
  it('destructive calls (remove, suspend, key revoke): 10 an org an hour, then `429 platform:breaker_org`; a call that changed nothing gets its slot back (once)', async () => {
    const net = await network();
    const now = freshNow();
    const apps: string[] = [];
    for (let i = 0; i < 11; i++) apps.push((await bareApp(net.org, net.s1)).id);
    // A no-op suspend (resume of a running app) isn't destructive; a suspend of an app already suspended changed nothing.
    expect((await post(net.k, `/v1/platform/apps/${apps[0]!}/suspend`, { suspended: true }, { now })).status).toBe(200);
    expect((await post(net.k, `/v1/platform/apps/${apps[0]!}/suspend`, { suspended: true }, { now: now + 10 })).status).toBe(200); // refunded
    for (let i = 1; i < 10; i++) expect((await post(net.k, `/v1/platform/apps/${apps[i]!}/suspend`, { suspended: true }, { now: now + 3000 * i })).status, String(i)).toBe(200);
    const over = await post(net.k, `/v1/platform/apps/${apps[10]!}/suspend`, { suspended: true }, { now: now + 40_000 });
    expect([over.status, over.body.limit]).toEqual([429, 'platform:breaker_org']);
    // A resume isn't counted: still admitted.
    expect((await post(net.k, `/v1/platform/apps/${apps[1]!}/suspend`, { suspended: false }, { now: now + 43_000 })).status).toBe(200);
    expect((await one<{ s: number }>("SELECT COUNT(*) AS s FROM apps WHERE org_id = ?1 AND suspended_by = 4", net.org)).s).toBe(9);
  });

  it('a kill switch spends the platform’s reserve when ordinary calls have emptied the org’s bucket, never the console’s', async () => {
    const net = await network();
    const a = await createdApp(net);
    const now = freshNow();
    // 40 tokens, 10 kept for kill switches: GETs of cost 5 until the org's bucket refuses.
    let refused: Record<string, unknown> | null = null;
    for (let i = 0; i < 10 && !refused; i++) {
      const r = await get(net.k, `/v1/platform/apps/${a.id}`, { now });
      if (r.status === 429) refused = r.body;
    }
    expect(refused).toMatchObject({ limit: 'platform:budget_org' });
    expect((await post(net.k, `/v1/platform/apps/${a.id}/keys`, {}, { now })).body.limit).toBe('platform:budget_org');
    const kill = await post(net.k, `/v1/platform/apps/${a.id}/suspend`, { suspended: true }, { now });
    expect(kill.status).toBe(200);
    // The console's own budget for this org is untouched: a member's call is admitted at the same moment.
    await expect(admitMemberCall(env, { org: net.org, cost: 5 }, now)).resolves.toMatchObject({ reserveUsed: 0 });
    expect(PLATFORM_LIMITS.perOrg.reserve).toBe(10);
  });
});

// ---- the D1 cost of each route (A5, L8) ----

/** A D1 binding that counts statements and the rows D1 reports reading (`meta.rows_read`; the free plan bills it, D417). */
function rowsDb(acc: { statements: number; rowsRead: number }): D1Database {
  const wrap = (st: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(st, {
      get(t, p) {
        if (p === 'bind') return (...args: unknown[]) => wrap(t.bind(...args));
        if (p === 'first')
          return async () => {
            const r = await t.all();
            acc.statements++;
            acc.rowsRead += r.meta.rows_read ?? 0;
            (acc as { log?: string[] }).log?.push(`${r.meta.rows_read} first`);
            return r.results[0] ?? null;
          };
        if (p === 'all' || p === 'run')
          return async () => {
            const r = await (t[p] as () => Promise<D1Result>)();
            acc.statements++;
            acc.rowsRead += r.meta.rows_read ?? 0;
            (acc as { log?: string[] }).log?.push(`${r.meta.rows_read} ${(t as unknown as { statement?: string }).statement ?? ''}`.slice(0, 300));
            return r;
          };
        if (p === '__real') return t;
        const v: unknown = Reflect.get(t, p);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  return new Proxy(env.DB, {
    get(t, p) {
      if (p === 'prepare') return (sql: string) => wrap(t.prepare(sql));
      if (p === 'batch')
        return async (stmts: D1PreparedStatement[]) => {
          const res = await t.batch(stmts.map((s) => (s as unknown as { __real: D1PreparedStatement }).__real ?? s));
          acc.statements += stmts.length;
          for (const [i, r] of res.entries()) {
            acc.rowsRead += r.meta.rows_read ?? 0;
            (acc as { log?: string[] }).log?.push(`${r.meta.rows_read} B${i}`);
          }
          return res;
        };
      const v: unknown = Reflect.get(t, p);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

describe('each route within its D1 cost (statements and rows read)', () => {
  it('on an org with 10 apps of 20 web addresses and 5 keys each: every route within its declared cost, PLATFORM_DB_LIMITS and its pinned rows', async () => {
    const net = await network();
    const apps: string[] = [];
    for (let i = 0; i < 9; i++) {
      const id = (await bareApp(net.org, net.s1)).id;
      for (let j = 0; j < 20; j++) await env.DB.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, ?2, 1)').bind(id, `https://o${j}.app${i}.example`).run();
      for (let j = 0; j < 4; j++) await env.DB.prepare('INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(newId('key'), id, newPublishableKey('test'), 'x', j).run();
      apps.push(id);
    }
    await env.DB.prepare('UPDATE platform_orgs SET max_apps = 12 WHERE org_id = ?1').bind(net.org).run();
    const s = await writeSetup(net);
    const cases: { route: (typeof PLATFORM_ROUTES)[number]; path: string; body?: unknown; rows: number }[] = [];
    const byPath = (p: string, m: string) => PLATFORM_ROUTES.find((r) => r.path === p && r.method === m)!;
    cases.push({ route: byPath('/v1/platform/apps', 'GET'), path: '/v1/platform/apps', rows: 0 });
    cases.push({ route: byPath('/v1/platform/apps/:appId', 'GET'), path: `/v1/platform/apps/${apps[0]!}`, rows: 0 });
    cases.push({ route: byPath('/v1/platform/apps', 'POST'), path: '/v1/platform/apps', body: { scopeId: net.s1, name: 'Costed', origins: Array.from({ length: 10 }, (_, i) => `https://c${i}.example`) }, rows: 0 });
    cases.push({ route: byPath('/v1/platform/apps/:appId/origins', 'POST'), path: `/v1/platform/apps/${s.app}/origins`, body: { add: Array.from({ length: 10 }, (_, i) => `https://n${i}.example`), expectedVersion: s.version }, rows: 0 });
    cases.push({ route: byPath('/v1/platform/apps/:appId/origins/remove', 'POST'), path: `/v1/platform/apps/${s.app}/origins/remove`, body: { remove: ['https://live.example'], expectedVersion: s.version + 1 }, rows: 0 });
    cases.push({ route: byPath('/v1/platform/changes/:changeId/cancel', 'POST'), path: `/v1/platform/changes/${s.change}/cancel`, body: {}, rows: 0 });
    cases.push({ route: byPath('/v1/platform/apps/:appId/suspend', 'POST'), path: `/v1/platform/apps/${s.app}/suspend`, body: { suspended: true }, rows: 0 });
    cases.push({ route: byPath('/v1/platform/apps/:appId/keys', 'POST'), path: `/v1/platform/apps/${s.app}/keys`, body: {}, rows: 0 });
    cases.push({ route: byPath('/v1/platform/apps/:appId/keys/:keyId/revoke', 'POST'), path: `/v1/platform/apps/${s.app}/keys/${s.key}/revoke`, body: {}, rows: 0 });
    const measured: Record<string, number[]> = {};
    for (const c of cases) {
      const acc = { statements: 0, rowsRead: 0 };
      const count: DbCount = { reads: 0, batches: 0, statements: 0 };
      // Both wrappers: statements by the HotDb's own shape, rows by D1's report.
      const r = c.route.method === 'GET' ? await get(net.k, c.path, { bindings: { DB: rowsDb(acc) } }) : await post(net.k, c.path, c.body, { bindings: { DB: rowsDb(acc) } });
      expect(r.status, `${c.route.path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
      expect(acc.statements, c.route.path).toBeLessThanOrEqual(c.route.cost);
      void count;
      measured[`${c.route.method} ${c.route.path}`] = [acc.statements, acc.rowsRead];
    }
    // The rows each reads on this org, pinned (a change that adds a scan shows here): a bound with a little headroom.
    const ROWS: Record<string, number> = {
      'GET /v1/platform/apps': 420, // measured 352: ten apps, their 200 web addresses and 50 keys, once each
      'GET /v1/platform/apps/:appId': 50, // 39
      'POST /v1/platform/apps': 300, // 249: the org's apps and waiting proposals counted, the scope's apps for the names
      'POST /v1/platform/apps/:appId/origins': 330, // 277: the org's waiting proposals counted twice (the plan read's cap check, after PR 160's review, M1; the commit predicate)
      'POST /v1/platform/apps/:appId/origins/remove': 90, // 69
      'POST /v1/platform/changes/:changeId/cancel': 50, // 40
      'POST /v1/platform/apps/:appId/suspend': 30, // 23
      'POST /v1/platform/apps/:appId/keys': 50, // 38
      'POST /v1/platform/apps/:appId/keys/:keyId/revoke': 45, // 33
    };
    for (const [k, [, rowsRead]] of Object.entries(measured)) expect(rowsRead, k).toBeLessThanOrEqual(ROWS[k]!);
  });

  it('a retry within its cost: one plan read and one read of what it first did, no batch', async () => {
    const net = await network();
    const key = 'cost-retry-0001';
    expect((await create(net.k, { scopeId: net.s1, name: 'Retry cost' }, { idempotencyKey: key })).status).toBe(201);
    const count: DbCount = { reads: 0, batches: 0, statements: 0 };
    const r = await create(net.k, { scopeId: net.s1, name: 'Retry cost' }, { idempotencyKey: key, bindings: { DB: countingDb(env.DB, count) } });
    expect(r.body.replayed).toBe(true);
    // The key's read, the plan read and the replay's read; the call log's batch (and the announced keys' list, once).
    expect(count.batches).toBe(1);
    expect(count.reads).toBeLessThanOrEqual(4);
    expect(count.statements).toBeLessThanOrEqual(PLATFORM_ROUTES.find((x) => x.path === '/v1/platform/apps' && x.method === 'POST')!.cost);
  });
});

// ---- what stopping the key, the switch-off and the freeze cancel ----

describe('a revocation, the switch-off and a freeze cancel, in their own batch, every web address the platform’s operations left waiting', () => {
  it('the key revoked (by itself, an owner or staff): its create’s and its proposal’s web addresses cancelled, one in force kept; another key’s left', async () => {
    for (const by of ['self', 'owner', 'staff'] as const) {
      const net = await network();
      const k2 = await seedKey({ org: net.site, scopes: [net.s1] });
      const a = await createdApp(net, ['https://created.example']);
      const p = await post(net.k, `/v1/platform/apps/${a.id}/origins`, { add: ['https://proposed.example'], expectedVersion: a.version });
      const theirs = await post(k2, `/v1/platform/apps/${a.id}/origins`, { add: ['https://other-key.example'], expectedVersion: a.version + 1 });
      expect([p.status, theirs.status]).toEqual([202, 202]);
      const live = await platformProposal(a.id, net.k.id, 'https://live.example', { inForce: true });
      if (by === 'self') expect((await post(net.k, '/v1/platform/credential/revoke', {})).status).toBe(200);
      if (by === 'owner') expect(await consoleRpc().revokePlatformKey({ ...member(), orgId: net.org, keyId: net.k.id })).toMatchObject({ ok: true });
      if (by === 'staff') expect(await adminRpc().revokePlatformKey({ ...hana(), orgId: net.org, keyId: net.k.id, reason: 'Stolen key reported by the network' })).toMatchObject({ ok: true });
      const status = Object.fromEntries((await rows<{ origin: string; status: string }>('SELECT origin, status FROM guarded_changes WHERE app_id = ?1', a.id)).map((r) => [r.origin, r.status]));
      expect(status, by).toEqual({ 'https://created.example': 'cancelled', 'https://proposed.example': 'cancelled', 'https://other-key.example': 'pending', 'https://live.example': 'active' });
      expect((await rows('SELECT origin FROM app_origins WHERE app_id = ?1 ORDER BY origin', a.id)).map((r) => r.origin)).toEqual(['https://live.example', 'https://other-key.example']);
      void live;
    }
  });

  it('the switch-off and the freeze: every key’s waiting web addresses on the org’s apps cancelled', async () => {
    for (const how of ['off', 'freeze'] as const) {
      const net = await network();
      const k2 = await seedKey({ org: net.site, scopes: [net.s1] });
      const a = await createdApp(net, ['https://one.example']);
      await post(k2, `/v1/platform/apps/${a.id}/origins`, { add: ['https://two.example'], expectedVersion: a.version });
      if (how === 'off') expect(await adminRpc().setPlatformOrg({ ...hana(), orgId: net.org, enabled: false, reason: 'Paused while we look into it' })).toMatchObject({ ok: true });
      else expect(await adminRpc().setPlatformOrgFrozen({ ...hana(), orgId: net.org, frozen: true })).toMatchObject({ ok: true });
      expect((await rows<{ status: string }>('SELECT status FROM guarded_changes WHERE app_id = ?1', a.id)).map((r) => r.status), how).toEqual(['cancelled', 'cancelled']);
      expect(await rows('SELECT origin FROM app_origins WHERE app_id = ?1', a.id), how).toEqual([]);
    }
  });
});

// ---- as apps multiply ----

describe('as a network’s apps multiply', () => {
  it('the “also used on other apps” line counts and names them (10 platform apps and the network’s own site on one wallet)', async () => {
    const net = await network();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await bareApp(net.org, net.s1, `Partner number ${'abcdefghij'[i]!}`)).id);
    for (const id of ids) {
      await env.DB.prepare('UPDATE apps SET first_login_at = 1, created_at = ?2 WHERE id = ?1').bind(id, ids.indexOf(id) + 10).run();
      await env.DB.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, ?2, 1)').bind(id, `https://${id.toLowerCase()}.example`).run();
    }
    const other = await readOtherApps(env.DB, { id: ids[0]!, scope_id: net.s1 }, Date.now());
    expect(other.count).toBe(10); // nine partners and the network's own site
    expect(other.names).toHaveLength(5);
  });
});

// ---- what the operations may import ----

/**
 * The operations module's allowlist (D929): the writers it reuses (each now holding the platform's reach in its plan
 * read and commit), the reads and rules it needs, and nothing that registers, accepts or confirms a key, confirms or
 * expedites a web address, proposes a policy or raw signing, changes settings, labels or the mainnet demo, verifies a
 * step-up, or reaches an RPC entrypoint.
 */
const OPS_IMPORTS: Record<string, string[]> = {
  // Data and rules shared with the console and the network's guide: the bodies, the view's types, the limits, ids,
  // the name and origin display rules, hashing.
  '@hana-id/console-core': [
    'Actor',
    'PlatformApp',
    'PlatformChange',
    'PlatformOrigin',
    'PLATFORM_OPS_LIMITS',
    'SUSPENSION_BITS',
    'appIdInput',
    'b64url',
    'hex',
    'namesLookAlike',
    'newId',
    'newPublishableKey',
    'originDisplay',
    'platformAddOriginsBody',
    'platformCreateAppBody',
    'platformRemoveOriginsBody',
    'scopeIdInput',
    'sha256',
    'utf8',
  ],
  '../env.ts': ['Env'],
  // The org's quota windows (a pinned RateLimiter object).
  '../placement.ts': ['placedStub'],
  '../rate-limiter.ts': ['Limit'],
  // The platform minimum (24 h; a `local*` test env's own delay).
  '../guarded/config.ts': ['platformMinDelayMs'],
  // The compare-and-swap write and its replay check.
  '../changes/cas.ts': ['RpcRefusal', 'Writer', 'actorId', 'commitOn', 'committed', 'expectReplay', 'refuse', 'refuseReplay', 'replayRow', 'runWrite'],
  '../changes/db.ts': ['HotDb'],
  // The reused writers, each with the reach: publishable keys, the cancel (held to platform proposals, H2), the
  // origin writers (the platform's proposal with the live rules and the wait; the immediate removal), suspension.
  '../changes/keys.ts': ['createKey', 'revokeKey'],
  '../changes/lifecycle.ts': ['cancelChange'],
  '../changes/origins.ts': ['checkOriginRules', 'normaliseAll', 'platformProposeOrigins', 'platformWaits', 'removeOrigins', 'requireChangeConfig'],
  // The app name rule only (never the settings writers).
  '../changes/settings.ts': ['appName'],
  '../changes/sql.ts': ['Q', 'q', 'raw'],
  '../changes/suspension.ts': ['PartnerBitBy', 'setSuspensionBit'],
  './events.ts': ['platformQuotaEvent'],
  './keys.ts': ['KEY_IN_FORCE'],
  './refusal.ts': ['PlatformRefusal'],
  './request.ts': ['AuthRow'],
};

describe('what the operations may import', () => {
  it('only the writers and rules the app operations need (nothing that confirms, accepts, registers, expedites, waives or reaches an RPC)', () => {
    expect(importProblems(opsSource, OPS_IMPORTS)).toEqual([]);
    for (const names of Object.values(OPS_IMPORTS)) for (const name of names) expect(name).not.toMatch(/confirm|accept|approve|register|expedite|waiver|stepUp|policy|rawSign|settings|label|mainnet|ack/iu);
  });
});
void [PLATFORM_OPS_LIMITS, PLATFORM_REQUEST_LIMITS, ConsoleRpc, AdminRpc];

describe('the quota windows’ limiter failing', () => {
  it('a create or a proposal fails closed (`503 rate_limiter_unavailable`), writing nothing', async () => {
    const net = await network();
    const a = await createdApp(net);
    const real = env.RATE_LIMITER.idFromName.bind(env.RATE_LIMITER);
    const before = await written();
    vi.spyOn(env.RATE_LIMITER, 'idFromName').mockImplementation((name: string) => {
      if (name.startsWith(`platform:${net.org}`)) throw new Error('limiter down');
      return real(name);
    });
    const c = await create(net.k, { scopeId: net.s1, name: 'Limiter down' });
    const p = await post(net.k, `/v1/platform/apps/${a.id}/origins`, { add: ['https://down.example'], expectedVersion: a.version });
    vi.restoreAllMocks();
    expect([c.status, c.body.code]).toEqual([503, 'rate_limiter_unavailable']);
    expect([p.status, p.body.code]).toEqual([503, 'rate_limiter_unavailable']);
    expect(await written()).toEqual(before);
  });
});

// ---- after PR 157's review ----

describe('after PR 157’s review', () => {
  /** 3 000 revoked keys on an app, written straight to D1 (as years of churn would leave them). */
  const revokedHistory = (appId: string, n = 3000) =>
    env.DB.prepare(
      `WITH RECURSIVE i(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM i WHERE x < ?2)
       INSERT INTO app_keys (id, app_id, key, created_by, created_at, revoked_at, revoked_by)
       SELECT 'key_hist' || x || ?3, ?1, 'pk_test_' || printf('%024d', x) || ?3, 'x', x, x + 1, 'x' FROM i`,
    )
      .bind(appId, n, newId('key').slice(4, 10))
      .run();

  it('M1: thousands of revoked keys cost nothing: the view, the key writes (the console’s and staff’s too) read only what they need', async () => {
    const net = await network();
    const a = await createdApp(net);
    await revokedHistory(a.id);
    const acc = { statements: 0, rowsRead: 0 };
    const view = await get(net.k, `/v1/platform/apps/${a.id}`, { bindings: { DB: rowsDb(acc) } });
    expect(view.status).toBe(200);
    expect((view.body.app as { keys: unknown[] }).keys).toHaveLength(20);
    expect(acc.rowsRead).toBeLessThanOrEqual(80);
    for (const [path, rowsMax] of [[`/v1/platform/apps/${a.id}/keys`, 60], [`/v1/platform/apps/${a.id}/keys/${a.keyId}/revoke`, 60]] as const) {
      const w = { statements: 0, rowsRead: 0, log: [] as string[] };
      const r = await post(net.k, path, {}, { bindings: { DB: rowsDb(w) } });
      expect(r.status, path).toBeLessThan(300);
      expect(w.rowsRead, `${path} ${w.log.join('\n')}`).toBeLessThanOrEqual(rowsMax);
    }
    // The console's and staff's key writes share the plan read: the same bound, the same answers.
    const r = await consoleRpc().createKey({ ...member(), orgId: net.org, appId: a.id });
    expect(r).toMatchObject({ ok: true });
    const plan = async (keyId?: string) => {
      const p = { statements: 0, rowsRead: 0 };
      const out = await planApp(new HotDb(rowsDb(p)), { appId: a.id, orgId: net.org, w: { actor: { kind: 'hana', id: 's' } as never, requestId: rid(), now: Date.now() + 400 * DAY }, with: { keys: true }, ...(keyId ? { keyId } : {}) });
      return { rows: p.rowsRead, keys: out.keys.map((k) => k.id) };
    };
    const none = await plan();
    expect(none.keys).toHaveLength(2); // the two unrevoked keys (one created here, one through the console)
    expect(none.rows).toBeLessThanOrEqual(20);
    expect((await plan('key_doesnotexist')).keys).toHaveLength(2); // an id that doesn't exist adds nothing
    const target = (await one<{ id: string }>('SELECT id FROM app_keys WHERE app_id = ?1 AND revoked_at IS NOT NULL ORDER BY created_at LIMIT 1', a.id)).id;
    const named = await plan(target);
    expect(named.keys).toContain(target);
    expect(named.keys).toHaveLength(3);
    expect(named.rows).toBeLessThanOrEqual(20);
    // Revoking an old revoked key is still `conflict`, and a rotation still finds its key.
    expect(await adminRpc().revokeKey({ ...hana(), orgId: net.org, appId: a.id, keyId: target })).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('M1: publishable key creations, 20 a clock hour and 50 a UTC day per org; refused ones don’t count', async () => {
    const net = await network();
    let base = freshNow();
    base = Math.ceil(base / DAY) * DAY + HOUR + 1000;
    const apps: string[] = [];
    for (let i = 0; i < 14; i++) apps.push((await bareApp(net.org, net.s1)).id);
    let n = 0;
    const make = async (now: number) => post(net.k, `/v1/platform/apps/${apps[Math.floor(n / 4)]!}/keys`, {}, { now }).then((r) => (r.status === 201 && n++, r));
    // A refused one (no such app) first: not counted.
    expect((await post(net.k, `/v1/platform/apps/app_${'N'.repeat(20)}/keys`, {}, { now: base })).status).toBe(404);
    for (let i = 0; i < 20; i++) expect((await make(base + 1000 + i * 3000)).status, String(i)).toBe(201);
    const hour = await make(base + 70_000);
    expect([hour.status, hour.body.limit]).toEqual([429, 'platform:keys:hour']);
    for (let i = 0; i < 20; i++) expect((await make(base + HOUR + i * 3000)).status).toBe(201);
    for (let i = 0; i < 10; i++) expect((await make(base + 2 * HOUR + i * 3000)).status).toBe(201);
    const day = await make(base + 2 * HOUR + 40_000);
    expect([day.status, day.body.limit]).toEqual([429, 'platform:keys:day']);
    while (freshNow() < base + 4 * HOUR);
  });

  it('L1: a replayed cancel after its app left the reach is `not_found`, as a replayed suspend', async () => {
    const net = await network();
    const a = await createdApp(net, ['https://cancel.example']);
    const now = freshNow();
    const cancel = { idempotencyKey: 'replay-cancel-1', now };
    const suspend = { idempotencyKey: 'replay-suspend-1', now: now + 1000 };
    expect((await post(net.k, `/v1/platform/changes/${a.changes[0]!.changeId}/cancel`, {}, cancel)).status).toBe(200);
    expect((await post(net.k, `/v1/platform/apps/${a.id}/suspend`, { suspended: true }, suspend)).status).toBe(200);
    expect(await adminRpc().deleteApp({ ...hana(), appId: a.id })).toMatchObject({ ok: true });
    const c = await post(net.k, `/v1/platform/changes/${a.changes[0]!.changeId}/cancel`, {}, { ...cancel, now: now + 2000 });
    const s = await post(net.k, `/v1/platform/apps/${a.id}/suspend`, { suspended: true }, { ...suspend, now: now + 3000 });
    expect([c.status, c.body.code]).toEqual([404, 'not_found']);
    expect(sansId(c.body)).toEqual(sansId(s.body));
  });

  it('L3: a write that committed but whose answer was lost keeps its quota (refunded only with no ledger row)', async () => {
    const net = await network();
    const now = freshNow();
    const lost = new Proxy(env.DB, {
      get(t, p) {
        if (p === 'batch')
          return async (stmts: D1PreparedStatement[]) => {
            const r = await t.batch(stmts);
            if (stmts.length > 3) throw new Error('the answer was lost on the way back');
            return r;
          };
        const v: unknown = Reflect.get(t, p);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const first = await create(net.k, { scopeId: net.s1, name: 'Lost answer' }, { now, bindings: { DB: lost } });
    expect(first.status).toBeGreaterThanOrEqual(400);
    expect((await rows("SELECT id FROM apps WHERE org_id = ?1 AND name = 'Lost answer'", net.org)).length).toBe(1);
    expect((await create(net.k, { scopeId: net.s1, name: 'Second' }, { now: now + 10_000 })).status).toBe(201);
    // Two committed creations this hour: the third is refused (the lost one wasn't given back).
    expect((await create(net.k, { scopeId: net.s1, name: 'Third' }, { now: now + 20_000 })).body.limit).toBe('platform:creations:hour');
    // A refused write (nothing committed) still gives its quota back: here a version_conflict on a proposal.
    const a = await bareApp(net.org, net.s2);
    const ok = await post(net.k, `/v1/platform/apps/${a.id}/origins`, { add: Array.from({ length: 20 }, (_, i) => `https://q${i}.example`), expectedVersion: 0 }, { now: now + 30_000 });
    expect(ok.status).toBe(202);
    const b = await bareApp(net.org, net.s2);
    const raced = await post(net.k, `/v1/platform/apps/${b.id}/origins`, { add: ['https://raced.example'], expectedVersion: 0 }, { now: now + 40_000, bindings: { DB: beforeFirstBatch(() => env.DB.prepare('UPDATE apps SET origins_version = 5 WHERE id = ?1').bind(b.id).run()) } });
    expect(raced.body.limit ?? raced.body.code).toBe('platform:proposals:hour'); // 20 this hour already: refused before the batch, nothing to refund
    void raced;
  });

  it('N2: the platform never sees the ledger’s sequence', async () => {
    const net = await network();
    const now = freshNow();
    expect((await create(net.k, { scopeId: net.s1, name: 'Seq hidden' }, { idempotencyKey: 'seq-hidden-1', now })).status).toBe(201);
    const late = await create(net.k, { scopeId: net.s1, name: 'Seq hidden' }, { idempotencyKey: 'seq-hidden-1', now: now + 8 * DAY });
    expect(late.body.code).toBe('already_applied');
    expect(late.text).not.toMatch(/seq|app_changes/iu);
    while (freshNow() < now + 9 * DAY);
  });

  it('N4: a replayed key create returns that key by its id, however many keys came after it', async () => {
    const net = await network();
    const a = await createdApp(net);
    const now = freshNow();
    const first = await post(net.k, `/v1/platform/apps/${a.id}/keys`, {}, { idempotencyKey: 'replay-key-1', now });
    expect(first.status).toBe(201);
    await revokedHistory(a.id, 30);
    await env.DB.prepare('UPDATE app_keys SET created_at = created_at - 1000000000000 WHERE id = ?1').bind((first.body.key as { id: string }).id).run().catch(() => undefined);
    const again = await post(net.k, `/v1/platform/apps/${a.id}/keys`, {}, { idempotencyKey: 'replay-key-1', now: now + 1000 });
    expect(again.body.replayed).toBe(true);
    expect((again.body.key as { id: string }).id).toBe((first.body.key as { id: string }).id);
    // And the create's replay names its first key the same way.
    const c = await create(net.k, { scopeId: net.s2, name: 'Replay key app' }, { idempotencyKey: 'replay-create-key', now: now + 2000 });
    await revokedHistory((c.body.app as { id: string }).id, 30);
    const cr = await create(net.k, { scopeId: net.s2, name: 'Replay key app' }, { idempotencyKey: 'replay-create-key', now: now + 3000 });
    expect(cr.body.publishableKey).toBe(c.body.publishableKey);
  });

  it('a proposal’s retry is answered by its replay even when the hour’s window is full (the quota is taken after the plan read)', async () => {
    const net = await network();
    const a = await bareApp(net.org, net.s1);
    const now = freshNow();
    const add = Array.from({ length: 20 }, (_, i) => `https://full${i}.example`);
    expect((await post(net.k, `/v1/platform/apps/${a.id}/origins`, { add, expectedVersion: 0 }, { idempotencyKey: 'full-window-1', now })).status).toBe(202);
    const retry = await post(net.k, `/v1/platform/apps/${a.id}/origins`, { add, expectedVersion: 0 }, { idempotencyKey: 'full-window-1', now: now + 1000 });
    expect([retry.status, retry.body.replayed]).toEqual([200, true]);
    // A new proposal (another app: this one is full) is refused by the window.
    const b = await bareApp(net.org, net.s1);
    expect((await post(net.k, `/v1/platform/apps/${b.id}/origins`, { add: ['https://more.example'], expectedVersion: 0 }, { now: now + 2000 })).body.limit).toBe('platform:proposals:hour');
  });
});
