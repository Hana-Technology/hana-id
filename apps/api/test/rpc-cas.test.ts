// Batch C5 (docs/batch-c-spec.md tests "CAS, breaker, budget" and "Topology and config"): the compare-and-swap writes
// with `app_changes` as the commit point (a replayed request id, a moved version, fault injection on every statement),
// the destructive-call breaker per org and across orgs, the hot-DB budget, the suspension bits by caller, the
// entrypoints unreachable from `fetch`, and org A asking for org B's app getting `not_found` on every org method.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAppByKey } from '../src/apps.ts';
import type { Writer } from '../src/changes/cas.ts';
import { HotDb } from '../src/changes/db.ts';
import { rotateKey } from '../src/changes/keys.ts';
import { removeOrigins } from '../src/changes/origins.ts';
import { AdminRpc } from '../src/rpc/admin.ts';
import { rpcHooks } from '../src/rpc/common.ts';
import { CONSOLE_COSTS, ConsoleRpc } from '../src/rpc/console.ts';
import { ORIGIN, call } from './helpers.ts';
import { adminRpc, appRow, consoleRpc, hana, ledgerCount, linkToken, member, newOrg, orgApp, ownClock, rid, rows, system } from './rpc-helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
  rpcHooks.onDb = undefined;
});

const SECOND = 'https://second.example.com';

describe('compare-and-swap writes', () => {
  beforeEach(() => void ownClock());

  it('a replayed requestId answers already_applied and writes nothing', async () => {
    const app = await orgApp({ origins: [ORIGIN, SECOND] });
    const c = { ...member(), orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 0 };
    expect(await consoleRpc().removeOrigins(c)).toEqual({ ok: true, version: 1 });
    const before = await ledgerCount();
    const again = await consoleRpc().removeOrigins({ ...c, expectedVersion: 1 });
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
    const r = await consoleRpc().removeOrigins({ ...member(), orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 7 });
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
      const db = new HotDb(env.DB);
      db.faultAt = k;
      const w: Writer = { actor: member().actor, requestId: rid(), now: Date.now() };
      await expect(removeOrigins(db, w, { orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 0 })).rejects.toThrow();
      expect(await rows('SELECT seq FROM app_changes WHERE request_id = ?1', w.requestId), `statement ${k}`).toHaveLength(0);
      expect(await rows('SELECT origin FROM app_origins WHERE app_id = ?1', app.id), `statement ${k}`).toHaveLength(2);
      expect((await appRow(app.id)).origins_version, `statement ${k}`).toBe(0);
    }
    for (let k = 0; k < 4; k++) {
      const app = await orgApp();
      const key = (await rows<{ id: string }>('SELECT id FROM app_keys WHERE app_id = ?1', app.id))[0]!;
      const db = new HotDb(env.DB);
      db.faultAt = k;
      const w: Writer = { actor: member().actor, requestId: rid(), now: Date.now() };
      await expect(rotateKey(db, w, { orgId: app.org, appId: app.id, keyId: key.id })).rejects.toThrow();
      expect(await rows('SELECT seq FROM app_changes WHERE request_id = ?1', w.requestId), `statement ${k}`).toHaveLength(0);
      expect(await rows('SELECT id, revoked_at FROM app_keys WHERE app_id = ?1', app.id), `statement ${k}`).toEqual([{ id: key.id, revoked_at: null }]);
    }
  });
});

describe('the destructive-call breaker', () => {
  beforeEach(() => void ownClock());

  it('the sixth suspension, revocation, rotation or removal for one org within an hour is refused with a breaker event', async () => {
    const org = newOrg();
    const apps = await Promise.all([1, 2, 3].map(() => orgApp({ org, origins: [ORIGIN, SECOND] })));
    const keyOf = async (appId: string) => (await rows<{ id: string }>('SELECT id FROM app_keys WHERE app_id = ?1 AND revoked_at IS NULL', appId))[0]!.id;
    const rpc = consoleRpc();
    const calls = [
      () => rpc.setSuspended({ ...member(), orgId: org, appId: apps[0]!.id, suspended: true }),
      async () => rpc.revokeKey({ ...member(), orgId: org, appId: apps[0]!.id, keyId: await keyOf(apps[0]!.id) }),
      async () => rpc.rotateKey({ ...member(), orgId: org, appId: apps[1]!.id, keyId: await keyOf(apps[1]!.id) }),
      () => rpc.removeOrigins({ ...member(), orgId: org, appId: apps[1]!.id, remove: [SECOND], expectedVersion: 0 }),
      () => rpc.setSuspended({ ...member(), orgId: org, appId: apps[2]!.id, suspended: true }),
    ];
    for (const c of calls) expect(await c()).toMatchObject({ ok: true });
    // Not counted: a resume, a turn-off, a cancel, and every AdminRpc call.
    expect(await rpc.setSuspended({ ...member(), orgId: org, appId: apps[2]!.id, suspended: false })).toMatchObject({ ok: true });
    expect(await rpc.turnOff({ ...member(), orgId: org, appId: apps[2]!.id, what: 'policy', expectedVersion: 0 })).toMatchObject({ ok: true });
    expect(await rpc.cancelChange({ ...member(), orgId: org, changeId: 'gc_none' })).toMatchObject({ ok: false, code: 'not_found' });
    for (let k = 0; k < 6; k++) expect(await adminRpc().setSuspended({ ...hana(), appId: apps[2]!.id, bit: 1, suspended: k % 2 === 0 })).toMatchObject({ ok: true });
    const sixth = await rpc.removeOrigins({ ...member(), orgId: org, appId: apps[0]!.id, remove: [SECOND], expectedVersion: 0 });
    expect(sixth).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(await rows('SELECT origin FROM app_origins WHERE app_id = ?1', apps[0]!.id)).toHaveLength(2);
    const events = await rows<{ kind: string; detail_json: string }>("SELECT kind, detail_json FROM security_events WHERE kind = 'breaker' AND org_id = ?1", org);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.detail_json)).toMatchObject({ limit: 'org', perOrg: 5 });
    // A second refusal in the same hour writes no second event.
    expect(await rpc.setSuspended({ ...member(), orgId: org, appId: apps[1]!.id, suspended: true })).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(await rows("SELECT id FROM security_events WHERE kind = 'breaker' AND org_id = ?1", org)).toHaveLength(1);
  });

  it('the 21st across orgs within an hour is refused, with a global breaker event', async () => {
    const clock = ownClock();
    const rpc = consoleRpc();
    for (let k = 0; k < 20; k++) {
      clock.advance(1000); // within the hour, but past the hot-DB budget's burst
      const app = await orgApp();
      expect(await rpc.setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: true }), `call ${k + 1}`).toMatchObject({ ok: true });
    }
    const app = await orgApp();
    expect(await rpc.setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: true })).toMatchObject({ ok: false, code: 'rate_limited' });
    expect((await appRow(app.id)).suspended_by).toBe(0);
    const t = Math.floor(Date.now() / (60 * 60 * 1000)) * 60 * 60 * 1000;
    const events = await rows<{ detail_json: string }>("SELECT detail_json FROM security_events WHERE kind = 'breaker' AND org_id IS NULL AND detected_at >= ?1", t);
    expect(events.map((e) => JSON.parse(e.detail_json).limit)).toEqual(['global']);
  });
});

describe('suspension bits', () => {
  beforeEach(() => void ownClock());

  it('a member sets and clears only bit 4; Hana clears any bit, bit 4 included', async () => {
    const app = await orgApp();
    expect(await adminRpc().setSuspended({ ...hana(), appId: app.id, bit: 1, suspended: true })).toEqual({ ok: true, suspendedBy: 1 });
    expect(await adminRpc().setSuspended({ ...hana(), appId: app.id, bit: 2, suspended: true })).toEqual({ ok: true, suspendedBy: 3 });
    expect(await consoleRpc().setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: true })).toEqual({ ok: true, suspendedBy: 7 });
    // A member's resume clears bit 4 and never bits 1 or 2: the app stays suspended.
    expect(await consoleRpc().setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: false })).toEqual({ ok: true, suspendedBy: 3 });
    expect((await appRow(app.id)).status).toBe('suspended');
    expect(await consoleRpc().setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: true })).toEqual({ ok: true, suspendedBy: 7 });
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
    expect(await consoleRpc().setSuspended({ ...member(), orgId: org, appId: a.id, suspended: false })).toEqual({ ok: true, suspendedBy: 2 });
    expect(await rows("SELECT seq FROM app_changes WHERE org_id = ?1 AND kind = 'suspension.org_set' AND app_id IS NULL", org)).toHaveLength(1);
    expect(await adminRpc().suspendOrg({ ...hana(), orgId: org, suspended: false })).toEqual({ ok: true, apps: 2 });
    expect((await appRow(b.id)).status).toBe('active');
  });
});

describe('the hot-DB budget', () => {
  it('each ConsoleRpc method stays within two reads and one batch of at most eight statements, and its declared cost', async () => {
    ownClock();
    const app = await orgApp({ origins: [ORIGIN, SECOND] });
    const counted: { method: string; db: HotDb }[] = [];
    const rpc = consoleRpc();
    const key = (await rows<{ id: string }>('SELECT id FROM app_keys WHERE app_id = ?1', app.id))[0]!.id;
    const pending = await adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: ['https://pending.example.com'], expectedVersion: 0 });
    if (!pending.ok) throw new Error(pending.code);
    const { token, hash } = linkToken();
    expect(await adminRpc().ackNotice({ ...system(), changeId: pending.changes[0]!.id, cancelTokenHash: await hash })).toMatchObject({ ok: true });
    const pending2 = await adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: ['https://pending2.example.com'], expectedVersion: 1 });
    if (!pending2.ok) throw new Error(pending2.code);
    rpcHooks.onDb = (db, method) => counted.push({ method, db });
    const results: { ok: boolean }[] = [
      await rpc.listApps({ ...member(), orgId: app.org }),
      await rpc.getApp({ ...member(), orgId: app.org, appId: app.id }),
      await rpc.listChanges({ ...member(), orgId: app.org, limit: 50 }),
      await rpc.removeOrigins({ ...member(), orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 2 }),
      await rpc.turnOff({ ...member(), orgId: app.org, appId: app.id, what: 'raw_sign', expectedVersion: 0 }),
      await rpc.updateSettings({ ...member(), orgId: app.org, appId: app.id, expectedVersion: 0, persistence: 'none', name: 'Renamed' }),
      await rpc.setLogo({ ...member(), orgId: app.org, appId: app.id, logoKey: `logos/${app.id}/${'a'.repeat(64)}.png`, expectedVersion: 1 }),
      await rpc.cancelChangeByLink({ ...{ actor: { kind: 'link' as const, id: pending.changes[0]!.id }, requestId: rid(), clientIp: '203.0.113.1' }, changeId: pending.changes[0]!.id, token }),
      await rpc.cancelChange({ ...member(), orgId: app.org, changeId: pending2.changes[0]!.id }),
      await rpc.setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: true }),
      await rpc.createKey({ ...member(), orgId: app.org, appId: app.id }),
      await rpc.rotateKey({ ...member(), orgId: app.org, appId: app.id, keyId: key }),
    ];
    const created = results[10] as unknown as { ok: true; key: { id: string } };
    results.push(await rpc.revokeKey({ ...member(), orgId: app.org, appId: app.id, keyId: created.key.id }));
    for (const [k, r] of results.entries()) expect(r, counted[k]?.method).toMatchObject({ ok: true });
    expect(new Set(counted.map((c) => c.method))).toEqual(new Set(Object.keys(CONSOLE_COSTS)));
    for (const { method, db } of counted) {
      expect(db.reads, method).toBeLessThanOrEqual(2);
      expect(db.batches, method).toBeLessThanOrEqual(1);
      expect(db.statements, method).toBeLessThanOrEqual(CONSOLE_COSTS[method as keyof typeof CONSOLE_COSTS]);
    }
  });

  it('over the budget is rate_limited; the bucket refills with time', async () => {
    const clock = ownClock({ freeze: true });
    const app = await orgApp();
    const rpc = consoleRpc();
    let ok = 0;
    let refused: unknown;
    for (let k = 0; k < 70 && !refused; k++) {
      const r = await rpc.listApps({ ...member(), orgId: app.org });
      if (r.ok) ok++;
      else refused = r;
    }
    expect(ok).toBe(60);
    expect(refused).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(await rows("SELECT id FROM security_events WHERE kind = 'breaker' AND org_id = ?1", app.org)).toHaveLength(0);
    clock.advance(1000);
    expect(await rpc.listApps({ ...member(), orgId: app.org })).toMatchObject({ ok: true });
  });

  it('AdminRpc is neither charged nor limited', async () => {
    ownClock({ freeze: true });
    const app = await orgApp();
    for (let k = 0; k < 80; k++) expect(await adminRpc().listApps({ ...hana(), orgId: app.org })).toMatchObject({ ok: true });
  });
});

describe('entrypoints', () => {
  beforeEach(() => void ownClock());

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
    for (const m of ['createApp', 'assignScopeOrg', 'deleteApp', 'suspendOrg', 'addOrigins', 'proposeChange', 'expediteChange', 'pendingNotices', 'ackNotice', 'setSecurityContacts', 'getSecurityContacts', 'listScopes', 'changesSince', 'securityEvents', 'markSecurityEventNotified', 'relayerKeys']) {
      expect(consoleMethods, m).not.toContain(m);
      expect(Object.getOwnPropertyNames(AdminRpc.prototype), m).toContain(m);
    }
  });

  it('each entrypoint takes only its own actors; a bad input is bad_request', async () => {
    const app = await orgApp();
    expect(await consoleRpc().listApps({ ...hana(), orgId: app.org })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await adminRpc().listApps({ ...member(), orgId: app.org })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await adminRpc().createApp({ ...system(), orgId: app.org, scopeId: 's1', environment: 'test', name: 'x', origins: [], orgOwnerSubs: [] })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await consoleRpc().cancelChangeByLink({ ...member(), changeId: 'gc_x', token: 'A'.repeat(43) })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await consoleRpc().listApps({ ...member(), orgId: app.org, extra: 1 })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await consoleRpc().listApps({ ...member(), orgId: 'not-an-org' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await consoleRpc().listApps(null)).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('org A asking for org B’s app is not_found on every ConsoleRpc org method, and nothing is written', async () => {
    const b = await orgApp({ origins: [ORIGIN, SECOND] });
    const a = await orgApp();
    const key = (await rows<{ id: string }>('SELECT id FROM app_keys WHERE app_id = ?1', b.id))[0]!.id;
    const staff = await adminRpc().addOrigins({ ...hana(), orgId: b.org, appId: b.id, add: ['https://p.example.com'], expectedVersion: 0 });
    if (!staff.ok) throw new Error(staff.code);
    const before = await ledgerCount();
    const rpc = consoleRpc();
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
    };
    for (const [m, r] of Object.entries(answers)) expect(r, m).toMatchObject({ ok: false, code: 'not_found' });
    expect(await rpc.listApps({ ...member(), orgId: a.org })).toMatchObject({ ok: true, apps: [{ id: a.id }] });
    const changes = await rpc.listChanges({ ...member(), orgId: a.org, limit: 200 });
    expect(changes.ok && changes.changes.every((c) => c.orgId === a.org)).toBe(true);
    expect(await ledgerCount()).toBe(before);
    expect(await getAppByKey(env.DB, b.key)).not.toBeNull();
  });
});
