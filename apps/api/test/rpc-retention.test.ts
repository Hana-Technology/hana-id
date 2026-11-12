// AdminRpc's retention methods (batch C13, D90; docs/batch-c-spec.md "Retention"): purgeAudit (app_changes and
// guarded_changes after 60 months, the drift check's rows kept), deletedApps (30 days after deletion, paged) and
// purgeDirectory (the wallet directory of a scope whose apps were all deleted 30 days ago), purgeUserEvents (migration
// 0013's key exports and mainnet demo signatures after 24 months, and those of a dead scope). The admin Worker's monthly
// job is the only caller: a `system` actor; staff and members are refused. `before` is clamped to each period.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { detectDrift } from '../src/changes/drift.ts';
import { ORIGIN, newKey, uid } from './helpers.ts';
import { adminRpc, hana, member, orgApp, rid, system } from './rpc-helpers.ts';

const DAY = 86_400_000;
const MONTH = 30.44 * DAY;
const now = () => Date.now();
const db = () => env.DB;

async function change(app: { id: string; org: string; scope: string } | null, at: number, kind: string, detail: unknown = {}): Promise<number> {
  const r = await db()
    .prepare("INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'system', 'test', ?7) RETURNING seq")
    .bind(at, app?.org ?? 'org_legacy', app?.id ?? null, app?.scope ?? null, kind, JSON.stringify(detail), rid())
    .first<{ seq: number }>();
  return r!.seq;
}
const changeExists = async (seq: number) => !!(await db().prepare('SELECT 1 AS x FROM app_changes WHERE seq = ?1').bind(seq).first());

async function guarded(appId: string, o: { status: 'pending' | 'active' | 'cancelled' | 'ended'; proposedAt: number; closedAt?: number; origin?: string }): Promise<string> {
  const id = `gc_${uid()}`;
  await db()
    .prepare(
      `INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, ended_at, cancelled_at, request_id)
       VALUES (?1, ?2, 'origin_add', ?3, ?4, 'hana', 'staff', ?5, ?6, ?7, ?8)`,
    )
    .bind(id, appId, o.origin ?? `https://g${uid()}.example`, o.status, o.proposedAt, o.status === 'ended' ? (o.closedAt ?? null) : null, o.status === 'cancelled' ? (o.closedAt ?? null) : null, rid())
    .run();
  return id;
}
const guardedExists = async (id: string) => !!(await db().prepare('SELECT 1 AS x FROM guarded_changes WHERE id = ?1').bind(id).first());
/** A second (test) app in an existing scope of `org`. */
async function appInScope(scope: string, org: string): Promise<{ id: string; scope: string; org: string }> {
  const id = `app_${uid()}`;
  await db().prepare("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, status, plan) VALUES (?1, ?2, ?3, ?4, ?5, 'active', 'free')").bind(id, `Test ${id}`, scope, org, newKey('pk_test_')).run();
  return { id, scope, org };
}
const deleteAppAt = (appId: string, at: number) => db().prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind(appId, at).run();

describe('AdminRpc retention methods: who may call them', () => {
  it('only the admin Worker’s cron (a system actor); staff and members are forbidden', async () => {
    for (const actor of [hana(), member()]) {
      expect(await adminRpc().purgeAudit({ ...actor, before: now(), limit: 10 })).toMatchObject({ ok: false, code: 'forbidden' });
      expect(await adminRpc().deletedApps({ ...actor, before: now() })).toMatchObject({ ok: false, code: 'forbidden' });
      expect(await adminRpc().purgeDirectory({ ...actor, before: now(), limit: 10 })).toMatchObject({ ok: false, code: 'forbidden' });
    }
    expect(await adminRpc().purgeAudit({ ...system(), before: now(), limit: 1001 })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await adminRpc().deletedApps({ ...system(), before: now(), after: 'nope' })).toMatchObject({ ok: false, code: 'bad_request' });
  });
});

describe('AdminRpc.purgeAudit (5 years, D90)', () => {
  it('deletes app_changes older than 60 months, never a younger one even when `before` is now; in batches of `limit`', async () => {
    const app = await orgApp();
    const old = [await change(app, now() - 62 * MONTH, 'key.created'), await change(app, now() - 61 * MONTH, 'settings.updated'), await change(app, now() - 61 * MONTH, 'app.renamed')];
    const young = await change(app, now() - 59 * MONTH, 'key.created');
    const first = await adminRpc().purgeAudit({ ...system(), before: now(), limit: 2 });
    expect(first).toMatchObject({ ok: true });
    expect((first as { appChanges: number }).appChanges).toBe(2);
    const rest = await adminRpc().purgeAudit({ ...system(), before: now(), limit: 500 });
    expect((rest as { appChanges: number }).appChanges).toBeGreaterThanOrEqual(1);
    for (const s of old) expect(await changeExists(s)).toBe(false);
    expect(await changeExists(young)).toBe(true);
    // A `before` further back than 60 months is honoured.
    const older = await change(app, now() - 80 * MONTH, 'key.created');
    const kept = await change(app, now() - 70 * MONTH, 'key.created');
    await adminRpc().purgeAudit({ ...system(), before: now() - 75 * MONTH, limit: 500 });
    expect([await changeExists(older), await changeExists(kept)]).toEqual([false, true]);
  });

  it('keeps the drift check’s rows of a live app with a baseline, so an origin it explains is never reported as drift', async () => {
    const app = await orgApp({ origins: [ORIGIN] });
    const baseline = await change(app, now() - 70 * MONTH, 'migration.baseline', { origins: [ORIGIN] });
    const ended = await change(app, now() - 69 * MONTH, 'policy.removed', {});
    const parts = await change(app, now() - 69 * MONTH, 'settings.updated', { parts: [{ kind: 'raw_sign.off' }] });
    const plain = await change(app, now() - 69 * MONTH, 'key.created');
    await adminRpc().purgeAudit({ ...system(), before: now(), limit: 500 });
    expect([await changeExists(baseline), await changeExists(ended), await changeExists(parts), await changeExists(plain)]).toEqual([true, true, true, false]);
    await detectDrift(env, now());
    expect(await db().prepare("SELECT COUNT(*) AS n FROM security_events WHERE kind = 'drift' AND app_id = ?1").bind(app.id).first<{ n: number }>()).toEqual({ n: 0 });

    // The same rows of an app deleted (drift skips deleted apps) go with the rest.
    const gone = await orgApp();
    const b2 = await change(gone, now() - 70 * MONTH, 'migration.baseline', { origins: [ORIGIN] });
    const e2 = await change(gone, now() - 69 * MONTH, 'origin.removed', { origins: [{ origin: ORIGIN }] });
    await deleteAppAt(gone.id, now() - 65 * MONTH);
    await adminRpc().purgeAudit({ ...system(), before: now(), limit: 500 });
    expect([await changeExists(b2), await changeExists(e2)]).toEqual([false, false]);
  });

  it('deletes guarded changes closed more than 60 months ago and every change of an app deleted that long ago; open ones stay', async () => {
    const app = await orgApp();
    const cancelled = await guarded(app.id, { status: 'cancelled', proposedAt: now() - 70 * MONTH, closedAt: now() - 69 * MONTH });
    const ended = await guarded(app.id, { status: 'ended', proposedAt: now() - 70 * MONTH, closedAt: now() - 61 * MONTH });
    const recentlyEnded = await guarded(app.id, { status: 'ended', proposedAt: now() - 70 * MONTH, closedAt: now() - 59 * MONTH });
    const active = await guarded(app.id, { status: 'active', proposedAt: now() - 70 * MONTH });
    const pending = await guarded(app.id, { status: 'pending', proposedAt: now() - 70 * MONTH });
    // An ended change an origin row still names (a direct edit) stays: nothing dangles.
    const named = await guarded(app.id, { status: 'ended', proposedAt: now() - 70 * MONTH, closedAt: now() - 69 * MONTH, origin: 'https://named.example' });
    await db().prepare('INSERT INTO app_origins (app_id, origin, active_from, change_id) VALUES (?1, ?2, ?3, ?4)').bind(app.id, 'https://named.example', now(), named).run();
    const gone = await orgApp();
    const goneActive = await guarded(gone.id, { status: 'active', proposedAt: now() - 70 * MONTH });
    await deleteAppAt(gone.id, now() - 61 * MONTH);
    const r = await adminRpc().purgeAudit({ ...system(), before: now(), limit: 500 });
    expect((r as { guardedChanges: number }).guardedChanges).toBeGreaterThanOrEqual(3);
    expect(await Promise.all([cancelled, ended, recentlyEnded, active, pending, named, goneActive].map(guardedExists))).toEqual([false, false, true, true, true, true, false]);
  });
});

describe('AdminRpc.deletedApps (the ledger’s app_users purge, 30 days after deletion)', () => {
  it('lists apps deleted 30 days ago or more, oldest first, never younger even with `before` now; pages with next', async () => {
    const t = now();
    const apps = await Promise.all([0, 1, 2, 3].map(() => orgApp()));
    await deleteAppAt(apps[0]!.id, t - 400 * DAY);
    await deleteAppAt(apps[1]!.id, t - 300 * DAY);
    await deleteAppAt(apps[2]!.id, t - 31 * DAY);
    await deleteAppAt(apps[3]!.id, t - 29 * DAY);
    const all: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = (await adminRpc().deletedApps({ ...system(), before: t, limit: 1, ...(after ? { after } : {}) })) as { ok: boolean; appIds: string[]; next?: string; more: boolean };
      expect(r.ok).toBe(true);
      all.push(...r.appIds);
      if (!r.more) {
        // The last page names its own end: from there, nothing is left.
        expect(r.next).toBeDefined();
        expect(await adminRpc().deletedApps({ ...system(), before: t, after: r.next! })).toEqual({ ok: true, appIds: [], more: false });
        break;
      }
      after = r.next;
    }
    const mine = all.filter((id) => apps.some((a) => a.id === id));
    expect(mine).toEqual([apps[0]!.id, apps[1]!.id, apps[2]!.id]);
    // A `before` further back is honoured.
    const r = (await adminRpc().deletedApps({ ...system(), before: t - 350 * DAY })) as { appIds: string[] };
    expect(r.appIds.filter((id) => apps.some((a) => a.id === id))).toEqual([apps[0]!.id]);
  });
});

describe('AdminRpc.purgeDirectory (the wallet directory of a scope left without apps)', () => {
  const user = async (scope: string, n: number) => {
    const userId = `hu_${String(n).padStart(26, '0')}`;
    await db().prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, 1, 2)').bind(userId, `u1_${String(n).padStart(21, 'B')}A`, userId.slice(3, 11).toUpperCase(), scope).run();
    await db().prepare("INSERT INTO end_user_wallets (user_id, chain, address, key_index, first_seen_at, last_used_at) VALUES (?1, 'stellar', ?2, 0, 1, 2)").bind(userId, `G${String(n).padStart(55, 'A')}`).run();
    await db().prepare("INSERT INTO end_user_identities (scope_id, identity_key, user_id, provider, sub, role, status, first_seen_at, observed_at) VALUES (?1, ?2, ?3, 'google', ?4, 'root', 'active', 1, 2)").bind(scope, String(n).padStart(64, '0'), userId, `sub-${n}`).run();
    return userId;
  };
  const userExists = async (userId: string) => {
    const r = await db().prepare('SELECT (SELECT COUNT(*) FROM end_users WHERE user_id = ?1) + (SELECT COUNT(*) FROM end_user_wallets WHERE user_id = ?1) + (SELECT COUNT(*) FROM end_user_identities WHERE user_id = ?1) AS n').bind(userId).first<{ n: number }>();
    return r!.n;
  };

  it('deletes the users, wallets and identities of a scope whose every app was deleted 30 days ago; other scopes keep theirs', async () => {
    const t = now();
    const dead = await orgApp();
    const deadToo = await appInScope(dead.scope, dead.org);
    const recent = await orgApp();
    const mixedLive = await orgApp();
    const mixedGone = await appInScope(mixedLive.scope, mixedLive.org);
    await deleteAppAt(dead.id, t - 90 * DAY);
    await deleteAppAt(deadToo.id, t - 31 * DAY);
    await deleteAppAt(recent.id, t - 10 * DAY);
    await deleteAppAt(mixedGone.id, t - 90 * DAY);
    const deadUsers = [await user(dead.scope, 1001), await user(dead.scope, 1002), await user(dead.scope, 1003)];
    const kept = [await user(recent.scope, 1004), await user(mixedLive.scope, 1005)];
    const first = (await adminRpc().purgeDirectory({ ...system(), before: t, limit: 2 })) as { ok: boolean; scopes: number; users: number; wallets: number; identities: number };
    expect(first).toEqual({ ok: true, scopes: 1, users: 2, wallets: 2, identities: 2, emailConsents: 0, nameShares: 0 });
    const second = (await adminRpc().purgeDirectory({ ...system(), before: t, limit: 2 })) as { users: number };
    expect(second.users).toBe(1);
    for (const u of deadUsers) expect(await userExists(u)).toBe(0);
    for (const u of kept) expect(await userExists(u)).toBe(3);
    expect(((await adminRpc().purgeDirectory({ ...system(), before: t, limit: 2 })) as { users: number }).users).toBe(0);
  });
});

describe('AdminRpc.purgeUserEvents (key exports and mainnet demo signatures: 24 months, readiness 7.17)', () => {
  const internalId = (n: number) => `hu_${String(n).padStart(26, '0')}`;
  const ADDR = '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826';
  /** One row of each kind for `user` at `at`. */
  const events = async (app: { id: string; scope: string }, user: string, at: number): Promise<number[]> => {
    const ids: number[] = [];
    for (const kind of ['key_exported', 'mainnet_signature'] as const) {
      const sig = kind === 'mainnet_signature';
      const r = await db()
        .prepare(
          `INSERT INTO user_events (kind, app_id, scope_id, user_id, chain, network, address, usd_micros, request_id, at)
           VALUES (?1, ?2, ?3, ?4, 'evm', ?5, ?6, ?7, ?8, ?9) RETURNING id`,
        )
        .bind(kind, app.id, app.scope, user, sig ? '8453' : null, sig ? ADDR : null, sig ? 1 : null, rid(), at)
        .first<{ id: number }>();
      ids.push(r!.id);
    }
    return ids;
  };
  const left = async (ids: number[]) => (await db().prepare(`SELECT COUNT(*) AS n FROM user_events WHERE id IN (${ids.map(Number).join(', ')})`).first<{ n: number }>())!.n;
  const purge = (o: { before?: number; deletedBefore?: number; limit?: number } = {}) =>
    adminRpc().purgeUserEvents({ ...system(), before: o.before ?? now(), deletedBefore: o.deletedBefore ?? now(), limit: o.limit ?? 500 }) as Promise<{ ok: boolean; expired: number; deadScopes: number }>;

  it('only the admin Worker’s cron (a system actor); staff and members are forbidden; the input is exact', async () => {
    for (const actor of [hana(), member()]) {
      expect(await adminRpc().purgeUserEvents({ ...actor, before: now(), deletedBefore: now(), limit: 10 })).toMatchObject({ ok: false, code: 'forbidden' });
    }
    expect(await adminRpc().purgeUserEvents({ ...system(), before: now(), limit: 10 })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await adminRpc().purgeUserEvents({ ...system(), before: now(), deletedBefore: now(), limit: 1001 })).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('deletes events older than 24 months, never a younger one even when `before` is now; in batches of `limit`', async () => {
    const app = await orgApp();
    const old = [...(await events(app, internalId(2001), now() - 26 * MONTH)), ...(await events(app, internalId(2002), now() - 24.5 * MONTH))];
    const young = await events(app, internalId(2001), now() - 23 * MONTH);
    expect(await purge({ limit: 3 })).toEqual({ ok: true, expired: 3, deadScopes: 0 });
    expect(await purge()).toEqual({ ok: true, expired: 1, deadScopes: 0 });
    expect([await left(old), await left(young)]).toEqual([0, 2]);
    // A `before` further back than 24 months is honoured.
    const older = await events(app, internalId(2003), now() - 40 * MONTH);
    const kept = await events(app, internalId(2003), now() - 30 * MONTH);
    await purge({ before: now() - 35 * MONTH });
    expect([await left(older), await left(kept), await left(young)]).toEqual([0, 2, 2]);
  });

  it('deletes every event of a scope whose apps were all deleted 30 days ago, whatever its age; other scopes keep theirs', async () => {
    const t = now();
    const dead = await orgApp();
    const deadToo = await appInScope(dead.scope, dead.org);
    const recent = await orgApp();
    const mixedLive = await orgApp();
    const mixedGone = await appInScope(mixedLive.scope, mixedLive.org);
    await deleteAppAt(dead.id, t - 90 * DAY);
    await deleteAppAt(deadToo.id, t - 31 * DAY);
    await deleteAppAt(recent.id, t - 10 * DAY);
    await deleteAppAt(mixedGone.id, t - 90 * DAY);
    const gone = [...(await events(dead, internalId(2101), t - DAY)), ...(await events(deadToo, internalId(2102), t - 2 * DAY))];
    // An app deleted from a scope that still has a live app: its users are still the directory's, so their events stay.
    const kept = [...(await events(recent, internalId(2103), t - DAY)), ...(await events(mixedGone, internalId(2104), t - DAY)), ...(await events(mixedLive, internalId(2104), t - DAY))];
    expect(await purge({ limit: 3 })).toMatchObject({ ok: true, deadScopes: 3 });
    expect(await purge({ limit: 3 })).toMatchObject({ ok: true, deadScopes: 1 });
    expect([await left(gone), await left(kept)]).toEqual([0, kept.length]);
    expect((await purge()).deadScopes).toBe(0);
    // A `deletedBefore` further back is honoured: a scope dead 90 days isn't purged with a 120-day cutoff.
    const later = await orgApp();
    await deleteAppAt(later.id, t - 90 * DAY);
    const notYet = await events(later, internalId(2105), t - DAY);
    expect((await purge({ deletedBefore: t - 120 * DAY })).deadScopes).toBe(0);
    expect(await left(notYet)).toBe(2);
    expect((await purge()).deadScopes).toBe(2);
  });

  it('an env without migration 0013 has nothing to purge: zeros, not a failure', async () => {
    await db().exec('ALTER TABLE user_events RENAME TO user_events_away');
    try {
      expect(await purge()).toEqual({ ok: true, expired: 0, deadScopes: 0 });
    } finally {
      await db().exec('ALTER TABLE user_events_away RENAME TO user_events');
    }
  });
});
