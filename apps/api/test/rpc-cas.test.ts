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
import { CONSOLE_COSTS, ConsoleRpc } from '../src/rpc/console.ts';
import { ORIGIN, call } from './helpers.ts';
import { nonceOf, originChangeDigest, ownerActionNonce, settingsChangeDigest } from '@hana-id/console-core';
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
  orgApp,
  ownClock,
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

  it('the sixth suspension, revocation, rotation or removal for one org within an hour is refused with a breaker event', async () => {
    const org = newOrg();
    const apps = await Promise.all([1, 2, 3].map(() => orgApp({ org, origins: [ORIGIN, SECOND] })));
    const keyOf = async (appId: string) => (await rows<{ id: string }>('SELECT id FROM app_keys WHERE app_id = ?1 AND revoked_at IS NULL', appId))[0]!.id;
    const rpc = consoleRpc(clk);
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
    const rpc = consoleRpc(clock);
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
    ownerChain();
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
    const calls: [keyof typeof CONSOLE_COSTS, (rpc: ConsoleRpc) => Promise<{ ok: boolean }>][] = [
      ['listApps', (rpc) => rpc.listApps({ ...member(), orgId: app.org })],
      ['getApp', (rpc) => rpc.getApp({ ...member(), orgId: app.org, appId: app.id })],
      ['listChanges', (rpc) => rpc.listChanges({ ...member(), orgId: app.org, limit: 50 })],
      ['removeOrigins', (rpc) => rpc.removeOrigins({ ...member(), orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 2 })],
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
    ];
    expect(new Set(calls.map(([m]) => m))).toEqual(new Set(Object.keys(CONSOLE_COSTS)));
    for (const [method, run] of calls) {
      clock.advance(5000); // a refilled budget for each call
      const count: DbCount = { reads: 0, batches: 0, statements: 0 };
      expect(await run(counted((c, e) => new ConsoleRpc(c, e), count)), method).toMatchObject({ ok: true });
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
    for (let k = 0; k < 40 && !refused; k++) {
      const r = await rpc.listApps({ ...member(), orgId: a.org });
      if (r.ok) ok++;
      else refused = r;
    }
    // Org A's burst (40) less the kill-switch reserve (10).
    expect(ok).toBe(30);
    expect(refused).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(await rows("SELECT id FROM security_events WHERE kind = 'breaker' AND org_id = ?1", a.org)).toHaveLength(0);
    // Org B is unaffected, and org A's kill switches still pass on its reserve.
    expect(await rpc.listApps({ ...member(), orgId: b.org })).toMatchObject({ ok: true });
    expect(await rpc.setSuspended({ ...member(), orgId: a.org, appId: a.id, suspended: true })).toMatchObject({ ok: true });
    expect(await rpc.turnOff({ ...member(), orgId: a.org, appId: a.id, what: 'policy', expectedVersion: 0 })).toMatchObject({ ok: true });
    clock.advance(2000); // 20 tokens: above the reserve again
    expect(await rpc.listApps({ ...member(), orgId: a.org })).toMatchObject({ ok: true });
  });

  it('the global reserve keeps kill switches working when many orgs flood reads', async () => {
    ownClock({ freeze: true });
    const rpc = consoleRpc();
    let refusedGlobal = false;
    // The global bucket (60, 20 reserved for kill switches) refuses ordinary calls after 40, whichever orgs make them.
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

  it('one org’s flood of no-op kill switches can’t drain the global reserve: another org’s real suspend works', async () => {
    ownClock({ freeze: true });
    const rpc = consoleRpc();
    // Ordinary calls of two orgs take the global bucket down to its reserve (60 − 40 = 20).
    for (const n of [30, 10]) {
      const o = await orgApp();
      for (let k = 0; k < n; k++) expect(await rpc.listApps({ ...member(), orgId: o.org })).toMatchObject({ ok: true });
    }
    expect(await rpc.listApps({ ...member(), orgId: (await orgApp()).org })).toMatchObject({ ok: false, code: 'rate_limited' });
    // Org A suspends its app once (a real kill switch, 5 reserve tokens), then floods no-ops on it: already suspended,
    // nothing to turn off, an unknown app. Each gives back what it took of the reserve, charged to org A instead.
    const a = await orgApp();
    expect(await rpc.setSuspended({ ...member(), orgId: a.org, appId: a.id, suspended: true })).toMatchObject({ ok: true, suspendedBy: 4 });
    const flood = [
      () => rpc.setSuspended({ ...member(), orgId: a.org, appId: a.id, suspended: true }),
      () => rpc.turnOff({ ...member(), orgId: a.org, appId: a.id, what: 'raw_sign', expectedVersion: 0 }),
      () => rpc.revokeKey({ ...member(), orgId: a.org, appId: a.id, keyId: 'key_none' }),
      () => rpc.removeOrigins({ ...member(), orgId: a.org, appId: 'app_none', remove: [SECOND], expectedVersion: 0 }),
    ];
    for (let k = 0; k < 40; k++) await flood[k % flood.length]!();
    // Org B's real suspend still finds the reserve.
    const b = await orgApp();
    expect(await rpc.setSuspended({ ...member(), orgId: b.org, appId: b.id, suspended: true })).toMatchObject({ ok: true, suspendedBy: 4 });
  });

  it('one org takes at most its share of the global reserve, even with real kill switches', async () => {
    ownClock({ freeze: true });
    const rpc = consoleRpc();
    for (const n of [30, 10]) {
      const o = await orgApp();
      for (let k = 0; k < n; k++) await rpc.listApps({ ...member(), orgId: o.org });
    }
    const org = newOrg();
    const apps = await Promise.all([1, 2, 3].map(() => orgApp({ org })));
    expect(await rpc.setSuspended({ ...member(), orgId: org, appId: apps[0]!.id, suspended: true })).toMatchObject({ ok: true });
    expect(await rpc.setSuspended({ ...member(), orgId: org, appId: apps[1]!.id, suspended: true })).toMatchObject({ ok: true });
    // A third would take 15 reserve tokens in the minute: over the 12-token share.
    expect(await rpc.setSuspended({ ...member(), orgId: org, appId: apps[2]!.id, suspended: true })).toMatchObject({ ok: false, code: 'rate_limited' });
    expect((await appRow(apps[2]!.id)).suspended_by).toBe(0);
    // The rest of the reserve is still there for another org.
    const other = await orgApp();
    expect(await rpc.setSuspended({ ...member(), orgId: other.org, appId: other.id, suspended: true })).toMatchObject({ ok: true });
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

  it('a destructive call that changed nothing gets its slot back (not_found, conflict, version_conflict, a no-op)', async () => {
    const app = await orgApp({ origins: [ORIGIN, SECOND] });
    const rpc = consoleRpc(clk);
    for (let k = 0; k < 3; k++) expect(await rpc.removeOrigins({ ...member(), orgId: app.org, appId: 'app_none', remove: [SECOND], expectedVersion: 0 })).toMatchObject({ code: 'not_found' });
    expect(await rpc.removeOrigins({ ...member(), orgId: app.org, appId: app.id, remove: [SECOND], expectedVersion: 9 })).toMatchObject({ code: 'version_conflict' });
    expect(await rpc.revokeKey({ ...member(), orgId: app.org, appId: app.id, keyId: 'key_none' })).toMatchObject({ code: 'not_found' });
    expect(await rpc.setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: true })).toMatchObject({ ok: true, suspendedBy: 4 });
    // Already suspended: a no-op, refunded.
    for (let k = 0; k < 3; k++) expect(await rpc.setSuspended({ ...member(), orgId: app.org, appId: app.id, suspended: true })).toMatchObject({ ok: true, suspendedBy: 4 });
    // So four more real destructive calls fit in the hour (5 in all), and the sixth doesn't.
    const others = await Promise.all([1, 2, 3, 4].map(() => orgApp({ org: app.org })));
    for (const o of others) expect(await rpc.setSuspended({ ...member(), orgId: app.org, appId: o.id, suspended: true })).toMatchObject({ ok: true });
    const sixth = await orgApp({ org: app.org });
    expect(await rpc.setSuspended({ ...member(), orgId: app.org, appId: sixth.id, suspended: true })).toMatchObject({ ok: false, code: 'rate_limited' });
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
    const rpc = consoleRpc(clk);
    for (const a of apps.slice(0, 5)) expect(await rpc.setSuspended({ ...member(), orgId: org, appId: a.id, suspended: true })).toMatchObject({ ok: true });
    expect(await rpc.setSuspended({ ...member(), orgId: org, appId: apps[5]!.id, suspended: true })).toMatchObject({ code: 'rate_limited' });
    expect(await rows("SELECT id FROM security_events WHERE kind = 'breaker' AND org_id = ?1", org)).toHaveLength(1);
    // Delete the row: a second refusal in the same hour doesn't write it again (the limiter object remembers).
    await env.DB.prepare("DELETE FROM security_events WHERE kind = 'breaker' AND org_id = ?1").bind(org).run();
    expect(await rpc.setSuspended({ ...member(), orgId: org, appId: apps[6]!.id, suspended: true })).toMatchObject({ code: 'rate_limited' });
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
    for (const m of ['createApp', 'assignScopeOrg', 'deleteApp', 'suspendOrg', 'addOrigins', 'expediteChange', 'pendingNotices', 'ackNotice', 'setSecurityContacts', 'getSecurityContacts', 'listScopes', 'changesSince', 'securityEvents', 'markSecurityEventNotified', 'relayerKeys']) {
      expect(consoleMethods, m).not.toContain(m);
      expect(Object.getOwnPropertyNames(AdminRpc.prototype), m).toContain(m);
    }
  });

  it('each entrypoint takes only its own actors; a bad input is bad_request', async () => {
    const app = await orgApp();
    expect(await consoleRpc(clk).listApps({ ...hana(), orgId: app.org })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await adminRpc().listApps({ ...member(), orgId: app.org })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await adminRpc().createApp({ ...system(), orgId: app.org, scopeId: 's1', environment: 'test', name: 'x', origins: [], orgOwnerSubs: [] })).toMatchObject({ ok: false, code: 'forbidden' });
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
