// admin.ts retention:issuer: the email issuer's part of the monthly retention (D90; batch C13, D365), which the admin
// Worker can't do (it has no binding to the issuer's D1, and DirectoryRpc stays read-only, D276):
//
//   user_email_apps     the rows of apps deleted 30 days ago or more (the API's D1 names them), as the ledger's
//                       app_users of those apps are purged; the identity's user_emails row stays (D269: no expiry; an
//                       erasure request removes it with uid-erase)
//   email_admin_audit   staff actions older than 60 months (5 years, as the other audit logs; D90)
//
// The issuer's D1 is reached like user:* (lib/d1.ts issuerD1Execute: never the statement in a process argument;
// remotely D1's REST API as the operator). The deleted apps come from the API's D1 (ids only). Dry run by default:
// counts; --yes deletes and prints what it deleted. Run after each month's job (docs/operations.md "Retention").
import { DELETED_APP_GRACE_MS, auditCutoff } from '@hana-id/console-core';
import type { Args } from './cli.ts';
import { sql } from './sql.ts';

/** App ids per statement (well under D1's statement size). */
export const ISSUER_PURGE_CHUNK = 200;

export interface RetentionIssuerDeps {
  /** A read of the API's D1 (app ids only). */
  apiD1: (statement: string) => Record<string, unknown>[];
  /** A statement on the issuer's D1, privately. */
  issuerD1: (statement: string) => Promise<Record<string, unknown>[]>;
  now: () => number;
  log: (line: string) => void;
}

const chunks = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const count = (rows: Record<string, unknown>[]): number => Number(rows[0]?.n ?? 0);

/** `retention:issuer [--yes]`. Returns the counts (to delete, or deleted with --yes). */
export async function retentionIssuer(args: Args, where: { api: string; issuer: string }, deps: RetentionIssuerDeps): Promise<{ apps: number; appRows: number; auditRows: number }> {
  const now = deps.now();
  const deletedBefore = now - DELETED_APP_GRACE_MS;
  const auditBefore = auditCutoff(now);
  const apps = deps.apiD1(sql`SELECT id FROM apps WHERE deleted_at IS NOT NULL AND deleted_at <= ${deletedBefore} ORDER BY id`).map((r) => String(r.id));
  const yes = args.flag('yes');
  let appRows = 0;
  for (const part of chunks(apps, ISSUER_PURGE_CHUNK)) {
    const ids = part.map((a) => sql`${a}`).join(', ');
    appRows += yes ? (await deps.issuerD1(`DELETE FROM user_email_apps WHERE app_id IN (${ids}) RETURNING 1 AS x`)).length : count(await deps.issuerD1(`SELECT COUNT(*) AS n FROM user_email_apps WHERE app_id IN (${ids})`));
  }
  const auditRows = yes
    ? (await deps.issuerD1(sql`DELETE FROM email_admin_audit WHERE at_ms < ${auditBefore} RETURNING 1 AS x`)).length
    : count(await deps.issuerD1(sql`SELECT COUNT(*) AS n FROM email_admin_audit WHERE at_ms < ${auditBefore}`));
  // The daily counters past 24 months (D90's raw usage period; D446): counts only, no personal data.
  const dailyBefore = new Date(now - 730 * 86_400_000).toISOString().slice(0, 10);
  const dailyRows = yes
    ? (await deps.issuerD1(sql`DELETE FROM email_daily WHERE day < ${dailyBefore} RETURNING 1 AS x`)).length
    : count(await deps.issuerD1(sql`SELECT COUNT(*) AS n FROM email_daily WHERE day < ${dailyBefore}`));
  deps.log(`Issuer retention (${where.issuer}; deleted apps from ${where.api}):`);
  deps.log(`  ${apps.length} app(s) deleted 30 days ago or more: ${appRows} user_email_apps row(s) ${yes ? 'deleted' : 'to delete'} (each identity's address row stays: D269, uid-erase removes it)`);
  deps.log(`  email_admin_audit rows older than 60 months: ${auditRows} ${yes ? 'deleted' : 'to delete'}`);
  deps.log(`  email_daily rows older than 24 months: ${dailyRows} ${yes ? 'deleted' : 'to delete'}`);
  if (!yes) deps.log('Dry run: nothing changed. Run again with --yes to delete.');
  return { apps: apps.length, appRows, auditRows };
}
