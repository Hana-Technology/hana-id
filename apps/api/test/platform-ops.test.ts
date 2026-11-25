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
import { HotDb } from '../src/changes/db.ts';
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
    const changes = await rows<Record<string, unknown>>('SELECT kind, status, proposed_by_kind, proposed_by, proposer_sub, waiver, notified_at, active_from, min_delay_ms, unconfirmed_active_from FROM guarded_changes WHERE app_id = ?1 ORDER BY origin', app.id);
    expect(changes).toEqual(Array(2).fill({ kind: 'origin_add', status: 'pending', proposed_by_kind: 'platform', proposed_by: net.k.id, proposer_sub: null, waiver: null, notified_at: null, active_from: null, min_delay_ms: DAY, unconfirmed_active_from: null }));
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
      expect(r.body.error, name).toContain('Acme Swap');
    }
    // The network's own (staff-created) site counts too.
    const siteName = (await one<{ name: string }>('SELECT name FROM apps WHERE id = ?1', net.site.id)).name;
    expect((await create(net.k, { scopeId: net.s1, name: siteName.toUpperCase() })).body.code).toBe('conflict');
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
    const at = (h: number, s = 0) => base + h * HOUR + s * 1000;
    expect((await create(net.k, { scopeId: net.s3, name: 'Refused' }, { now: at(0) })).status).toBe(403);
    expect((await create(net.k, { scopeId: net.s1, name: 'A1' }, { now: at(0, 1) })).status).toBe(201);
    expect((await create(net.k, { scopeId: net.s1, name: 'A2' }, { now: at(0, 2) })).status).toBe(201);
    const third = await create(net.k, { scopeId: net.s1, name: 'A3' }, { now: at(0, 3) });
    expect([third.status, third.body.code, third.body.limit]).toEqual([429, 'rate_limited', 'platform:creations:hour']);
    expect(third.headers.find(([h]) => h === 'retry-after')?.[1]).toMatch(/^\d+$/u);
    expect((await create(net.k, { scopeId: net.s1, name: 'A4' }, { now: at(0, 4) })).status).toBe(429);
    expect((await rows("SELECT id FROM security_events WHERE kind = 'platform_quota' AND org_id = ?1", net.org)).length).toBe(1);
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
    const g = await one<{ notified_at: number; active_from: number; unconfirmed_active_from: number; waiver: string | null }>('SELECT notified_at, active_from, unconfirmed_active_from, waiver FROM guarded_changes WHERE id = ?1', change);
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
    const early = /no earlier than its wait|announced once|in force only once|never comes back|never deleted|never replaced|takes no waiver|are fixed/u;
    const attempts: [string, string, unknown[]][] = [
      ['the change in force now', 'UPDATE guarded_changes SET active_from = ?2 WHERE id = ?1', [c1, t]],
      ['the earliest time moved', 'UPDATE guarded_changes SET unconfirmed_active_from = ?2, active_from = ?2 WHERE id = ?1', [c1, t]],
      ['the gate’s row in force now', 'UPDATE app_origins SET active_from = ?2 WHERE change_id = ?1', [c1, t]],
      ['the gate’s row unlinked and in force', 'UPDATE app_origins SET change_id = NULL, active_from = ?2 WHERE change_id = ?1', [c1, t]],
      ['the gate’s row replaced', "INSERT OR REPLACE INTO app_origins (app_id, origin, active_from) VALUES (?1, 'https://partner.example', ?2)", [a.id, t]],
      ['the gate’s row deleted and inserted again', "INSERT INTO app_origins (app_id, origin, active_from) SELECT ?1, 'https://partner.example', ?2 WHERE (SELECT changes() FROM (SELECT 1)) >= 0", [a.id, t]],
      ['recorded in force early', "UPDATE guarded_changes SET status = 'active' WHERE id = ?1", [c1]],
      ['a waiver', "UPDATE guarded_changes SET waiver = 'no_session' WHERE id = ?1", [c1]],
      ['an expedite', "UPDATE guarded_changes SET expedited_by = 'staff', expedite_reason = 'x' WHERE id = ?1", [c1]],
      ['announced again, back-dated', 'UPDATE guarded_changes SET notified_at = ?2 WHERE id = ?1', [c1, t - DAY]],
      ['the unannounced one announced back-dated', 'UPDATE guarded_changes SET notified_at = ?2, unconfirmed_active_from = ?3, active_from = ?3 WHERE id = ?1', [c2, t - 2 * DAY, t - DAY]],
      ['the unannounced one announced with a short wait', 'UPDATE guarded_changes SET notified_at = ?2, unconfirmed_active_from = ?3, active_from = ?3 WHERE id = ?1', [c2, t, t + 60_000]],
      ['its wait shortened first', 'UPDATE guarded_changes SET min_delay_ms = 60000 WHERE id = ?1', [c2]],
      ['made a staff proposal', "UPDATE guarded_changes SET proposed_by_kind = 'hana' WHERE id = ?1", [c1]],
      ['deleted (to insert it again)', 'DELETE FROM guarded_changes WHERE id = ?1', [c1]],
      ['replaced by id', "INSERT OR REPLACE INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES (?1, ?2, 'origin_add', 'https://partner.example', 'active', 'hana', 's', 1, 'r_x')", [c1, a.id]],
      ['another row moved onto its id', "UPDATE OR REPLACE guarded_changes SET id = ?1 WHERE id = ?2", [c1, c2]],
    ];
    for (const [what, sql, args] of attempts) expect(await refusal(sql, ...args), what).toMatch(early);
    // The deleted-and-inserted-again case, done for real: the delete itself is refused, so the insert meets the waiting proposal.
    expect(await refusal('DELETE FROM app_origins WHERE change_id = ?1', c1)).toBe('accepted');
    expect(await refusal("INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, 'https://partner.example', ?2)", a.id, t)).toMatch(early);
    // A cancelled one never comes back.
    expect((await post(net.k, `/v1/platform/changes/${c2}/cancel`, {})).status).toBe(200);
    expect(await refusal("UPDATE guarded_changes SET status = 'pending', cancelled_at = NULL, cancelled_by = NULL WHERE id = ?1", c2)).toMatch(/never comes back/u);
    expect((await one<{ active_from: number }>('SELECT active_from FROM guarded_changes WHERE id = ?1', c1)).active_from).toBeGreaterThanOrEqual(t + DAY - 120_000);
  });

  it('in a `local*` test env the platform minimum gives way to the env’s own delay; a member’s proposal keeps the env’s delay everywhere', async () => {
    const net = await network();
    const a = await createdApp(net, ['https://partner.example']);
    const local = { ...env, ENV_NAME: 'local-test', NETWORK: 'testnet' } as typeof env;
    await ackNotice(new HotDb(env.DB), local, { actor: { kind: 'system', id: 'admin-cron' }, requestId: rid(), now: Date.now() }, { changeId: a.changes[0]!.changeId, cancelTokenHash: await linkToken().hash });
    const g = await one<{ notified_at: number; active_from: number; min_delay_ms: number }>('SELECT notified_at, active_from, min_delay_ms FROM guarded_changes WHERE id = ?1', a.changes[0]!.changeId);
    // Proposed on this dev env (24 h recorded), announced in a local one: the recorded wait still holds.
    expect(g.active_from - g.notified_at).toBe(DAY);
    // Proposed in a local env: its wait is the env's delay (60 s here).
    const before = (await one<{ v: number }>('SELECT origins_version AS v FROM apps WHERE id = ?1', a.id)).v;
    const p = await post(net.k, `/v1/platform/apps/${a.id}/origins`, { add: ['https://local.example'], expectedVersion: before }, { envName: 'local-test', bindings: { ENV_NAME: 'local-test', NETWORK: 'testnet' } as Partial<typeof env> });
    expect(p.status, JSON.stringify(p.body)).toBe(202);
    const lc = (p.body.changes as { changeId: string }[])[0]!.changeId;
    expect((await one<{ min_delay_ms: number }>('SELECT min_delay_ms FROM guarded_changes WHERE id = ?1', lc)).min_delay_ms).toBe(60_000);
    await ackNotice(new HotDb(env.DB), local, { actor: { kind: 'system', id: 'admin-cron' }, requestId: rid(), now: Date.now() }, { changeId: lc, cancelTokenHash: await linkToken().hash });
    const l = await one<{ notified_at: number; active_from: number }>('SELECT notified_at, active_from FROM guarded_changes WHERE id = ?1', lc);
    expect(l.active_from - l.notified_at).toBe(60_000);
    // A member's proposal: the env's delay, as before (no earliest time recorded).
    const m = await memberProposal(net.site, { kind: 'origin_add', origin: 'https://member.example' });
    await adminRpc().ackNotice({ ...system(), changeId: m, cancelTokenHash: await linkToken().hash });
    const mg = await one<{ notified_at: number; active_from: number; unconfirmed_active_from: number | null }>('SELECT notified_at, active_from, unconfirmed_active_from FROM guarded_changes WHERE id = ?1', m);
    expect(mg.unconfirmed_active_from).toBeNull();
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
    expect(await rows('SELECT proposed_by_kind, proposed_by, min_delay_ms, status FROM guarded_changes WHERE app_id = ?1', a.id)).toEqual(Array(2).fill({ proposed_by_kind: 'platform', proposed_by: net.k.id, min_delay_ms: DAY, status: 'pending' }));
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
    expect((await add(a.id, va++, 15, 0, base + 1000)).status).toBe(202);
    expect((await add(a.id, va, 5, 100, base + 2000)).status).toBe(202);
    va++;
    const over = await add(b.id, vb, 1, 200, base + 3000);
    expect([over.status, over.body.limit]).toEqual([429, 'platform:proposals:hour']);
    expect((await add(b.id, vb++, 10, 300, base + HOUR)).status).toBe(202);
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
