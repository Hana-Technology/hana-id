// Suspension and deletion (docs/batch-c-spec.md "Apps, scopes and client mode"): the bitmask hana = 1 (per app, Hana),
// org = 2 (every app of an org, Hana), partner = 4 (an owner). Active iff 0; clearing one bit never clears another;
// only Hana clears bits 1 and 2 (ConsoleRpc touches bit 4 alone), and Hana may clear any bit, bit 4 after a malicious
// mass suspension included. `apps.status` follows the bitmask by trigger (0006). deleteApp is a soft delete: deleted_at,
// bit 1, every key revoked, pending changes cancelled; never a hard delete, ids never reused.
import { SUSPENSION_BITS } from '@hana-id/console-core';
import { planApp } from './apps.ts';
import { RpcRefusal, type Writer, actorId, commitOn, commitOnApp, committed, runWrite, expectReplay } from './cas.ts';
import type { HotDb } from './db.ts';
import { legacyKeyTombstone } from './keys.ts';
import { q } from './sql.ts';

/**
 * Sets or clears one bit of an app's suspension. Already in that state: nothing written, the bitmask answered. A
 * deleted app is `not_found` (its bit 1 can never be cleared, so it stays suspended for every reader of `status`).
 */
export async function setSuspensionBit(db: HotDb, w: Writer, i: { orgId: string | null; appId: string; bit: 1 | 2 | 4; suspended: boolean }): Promise<{ suspendedBy: number }> {
  expectReplay(w, ['suspension.set', 'suspension.cleared']);
  const plan = await planApp(db, { appId: i.appId, orgId: i.orgId, w });
  const current = plan.app.suspended_by;
  const next = i.suspended ? current | i.bit : current & ~i.bit;
  if (next === current) return { suspendedBy: current };
  const results = await runWrite(db, w, [
    commitOnApp(
      w,
      { kind: i.suspended ? 'suspension.set' : 'suspension.cleared', detail: q`json_object('bit', ${i.bit}, 'suspendedBy', ${i.suspended ? q`a.suspended_by | ${i.bit}` : q`a.suspended_by & ~${i.bit}`})` },
      i.appId,
      i.orgId,
      q`a.deleted_at IS NULL AND a.suspended_by = ${current}`,
    ),
    q`UPDATE apps SET suspended_by = ${i.suspended ? q`suspended_by | ${i.bit}` : q`suspended_by & ~${i.bit}`} WHERE id = ${i.appId} AND ${committed(w.requestId)}`,
    q`SELECT suspended_by FROM apps WHERE id = ${i.appId}`,
  ]);
  return { suspendedBy: (results[2]!.results[0] as { suspended_by: number }).suspended_by };
}

/** AdminRpc.suspendOrg: bit 2 on (or off) for every app of the org that isn't deleted; one `app_changes` row for the org. */
export async function suspendOrg(db: HotDb, w: Writer, i: { orgId: string; suspended: boolean }): Promise<{ apps: number }> {
  expectReplay(w, ['suspension.org_set', 'suspension.org_cleared'], null);
  const bit = SUSPENSION_BITS.org;
  const results = await runWrite(db, w, [
    commitOn(
      w,
      { kind: i.suspended ? 'suspension.org_set' : 'suspension.org_cleared', detail: q`json_object('bit', ${bit}, 'apps', (SELECT COUNT(*) FROM apps WHERE org_id = ${i.orgId} AND deleted_at IS NULL))` },
      { orgId: i.orgId },
      q`EXISTS (SELECT 1 FROM apps WHERE org_id = ${i.orgId} AND deleted_at IS NULL)`,
    ),
    q`UPDATE apps SET suspended_by = ${i.suspended ? q`suspended_by | ${bit}` : q`suspended_by & ~${bit}`} WHERE org_id = ${i.orgId} AND deleted_at IS NULL AND ${committed(w.requestId)}`,
    // The count, not the UPDATE's change count (D1 counts the status trigger's writes too).
    q`SELECT COUNT(*) AS n FROM apps WHERE org_id = ${i.orgId} AND deleted_at IS NULL`,
  ]).catch((e: unknown) => {
    // No app to suspend (the commit predicate) reads as a conflict to runWrite; it is simply zero apps here.
    if (e instanceof RpcRefusal && e.code === 'version_conflict') return null;
    throw e;
  });
  return { apps: results ? (results[2]!.results[0] as { n: number }).n : 0 };
}

/** AdminRpc.deleteApp: soft delete, in one batch. */
export async function deleteApp(db: HotDb, w: Writer, i: { appId: string }): Promise<Record<string, never>> {
  expectReplay(w, ['app.deleted']);
  const plan = await planApp(db, { appId: i.appId, orgId: null, w });
  const notYet = q`(active_from IS NULL OR active_from > ${w.now})`;
  await runWrite(db, w, [
    commitOnApp(w, { kind: 'app.deleted', detail: { name: plan.app.name, scopeId: plan.app.scope_id } }, i.appId, null, q`a.deleted_at IS NULL`),
    q`UPDATE apps SET deleted_at = ${w.now}, suspended_by = suspended_by | ${SUSPENSION_BITS.hana}, publishable_key = ${legacyKeyTombstone(plan.app.environment)}
       WHERE id = ${i.appId} AND ${committed(w.requestId)}`,
    q`UPDATE app_keys SET revoked_at = ${w.now}, revoked_by = ${actorId(w.actor)} WHERE app_id = ${i.appId} AND (revoked_at IS NULL OR revoked_at > ${w.now}) AND ${committed(w.requestId)}`,
    q`UPDATE guarded_changes SET status = 'cancelled', cancelled_by = ${actorId(w.actor)}, cancelled_at = ${w.now}
       WHERE app_id = ${i.appId} AND status = 'pending' AND ${notYet} AND ${committed(w.requestId)}`,
    q`DELETE FROM app_origins WHERE app_id = ${i.appId} AND ${notYet} AND ${committed(w.requestId)}`,
  ]);
  return {};
}
