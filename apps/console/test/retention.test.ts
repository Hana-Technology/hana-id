// StaffRpc.purgeAudit (batch C13, D90; docs/batch-c-spec.md "Retention"): audit_log rows and closed owner grants older
// than 60 months, in batches; never a younger row (the trigger and the clamp), never an open grant; the admin Worker's
// monthly job only (a `system` actor).
import { describe, expect, it } from 'vitest';
import { db, hana, member, rid, seedOrg, staffRpc, system, uid } from './helpers.ts';

const MONTH = 30.44 * 86_400_000;
const now = () => Date.now();

async function auditRow(at: number): Promise<number> {
  const r = await db
    .prepare("INSERT INTO audit_log (at, actor_kind, actor_id, action, details_json, request_id, outcome) VALUES (?, 'system', 'test', 'invite.expired', '{}', ?, 'ok') RETURNING seq")
    .bind(at, rid())
    .first<{ seq: number }>();
  return r!.seq;
}
const auditExists = async (seq: number) => !!(await db.prepare('SELECT 1 AS x FROM audit_log WHERE seq = ?').bind(seq).first());

async function grant(orgId: string, o: { createdAt: number; appliedAt?: number; cancelledAt?: number }): Promise<string> {
  const id = `og_${uid()}`;
  await db
    .prepare("INSERT INTO owner_grants (id, org_id, user_id, granted_by_kind, granted_by, created_at, applied_at, cancelled_at, cancelled_by) VALUES (?, ?, ?, 'hana', 'staff', ?, ?, ?, ?)")
    .bind(id, orgId, `usr_${uid()}`, o.createdAt, o.appliedAt ?? null, o.cancelledAt ?? null, o.cancelledAt ? 'test' : null)
    .run();
  return id;
}
const grantExists = async (id: string) => !!(await db.prepare('SELECT 1 AS x FROM owner_grants WHERE id = ?').bind(id).first());

describe('StaffRpc.purgeAudit', () => {
  it('only the admin Worker’s cron: staff and members are forbidden; limits are checked', async () => {
    for (const actor of [hana(), member()]) expect(await staffRpc().purgeAudit({ ...actor, before: now(), limit: 10 })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await staffRpc().purgeAudit({ ...system(), before: now(), limit: 0 })).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('deletes audit rows older than 60 months in batches, never a younger one even with `before` now', async () => {
    const old = [await auditRow(now() - 70 * MONTH), await auditRow(now() - 65 * MONTH), await auditRow(now() - 61 * MONTH)];
    const young = await auditRow(now() - 59 * MONTH);
    const first = await staffRpc().purgeAudit({ ...system(), before: now(), limit: 2 });
    expect(first).toEqual({ ok: true, auditLog: 2, ownerGrants: 0 });
    const second = await staffRpc().purgeAudit({ ...system(), before: now(), limit: 2 });
    expect(second).toMatchObject({ ok: true, auditLog: 1 });
    for (const s of old) expect(await auditExists(s)).toBe(false);
    expect(await auditExists(young)).toBe(true);
    expect(await staffRpc().purgeAudit({ ...system(), before: now(), limit: 2 })).toMatchObject({ ok: true, auditLog: 0 });
  });

  it('deletes owner grants applied or cancelled more than 60 months ago; an open grant stays whatever its age', async () => {
    const org = await seedOrg();
    const applied = await grant(org, { createdAt: now() - 70 * MONTH, appliedAt: now() - 69 * MONTH });
    const cancelled = await grant(org, { createdAt: now() - 70 * MONTH, cancelledAt: now() - 61 * MONTH });
    const recent = await grant(org, { createdAt: now() - 70 * MONTH, appliedAt: now() - 59 * MONTH });
    const open = await grant(org, { createdAt: now() - 70 * MONTH });
    const r = await staffRpc().purgeAudit({ ...system(), before: now(), limit: 500 });
    expect(r).toMatchObject({ ok: true, ownerGrants: 2 });
    expect(await Promise.all([applied, cancelled, recent, open].map(grantExists))).toEqual([false, false, true, true]);
  });
});
