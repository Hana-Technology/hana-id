// D931 (piece P10 of docs/partner-platform-spec.md, A15; D914, D917): a second person's confirmation of web addresses
// that wait at least 24 h. Through ConsoleRpc and AdminRpc with real step-up tokens and a mock chain:
// - who: a member actor only for ConsoleRpc (staff, the system, a link refused; the platform can't even be named), an
//   on-chain owner of the app's scope (checked by the API, uncached), the token's `sub` the member's own, fresh;
// - the token: bound to exactly this set, app, org, scope and env, of its own kind (an origin-add or a key-confirm
//   token refused), single use; a refusal leaves it unused;
// - the set: one app, one proposing request, 1 to 20, all or nothing; another org's or another app's change answers
//   exactly as one that doesn't exist;
// - the state: announced, waiting, not confirmed, not cancelled; the key in force, the switch on, the org not frozen,
//   the app not deleted nor suspended by Journear; each moving between the plan read and the batch writes nothing;
// - staff proposals on a shared wallet (four eyes): their wait written, no waiver, the proposer never the confirmer
//   (by Access subject or email), a second staffer or an owner yes;
// - the records: one `origin.confirmed` ledger row with the member and the step-up's `sub`; the confirmation rows;
//   `confirmedAt` in the platform's view and the console's; the notice and its ack; the removal link; the queue;
// - the limits and the cost.
import { CONSOLE_ERROR_STATUS, ORIGIN_CONFIRM_LIMITS, ORIGIN_REMOVAL_LINK_MS, newId, newPublishableKey, nonceOf, originChangeDigest, originConfirmDigest, personEmailKey, platformKeyDigest } from '@hana-id/console-core';
import { sha256Hex } from '../src/owner-actions.ts';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearJwksCache } from '@hana-id/oidc';
import { HotDb } from '../src/changes/db.ts';
import { NOT_VISIBLE } from '../src/changes/confirm.ts';
import { ackNotice } from '../src/changes/lifecycle.ts';
import { placedStub } from '../src/placement.ts';
import { TOKEN_LIMITER } from '../src/changes/step-up.ts';
import { AdminRpc } from '../src/rpc/admin.ts';
import { CONSOLE_COSTS, ConsoleRpc } from '../src/rpc/console.ts';
import { clearViewCaches } from '../src/views.ts';
import { freeze, freshNow, seedKey, send, switchOff } from './platform-helpers.ts';
import { type DbCount, STEP_UP_SUB, countingDb, hana, link, linkToken, member, memberProposal, orgApp, ownClock, ownerChain, rid, rows, stepUp, system } from './rpc-helpers.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
type Env = typeof env;
let clock: ReturnType<typeof ownClock>;
beforeEach(() => {
  clock = ownClock({ freeze: true });
  clearJwksCache();
  clearViewCaches();
  ownerChain({ owners: [STEP_UP_SUB, 'owner-sub-2'] });
});
afterEach(() => vi.restoreAllMocks());

/** ConsoleRpc over `e`; each call first moves the clock 2 s on (a person clicking), so the org's budget refills. */
const consoleOn = (e: Partial<Env> = {}): ConsoleRpc => {
  const rpc = new ConsoleRpc(createExecutionContext(), { ...env, ...e } as Env);
  return new Proxy(rpc, {
    get(t, p) {
      const v: unknown = Reflect.get(t, p);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        clock.advance(2000);
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
};
const adminOn = (e: Partial<Env> = {}) => new AdminRpc(createExecutionContext(), { ...env, ...e } as Env);
async function ok<T>(p: Promise<T>): Promise<Extract<T, { ok: true }>> {
  const r = await p;
  if (!(r as { ok: boolean }).ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}
async function no<T>(p: Promise<T>): Promise<{ code: string; error?: string }> {
  const r = (await p) as { ok: boolean; code?: string; error?: string };
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
  return r as { code: string; error?: string };
}
const one = async <T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T> => (await rows<T>(sql, ...args))[0]!;
const dbNow = async (): Promise<number> => (await one<{ t: number }>("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS t")).t;

/** A network: an org whose test scope is marked as shared, with its platform key in force and its switch on. */
async function network() {
  const site = await orgApp({ contacts: ['security@partner.example'] });
  await env.DB.prepare('UPDATE scopes SET app_user_ids = 1 WHERE scope_id = ?1').bind(site.scope).run();
  const k = await seedKey({ org: site, scopes: [site.scope] });
  return { k, org: site.org, scope: site.scope, site };
}
type Net = Awaited<ReturnType<typeof network>>;

/** A platform-created app on the network's scope (as a create leaves it, less its ledger row). */
async function platformApp(net: Net, name = `Partner ${newId('app').slice(4, 10)}`): Promise<string> {
  const id = newId('app');
  const key = newPublishableKey('test');
  await env.DB.prepare(
    "INSERT INTO apps (id, name, scope_id, org_id, publishable_key, status, plan, created_at, origins_version, user_ids, created_by_kind) VALUES (?1, ?2, ?3, ?4, ?5, 'active', 'free', ?6, 0, 'app', 'platform')",
  )
    .bind(id, name, net.scope, net.org, key, Date.now())
    .run();
  await env.DB.prepare('INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(newId('key'), id, key, net.k.id, Date.now()).run();
  return id;
}

/** `n` web addresses the platform proposed in one request on `appId`, announced now (unless told not) with a day's wait. */
async function proposed(net: Net, appId: string, n = 2, o: { announce?: boolean; request?: string } = {}) {
  const request = o.request ?? `pf_${newId('guardedChange').slice(3)}`;
  const changes: { changeId: string; origin: string }[] = [];
  for (let k = 0; k < n; k++) {
    const id = newId('guardedChange');
    const origin = `https://p${k}-${id.slice(3, 9).toLowerCase()}.example`;
    await env.DB.prepare('INSERT INTO platform_origin_waits (change_id, app_id, origin, key_id, min_delay_ms, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(id, appId, origin, net.k.id, DAY, Date.now()).run();
    await env.DB.prepare("INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES (?1, ?2, 'origin_add', ?3, 'pending', 'platform', ?4, ?5, ?6)")
      .bind(id, appId, origin, net.k.id, Date.now(), request)
      .run();
    await env.DB.prepare('INSERT INTO app_origins (app_id, origin, active_from, change_id) VALUES (?1, ?2, NULL, ?3)').bind(appId, origin, id).run();
    if (o.announce !== false) {
      // The test's clock (ownClock runs it hours ahead of the database's): every 0033 and 0034 clock rule is a lower bound.
      const t = Math.max(Date.now(), await dbNow());
      await env.DB.prepare('UPDATE platform_origin_waits SET unconfirmed_active_from = ?2 WHERE change_id = ?1').bind(id, t + DAY).run();
      await env.DB.prepare('UPDATE guarded_changes SET notified_at = ?2, active_from = ?3 WHERE id = ?1').bind(id, t, t + DAY).run();
      await env.DB.prepare('UPDATE app_origins SET active_from = ?2 WHERE change_id = ?1').bind(id, t + DAY).run();
    }
    changes.push({ changeId: id, origin });
  }
  return { request, changes: changes.sort((a, b) => (a.changeId < b.changeId ? -1 : 1)) };
}

/** The step-up token for exactly this set (or `over`), from `sub`. */
async function tokenFor(net: Net, appId: string, changes: { changeId: string; origin: string }[], o: { sub?: string; over?: Partial<Parameters<typeof originConfirmDigest>[0]>; claims?: Record<string, unknown> } = {}) {
  const d = await originConfirmDigest({ signer: env.SIGNER_ACCOUNT, env: env.ENV_NAME, orgId: net.org, appId, scopeId: net.scope, changes, ...o.over });
  return stepUp(nonceOf(d), { sub: o.sub ?? STEP_UP_SUB, ...o.claims });
}

/** An owner's confirmation call (the actor: `who`, default a fresh member with STEP_UP_SUB). */
async function confirm(net: Net, appId: string, changes: { changeId: string; origin: string }[], o: { who?: ReturnType<typeof member>; jwt?: string; rpc?: ConsoleRpc; ids?: string[] } = {}) {
  const who = o.who ?? member();
  const jwt = o.jwt ?? (await tokenFor(net, appId, changes, { sub: who.actor.sub }));
  return (o.rpc ?? consoleOn()).confirmOrigins({ ...who, orgId: net.org, appId, changeIds: o.ids ?? changes.map((c) => c.changeId), stepUpJwt: jwt });
}

const stateOf = async (appId: string) => ({
  changes: await rows('SELECT id, status, active_from FROM guarded_changes WHERE app_id = ?1 ORDER BY id', appId),
  origins: await rows('SELECT origin, active_from FROM app_origins WHERE app_id = ?1 ORDER BY origin', appId),
  confirmations: await rows('SELECT change_id FROM origin_confirmations WHERE app_id = ?1 ORDER BY change_id', appId),
  ledger: await rows("SELECT request_id FROM app_changes WHERE app_id = ?1 AND kind = 'origin.confirmed'", appId),
});

describe('an owner confirms web addresses the platform asked for', () => {
  it('in force at once: the changes and their gate rows; one ledger row with the member and the step-up’s sub; the confirmation rows with the token’s hash, never the token', async () => {
    const net = await network();
    const app = await platformApp(net);
    const set = await proposed(net, app, 2);
    const who = member();
    const jwt = await tokenFor(net, app, set.changes);
    const r = await ok(confirm(net, app, set.changes, { who, jwt }));
    expect(r.confirmedAt).toBe(Date.now());
    const at = r.confirmedAt;
    for (const c of set.changes) {
      expect(await one('SELECT active_from FROM guarded_changes WHERE id = ?1', c.changeId)).toEqual({ active_from: at });
      expect(await one('SELECT active_from FROM app_origins WHERE change_id = ?1', c.changeId)).toEqual({ active_from: at });
    }
    const led = await rows<{ actor_kind: string; actor_id: string; actor_sub: string; detail_json: string; request_id: string }>("SELECT actor_kind, actor_id, actor_sub, detail_json, request_id FROM app_changes WHERE app_id = ?1 AND kind = 'origin.confirmed'", app);
    expect(led).toHaveLength(1);
    expect(led[0]).toMatchObject({ actor_kind: 'member', actor_id: who.actor.id, actor_sub: STEP_UP_SUB, request_id: who.requestId });
    expect(JSON.parse(led[0]!.detail_json)).toEqual({ changes: set.changes, proposalRequestId: set.request, proposedBy: 'platform', keyId: net.k.id });
    const oc = await rows<Record<string, unknown>>('SELECT * FROM origin_confirmations WHERE app_id = ?1 ORDER BY change_id', app);
    expect(oc.map((x) => x.change_id)).toEqual(set.changes.map((c) => c.changeId));
    for (const x of oc) {
      expect(x).toMatchObject({ confirmed_by_kind: 'member', confirmed_by: who.actor.id, confirmed_sub: STEP_UP_SUB, confirmed_email_key: personEmailKey(who.actor.email), token_sha256: await sha256Hex(jwt), request_id: who.requestId, proposal_request_id: set.request, notice_at: null });
      expect(JSON.stringify(x)).not.toContain(jwt.split('.')[2]!);
    }
    // The console's app view and the platform's view show it (never who, to the platform).
    const detail = await ok(consoleOn().getApp({ ...member(), orgId: net.org, appId: app }));
    const view = detail.app.changes.filter((c) => c.kind === 'origin_add');
    expect(view.every((c) => c.confirmedAt === at && c.confirmedByKind === 'member' && c.requestId === set.request)).toBe(true);
    const pv = await send(net.k, { path: `/v1/platform/apps/${app}`, now: freshNow() });
    expect(pv.status).toBe(200);
    const origins = (pv.body.app as { origins: { changeId: string; confirmedAt: number | null; activeFrom: number }[] }).origins;
    for (const o of origins) expect(o).toMatchObject({ confirmedAt: at, activeFrom: at });
    expect(JSON.stringify(pv.body)).not.toContain(who.actor.id);
  });

  it('the token: another set, app, org, scope or env, another kind, another person, too old or used: refused, nothing written, and a refusal never uses it up', async () => {
    const net = await network();
    const app = await platformApp(net);
    const set = await proposed(net, app, 2);
    const other = await platformApp(net);
    const before = await stateOf(app);
    const bad: [string, Promise<string>][] = [
      ['one of the two', tokenFor(net, app, set.changes.slice(0, 1))],
      ['another origin', tokenFor(net, app, [set.changes[0]!, { ...set.changes[1]!, origin: 'https://other.example' }])],
      ['another app', tokenFor(net, app, set.changes, { over: { appId: other } })],
      ['another org', tokenFor(net, app, set.changes, { over: { orgId: 'org_Otherorgother' } })],
      ['another scope', tokenFor(net, app, set.changes, { over: { scopeId: 's999' } })],
      ['another env', tokenFor(net, app, set.changes, { over: { env: 'sandbox-other' } })],
      ['an origin-add token', originChangeDigest({ signer: env.SIGNER_ACCOUNT, appId: app, add: set.changes.map((c) => c.origin).sort(), remove: [], originsVersion: 0 }).then((d) => stepUp(nonceOf(d)))],
      [
        'a key-confirm token',
        platformKeyDigest({ kind: 'confirm', signer: env.SIGNER_ACCOUNT, env: env.ENV_NAME, orgId: net.org, keyId: net.k.id, thumbprint: net.k.thumbprint, scopes: [net.scope], label: 'Backend key' }).then((d) => stepUp(nonceOf(d))),
      ],
      ['another person’s', tokenFor(net, app, set.changes, { sub: 'owner-sub-2' })],
      ['too old', tokenFor(net, app, set.changes, { claims: { iat: Math.floor(Date.now() / 1000) - 301 } })],
      ['with an email claim', tokenFor(net, app, set.changes, { claims: { email: 'owner@partner.example' } })],
    ];
    for (const [what, jwt] of bad) {
      const r = await no(confirm(net, app, set.changes, { jwt: await jwt }));
      expect(r.code, what).toBe('forbidden');
    }
    expect(await stateOf(app)).toEqual(before);
    // A refused attempt (not an on-chain owner) leaves the token unused; the same token then works for its owner.
    const jwt = await tokenFor(net, app, set.changes);
    ownerChain({ owners: ['owner-sub-2'] });
    expect((await no(confirm(net, app, set.changes, { jwt }))).code).toBe('not_owner');
    expect(await stateOf(app)).toEqual(before);
    ownerChain({ owners: [STEP_UP_SUB] });
    await ok(confirm(net, app, set.changes, { jwt }));
    // A used token: reserved already (anywhere: the owner-actions limiter is shared) is `token_used`.
    const set2 = await proposed(net, app, 1);
    const jwt2 = await tokenFor(net, app, set2.changes);
    await placedStub(env, env.RATE_LIMITER, TOKEN_LIMITER).reserve(await sha256Hex(jwt2), Date.now() + HOUR);
    expect((await no(confirm(net, app, set2.changes, { jwt: jwt2 }))).code).toBe('token_used');
    expect(await one('SELECT COUNT(*) AS n FROM origin_confirmations WHERE change_id = ?1', set2.changes[0]!.changeId)).toEqual({ n: 0 });
  });

  it('who: a member actor only (staff, the system and a link refused; a platform actor can’t be named); the member’s own token', async () => {
    const net = await network();
    const app = await platformApp(net);
    const set = await proposed(net, app, 1);
    const jwt = await tokenFor(net, app, set.changes);
    const base = { orgId: net.org, appId: app, changeIds: [set.changes[0]!.changeId], stepUpJwt: jwt };
    for (const actor of [hana(), system(), link(set.changes[0]!.changeId)]) expect((await no(consoleOn().confirmOrigins({ ...actor, ...base }))).code).toBe('forbidden');
    expect((await no(consoleOn().confirmOrigins({ actor: { kind: 'platform', id: net.k.id }, requestId: rid(), clientIp: '203.0.113.7', ...base }))).code).toBe('bad_request');
    // A member whose session sub isn't the token's.
    expect((await no(consoleOn().confirmOrigins({ ...member('owner-sub-2'), ...base }))).code).toBe('forbidden');
    expect(await one('SELECT COUNT(*) AS n FROM origin_confirmations WHERE app_id = ?1', app)).toEqual({ n: 0 });
  });

  it('the set: one request, one app, 1 to 20, no repeats; another app’s or another org’s change answers exactly as one that doesn’t exist', async () => {
    const net = await network();
    const app = await platformApp(net);
    const a = await proposed(net, app, 1);
    const b = await proposed(net, app, 1);
    const mixed = [...a.changes, ...b.changes];
    expect((await no(confirm(net, app, mixed))).code).toBe('bad_request');
    expect((await no(confirm(net, app, a.changes, { ids: Array.from({ length: 21 }, () => newId('guardedChange')) }))).code).toBe('bad_request');
    expect((await no(confirm(net, app, a.changes, { ids: [a.changes[0]!.changeId, a.changes[0]!.changeId] }))).code).toBe('bad_request');
    // Invisible: one answer, word for word.
    const otherApp = await platformApp(net);
    const onOther = await proposed(net, otherApp, 1);
    const net2 = await network();
    const app2 = await platformApp(net2);
    const foreign = await proposed(net2, app2, 1);
    const answers = [
      await no(confirm(net, app, [{ changeId: newId('guardedChange'), origin: 'https://none.example' }])),
      await no(confirm(net, app, onOther.changes)),
      await no(confirm(net, app, foreign.changes)),
      await no(confirm(net, app2, foreign.changes)),
      await no(confirm({ ...net, org: net2.org } as Net, app, a.changes)),
    ];
    for (const x of answers) expect(x).toEqual({ ok: false, code: 'not_found', error: NOT_VISIBLE });
    expect(await one('SELECT COUNT(*) AS n FROM origin_confirmations WHERE app_id IN (?1, ?2, ?3)', app, otherApp, app2)).toEqual({ n: 0 });
  });

  it('the state: before its email, after a cancel, once in force, twice; a member’s proposal and a plain staff one never', async () => {
    const net = await network();
    const app = await platformApp(net);
    const quiet = await proposed(net, app, 1, { announce: false });
    expect((await no(confirm(net, app, quiet.changes))).error).toMatch(/email hasn’t gone out/u);
    const cancelled = await proposed(net, app, 1);
    await ok(consoleOn().cancelChange({ ...member(), orgId: net.org, changeId: cancelled.changes[0]!.changeId }));
    expect((await no(confirm(net, app, cancelled.changes))).code).toBe('not_pending');
    const twice = await proposed(net, app, 1);
    await ok(confirm(net, app, twice.changes));
    expect((await no(confirm(net, app, twice.changes))).code).toBe('not_pending');
    // A member's proposal and a staff one on a plain scope: visible, not confirmable.
    const plain = await orgApp({ org: net.org });
    const m = await memberProposal(plain, { kind: 'origin_add', origin: 'https://member.example' });
    const s = await ok(adminOn().addOrigins({ ...hana(), orgId: net.org, appId: plain.id, add: ['https://staff.example'], expectedVersion: 0 }));
    for (const id of [m, s.changes[0]!.id]) {
      const origin = id === m ? 'https://member.example' : 'https://staff.example';
      const r = await no(consoleOn().confirmOrigins({ ...member(), orgId: net.org, appId: plain.id, changeIds: [id], stepUpJwt: await stepUp(nonceOf(await originConfirmDigest({ signer: env.SIGNER_ACCOUNT, env: env.ENV_NAME, orgId: net.org, appId: plain.id, scopeId: plain.scope, changes: [{ changeId: id, origin }] }))) }));
      expect(r.code).toBe('not_pending');
    }
  });

  it('the key revoked, the switch off, the org frozen, the app suspended by Journear or deleted: refused before; between the plan read and the batch, nothing written', async () => {
    const cases: [string, (net: Net, app: string) => Promise<unknown>, string][] = [
      ['the key revoked', (net) => ok(adminOn().revokePlatformKey({ ...hana(), orgId: net.org, keyId: net.k.id, reason: 'test' })), 'not_pending|conflict'],
      ['the switch off', (net) => switchOff(net.org), 'conflict'],
      ['the org frozen', (net) => freeze(net.org), 'forbidden'],
      ['suspended by Journear', (_n, app) => env.DB.prepare('UPDATE apps SET suspended_by = 1 WHERE id = ?1').bind(app).run(), 'conflict'],
      ['deleted', (_n, app) => env.DB.prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind(app, Date.now()).run(), 'not_found'],
    ];
    for (const [what, act, code] of cases) {
      // Before the call.
      const net = await network();
      const app = await platformApp(net);
      const set = await proposed(net, app, 1);
      await act(net, app);
      expect((await no(confirm(net, app, set.changes))).code, what).toMatch(new RegExp(`^(${code})$`, 'u'));
      expect(await one('SELECT COUNT(*) AS n FROM origin_confirmations WHERE app_id = ?1', app), what).toEqual({ n: 0 });
      // Between the plan read and the batch.
      const net2 = await network();
      const app2 = await platformApp(net2);
      const set2 = await proposed(net2, app2, 1);
      const before = await stateOf(app2);
      let done = false;
      const db = new Proxy(env.DB, {
        get(t, p) {
          if (p === 'batch')
            return async (stmts: D1PreparedStatement[]) => {
              if (!done) {
                done = true;
                await act(net2, app2);
              }
              return t.batch(stmts);
            };
          const v: unknown = Reflect.get(t, p);
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
      const r = await no(confirm(net2, app2, set2.changes, { rpc: consoleOn({ DB: db }) }));
      expect(r.code, what).toBe('version_conflict');
      const after = await stateOf(app2);
      expect(after.confirmations, what).toEqual([]);
      expect(after.ledger, what).toEqual([]);
      // The revocation's own batch cancelled the waiting web address: nothing came into force.
      for (const c of after.changes as { active_from: number | null }[]) expect(c.active_from === null || c.active_from > Date.now(), what).toBe(true);
      if (what !== 'the key revoked') expect(after.origins, what).toEqual(before.origins);
    }
  });

  it('a cancel and a confirmation racing: whichever lands first wins, each order', async () => {
    const net = await network();
    const app = await platformApp(net);
    // The cancel first (between the confirmation's plan read and its batch): the confirmation writes nothing.
    const a = await proposed(net, app, 1);
    let done = false;
    const db = new Proxy(env.DB, {
      get(t, p) {
        if (p === 'batch')
          return async (stmts: D1PreparedStatement[]) => {
            if (!done) {
              done = true;
              await ok(consoleOn().cancelChange({ ...member(), orgId: net.org, changeId: a.changes[0]!.changeId }));
            }
            return t.batch(stmts);
          };
        const v: unknown = Reflect.get(t, p);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    expect((await no(confirm(net, app, a.changes, { rpc: consoleOn({ DB: db }) }))).code).toBe('version_conflict');
    expect(await one('SELECT status FROM guarded_changes WHERE id = ?1', a.changes[0]!.changeId)).toEqual({ status: 'cancelled' });
    // The confirmation first: the cancel finds it in force.
    const b = await proposed(net, app, 1);
    await ok(confirm(net, app, b.changes));
    expect((await no(consoleOn().cancelChange({ ...member(), orgId: net.org, changeId: b.changes[0]!.changeId }))).code).toBe('not_pending');
  });

  it('limits: a member’s confirmations in an hour, then the org’s; each attempt counts', async () => {
    const net = await network();
    const app = await platformApp(net);
    const set = await proposed(net, app, 1);
    const who = member();
    for (let k = 0; k < ORIGIN_CONFIRM_LIMITS.memberPerHour; k++) await no(confirm(net, app, set.changes, { who: { ...who, requestId: rid() }, jwt: 'a.b.c' }));
    expect((await no(confirm(net, app, set.changes, { who: { ...who, requestId: rid() } }))).code).toBe('rate_limited');
    // Another member of the org still can, until the org's own limit.
    await ok(confirm(net, app, set.changes));
    expect(CONSOLE_ERROR_STATUS.rate_limited).toBe(429);
  });

  it('within its D1 cost', async () => {
    const net = await network();
    const app = await platformApp(net);
    const set = await proposed(net, app, 3);
    const count: DbCount = { reads: 0, batches: 0, statements: 0 };
    await ok(confirm(net, app, set.changes, { rpc: consoleOn({ DB: countingDb(env.DB, count) }) }));
    expect(count.reads + count.statements).toBeLessThanOrEqual(CONSOLE_COSTS.confirmOrigins);
    expect(count.batches).toBe(1);
  });
});

describe('the confirmation page’s view', () => {
  it('the app, who asked and when, every web address of the request with its state; the other apps of the wallet; another org’s or a member’s change not found', async () => {
    const net = await network();
    const app = await platformApp(net, 'Coffee Club');
    await platformApp(net, 'Tea House');
    const set = await proposed(net, app, 2);
    const v = await ok(consoleOn().getConfirmation({ ...member(), orgId: net.org, changeId: set.changes[0]!.changeId }));
    expect(v.confirmation).toMatchObject({ app: { id: app, name: 'Coffee Club', sharedScope: true }, requestId: set.request, proposedByKind: 'platform', keyId: net.k.id, keyLabel: 'Backend key' });
    expect(v.confirmation.app.otherApps).toContain('Tea House');
    expect(v.confirmation.changes.map((c) => c.changeId).sort()).toEqual(set.changes.map((c) => c.changeId).sort());
    expect(v.confirmation.changes.every((c) => c.state === 'waiting' && c.confirmable && c.activeFrom! > Date.now())).toBe(true);
    const done = await ok(confirm(net, app, set.changes));
    const after = await ok(consoleOn().getConfirmation({ ...member(), orgId: net.org, changeId: set.changes[0]!.changeId }));
    expect(after.confirmation.changes.every((c) => c.state === 'in_force' && !c.confirmable && c.confirmedAt === done.confirmedAt)).toBe(true);
    const net2 = await network();
    expect(await no(consoleOn().getConfirmation({ ...member(), orgId: net2.org, changeId: set.changes[0]!.changeId }))).toEqual({ ok: false, code: 'not_found', error: NOT_VISIBLE });
    const m = await memberProposal(net.site, { kind: 'origin_add', origin: 'https://m.example' });
    expect(await no(consoleOn().getConfirmation({ ...member(), orgId: net.org, changeId: m }))).toEqual({ ok: false, code: 'not_found', error: NOT_VISIBLE });
  });
});

describe('staff web addresses on a shared wallet: four eyes', () => {
  /** A staff proposal on the network's own (staff-created) site app, on its shared scope. */
  async function staffProposal(net: Net, origin = `https://s-${newId('guardedChange').slice(3, 9).toLowerCase()}.example`, who = hana()) {
    const ver = (await one<{ v: number }>('SELECT origins_version AS v FROM apps WHERE id = ?1', net.site.id)).v;
    const r = await ok(adminOn().addOrigins({ ...who, orgId: net.org, appId: net.site.id, add: [origin], expectedVersion: ver }));
    const id = r.changes[0]!.id;
    return { id, origin };
  }
  async function announce(id: string, e: Partial<Env> = {}) {
    await ackNotice(new HotDb(env.DB), { ...env, ...e } as Env, { actor: { kind: 'system', id: 'admin-cron' }, requestId: rid(), now: Date.now() }, { changeId: id, cancelTokenHash: await linkToken().hash });
  }
  const staffConfirm = (net: Net, ids: string[], who: ReturnType<typeof hana>, reason = 'Checked with the network on a call today') => adminOn().confirmStaffOrigins({ ...who, orgId: net.org, appId: net.site.id, changeIds: ids, reason });
  const staffer = (id: string, email: string) => ({ ...hana(), actor: { kind: 'hana' as const, id, email } });

  it('its wait is written with the proposal, the ack gives at least 24 h and no waiver; nobody confirming: it waits; no expedite', async () => {
    const net = await network();
    const p = await staffProposal(net);
    expect(await one('SELECT proposed_by, proposer_email_key, min_delay_ms FROM staff_origin_waits WHERE change_id = ?1', p.id)).toEqual({ proposed_by: 'access-sub-staff-1', proposer_email_key: 'staff@hana.example', min_delay_ms: DAY });
    const notices = await ok(adminOn().pendingNotices({ ...system(), limit: 100 }));
    const n = notices.notices.find((x) => x.change.id === p.id)!;
    expect(n.secondPerson).toEqual({ requestId: expect.any(String), waitMs: DAY });
    expect(n.change.secondPerson).toBeUndefined(); // the notice's change view comes from the stored row
    await announce(p.id);
    const g = await one<{ notified_at: number; active_from: number; waiver: string | null }>('SELECT notified_at, active_from, waiver FROM guarded_changes WHERE id = ?1', p.id);
    expect(g.active_from - g.notified_at).toBe(DAY);
    expect(g.waiver).toBeNull();
    expect((await no(adminOn().expediteChange({ ...hana(), changeId: p.id, reason: 'Please make this work right now for the demo' }))).code).toBe('forbidden');
  });

  it('the proposer never confirms (by Access subject, or another subject with the same email); a second staff member does, at once; an owner does too', async () => {
    const net = await network();
    const p = await staffProposal(net);
    await announce(p.id);
    expect((await no(staffConfirm(net, [p.id], staffer('access-sub-staff-1', 'other@hana.example')))).code).toBe('forbidden');
    expect((await no(staffConfirm(net, [p.id], staffer('access-sub-staff-9', 'Staff+x@hana.example')))).code).toBe('forbidden');
    expect((await no(staffConfirm(net, [p.id], staffer('access-sub-staff-2', 'staff2@hana.example'), 'too short'))).code).toBe('bad_request');
    await ok(staffConfirm(net, [p.id], staffer('access-sub-staff-2', 'staff2@hana.example')));
    expect(await one('SELECT active_from FROM guarded_changes WHERE id = ?1', p.id)).toEqual({ active_from: Date.now() });
    expect(await one('SELECT confirmed_by_kind, confirmed_by, reason FROM origin_confirmations WHERE change_id = ?1', p.id)).toEqual({ confirmed_by_kind: 'hana', confirmed_by: 'access-sub-staff-2', reason: 'Checked with the network on a call today' });
    // An owner, with the same bar as for the platform's.
    const q2 = await staffProposal(net);
    await announce(q2.id);
    const jwt = await stepUp(nonceOf(await originConfirmDigest({ signer: env.SIGNER_ACCOUNT, env: env.ENV_NAME, orgId: net.org, appId: net.site.id, scopeId: net.scope, changes: [{ changeId: q2.id, origin: q2.origin }] })));
    await ok(consoleOn().confirmOrigins({ ...member(), orgId: net.org, appId: net.site.id, changeIds: [q2.id], stepUpJwt: jwt }));
    expect(await one('SELECT active_from FROM guarded_changes WHERE id = ?1', q2.id)).toEqual({ active_from: Date.now() });
  });

  it('no restore without the wait (A14): a web address removed from a platform app comes back only as a staff proposal that waits 24 h or a second person', async () => {
    const net = await network();
    const app = await platformApp(net);
    const set = await proposed(net, app, 1);
    await ok(confirm(net, app, set.changes));
    const ver = (await one<{ v: number }>('SELECT origins_version AS v FROM apps WHERE id = ?1', app)).v;
    await ok(adminOn().removeOrigins({ ...hana(), orgId: net.org, appId: app, remove: [set.changes[0]!.origin], expectedVersion: ver }));
    const back = await ok(adminOn().addOrigins({ ...hana(), orgId: net.org, appId: app, add: [set.changes[0]!.origin], expectedVersion: ver + 1 }));
    const id = back.changes[0]!.id;
    expect(await one('SELECT COUNT(*) AS n FROM staff_origin_waits WHERE change_id = ?1', id)).toEqual({ n: 1 });
    await announce(id);
    const g = await one<{ notified_at: number; active_from: number; waiver: string | null }>('SELECT notified_at, active_from, waiver FROM guarded_changes WHERE id = ?1', id);
    expect(g.active_from - g.notified_at).toBe(DAY);
    expect(g.waiver).toBeNull();
    expect((await no(adminOn().expediteChange({ ...hana(), changeId: id, reason: 'Restore it now please, it was removed by mistake' }))).code).toBe('forbidden');
    expect((await no(staffConfirm({ ...net, site: { ...net.site, id: app } } as Net, [id], hana()))).code).toBe('forbidden');
  });

  it('staff never confirm a platform proposal; a staff proposal on a plain scope needs no second person', async () => {
    const net = await network();
    const app = await platformApp(net);
    const set = await proposed(net, app, 1);
    const r = await no(adminOn().confirmStaffOrigins({ ...staffer('access-sub-staff-2', 'staff2@hana.example'), orgId: net.org, appId: app, changeIds: [set.changes[0]!.changeId], reason: 'Checked with the network on a call today' }));
    expect(r.code).toBe('forbidden');
    const plain = await orgApp({ org: net.org });
    const s = await ok(adminOn().addOrigins({ ...hana(), orgId: net.org, appId: plain.id, add: ['https://plain.example'], expectedVersion: 0 }));
    expect(await one('SELECT COUNT(*) AS n FROM staff_origin_waits WHERE change_id = ?1', s.changes[0]!.id)).toEqual({ n: 0 });
  });

  it('a new app on a scope staff mark as shared: its first web addresses wait for a second person, with no waiver', async () => {
    const org = (await orgApp()).org;
    ownerChain({ owners: [] });
    const scopeId = `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const r = await ok(adminOn().createApp({ ...hana(), orgId: org, scopeId, environment: 'test', name: 'Network site', origins: ['https://site.example'], orgOwnerSubs: [], appUserIds: true }));
    const id = (await one<{ id: string }>("SELECT id FROM guarded_changes WHERE app_id = ?1 AND kind = 'origin_add'", r.app.id)).id;
    expect(await one('SELECT waiver FROM guarded_changes WHERE id = ?1', id)).toEqual({ waiver: null });
    expect(await one('SELECT COUNT(*) AS n FROM staff_origin_waits WHERE change_id = ?1', id)).toEqual({ n: 1 });
  });
});

describe('the confirmation’s notice and its removal link', () => {
  it('one notice per confirmation with the contacts, who confirmed and the web addresses; acked once with exactly its removal links (7 days)', async () => {
    const net = await network();
    const app = await platformApp(net, 'Coffee Club');
    const set = await proposed(net, app, 2);
    const who = member();
    await ok(confirm(net, app, set.changes, { who }));
    const page = await ok(adminOn().confirmationNotices({ ...system(), limit: 50 }));
    const n = page.notices.find((x) => x.requestId === who.requestId)!;
    expect(n).toMatchObject({ app: { id: app, name: 'Coffee Club', orgId: net.org }, contacts: ['security@partner.example'], confirmedByKind: 'member', confirmedBy: who.actor.id, proposedByKind: 'platform', keyId: net.k.id, keyLabel: 'Backend key' });
    expect(n.changes.map((c) => c.changeId)).toEqual(set.changes.map((c) => c.changeId));
    const tokens = set.changes.map(() => linkToken());
    const removals = await Promise.all(set.changes.map(async (c, k) => ({ changeId: c.changeId, removalTokenHash: await tokens[k]!.hash })));
    expect((await no(adminOn().ackConfirmationNotice({ ...hana(), requestId: who.requestId, removals }))).code).toBe('forbidden');
    expect((await no(adminOn().ackConfirmationNotice({ ...system(), requestId: who.requestId, removals: removals.slice(0, 1) }))).code).toBe('bad_request');
    const acked = await ok(adminOn().ackConfirmationNotice({ ...system(), requestId: who.requestId, removals }));
    expect(acked.removalUntil).toBe(Date.now() + ORIGIN_REMOVAL_LINK_MS);
    expect((await no(adminOn().ackConfirmationNotice({ ...system(), requestId: who.requestId, removals }))).code).toBe('not_pending');
    expect((await ok(adminOn().confirmationNotices({ ...system(), limit: 50 }))).notices.find((x) => x.requestId === who.requestId)).toBeUndefined();

    // The removal link: a preview changes nothing; the removal stops it at once, single use; a wrong token is refused.
    const c0 = set.changes[0]!;
    const wrong = linkToken();
    expect((await no(consoleOn().removalPreview({ ...link(c0.changeId), changeId: c0.changeId, token: wrong.token }))).code).toBe('forbidden');
    const pv = await ok(consoleOn().removalPreview({ ...link(c0.changeId), changeId: c0.changeId, token: tokens[0]!.token }));
    expect(pv.removal).toMatchObject({ changeId: c0.changeId, appName: 'Coffee Club', origin: c0.origin, confirmedByKind: 'member', removable: true });
    expect(await one('SELECT COUNT(*) AS n FROM app_origins WHERE change_id = ?1', c0.changeId)).toEqual({ n: 1 });
    await ok(consoleOn().removeOriginByLink({ ...link(c0.changeId), changeId: c0.changeId, token: tokens[0]!.token }));
    expect(await one('SELECT COUNT(*) AS n FROM app_origins WHERE change_id = ?1', c0.changeId)).toEqual({ n: 0 });
    expect(await one('SELECT status FROM guarded_changes WHERE id = ?1', c0.changeId)).toEqual({ status: 'ended' });
    const led = await one<{ actor_kind: string; actor_id: string }>("SELECT actor_kind, actor_id FROM app_changes WHERE app_id = ?1 AND kind = 'origin.removed' ORDER BY seq DESC LIMIT 1", app);
    expect(led).toEqual({ actor_kind: 'link', actor_id: c0.changeId });
    expect((await no(consoleOn().removeOriginByLink({ ...link(c0.changeId), changeId: c0.changeId, token: tokens[0]!.token }))).code).toBe('not_pending');
    // The other web address's link is its own (one link never removes another); after 7 days it is refused.
    expect((await no(consoleOn().removeOriginByLink({ ...link(set.changes[1]!.changeId), changeId: set.changes[1]!.changeId, token: tokens[0]!.token }))).code).toBe('forbidden');
    clock.advance(ORIGIN_REMOVAL_LINK_MS + 1000);
    expect((await no(consoleOn().removeOriginByLink({ ...link(set.changes[1]!.changeId), changeId: set.changes[1]!.changeId, token: tokens[1]!.token }))).error).toMatch(/expired/u);
    expect(await one('SELECT COUNT(*) AS n FROM app_origins WHERE change_id = ?1', set.changes[1]!.changeId)).toEqual({ n: 1 });
  });

  it('the staff queue lists confirmed web addresses for 7 days, with who and when, and staff ones waiting for a second person', async () => {
    const net = await network();
    const app = await platformApp(net);
    const set = await proposed(net, app, 1);
    const who = member();
    await ok(confirm(net, app, set.changes, { who }));
    const ver = (await one<{ v: number }>('SELECT origins_version AS v FROM apps WHERE id = ?1', net.site.id)).v;
    const s = await ok(adminOn().addOrigins({ ...hana(), orgId: net.org, appId: net.site.id, add: ['https://waits.example'], expectedVersion: ver }));
    const q = await ok(adminOn().platformQueue({ ...hana(), limit: 100 }));
    expect(q.confirmed.find((c) => c.changeId === set.changes[0]!.changeId)).toMatchObject({ appId: app, confirmedByKind: 'member', confirmedBy: who.actor.id, confirmedAt: Date.now(), proposedByKind: 'platform', removed: false });
    expect(q.secondPerson.find((c) => c.changeId === s.changes[0]!.id)).toMatchObject({ appId: net.site.id, proposedBy: 'access-sub-staff-1', notifiedAt: null });
    clock.advance(7 * DAY + 1000);
    const later = await ok(adminOn().platformQueue({ ...hana(), limit: 100 }));
    expect(later.confirmed.find((c) => c.changeId === set.changes[0]!.changeId)).toBeUndefined();
  });
});
