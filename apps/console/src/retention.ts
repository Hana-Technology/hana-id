// CONSOLE_DB's part of retention (D90; docs/batch-c-spec.md "Retention"; batch C13): `StaffRpc.purgeAudit`, called only
// by the admin Worker's monthly job (a `system` actor). Audit rows and owner grants are kept 60 months: `audit_log` rows
// older than min(before, 60 months ago) (the table's trigger refuses a younger one anyway), and grants closed (applied
// or cancelled) that long ago. An open grant stays whatever its age. One D1 batch, `limit` rows of each table at most.
// The hourly housekeeping purges (sessions, flows, invites, logos) are not retention and stay in cron.ts.
import type { ConsolePurgeAuditResult } from '@hana-id/console-core';
import { lit } from './sql.ts';

export async function purgeAudit(db: D1Database, i: { before: number; limit: number }): Promise<ConsolePurgeAuditResult> {
  const cutoff = `MIN(${lit(i.before)}, unixepoch('now', '-60 months') * 1000)`;
  const closedAt = 'COALESCE(applied_at, cancelled_at)';
  const [audit, grants] = await db.batch([
    db.prepare(`DELETE FROM audit_log WHERE seq IN (SELECT seq FROM audit_log WHERE at < ${cutoff} ORDER BY seq LIMIT ${lit(i.limit)})`),
    db.prepare(
      `DELETE FROM owner_grants WHERE id IN (SELECT id FROM owner_grants WHERE (applied_at IS NOT NULL OR cancelled_at IS NOT NULL) AND ${closedAt} < ${cutoff} ORDER BY ${closedAt}, id LIMIT ${lit(i.limit)})`,
    ),
  ]);
  return { auditLog: audit!.meta.changes ?? 0, ownerGrants: grants!.meta.changes ?? 0 };
}
