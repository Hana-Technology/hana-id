// The admin Worker's ops store (src/ops.ts) on the usage ledger's real migrations (apps/api/migrations-usage), run as
// the usage_admin role exactly as the admin Hyperdrive config connects: the feed cursors in ops.state persist and
// update, the watcher's snapshots replace, a scope_watch row keeps its first notified time; and the role can't touch
// the ledger's tables beyond its grants.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, failure, freshDb } from '../../api/test-usage/db.ts';
import { type OpsStore, sqlOps } from '../src/ops.ts';

let db: TestDb;
let ops: OpsStore;

beforeAll(async () => {
  db = await freshDb();
  ops = sqlOps((sql, params) => db.asRole('usage_admin', () => db.query(sql, params)));
});
afterAll(async () => {
  await db.close();
});

describe('ops.state (the feed and watcher cursors)', () => {
  it('reads nothing for unknown keys, then upserts with updated_at; a new store over the same database reads it back', async () => {
    expect((await ops.getState(['feed.app_changes.seq'])).size).toBe(0);
    await ops.setState('feed.app_changes.seq', '41');
    const first = (await ops.getState(['feed.app_changes.seq', 'other'])).get('feed.app_changes.seq')!;
    expect(first.value).toBe('41');
    expect(first.updatedAt).toBeGreaterThan(Date.now() - 60_000);
    await ops.setState('feed.app_changes.seq', '42');
    const restarted = sqlOps((sql, params) => db.asRole('usage_admin', () => db.query(sql, params)));
    expect((await restarted.getState(['feed.app_changes.seq'])).get('feed.app_changes.seq')!.value).toBe('42');
    const rows = await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM ops.state WHERE key = 'feed.app_changes.seq'");
    expect(rows[0]!.n).toBe('1');
  });
});

describe('ops.scope_snapshot and ops.scope_watch (the watcher)', () => {
  it('stores and replaces a snapshot (owners, clients, allow_shared, seen_at)', async () => {
    expect(await ops.getSnapshot('s1')).toBeNull();
    await ops.putSnapshot('s1', { owners: [{ Oidc: { provider: 'google', sub: 'a' } }], clients: [['google', 'c1']], allowShared: false }, 1_800_000_000_000);
    expect(await ops.getSnapshot('s1')).toEqual({ owners: [{ Oidc: { provider: 'google', sub: 'a' } }], clients: [['google', 'c1']], allowShared: false, seenAt: 1_800_000_000_000 });
    await ops.putSnapshot('s1', { owners: [], clients: [], allowShared: true }, 1_800_000_060_000);
    expect(await ops.getSnapshot('s1')).toMatchObject({ owners: [], clients: [], allowShared: true, seenAt: 1_800_000_060_000 });
  });

  it('records a pending change when first seen; marks it notified once and keeps that first time', async () => {
    await ops.markWatch('s1', 7, 1_800_000_000_000, null);
    expect(await ops.watchRows('s1')).toEqual([{ changeId: 7, notifiedAt: null }]);
    await ops.markWatch('s1', 7, 1_800_000_100_000, 1_800_000_200_000);
    await ops.markWatch('s1', 7, 1_800_000_300_000, 1_800_000_400_000);
    expect(await ops.watchRows('s1')).toEqual([{ changeId: 7, notifiedAt: 1_800_000_200_000 }]);
    const first = await db.query<{ first_seen_at: Date }>("SELECT first_seen_at FROM ops.scope_watch WHERE scope_id = 's1' AND change_id = 7");
    expect(new Date(first[0]!.first_seen_at).getTime()).toBe(1_800_000_000_000);
    expect(await ops.watchRows('s2')).toEqual([]);
  });
});

describe('the usage_admin role', () => {
  it('can write ops but not the ledger’s events', async () => {
    expect(await failure(db.asRole('usage_admin', () => db.query("INSERT INTO ops.state (key, value) VALUES ('x', 'y')")))).toBeNull();
    expect(await failure(db.asRole('usage_admin', () => db.query('DELETE FROM usage.events')))).not.toBeNull();
    expect(await failure(db.asRole('usage_admin', () => db.query("UPDATE usage.events SET code = 'x'")))).not.toBeNull();
  });
});
