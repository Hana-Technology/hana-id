// The hot DB's part of retention (D90; docs/batch-c-spec.md "Retention"; batch C13, D360–D369), for the admin Worker's
// monthly job through AdminRpc (a `system` actor only):
//
//   purgeAudit      app_changes and guarded_changes rows older than 60 months, in batches
//   deletedApps     the apps deleted 30 days ago or more (the ledger's app_users purge, usage.purge_app_users)
//   purgeDirectory  the wallet directory (migration 0011) of every scope whose apps were all deleted 30 days ago or more
//
// Each clamps the caller's `before` to its own period in SQL (`unixepoch('now', …)`: the same clock as the
// app_changes trigger), so even a compromised admin Worker can't purge rows D90 still keeps. Nothing here reads or
// changes what derivation depends on: paths and identities are on chain; these rows are indexes and history.
import { DELETED_APP_GRACE_MS, type ApiPurgeAuditResult, type DeletedAppsResult, type PurgeDirectoryResult } from '@hana-id/console-core';
import type { HotDb } from './db.ts';
import { DRIFT_LEDGER_KINDS } from './drift.ts';
import { type Q, q, raw } from './sql.ts';

const kinds = (list: readonly string[]): Q => raw(list.map((k) => `'${k.replace(/'/gu, "''")}'`).join(', '));

/** min(before, 60 months ago): the trigger refuses a younger app_changes row anyway; this keeps the batch clean. */
const auditCutoff = (before: number): Q => q`MIN(${before}, unixepoch('now', '-60 months') * 1000)`;
/** min(before, 30 days ago) for deleted apps. */
const deletedCutoff = (before: number, now: number): number => Math.min(before, now - DELETED_APP_GRACE_MS);

/**
 * An app_changes row the drift check still reads (changes/drift.ts DRIFT_LEDGER_KINDS): a live app's baseline and the
 * rows that end its values, while the app has a baseline. Kept past 60 months: deleting the baseline of a value still
 * in force would report it as drift, and deleting a row that ended one would let the baseline explain it again.
 */
const DRIFT_ROW = q`(c.app_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM apps a WHERE a.id = c.app_id AND a.deleted_at IS NULL)
  AND EXISTS (SELECT 1 FROM app_changes b WHERE b.app_id = c.app_id AND b.kind = 'migration.baseline')
  AND (c.kind IN (${kinds(DRIFT_LEDGER_KINDS)})
       OR EXISTS (SELECT 1 FROM json_each(c.detail_json, '$.parts') p WHERE json_extract(p.value, '$.kind') IN (${kinds(DRIFT_LEDGER_KINDS)}))))`;

/**
 * A guarded change past 60 months that nothing reads any more: closed (cancelled or ended) that long ago and no origin
 * row names it, or of an app deleted that long ago (drift skips deleted apps). Pending and active changes of a live app
 * stay: drift and the gate explain what is in force with them.
 */
const OLD_GUARDED = (cutoff: Q): Q => q`(
  (g.status IN ('cancelled', 'ended') AND COALESCE(g.ended_at, g.cancelled_at, g.proposed_at) < ${cutoff}
   AND NOT EXISTS (SELECT 1 FROM app_origins o WHERE o.change_id = g.id))
  OR EXISTS (SELECT 1 FROM apps a WHERE a.id = g.app_id AND a.deleted_at IS NOT NULL AND a.deleted_at < ${cutoff} AND g.proposed_at < ${cutoff}))`;

export async function purgeAudit(db: HotDb, i: { before: number; limit: number }): Promise<ApiPurgeAuditResult> {
  const cutoff = auditCutoff(i.before);
  const [changes, guarded] = await db.batch([
    q`DELETE FROM app_changes WHERE seq IN (SELECT c.seq FROM app_changes c WHERE c.at < ${cutoff} AND NOT ${DRIFT_ROW} ORDER BY c.seq LIMIT ${i.limit})`,
    q`DELETE FROM guarded_changes WHERE id IN (SELECT g.id FROM guarded_changes g WHERE ${OLD_GUARDED(cutoff)} ORDER BY g.proposed_at, g.id LIMIT ${i.limit})`,
  ]);
  return { appChanges: changes!.meta.changes ?? 0, guardedChanges: guarded!.meta.changes ?? 0 };
}

/**
 * Apps deleted at or before min(before, now − 30 days), oldest deletion first, after `after` (`<deleted_at>:<id>`).
 * `next` is the cursor after the page's last app (the job keeps it, so next month starts there); `more` says whether
 * another page exists now.
 */
export async function deletedApps(db: HotDb, i: { before: number; after?: string; limit?: number }, now: number): Promise<DeletedAppsResult> {
  const limit = i.limit ?? 500;
  const cutoff = deletedCutoff(i.before, now);
  let after = q`1`;
  if (i.after) {
    const sep = i.after.indexOf(':');
    const at = Number(i.after.slice(0, sep));
    const id = i.after.slice(sep + 1);
    after = q`(deleted_at > ${at} OR (deleted_at = ${at} AND id > ${id}))`;
  }
  const rows = await db.all<{ id: string; deleted_at: number }>(
    q`SELECT id, deleted_at FROM apps WHERE deleted_at IS NOT NULL AND deleted_at <= ${cutoff} AND ${after} ORDER BY deleted_at, id LIMIT ${limit + 1}`,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { appIds: page.map((r) => r.id), ...(last ? { next: `${last.deleted_at}:${last.id}` } : {}), more: rows.length > limit };
}

/**
 * The scopes whose wallet directory may go: at least one app was deleted at or before the cutoff and no app of the
 * scope is live or deleted after it. (A scope whose users can no longer log in through Hana; their wallets stay on
 * chain and a new app in the scope records its users again at their next login.) A scope with no app row at all is
 * never purged: there is no deletion time to count from.
 */
const deadScope = (scope: Q, cutoff: number): Q => q`(
  EXISTS (SELECT 1 FROM apps a WHERE a.scope_id = ${scope} AND a.deleted_at IS NOT NULL AND a.deleted_at <= ${cutoff})
  AND NOT EXISTS (SELECT 1 FROM apps a WHERE a.scope_id = ${scope} AND (a.deleted_at IS NULL OR a.deleted_at > ${cutoff})))`;

export async function purgeDirectory(db: HotDb, i: { before: number; limit: number }, now: number): Promise<PurgeDirectoryResult> {
  const cutoff = deletedCutoff(i.before, now);
  // The same page of users in every statement: one D1 batch is one transaction, and the order is total.
  const page = q`SELECT u.user_id FROM end_users u WHERE ${deadScope(raw('u.scope_id'), cutoff)} ORDER BY u.user_id LIMIT ${i.limit}`;
  const [scopes, wallets, identities, users] = await db.batch([
    q`SELECT COUNT(DISTINCT scope_id) AS n FROM end_users WHERE user_id IN (${page})`,
    q`DELETE FROM end_user_wallets WHERE user_id IN (${page})`,
    q`DELETE FROM end_user_identities WHERE user_id IN (${page})`,
    q`DELETE FROM end_users WHERE user_id IN (${page})`,
  ]);
  const n = (scopes!.results as { n: number }[] | undefined)?.[0]?.n ?? 0;
  return { scopes: n, users: users!.meta.changes ?? 0, wallets: wallets!.meta.changes ?? 0, identities: identities!.meta.changes ?? 0 };
}
