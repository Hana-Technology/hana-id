// Batch C5 (docs/batch-c-spec.md tests "CAS, breaker, budget" and "Topology and config"): the compare-and-swap writes
// with `app_changes` as the commit point (a replayed request id, a moved version, fault injection on every statement),
// the destructive-call breaker per org and across orgs, the hot-DB budget, the suspension bits by caller, the
// entrypoints unreachable from `fetch`, and org A asking for org B's app getting `not_found` on every org method.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAppByKey } from '../src/apps.ts';
import type { Writer } from '../src/changes/cas.ts';
import { HotDb } from '../src/changes/db.ts';
import { CONSOLE_KEY_REVOKES } from '../src/changes/guard.ts';
import { placedStub } from '../src/placement.ts';
import { rotateKey } from '../src/changes/keys.ts';
import { removeOrigins } from '../src/changes/origins.ts';
import { AdminRpc } from '../src/rpc/admin.ts';
import { CONSOLE_COSTS, ConsoleRpc } from '../src/rpc/console.ts';
import { ORIGIN, call, seedApp, uid } from './helpers.ts';
import { hex, labelChangeDigest, nonceOf, originChangeDigest, originConfirmDigest, ownerActionNonce, parsePlatformPublicKey, platformKeyDigest, settingsChangeDigest, sha256, utf8 } from '@hana-id/console-core';

/** A partner label document (D894) for the budget test: a made-up contract on the NEAR test network. */
const LABEL_DOC = JSON.stringify({
  schema: 'journear-labels/1',
  context: { near: { network: 'testnet', account: 'budget-club.testnet', codeHash: 'GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn' } },
  display: { formats: { join: { call: { args: {} }, intent: { verb: 'join', object: 'the club' }, sentence: ['verb', 'object'], fields: [] } } },
});
const sha256HexOf = async (s: string): Promise<string> => hex(await sha256(utf8(s)));
import {
  type DbCount,
  adminRpc,
  appRow,
  consoleRpc,
  counted,
  countingDb,
  hana,
  ledgerCount,
  link,
  linkToken,
  member,
  newOrg,
  newPlatformPublicKey,
  orgApp,
  ownClock,
  governanceViews,
  ownerChain,
  rid,
  rows,
  stepUp,
  system,
} from './rpc-helpers.ts';

afterEach(() => vi.restoreAllMocks());

const SECOND = 'https://second.example.com';
/** This test's clock (each describe's beforeEach); ConsoleRpc calls advance it 2 s, as a person clicking would. */
let clk: ReturnType<typeof ownClock>;

describe('compare-and-swap writes', () => {
  beforeEach(() => {
    clk = ownClock();
  });

  it('a replayed requestId answers already_applied and writes nothing', async () => {
    const app = await orgApp({ origins: [ORIGIN, SECOND] });
    const c = { ...member(), orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 0 };
    expect(await consoleRpc(clk).removeOrigins(c)).toEqual({ ok: true, version: 1 });
    const before = await ledgerCount();
    const again = await consoleRpc(clk).removeOrigins({ ...c, expectedVersion: 1 });
    expect(again).toMatchObject({ ok: false, code: 'already_applied' });
    expect(await ledgerCount()).toBe(before);
    expect((await appRow(app.id)).origins_version).toBe(1);
  });

  it('a replay racing the original write is refused by the unique request id: one ledger row, one bump', async () => {
    const app = await orgApp();
    const c = { ...hana(), orgId: app.org, appId: app.id, add: ['https://race.example.com'], expectedVersion: 0 };
    const [a, b] = await Promise.all([adminRpc().addOrigins(c), adminRpc().addOrigins(c)]);
    const codes = [a, b].map((r) => (r.ok ? 'ok' : r.code)).sort();
    expect(codes[0]).toBe('already_applied');
    expect(codes[1]).toBe('ok');
    expect(await rows('SELECT seq FROM app_changes WHERE request_id = ?1', c.requestId)).toHaveLength(1);
    expect(await rows("SELECT id FROM guarded_changes WHERE app_id = ?1 AND kind = 'origin_add'", app.id)).toHaveLength(1);
    expect((await appRow(app.id)).origins_version).toBe(1);
  });

  it('a moved version answers version_conflict and writes nothing', async () => {
    const app = await orgApp({ origins: [ORIGIN, SECOND] });
    const before = await ledgerCount();
    const r = await consoleRpc(clk).removeOrigins({ ...member(), orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 7 });
    expect(r).toMatchObject({ ok: false, code: 'version_conflict' });
    expect(await ledgerCount()).toBe(before);
    expect(await rows('SELECT origin FROM app_origins WHERE app_id = ?1', app.id)).toHaveLength(2);
  });

  it('a version moved between the plan read and the batch commits nothing (the commit predicate)', async () => {
    const app = await orgApp({ origins: [ORIGIN, SECOND] });
    const db = new HotDb(env.DB);
    const w: Writer = { actor: member().actor, requestId: rid(), now: Date.now() };
    // Another writer bumps the version after this call's plan read: the read is wrapped so the bump lands in between.
    const first = db.first.bind(db);
    db.first = async (s) => {
      const r = await first(s);
      await env.DB.prepare('UPDATE apps SET origins_version = origins_version + 1 WHERE id = ?1').bind(app.id).run();
      return r as never;
    };
    await expect(removeOrigins(db, w, { orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 0 })).rejects.toMatchObject({ code: 'version_conflict' });
    expect(await rows('SELECT seq FROM app_changes WHERE request_id = ?1', w.requestId)).toHaveLength(0);
    expect(await rows('SELECT origin FROM app_origins WHERE app_id = ?1', app.id)).toHaveLength(2);
  });

  it('no applied change lacks its app_changes row: a fault on any statement rolls the whole write back', async () => {
    for (let k = 0; k < 4; k++) {
      const app = await orgApp({ origins: [ORIGIN, SECOND] });
      const db = new HotDb(countingDb(env.DB, { reads: 0, batches: 0, statements: 0 }, { faultAt: k }));
      const w: Writer = { actor: member().actor, requestId: rid(), now: Date.now() };
      await expect(removeOrigins(db, w, { orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 0 })).rejects.toThrow();
      expect(await rows('SELECT seq FROM app_changes WHERE request_id = ?1', w.requestId), `statement ${k}`).toHaveLength(0);
      expect(await rows('SELECT origin FROM app_origins WHERE app_id = ?1', app.id), `statement ${k}`).toHaveLength(2);
      expect((await appRow(app.id)).origins_version, `statement ${k}`).toBe(0);
    }
    for (let k = 0; k < 4; k++) {
      const app = await orgApp();
      const key = (await rows<{ id: string }>('SELECT id FROM app_keys WHERE app_id = ?1', app.id))[0]!;
      const db = new HotDb(countingDb(env.DB, { reads: 0, batches: 0, statements: 0 }, { faultAt: k }));
      const w: Writer = { actor: member().actor, requestId: rid(), now: Date.now() };
      await expect(rotateKey(db, w, { orgId: app.org, appId: app.id, keyId: key.id })).rejects.toThrow();
      expect(await rows('SELECT seq FROM app_changes WHERE request_id = ?1', w.requestId), `statement ${k}`).toHaveLength(0);
      expect(await rows('SELECT id, revoked_at FROM app_keys WHERE app_id = ?1', app.id), `statement ${k}`).toEqual([{ id: key.id, revoked_at: null }]);
    }
  });
});

describe('the destructive-call breaker', () => {
  beforeEach(() => {
    clk = ownClock();
  });

  it('the sixth rotation or removal for one org within an hour is refused with a breaker event; a suspension and a publishable key’s revocation are neither counted nor refused (D935, D937)', async () => {
    const org = newOrg();
    const apps = await Promise.all([1, 2, 3, 4].map(() => orgApp({ org, origins: [ORIGIN, SECOND] })));
    const keyOf = async (appId: string) => (await rows<{ id: string }>('SELECT id FROM app_keys WHERE app_id = ?1 AND revoked_at IS NULL', appId))[0]!.id;
    const rpc = consoleRpc(clk);
    // D935: a revocation before the five counted calls isn't one of them; D937: nor a suspension.
    expect(await rpc.createKey({ ...member(), orgId: org, appId: apps[0]!.id })).toMatchObject({ ok: true });
    expect(await rpc.revokeKey({ ...member(), orgId: org, appId: apps[0]!.id, keyId: await keyOf(apps[0]!.id) })).toMatchObject({ ok: true });
    expect(await rpc.setSuspended({ ...member(), orgId: org, appId: apps[3]!.id, suspended: true })).toMatchObject({ ok: true });
    const calls = [
      async () => rpc.rotateKey({ ...member(), orgId: org, appId: apps[1]!.id, keyId: await keyOf(apps[1]!.id) }),
      () => rpc.removeOrigins({ ...member(), orgId: org, appId: apps[1]!.id, remove: [SECOND], expectedVersion: 0 }),
      async () => rpc.rotateKey({ ...member(), orgId: org, appId: apps[2]!.id, keyId: await keyOf(apps[2]!.id) }),
      () => rpc.removeOrigins({ ...member(), orgId: org, appId: apps[2]!.id, remove: [SECOND], expectedVersion: 0 }),
      async () => rpc.rotateKey({ ...member(), orgId: org, appId: apps[3]!.id, keyId: await keyOf(apps[3]!.id) }),
    ];
    for (const c of calls) expect(await c()).toMatchObject({ ok: true });
    // Not counted: a resume, a turn-off, a cancel, and every AdminRpc call.
    expect(await rpc.setSuspended({ ...member(), orgId: org, appId: apps[3]!.id, suspended: false })).toMatchObject({ ok: true });
    expect(await rpc.turnOff({ ...member(), orgId: org, appId: apps[2]!.id, what: 'policy', expectedVersion: 0 })).toMatchObject({ ok: true });
    expect(await rpc.cancelChange({ ...member(), orgId: org, changeId: 'gc_none' })).toMatchObject({ ok: false, code: 'not_found' });
    for (let k = 0; k < 6; k++) expect(await adminRpc().setSuspended({ ...hana(), appId: apps[2]!.id, bit: 1, suspended: k % 2 === 0 })).toMatchObject({ ok: true });
    const sixth = await rpc.removeOrigins({ ...member(), orgId: org, appId: apps[0]!.id, remove: [SECOND], expectedVersion: 0 });
    expect(sixth).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(await rows('SELECT origin FROM app_origins WHERE app_id = ?1', apps[0]!.id)).toHaveLength(2);
    // D935: with the org's breaker full, a publishable key's revocation still goes through; D937: and a suspension.
    const live = await keyOf(apps[0]!.id);
    expect(await rpc.revokeKey({ ...member(), orgId: org, appId: apps[0]!.id, keyId: live })).toMatchObject({ ok: true, warning: 'last_key' });
    expect((await rows<{ revoked_at: number | null }>('SELECT revoked_at FROM app_keys WHERE id = ?1', live))[0]!.revoked_at).not.toBeNull();
    expect(await rpc.setSuspended({ ...member(), orgId: org, appId: apps[0]!.id, suspended: true })).toMatchObject({ ok: true, suspendedBy: 4 });
    const events = await rows<{ kind: string; detail_json: string }>("SELECT kind, detail_json FROM security_events WHERE kind = 'breaker' AND org_id = ?1", org);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.detail_json)).toMatchObject({ limit: 'org', perOrg: 5, floor: 3 });
    // A second refusal in the same hour writes no second event.
    expect(await rpc.rotateKey({ ...member(), orgId: org, appId: apps[1]!.id, keyId: await keyOf(apps[1]!.id) })).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(await rows("SELECT id FROM security_events WHERE kind = 'breaker' AND org_id = ?1", org)).toHaveLength(1);
  });

  it('past 20 across orgs within an hour an org past its first 3 is refused, with a global breaker event; every org’s first 3 still pass (D937)', async () => {
    const clock = ownClock();
    const rpc = consoleRpc(clock);
    const liveKey = async (appId: string) => (await rows<{ id: string }>('SELECT id FROM app_keys WHERE app_id = ?1 AND revoked_at IS NULL', appId))[0]!.id;
    const rotate = async (app: { org: string; id: string }) => rpc.rotateKey({ ...member(), orgId: app.org, appId: app.id, keyId: await liveKey(app.id) });
    // 17 orgs one rotation each, then org X three: 20 across orgs.
    for (let k = 0; k < 17; k++) {
      clock.advance(1000); // within the hour, but past the hot-DB budget's burst
      expect(await rotate(await orgApp()), `call ${k + 1}`).toMatchObject({ ok: true });
    }
    const x = await orgApp();
    for (let k = 0; k < 3; k++) expect(await rotate(x)).toMatchObject({ ok: true });
    // X's fourth: past its floor with the global count full.
    const before = await liveKey(x.id);
    expect(await rotate(x)).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(await liveKey(x.id)).toBe(before);
    const t = Math.floor(Date.now() / (60 * 60 * 1000)) * 60 * 60 * 1000;
    const events = await rows<{ detail_json: string }>("SELECT detail_json FROM security_events WHERE kind = 'breaker' AND org_id IS NULL AND detected_at >= ?1", t);
    expect(events.map((e) => JSON.parse(e.detail_json).limit)).toEqual(['global']);
    // Another org's first 3 pass whatever the global count (D937); its suspension and revocation are outside the breaker.
    const y = await orgApp({ origins: [ORIGIN, SECOND] });
    expect(await rpc.removeOrigins({ ...member(), orgId: y.org, appId: y.id, remove: [SECOND], expectedVersion: 0 })).toMatchObject({ ok: true });
    expect(await rpc.setSuspended({ ...member(), orgId: y.org, appId: y.id, suspended: true })).toMatchObject({ ok: true, suspendedBy: 4 });
    expect(await rpc.revokeKey({ ...member(), orgId: y.org, appId: y.id, keyId: await liveKey(y.id) })).toMatchObject({ ok: true });
  });
});

describe('D935: a member’s publishable key revocations, outside the breaker', () => {
  beforeEach(() => {
    clk = ownClock();
  });
  const live = async (appId: string) => (await rows<{ id: string }>('SELECT id FROM app_keys WHERE app_id = ?1 AND revoked_at IS NULL ORDER BY id', appId)).map((r) => r.id);
  const stops = (org: string) => placedStub(env, env.RATE_LIMITER, `console-stops:${org}`);

  it('20 an org a clock hour, then `rate_limited` writing nothing; a revocation that changes nothing never counts; another org untouched', async () => {
    const app = await orgApp();
    const rpc = consoleRpc(clk);
    expect(CONSOLE_KEY_REVOKES).toEqual([{ name: 'key-revokes:hour', windowMs: 60 * 60 * 1000, max: 20 }]);
    for (let i = 0; i < 20; i++) {
      // D937: the no-ops below pay the org's own kill bucket (1 a second): a person's pace, not a script's.
      clk.advance(10_000);
      expect(await rpc.createKey({ ...member(), orgId: app.org, appId: app.id }), `create ${i}`).toMatchObject({ ok: true });
      const [first] = await live(app.id);
      expect(await rpc.revokeKey({ ...member(), orgId: app.org, appId: app.id, keyId: first! }), `revoke ${i}`).toMatchObject({ ok: true });
      // No-ops in between: an already revoked key and an unknown one, each its usual answer.
      expect(await rpc.revokeKey({ ...member(), orgId: app.org, appId: app.id, keyId: first! })).toMatchObject({ ok: false, code: 'conflict' });
      expect(await rpc.revokeKey({ ...member(), orgId: app.org, appId: app.id, keyId: 'key_none' })).toMatchObject({ ok: false, code: 'not_found' });
    }
    const [last] = await live(app.id);
    const ledger = await ledgerCount();
    expect(await rpc.revokeKey({ ...member(), orgId: app.org, appId: app.id, keyId: last! })).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(await ledgerCount()).toBe(ledger);
    expect(await live(app.id)).toEqual([last]);
    // A no-op past the limit still answers what it is, not the limit.
    expect(await rpc.revokeKey({ ...member(), orgId: app.org, appId: app.id, keyId: 'key_none' })).toMatchObject({ ok: false, code: 'not_found' });
    // Another org's revocation, at the same moment, is its own.
    const other = await orgApp();
    expect(await rpc.revokeKey({ ...member(), orgId: other.org, appId: other.id, keyId: (await live(other.id))[0]! })).toMatchObject({ ok: true });
    // The next clock hour, it goes through.
    clk.advance(60 * 60 * 1000);
    expect(await rpc.revokeKey({ ...member(), orgId: app.org, appId: app.id, keyId: last! })).toMatchObject({ ok: true, warning: 'last_key' });
  });

  it('parallel revocations at the edge of the window: exactly the room left goes through', async () => {
    const app = await orgApp();
    const rpc = consoleRpc(clk);
    for (let i = 0; i < 4; i++) expect(await rpc.createKey({ ...member(), orgId: app.org, appId: app.id })).toMatchObject({ ok: true });
    const keys = await live(app.id);
    expect(keys).toHaveLength(5);
    // 18 of the hour's 20 used.
    expect(await stops(app.org).hit(CONSOLE_KEY_REVOKES, Date.now(), 18)).toMatchObject({ ok: true });
    const out = await Promise.all(keys.map((keyId) => rpc.revokeKey({ ...member(), orgId: app.org, appId: app.id, keyId })));
    expect(out.filter((r) => r.ok)).toHaveLength(2);
    expect(out.filter((r) => !r.ok).map((r) => (r as { code: string }).code)).toEqual(['rate_limited', 'rate_limited', 'rate_limited']);
    expect(await live(app.id)).toHaveLength(3);
  });

  it('a revocation whose batch fails gives its unit back; a limiter error refuses it (fails closed)', async () => {
    const app = await orgApp();
    const keyId = (await live(app.id))[0]!;
    const w = { actor: member().actor, requestId: rid(), now: Date.now() };
    const { withKeyRevokeQuota } = await import('../src/changes/guard.ts');
    const { revokeKey } = await import('../src/changes/keys.ts');
    expect(await stops(app.org).hit(CONSOLE_KEY_REVOKES, w.now, 19)).toMatchObject({ ok: true });
    const failing = new HotDb(countingDb(env.DB, { reads: 0, batches: 0, statements: 0 }, { faultAt: 1 }));
    await expect(withKeyRevokeQuota(env, w, app.org, () => revokeKey(failing, w, { orgId: app.org, appId: app.id, keyId }))).rejects.toThrow();
    // The unit came back: the 20th is still free.
    expect(await stops(app.org).hit(CONSOLE_KEY_REVOKES, w.now)).toMatchObject({ ok: true });
    await stops(app.org).unhit(CONSOLE_KEY_REVOKES, w.now);
    vi.spyOn(env.RATE_LIMITER, 'get').mockImplementation(() => {
      throw new Error('limiter down');
    });
    const w2 = { actor: member().actor, requestId: rid(), now: Date.now() };
    await expect(withKeyRevokeQuota(env, w2, app.org, () => revokeKey(new HotDb(env.DB), w2, { orgId: app.org, appId: app.id, keyId }))).rejects.toThrow();
    vi.restoreAllMocks();
    expect(await live(app.id)).toEqual([keyId]);
  });
});

describe('suspension bits', () => {
  beforeEach(() => {
    clk = ownClock();
  });

  it('a member sets and clears only bit 4; Hana clears any bit, bit 4 included', async () => {
    const app = await orgApp();
    expect(await adminRpc().setSuspended({ ...hana(), appId: app.id, bit: 1, suspended: true })).toEqual({ ok: true, suspendedBy: 1 });
    expect(await adminRpc().setSuspended({ ...hana(), appId: app.id, bit: 2, suspended: true })).toEqual({ ok: true, suspendedBy: 3 });
    expect(await consoleRpc(clk).setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: true })).toEqual({ ok: true, suspendedBy: 7 });
    // A member's resume clears bit 4 and never bits 1 or 2: the app stays suspended.
    expect(await consoleRpc(clk).setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: false })).toEqual({ ok: true, suspendedBy: 3 });
    expect((await appRow(app.id)).status).toBe('suspended');
    expect(await consoleRpc(clk).setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: true })).toEqual({ ok: true, suspendedBy: 7 });
    expect(await adminRpc().setSuspended({ ...hana(), appId: app.id, bit: 4, suspended: false })).toEqual({ ok: true, suspendedBy: 3 });
    expect(await adminRpc().setSuspended({ ...hana(), appId: app.id, bit: 1, suspended: false })).toEqual({ ok: true, suspendedBy: 2 });
    expect(await adminRpc().setSuspended({ ...hana(), appId: app.id, bit: 2, suspended: false })).toEqual({ ok: true, suspendedBy: 0 });
    expect((await appRow(app.id)).status).toBe('active');
    const kinds = await rows<{ kind: string; actor_kind: string }>("SELECT kind, actor_kind FROM app_changes WHERE app_id = ?1 AND kind LIKE 'suspension.%' ORDER BY seq", app.id);
    expect(kinds.map((k) => `${k.actor_kind}:${k.kind}`)).toEqual([
      'hana:suspension.set',
      'hana:suspension.set',
      'member:suspension.set',
      'member:suspension.cleared',
      'member:suspension.set',
      'hana:suspension.cleared',
      'hana:suspension.cleared',
      'hana:suspension.cleared',
    ]);
  });

  it('suspendOrg sets bit 2 on every app of the org, with one ledger row; a member can’t clear it', async () => {
    const org = newOrg();
    const a = await orgApp({ org });
    const b = await orgApp({ org });
    expect(await adminRpc().suspendOrg({ ...hana(), orgId: org, suspended: true })).toEqual({ ok: true, apps: 2 });
    expect((await appRow(a.id)).suspended_by).toBe(2);
    expect(await getAppByKey(env.DB, b.key)).toMatchObject({ suspended_by: 2, status: 'suspended' });
    expect(await consoleRpc(clk).setSuspended({ ...member(), orgId: org, appId: a.id, suspended: false })).toEqual({ ok: true, suspendedBy: 2 });
    expect(await rows("SELECT seq FROM app_changes WHERE org_id = ?1 AND kind = 'suspension.org_set' AND app_id IS NULL", org)).toHaveLength(1);
    expect(await adminRpc().suspendOrg({ ...hana(), orgId: org, suspended: false })).toEqual({ ok: true, apps: 2 });
    expect((await appRow(b.id)).status).toBe('active');
  });
});

describe('the hot-DB budget', () => {
  it('each ConsoleRpc method stays within two reads and one batch of at most eight statements, and its declared cost', async () => {
    const clock = ownClock();
    governanceViews(ownerChain());
    const app = await orgApp({ origins: [ORIGIN, SECOND] });
    const live = await orgApp({ live: true, org: app.org });
    const key = (await rows<{ id: string }>('SELECT id FROM app_keys WHERE app_id = ?1', app.id))[0]!.id;
    const pending = await adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: ['https://pending.example.com'], expectedVersion: 0 });
    if (!pending.ok) throw new Error(pending.code);
    const { token, hash } = linkToken();
    expect(await adminRpc().ackNotice({ ...system(), changeId: pending.changes[0]!.id, cancelTokenHash: await hash })).toMatchObject({ ok: true });
    const pending2 = await adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: ['https://pending2.example.com'], expectedVersion: 1 });
    if (!pending2.ok) throw new Error(pending2.code);
    let created: { key: { id: string } } | undefined;
    let labelId: string | undefined;
    let confirmable: { appId: string; scopeId: string; changeId: string; origin: string } | undefined;
    let removalToken: string | undefined;
    const pk = { one: await newPlatformPublicKey(), two: await newPlatformPublicKey(), three: await newPlatformPublicKey(), four: await newPlatformPublicKey(), five: await newPlatformPublicKey() };
    const keys: Record<string, string> = {};
    const keyNonce = async (kind: 'add' | 'accept' | 'confirm', keyId: string, publicKey: string, label: string) => {
      const p = await parsePlatformPublicKey(publicKey);
      if (!p.ok) throw new Error(p.problem);
      return nonceOf(await platformKeyDigest({ kind, signer: env.SIGNER_ACCOUNT, env: env.ENV_NAME, orgId: app.org, keyId, thumbprint: p.key.thumbprint, scopes: [app.scope], label }));
    };
    const staffTwo = () => ({ actor: { kind: 'hana' as const, id: 'access-sub-staff-2', email: 'staff2@hana.example' }, requestId: `req_${uid()}`, clientIp: '198.51.100.2' });
    const calls: [keyof typeof CONSOLE_COSTS, (rpc: ConsoleRpc) => Promise<{ ok: boolean }>][] = [
      ['listApps', (rpc) => rpc.listApps({ ...member(), orgId: app.org })],
      ['getApp', (rpc) => rpc.getApp({ ...member(), orgId: app.org, appId: app.id })],
      ['listChanges', (rpc) => rpc.listChanges({ ...member(), orgId: app.org, limit: 50 })],
      ['removeOrigins', (rpc) => rpc.removeOrigins({ ...member(), orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 2 })],
      // D934: a tightening, as a removal: its plan read and a batch of three.
      ['frameOnlyOrigins', async (rpc) => rpc.frameOnlyOrigins({ ...member(), orgId: app.org, appId: app.id, origins: ['https://pending2.example.com'], expectedVersion: (await appRow(app.id)).origins_version as number })],
      ['turnOff', (rpc) => rpc.turnOff({ ...member(), orgId: app.org, appId: app.id, what: 'raw_sign', expectedVersion: 0 })],
      ['updateSettings', (rpc) => rpc.updateSettings({ ...member(), orgId: app.org, appId: app.id, expectedVersion: 0, persistence: 'none', name: 'Renamed' })],
      ['setLogo', (rpc) => rpc.setLogo({ ...member(), orgId: app.org, appId: app.id, logoKey: `logos/${app.id}/${'a'.repeat(64)}.png`, expectedVersion: 1 })],
      ['cancelChangeByLink', (rpc) => rpc.cancelChangeByLink({ ...link(pending.changes[0]!.id), changeId: pending.changes[0]!.id, token })],
      ['cancelChange', (rpc) => rpc.cancelChange({ ...member(), orgId: app.org, changeId: pending2.changes[0]!.id })],
      ['setSuspended', (rpc) => rpc.setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: true })],
      ['createKey', async (rpc) => {
        const r = await rpc.createKey({ ...member(), orgId: app.org, appId: app.id });
        if (r.ok) created = r;
        return r;
      }],
      ['rotateKey', (rpc) => rpc.rotateKey({ ...member(), orgId: app.org, appId: app.id, keyId: key })],
      ['revokeKey', (rpc) => rpc.revokeKey({ ...member(), orgId: app.org, appId: app.id, keyId: created!.key.id })],
      // Batch C6: the step-up proposals (their removes too) and an owner action (its scope-in-org read).
      ['changeOrigins', async (rpc) => {
        const v = (await appRow(app.id)).origins_version as number;
        const add = ['https://c6-a.example.com', 'https://c6-b.example.com'];
        const nonce = nonceOf(await originChangeDigest({ signer: env.SIGNER_ACCOUNT, appId: app.id, add, remove: [ORIGIN], originsVersion: v }));
        return rpc.changeOrigins({ ...member(), orgId: app.org, appId: app.id, add, remove: [ORIGIN], expectedVersion: v, stepUpJwt: await stepUp(nonce) });
      }],
      ['proposeChange', async (rpc) => {
        const v = (await appRow(live.id)).settings_version as number;
        const nonce = nonceOf(await settingsChangeDigest({ signer: env.SIGNER_ACCOUNT, appId: live.id, kind: 'raw_sign_on', settingsVersion: v }));
        return rpc.proposeChange({ ...member(), orgId: live.org, appId: live.id, kind: 'raw_sign_on', expectedVersion: v, stepUpJwt: await stepUp(nonce) });
      }],
      ['ownerAction', async (rpc) => {
        const args = { scope_id: app.scope, change_id: 2 };
        const nonce = await ownerActionNonce({ signer: env.SIGNER_ACCOUNT, method: 'cancel_change', args, actionNonce: 4 });
        return rpc.ownerAction({ ...member(), orgId: app.org, body: { method: 'cancel_change', args: { ...args, auth: { Oidc: { jwt: await stepUp(nonce) } } } } });
      }],
      // Batch C14: the pending-upgrades page (the governance snapshot; no statement through the budget).
      ['pendingUpgrades', (rpc) => rpc.pendingUpgrades({ ...member(), orgId: app.org })],
      // The wallet directory (D315): one SELECT each.
      ['listUsers', (rpc) => rpc.listUsers({ ...member(), orgId: app.org })],
      // D894: partner labels (the switch on for this test's ConsoleRpc).
      ['listLabels', (rpc) => rpc.listLabels({ ...member(), orgId: app.org, scopeId: app.scope })],
      ['previewLabels', (rpc) => rpc.previewLabels({ ...member(), orgId: app.org, scopeId: app.scope, document: LABEL_DOC, appIds: [app.id] })],
      ['proposeLabels', async (rpc) => {
        const v = (await rows<{ v: number }>('SELECT labels_version AS v FROM scopes WHERE scope_id = ?1', app.scope))[0]!.v;
        const nonce = nonceOf(await labelChangeDigest({ signer: env.SIGNER_ACCOUNT, scopeId: app.scope, kind: 'labels_set', labelId: '', docSha256: await sha256HexOf(LABEL_DOC), appIds: [app.id], labelsVersion: v }));
        const r = await rpc.proposeLabels({ ...member(), orgId: app.org, scopeId: app.scope, document: LABEL_DOC, appIds: [app.id], expectedVersion: v, stepUpJwt: await stepUp(nonce) });
        if (r.ok) labelId = r.change!.labelId;
        return r;
      }],
      ['removeLabels', async (rpc) => {
        const v = (await rows<{ v: number }>('SELECT labels_version AS v FROM scopes WHERE scope_id = ?1', app.scope))[0]!.v;
        const nonce = nonceOf(await labelChangeDigest({ signer: env.SIGNER_ACCOUNT, scopeId: app.scope, kind: 'labels_remove', labelId: labelId!, appIds: [], labelsVersion: v }));
        return rpc.removeLabels({ ...member(), orgId: app.org, scopeId: app.scope, labelId: labelId!, expectedVersion: v, stepUpJwt: await stepUp(nonce) });
      }],
      // D918: platform keys (an owner's registration, then its announcement by the admin Worker, its confirmation and
      // its stop; a second key's cancel by the link; a staff key's acceptance and its stop by the link).
      ['proposePlatformKey', async (rpc) => {
        const r = await rpc.proposePlatformKey({ ...member(), orgId: app.org, scopeIds: [app.scope], label: 'Budget key', publicKey: pk.one, stepUpJwt: await stepUp(await keyNonce('add', '', pk.one, 'Budget key')) });
        if (r.ok) keys.one = r.key.id;
        return r;
      }],
      ['getPlatformKey', (rpc) => rpc.getPlatformKey({ ...member(), orgId: app.org, keyId: keys.one! })],
      ['listPlatformKeys', (rpc) => rpc.listPlatformKeys({ ...member(), orgId: app.org })],
      ['confirmPlatformKey', async (rpc) => {
        await adminRpc().ackPlatformKeyNotice({ ...system(), keyId: keys.one!, cancelTokenHash: await linkToken().hash });
        return rpc.confirmPlatformKey({ ...member(), orgId: app.org, keyId: keys.one!, stepUpJwt: await stepUp(await keyNonce('confirm', keys.one!, pk.one, 'Budget key')) });
      }],
      ['revokePlatformKey', (rpc) => rpc.revokePlatformKey({ ...member(), orgId: app.org, keyId: keys.one! })],
      ['cancelPlatformKeyByLink', async (rpc) => {
        const three = await adminRpc().registerPlatformKey({ ...hana(), orgId: app.org, scopeIds: [app.scope], label: 'Third', publicKey: pk.three, reason: 'Thumbprint checked by phone with the network' });
        if (!three.ok) throw new Error(three.code);
        const t = linkToken();
        await adminRpc().approvePlatformKey({ ...staffTwo(), orgId: app.org, keyId: three.key.id, reason: 'Second staff member checked it too' });
        await adminRpc().ackPlatformKeyNotice({ ...system(), keyId: three.key.id, cancelTokenHash: await t.hash });
        return rpc.cancelPlatformKeyByLink({ actor: { kind: 'link', id: three.key.id }, requestId: `req_${uid()}`, clientIp: '203.0.113.9', keyId: three.key.id, token: t.token });
      }],
      ['cancelPlatformKey', async (rpc) => {
        const r = await adminRpc().registerPlatformKey({ ...hana(), orgId: app.org, scopeIds: [app.scope], label: 'Fourth', publicKey: pk.four, reason: 'Thumbprint checked by phone with the network' });
        if (!r.ok) throw new Error(r.code);
        return rpc.cancelPlatformKey({ ...member(), orgId: app.org, keyId: r.key.id });
      }],
      ['acceptPlatformKey', async (rpc) => {
        const r = await adminRpc().registerPlatformKey({ ...hana(), orgId: app.org, scopeIds: [app.scope], label: 'Fifth', publicKey: pk.five, reason: 'Thumbprint checked by phone with the network' });
        if (!r.ok) throw new Error(r.code);
        keys.five = r.key.id;
        return rpc.acceptPlatformKey({ ...member(), orgId: app.org, keyId: r.key.id, stepUpJwt: await stepUp(await keyNonce('accept', r.key.id, pk.five, 'Fifth')) });
      }],
      ['revokePlatformKeyByLink', async (rpc) => {
        const t = linkToken();
        const r = linkToken();
        await adminRpc().ackPlatformKeyNotice({ ...system(), keyId: keys.five!, cancelTokenHash: await t.hash, revokeTokenHash: await r.hash });
        return rpc.revokePlatformKeyByLink({ actor: { kind: 'link', id: keys.five! }, requestId: `req_${uid()}`, clientIp: '203.0.113.9', keyId: keys.five!, token: r.token });
      }],
      // D930: one page of the org's platform calls (one read).
      ['platformCalls', (rpc) => rpc.platformCalls({ ...member(), orgId: app.org, limit: 50 })],
      // D931: an owner's confirmation of a staff web address on a shared wallet (four eyes), its page, and its notice's
      // removal link (the preview and the removal).
      ['getConfirmation', async (rpc) => {
        const shared = await orgApp({ org: app.org });
        await env.DB.prepare('UPDATE scopes SET app_user_ids = 1 WHERE scope_id = ?1').bind(shared.scope).run();
        const p = await adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: shared.id, add: ['https://four-eyes.example.com'], expectedVersion: 0 });
        if (!p.ok) throw new Error(p.code);
        await adminRpc().ackNotice({ ...system(), changeId: p.changes[0]!.id, cancelTokenHash: await linkToken().hash });
        confirmable = { appId: shared.id, scopeId: shared.scope, changeId: p.changes[0]!.id, origin: 'https://four-eyes.example.com' };
        return rpc.getConfirmation({ ...member(), orgId: app.org, changeId: confirmable.changeId });
      }],
      ['confirmOrigins', async (rpc) => {
        const c = confirmable!;
        const nonce = nonceOf(await originConfirmDigest({ signer: env.SIGNER_ACCOUNT, env: env.ENV_NAME, orgId: app.org, appId: c.appId, scopeId: c.scopeId, changes: [{ changeId: c.changeId, origin: c.origin }] }));
        const who = member();
        const r = await rpc.confirmOrigins({ ...who, orgId: app.org, appId: c.appId, changeIds: [c.changeId], stepUpJwt: await stepUp(nonce) });
        const removal = linkToken();
        await adminRpc().armConfirmationLinks({ ...system(), requestId: who.requestId, removals: [{ changeId: c.changeId, removalTokenHash: await removal.hash }] });
        await adminRpc().ackConfirmationNotice({ ...system(), requestId: who.requestId });
        removalToken = removal.token;
        return r;
      }],
      ['removalPreview', (rpc) => rpc.removalPreview({ ...link(confirmable!.changeId), changeId: confirmable!.changeId, token: removalToken! })],
      ['removeOriginByLink', (rpc) => rpc.removeOriginByLink({ ...link(confirmable!.changeId), changeId: confirmable!.changeId, token: removalToken! })],
      ['getUser', async (rpc) => {
        const userId = `u1_${'E'.repeat(21)}A`;
        await env.DB.prepare('INSERT OR IGNORE INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, 1, 1)').bind(`hu_${'1'.repeat(26)}`, userId, '11111111', app.scope).run();
        return rpc.getUser({ ...member(), orgId: app.org, userId });
      }],
      // D925: a person of a marked scope of the org, across its apps (one SELECT; the limits are RateLimiter objects).
      ['linkUser', async (rpc) => {
        const shared = await seedApp({ sharedScope: true });
        await env.DB.prepare('UPDATE scopes SET org_id = ?2 WHERE scope_id = ?1').bind(shared.scope, app.org).run();
        const userId = `u1_${'F'.repeat(21)}A`;
        await env.DB.prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, 1, 1)').bind(`hu_${'2'.repeat(26)}`, userId, '22222222', shared.scope).run();
        await env.DB.prepare('INSERT INTO end_user_apps (user_id, app_id, app_sub, support_code, first_seen_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, 1, 1)').bind(`hu_${'2'.repeat(26)}`, shared.id, `u1_${'G'.repeat(21)}A`, '33333333').run();
        return rpc.linkUser({ ...member(), orgId: app.org, query: `u1_${'G'.repeat(21)}A`, purpose: 'search' });
      }],
    ];
    expect(new Set(calls.map(([m]) => m))).toEqual(new Set(Object.keys(CONSOLE_COSTS)));
    for (const [method, run] of calls) {
      clock.advance(5000); // a refilled budget for each call
      const count: DbCount = { reads: 0, batches: 0, statements: 0 };
      expect(await run(counted((c, e) => new ConsoleRpc(c, { ...e, PARTNER_LABELS: 'on' }), count)), method).toMatchObject({ ok: true });
      expect(count.reads, method).toBeLessThanOrEqual(2);
      expect(count.batches, method).toBeLessThanOrEqual(1);
      expect(count.statements - count.reads, method).toBeLessThanOrEqual(8);
      expect(count.statements, method).toBeLessThanOrEqual(CONSOLE_COSTS[method]);
    }
  });

  it('one org can’t starve another: per-org buckets under the global one; the bucket refills with time', async () => {
    const clock = ownClock({ freeze: true });
    const a = await orgApp();
    const b = await orgApp();
    const rpc = consoleRpc();
    let ok = 0;
    let refused: unknown;
    for (let k = 0; k < 41 && !refused; k++) {
      const r = await rpc.listApps({ ...member(), orgId: a.org });
      if (r.ok) ok++;
      else refused = r;
    }
    // Org A's burst (40); D937: no reserve (kill switches have buckets of their own).
    expect(ok).toBe(40);
    expect(refused).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(await rows("SELECT id FROM security_events WHERE kind = 'breaker' AND org_id = ?1", a.org)).toHaveLength(0);
    // Org B is unaffected, and org A's kill switches still pass on its kill bucket.
    expect(await rpc.listApps({ ...member(), orgId: b.org })).toMatchObject({ ok: true });
    expect(await rpc.setSuspended({ ...member(), orgId: a.org, appId: a.id, suspended: true })).toMatchObject({ ok: true });
    expect(await rpc.turnOff({ ...member(), orgId: a.org, appId: a.id, what: 'policy', expectedVersion: 0 })).toMatchObject({ ok: true });
    clock.advance(2000); // 20 tokens again
    expect(await rpc.listApps({ ...member(), orgId: a.org })).toMatchObject({ ok: true });
  });

  it('kill switches keep working when many orgs flood reads: they never touch the ordinary buckets (D937)', async () => {
    ownClock({ freeze: true });
    const rpc = consoleRpc();
    let refusedGlobal = false;
    // The global bucket (60) refuses ordinary calls after 60, whichever orgs make them.
    for (let o = 0; o < 4 && !refusedGlobal; o++) {
      const app = await orgApp();
      for (let k = 0; k < 20; k++) {
        const r = await rpc.listApps({ ...member(), orgId: app.org });
        if (!r.ok) {
          refusedGlobal = true;
          break;
        }
      }
    }
    expect(refusedGlobal).toBe(true);
    const victim = await orgApp();
    expect(await rpc.getApp({ ...member(), orgId: victim.org, appId: victim.id })).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(await rpc.setSuspended({ ...member(), orgId: victim.org, appId: victim.id, suspended: true })).toMatchObject({ ok: true, suspendedBy: 4 });
  });

  it('an emailed-link flood has its own per-IP limit and link-read budget and never touches the members’ budget or kill switches', async () => {
    ownClock({ freeze: true });
    const app = await orgApp({ origins: [ORIGIN, SECOND] });
    const rpc = consoleRpc();
    const flood = (ip: string) => rpc.cancelChangeByLink({ ...link('gc_flood'), clientIp: ip, changeId: 'gc_flood', token: 'A'.repeat(43) });
    // One address: 5 a minute, then rate_limited before the token is read (an unknown change would be not_found).
    for (let k = 0; k < 5; k++) expect(await flood('203.0.113.50')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await flood('203.0.113.50')).toMatchObject({ ok: false, code: 'rate_limited' });
    // IPv6 by /64: another address in the same /64 is the same subject.
    for (let k = 0; k < 5; k++) await flood(`2001:db8:1:2::${k + 1}`);
    expect(await flood('2001:db8:1:2::ff')).toMatchObject({ ok: false, code: 'rate_limited' });
    // Many addresses at once: the link-read budget (burst 100, 10 already taken) protects D1, and refuses the rest.
    const answers = [];
    for (let k = 0; k < 20; k++) for (let j = 0; j < 5; j++) answers.push(await flood(`198.51.${100 + k}.${j + 1}`));
    expect(answers.filter((r) => !r.ok && r.code === 'not_found')).toHaveLength(90);
    expect(answers.filter((r) => !r.ok && r.code === 'rate_limited')).toHaveLength(10);
    // The members' budget is whole: a burst of reads and every kill switch still pass.
    for (let k = 0; k < 20; k++) expect(await rpc.listApps({ ...member(), orgId: app.org }), `read ${k}`).toMatchObject({ ok: true });
    expect(await rpc.removeOrigins({ ...member(), orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 0 })).toMatchObject({ ok: true });
    expect(await rpc.setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: true })).toMatchObject({ ok: true });
  });

  it('a many-address flood of bogus tokens can’t block a cancel whose token verifies', async () => {
    const clock = ownClock({ freeze: true });
    const app = await orgApp();
    const c = await adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: ['https://victim.example.com'], expectedVersion: 0 });
    if (!c.ok) throw new Error(c.code);
    const changeId = c.changes[0]!.id;
    const { token, hash } = linkToken();
    expect(await adminRpc().ackNotice({ ...system(), changeId, cancelTokenHash: await hash })).toMatchObject({ ok: true });
    const rpc = consoleRpc();
    // 30 addresses, each within its own limit (5), at 100 attempts a second (twice the link-read rate) against the change itself with a wrong
    // token: far past the old global link bucket (burst 20), all answered at the token check.
    let answered = 0;
    for (let k = 0; k < 30; k++) {
      for (let j = 0; j < 5; j++) {
        clock.advance(10);
        const r = await rpc.cancelChangeByLink({ ...link(changeId), clientIp: `203.0.${k}.${j + 1}`, changeId, token: 'B'.repeat(43) });
        expect(r).toMatchObject({ ok: false, code: 'forbidden' });
        answered++;
      }
    }
    expect(answered).toBe(150);
    // The token holder, from an address of their own, still cancels.
    expect(await rpc.cancelChangeByLink({ ...link(changeId), clientIp: '192.0.2.77', changeId, token })).toMatchObject({ ok: true, change: { status: 'cancelled' } });
  });

  it('one org’s flood of kill switches that change nothing costs only its own kill bucket: another org’s real suspend works (D937)', async () => {
    ownClock({ freeze: true });
    const rpc = consoleRpc();
    // Ordinary calls of two orgs empty the global bucket (60).
    for (const n of [40, 20]) {
      const o = await orgApp();
      for (let k = 0; k < n; k++) expect(await rpc.listApps({ ...member(), orgId: o.org })).toMatchObject({ ok: true });
    }
    expect(await rpc.listApps({ ...member(), orgId: (await orgApp()).org })).toMatchObject({ ok: false, code: 'rate_limited' });
    // Org A suspends its app once, then floods no-ops on it until its own kill bucket refuses: already suspended,
    // nothing to turn off, an unknown key, an unknown app. Nothing is given back.
    const a = await orgApp();
    expect(await rpc.setSuspended({ ...member(), orgId: a.org, appId: a.id, suspended: true })).toMatchObject({ ok: true, suspendedBy: 4 });
    const flood = [
      () => rpc.setSuspended({ ...member(), orgId: a.org, appId: a.id, suspended: true }),
      () => rpc.turnOff({ ...member(), orgId: a.org, appId: a.id, what: 'raw_sign', expectedVersion: 0 }),
      () => rpc.revokeKey({ ...member(), orgId: a.org, appId: a.id, keyId: 'key_none' }),
      () => rpc.removeOrigins({ ...member(), orgId: a.org, appId: 'app_none', remove: [SECOND], expectedVersion: 0 }),
    ];
    let refused = false;
    for (let k = 0; k < 40 && !refused; k++) refused = (await flood[k % flood.length]!()).ok === false && (await rpc.setSuspended({ ...member(), orgId: a.org, appId: a.id, suspended: true })).ok === false;
    expect(refused).toBe(true);
    // Org B's real suspend still passes, and its kill bucket is whole.
    const b = await orgApp();
    expect(await rpc.setSuspended({ ...member(), orgId: b.org, appId: b.id, suspended: true })).toMatchObject({ ok: true, suspendedBy: 4 });
  });

  it('the rpc log carries the method, the org and the actor kind, never the input', async () => {
    ownClock();
    const app = await orgApp();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => void lines.push(l));
    await consoleRpc().listApps({ ...member(), orgId: app.org });
    const rpcLine = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === 'rpc');
    expect(rpcLine).toMatchObject({ method: 'listApps', orgId: app.org, actorKind: 'member', outcome: 'ok' });
    expect(JSON.stringify(rpcLine)).not.toContain('owner@partner.example');
  });
});

describe('the breaker’s refunds and its event', () => {
  beforeEach(() => {
    clk = ownClock();
  });

  it('a destructive call that changed nothing gets its slot back (not_found, conflict, version_conflict)', async () => {
    const app = await orgApp({ origins: [ORIGIN, SECOND] });
    const rpc = consoleRpc(clk);
    for (let k = 0; k < 3; k++) expect(await rpc.removeOrigins({ ...member(), orgId: app.org, appId: 'app_none', remove: [SECOND], expectedVersion: 0 })).toMatchObject({ code: 'not_found' });
    expect(await rpc.removeOrigins({ ...member(), orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 9 })).toMatchObject({ code: 'version_conflict' });
    expect(await rpc.rotateKey({ ...member(), orgId: app.org, appId: app.id, keyId: 'key_none' })).toMatchObject({ code: 'not_found' });
    expect(await rpc.revokeKey({ ...member(), orgId: app.org, appId: app.id, keyId: 'key_none' })).toMatchObject({ code: 'not_found' });
    // So five real destructive calls fit in the hour, and the sixth doesn't.
    const others = await Promise.all([1, 2, 3, 4, 5, 6].map(() => orgApp({ org: app.org })));
    const liveKey = async (appId: string) => (await rows<{ id: string }>('SELECT id FROM app_keys WHERE app_id = ?1 AND revoked_at IS NULL', appId))[0]!.id;
    for (const o of others.slice(0, 5)) expect(await rpc.rotateKey({ ...member(), orgId: app.org, appId: o.id, keyId: await liveKey(o.id) })).toMatchObject({ ok: true });
    expect(await rpc.rotateKey({ ...member(), orgId: app.org, appId: others[5]!.id, keyId: await liveKey(others[5]!.id) })).toMatchObject({ ok: false, code: 'rate_limited' });
  });

  it('a web-client change is counted by the breaker', async () => {
    const app = await orgApp();
    const { chain } = await import('./helpers.ts');
    const near = chain();
    near.views.get_scope = (a) => ({ id: a.scope_id, owners: [], clients: [['google', 'c1.apps.googleusercontent.com'], ['google', 'c2.apps.googleusercontent.com']], pending: [], action_nonce: 0, allow_shared: false });
    const rpc = consoleRpc(clk);
    let v = 0;
    for (let k = 0; k < 5; k++) {
      expect(await rpc.updateSettings({ ...member(), orgId: app.org, appId: app.id, expectedVersion: v, googleWebClientId: k % 2 ? 'c1.apps.googleusercontent.com' : 'c2.apps.googleusercontent.com' })).toMatchObject({ ok: true });
      v++;
    }
    expect(await rpc.updateSettings({ ...member(), orgId: app.org, appId: app.id, expectedVersion: v, googleWebClientId: null })).toMatchObject({ ok: false, code: 'rate_limited' });
    // Other settings aren't counted.
    expect(await rpc.updateSettings({ ...member(), orgId: app.org, appId: app.id, expectedVersion: v, persistence: 'none' })).toMatchObject({ ok: true });
  });

  it('the breaker event is written once an hour: later refusals cost no write', async () => {
    const org = newOrg();
    const apps = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(() => orgApp({ org })));
    const liveKey = async (appId: string) => (await rows<{ id: string }>('SELECT id FROM app_keys WHERE app_id = ?1 AND revoked_at IS NULL', appId))[0]!.id;
    const rpc = consoleRpc(clk);
    const rotate = async (appId: string) => rpc.rotateKey({ ...member(), orgId: org, appId, keyId: await liveKey(appId) });
    for (const a of apps.slice(0, 5)) expect(await rotate(a.id)).toMatchObject({ ok: true });
    expect(await rotate(apps[5]!.id)).toMatchObject({ code: 'rate_limited' });
    expect(await rows("SELECT id FROM security_events WHERE kind = 'breaker' AND org_id = ?1", org)).toHaveLength(1);
    // Delete the row: a second refusal in the same hour doesn't write it again (the limiter object remembers).
    await env.DB.prepare("DELETE FROM security_events WHERE kind = 'breaker' AND org_id = ?1").bind(org).run();
    expect(await rotate(apps[6]!.id)).toMatchObject({ code: 'rate_limited' });
    expect(await rows("SELECT id FROM security_events WHERE kind = 'breaker' AND org_id = ?1", org)).toHaveLength(0);
  });
});

describe('replays, the legacy org and the notice ack', () => {
  beforeEach(() => {
    clk = ownClock();
  });

  it('a request id reused for another write is conflict, not already_applied', async () => {
    const app = await orgApp({ origins: [ORIGIN, SECOND] });
    const c = member();
    expect(await consoleRpc(clk).removeOrigins({ ...c, orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 0 })).toMatchObject({ ok: true });
    // Same id, another kind of write.
    expect(await consoleRpc(clk).setSuspended({ ...c, orgId: app.org, appId: app.id, suspended: true })).toMatchObject({ ok: false, code: 'conflict' });
    // Same id, same kind, another app.
    const other = await orgApp({ org: app.org, origins: [ORIGIN, SECOND] });
    expect(await consoleRpc(clk).removeOrigins({ ...c, orgId: app.org, appId: other.id, remove: [SECOND], expectedVersion: 0 })).toMatchObject({ ok: false, code: 'conflict' });
    // Same id, same write, another actor.
    expect(await consoleRpc(clk).removeOrigins({ ...member(), requestId: c.requestId, orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 1 })).toMatchObject({ ok: false, code: 'conflict' });
    // The same call again: already_applied.
    expect(await consoleRpc(clk).removeOrigins({ ...c, orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 1 })).toMatchObject({ ok: false, code: 'already_applied' });
    expect((await appRow(other.id)).origins_version).toBe(0);
  });

  it('ConsoleRpc never acts for org_legacy', async () => {
    expect(await consoleRpc(clk).listApps({ ...member(), orgId: 'org_legacy' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await adminRpc().listApps({ ...hana(), orgId: 'org_legacy' })).toMatchObject({ ok: true });
  });

  it('ackNotice takes only the admin Worker’s cron (system)', async () => {
    const app = await orgApp();
    const c = await adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: ['https://ack.example.com'], expectedVersion: 0 });
    if (!c.ok) throw new Error(c.code);
    const { hash } = linkToken();
    expect(await adminRpc().ackNotice({ ...hana(), changeId: c.changes[0]!.id, cancelTokenHash: await hash })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await adminRpc().ackNotice({ ...system(), changeId: c.changes[0]!.id, cancelTokenHash: await hash })).toMatchObject({ ok: true });
  });
});

describe('AdminRpc and the budget', () => {
  it('AdminRpc is neither charged nor limited', async () => {
    ownClock({ freeze: true });
    const app = await orgApp();
    for (let k = 0; k < 80; k++) expect(await adminRpc().listApps({ ...hana(), orgId: app.org })).toMatchObject({ ok: true });
  });
});

describe('entrypoints', () => {
  beforeEach(() => {
    clk = ownClock();
  });

  it('ConsoleRpc and AdminRpc are not reachable through the public fetch', async () => {
    for (const path of ['/ConsoleRpc/listApps', '/AdminRpc/createApp', '/rpc', '/v1/rpc/listApps', '/v1/admin/createApp']) {
      for (const method of ['GET', 'POST']) {
        const res = await call(path, { method, ...(method === 'POST' ? { body: { orgId: 'org_x' } } : {}) });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
  });

  it('ConsoleRpc has none of AdminRpc’s staff methods', () => {
    const consoleMethods = Object.getOwnPropertyNames(ConsoleRpc.prototype);
    // proposeChange is on both: a member's (with the step-up) and a staff proposal.
    for (const m of ['createApp', 'assignScopeOrg', 'deleteApp', 'suspendOrg', 'addOrigins', 'expediteChange', 'pendingNotices', 'ackNotice', 'setSecurityContacts', 'getSecurityContacts', 'listScopes', 'changesSince', 'securityEvents', 'markSecurityEventNotified', 'relayerKeys', 'governance', 'appNames']) {
      expect(consoleMethods, m).not.toContain(m);
      expect(Object.getOwnPropertyNames(AdminRpc.prototype), m).toContain(m);
    }
  });

  it('each entrypoint takes only its own actors; a bad input is bad_request', async () => {
    const app = await orgApp();
    expect(await consoleRpc(clk).listApps({ ...hana(), orgId: app.org })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await adminRpc().listApps({ ...member(), orgId: app.org })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await adminRpc().createApp({ ...system(), orgId: app.org, scopeId: 's1', environment: 'test', name: 'x', origins: [], orgOwnerSubs: [] })).toMatchObject({ ok: false, code: 'forbidden' });
    // The admin watcher's reads (C8, D282): listApps and getApp take the cron's system actor; writes don't.
    expect(await adminRpc().listApps({ ...system(), orgId: app.org })).toMatchObject({ ok: true });
    expect(await adminRpc().getApp({ ...system(), orgId: app.org, appId: app.id })).toMatchObject({ ok: true });
    expect(await adminRpc().revokeKey({ ...system(), orgId: app.org, appId: app.id, keyId: 'key_x' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await consoleRpc(clk).cancelChangeByLink({ ...member(), changeId: 'gc_x', token: 'A'.repeat(43) })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await consoleRpc(clk).listApps({ ...member(), orgId: app.org, extra: 1 })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await consoleRpc(clk).listApps({ ...member(), orgId: 'not-an-org' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await consoleRpc(clk).listApps(null)).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('org A asking for org B’s app is not_found on every ConsoleRpc org method, and nothing is written', async () => {
    const near = ownerChain();
    const b = await orgApp({ origins: [ORIGIN, SECOND] });
    const a = await orgApp();
    const key = (await rows<{ id: string }>('SELECT id FROM app_keys WHERE app_id = ?1', b.id))[0]!.id;
    const staff = await adminRpc().addOrigins({ ...hana(), orgId: b.org, appId: b.id, add: ['https://p.example.com'], expectedVersion: 0 });
    if (!staff.ok) throw new Error(staff.code);
    const before = await ledgerCount();
    const rpc = consoleRpc(clk);
    const as = { orgId: a.org, appId: b.id };
    const answers = {
      getApp: await rpc.getApp({ ...member(), ...as }),
      removeOrigins: await rpc.removeOrigins({ ...member(), ...as, remove: [SECOND], expectedVersion: 1 }),
      turnOff: await rpc.turnOff({ ...member(), ...as, what: 'policy', expectedVersion: 0 }),
      updateSettings: await rpc.updateSettings({ ...member(), ...as, expectedVersion: 0, persistence: 'none' }),
      setLogo: await rpc.setLogo({ ...member(), ...as, logoKey: null, expectedVersion: 0 }),
      cancelChange: await rpc.cancelChange({ ...member(), orgId: a.org, changeId: staff.changes[0]!.id }),
      setSuspended: await rpc.setSuspended({ ...member(), ...as, suspended: true }),
      createKey: await rpc.createKey({ ...member(), ...as }),
      rotateKey: await rpc.rotateKey({ ...member(), ...as, keyId: key }),
      revokeKey: await rpc.revokeKey({ ...member(), ...as, keyId: key }),
      // Batch C6: with tokens valid for org B's app and scope.
      changeOrigins: await rpc.changeOrigins({
        ...member(),
        ...as,
        add: ['https://c6.example.com'],
        remove: [],
        expectedVersion: 1,
        stepUpJwt: await stepUp(nonceOf(await originChangeDigest({ signer: env.SIGNER_ACCOUNT, appId: b.id, add: ['https://c6.example.com'], remove: [], originsVersion: 1 }))),
      }),
      proposeChange: await rpc.proposeChange({
        ...member(),
        ...as,
        kind: 'raw_sign_on',
        expectedVersion: 0,
        stepUpJwt: await stepUp(nonceOf(await settingsChangeDigest({ signer: env.SIGNER_ACCOUNT, appId: b.id, kind: 'raw_sign_on', settingsVersion: 0 }))),
      }),
      ownerAction: await rpc.ownerAction({
        ...member(),
        orgId: a.org,
        body: {
          method: 'cancel_change',
          args: { scope_id: b.scope, change_id: 2, auth: { Oidc: { jwt: await stepUp(await ownerActionNonce({ signer: env.SIGNER_ACCOUNT, method: 'cancel_change', args: { scope_id: b.scope, change_id: 2 }, actionNonce: 4 })) } } },
        },
      }),
    };
    for (const [m, r] of Object.entries(answers)) expect(r, m).toMatchObject({ ok: false, code: 'not_found' });
    expect(near.sent).toEqual([]);
    expect(await rpc.listApps({ ...member(), orgId: a.org })).toMatchObject({ ok: true, apps: [{ id: a.id }] });
    const changes = await rpc.listChanges({ ...member(), orgId: a.org, limit: 200 });
    expect(changes.ok && changes.changes.every((c) => c.orgId === a.org)).toBe(true);
    expect(await ledgerCount()).toBe(before);
    expect(await getAppByKey(env.DB, b.key)).not.toBeNull();
  });
});
