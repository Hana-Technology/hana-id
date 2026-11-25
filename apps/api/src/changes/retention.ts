// The hot DB's part of retention (D90; docs/batch-c-spec.md "Retention"; batch C13, D360–D369), for the admin Worker's
// monthly job through AdminRpc (a `system` actor only):
//
//   purgeAudit      app_changes and guarded_changes rows older than 60 months, in batches
//   deletedApps     the apps deleted 30 days ago or more (the ledger's app_users purge, usage.purge_app_users)
//   purgeDirectory  the wallet directory (migration 0011) of every scope whose apps were all deleted 30 days ago or more,
//                   and the email consents (migration 0014, D411), name shares (0021, D714) and per-app sign-in rows
//                   (`end_user_apps`, 0030, D919) of every app deleted 30 days ago or more
//   purgePlatformCalls platform_calls (migration 0032, D927) older than 13 months, and platform_requests (0033, D929)
//                      older than 7 days, in batches
//   purgeUserEvents user_events (migration 0013: key exports, mainnet demo signatures) older than 24 months, and those
//                   of a scope left without apps (purgeDirectory's rule)
//
// Each clamps the caller's `before` to its own period in SQL (`unixepoch('now', …)`: the same clock as the
// app_changes trigger), so even a compromised admin Worker can't purge rows D90 still keeps. Nothing here reads or
// changes what derivation depends on: paths and identities are on chain; these rows are indexes and history.
import { DELETED_APP_GRACE_MS, type ApiPurgeAuditResult, type DeletedAppsResult, type PurgeDirectoryResult, type PurgePlatformCallsResult, type PurgeUserEventsResult } from '@hana-id/console-core';
import type { HotDb } from './db.ts';
import { DRIFT_LEDGER_KINDS, SHARED_SCOPE_LEDGER_KIND } from './drift.ts';
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

/** D915: a scope's mark, which drift reads for as long as the scope exists: never purged. */
const SCOPE_MARK_ROW = q`(c.kind = ${SHARED_SCOPE_LEDGER_KIND})`;

/**
 * A guarded change past 60 months that nothing reads any more: closed (cancelled or ended) that long ago and no origin
 * row names it, or of an app deleted that long ago (drift skips deleted apps). Pending and active changes of a live app
 * stay: drift and the gate explain what is in force with them.
 */
const OLD_GUARDED = (cutoff: Q): Q => q`(
  (g.status IN ('cancelled', 'ended') AND COALESCE(g.ended_at, g.cancelled_at, g.proposed_at) < ${cutoff}
   AND NOT EXISTS (SELECT 1 FROM app_origins o WHERE o.change_id = g.id))
  OR EXISTS (SELECT 1 FROM apps a WHERE a.id = g.app_id AND a.deleted_at IS NOT NULL AND a.deleted_at < ${cutoff} AND g.proposed_at < ${cutoff}))`;

/**
 * D894 after review: a partner labels ledger row (`labels.*`, or a `change.*` row of kind `label_set`) is kept while
 * its entry exists (entries are never purged): label drift reads the proposal, announcement, allow, block and removal
 * rows of every entry, so purging them would report a false finding, or let a block or a removal be undone unseen.
 * `label_changes` rows are not purged at all yet ("kept 60 months" is a floor): they are small, and a version in force
 * must keep its text.
 */
const LABEL_ROW = q`((c.kind LIKE 'labels.%' OR (c.kind IN ('change.announced', 'change.cancelled') AND json_extract(c.detail_json, '$.kind') = 'label_set'))
  AND EXISTS (SELECT 1 FROM partner_labels pl WHERE pl.id = json_extract(c.detail_json, '$.labelId')))`;

export async function purgeAudit(db: HotDb, i: { before: number; limit: number }): Promise<ApiPurgeAuditResult> {
  const cutoff = auditCutoff(i.before);
  const [changes, guarded] = await db.batch([
    q`DELETE FROM app_changes WHERE seq IN (SELECT c.seq FROM app_changes c WHERE c.at < ${cutoff} AND NOT ${DRIFT_ROW} AND NOT ${LABEL_ROW} AND NOT ${SCOPE_MARK_ROW} ORDER BY c.seq LIMIT ${i.limit})`,
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
  // D411: a deleted app's consents (and the shared copies in them) go with its other per-user rows, 30 days on, in pages
  // of the same size; a live app's consents stay (a decline must be remembered).
  const consents = q`SELECT c.rowid FROM email_consents c JOIN apps a ON a.id = c.app_id WHERE a.deleted_at IS NOT NULL AND a.deleted_at <= ${cutoff} LIMIT ${i.limit}`;
  // D714: a deleted app's name shares, the same way (the names themselves are the users' own, kept in Home).
  const nameShares = q`SELECT n.rowid FROM name_shares n JOIN apps a ON a.id = n.app_id WHERE a.deleted_at IS NOT NULL AND a.deleted_at <= ${cutoff} LIMIT ${i.limit}`;
  // D919 (M8): a deleted app's rows of which apps a person signed in on (and that app's IDs), the same way, 30 days on;
  // a dead scope's users take theirs with them (deleted with the page, before the users, so ON DELETE CASCADE has
  // nothing left to do and the count is ours).
  const userApps = q`SELECT e.rowid FROM end_user_apps e JOIN apps a ON a.id = e.app_id WHERE a.deleted_at IS NOT NULL AND a.deleted_at <= ${cutoff} LIMIT ${i.limit}`;
  const [scopes, wallets, identities, pageApps, users, emailConsents, names, deletedApps] = await db.batch([
    q`SELECT COUNT(DISTINCT scope_id) AS n FROM end_users WHERE user_id IN (${page})`,
    q`DELETE FROM end_user_wallets WHERE user_id IN (${page})`,
    q`DELETE FROM end_user_identities WHERE user_id IN (${page})`,
    q`DELETE FROM end_user_apps WHERE user_id IN (${page})`,
    q`DELETE FROM end_users WHERE user_id IN (${page})`,
    q`DELETE FROM email_consents WHERE rowid IN (${consents})`,
    q`DELETE FROM name_shares WHERE rowid IN (${nameShares})`,
    q`DELETE FROM end_user_apps WHERE rowid IN (${userApps})`,
  ]);
  const n = (scopes!.results as { n: number }[] | undefined)?.[0]?.n ?? 0;
  return {
    scopes: n,
    users: users!.meta.changes ?? 0,
    wallets: wallets!.meta.changes ?? 0,
    identities: identities!.meta.changes ?? 0,
    emailConsents: emailConsents!.meta.changes ?? 0,
    nameShares: names!.meta.changes ?? 0,
    userApps: (pageApps!.meta.changes ?? 0) + (deletedApps!.meta.changes ?? 0),
  };
}

/** min(before, 24 months ago) for user events (console-core USER_EVENTS_KEEP_MONTHS), on the triggers' clock. */
const userEventsCutoff = (before: number): Q => q`MIN(${before}, unixepoch('now', '-24 months') * 1000)`;

/** The scopes left without apps at `cutoff`, as purgeDirectory decides them. */
const deadScopes = (cutoff: number): Q => q`SELECT DISTINCT d.scope_id FROM apps d WHERE d.deleted_at IS NOT NULL AND ${deadScope(raw('d.scope_id'), cutoff)}`;

/** D1's error for a table that isn't there (migration 0013 not applied in this env). */
const noUserEventsTable = (err: unknown): boolean => /no such table: user_events\b/u.test(String((err as { message?: unknown } | null)?.message ?? ''));

/**
 * user_events (migration 0013, D430): a key export names the account's internal id and a mainnet demo signature the
 * wallet address too, so both are personal data with a period of their own (readiness 7.17): rows older than
 * min(before, 24 months ago), and, whatever their age, the rows of a scope purgeDirectory empties (min(deletedBefore,
 * 30 days ago); the Users screen and the Support ID lookup only reach them through a directory user). Up to `limit` of
 * each, oldest first. An env without 0013 has nothing to purge: zeros, not a failure, so the monthly job doesn't fail
 * every month until the migration is applied.
 */
export async function purgeUserEvents(db: HotDb, i: { before: number; deletedBefore: number; limit: number }, now: number): Promise<PurgeUserEventsResult> {
  const cutoff = userEventsCutoff(i.before);
  const dead = deletedCutoff(i.deletedBefore, now);
  try {
    const [expired, scopes] = await db.batch([
      q`DELETE FROM user_events WHERE id IN (SELECT e.id FROM user_events e WHERE e.at < ${cutoff} ORDER BY e.id LIMIT ${i.limit})`,
      q`DELETE FROM user_events WHERE id IN (SELECT e.id FROM user_events e WHERE e.scope_id IN (${deadScopes(dead)}) ORDER BY e.id LIMIT ${i.limit})`,
    ]);
    return { expired: expired!.meta.changes ?? 0, deadScopes: scopes!.meta.changes ?? 0 };
  } catch (err) {
    if (noUserEventsTable(err)) return { expired: 0, deadScopes: 0 };
    throw err;
  }
}

const noPlatformCallsTable = (err: unknown): boolean => /no such table: platform_calls\b/u.test(String((err as { message?: unknown } | null)?.message ?? ''));

const noPlatformRequestsTable = (err: unknown): boolean => /no such table: platform_requests\b/u.test(String((err as { message?: unknown } | null)?.message ?? ''));

/**
 * D927: the platform API's call log older than min(before, 13 months ago by the database's clock), up to `limit` rows, oldest first (the table's
 * delete trigger refuses younger rows whoever asks). An env without migration 0032 has nothing to purge: zero.
 * D929: in the same batch, up to `limit` of the platform's idempotency records (`platform_requests`, migration 0033)
 * older than 7 days by the database's clock (their delete trigger refuses younger ones; after 7 days the ledger's
 * request id answers a reused Idempotency-Key). An env without 0033 purges the call log alone.
 */
export async function purgePlatformCalls(db: HotDb, i: { before: number; limit: number }): Promise<PurgePlatformCallsResult> {
  // By the database's clock, as the delete trigger judges it (the user events' rule, above).
  const cutoff = q`MIN(${i.before}, unixepoch('now', '-13 months') * 1000)`;
  const calls = q`DELETE FROM platform_calls WHERE seq IN (SELECT c.seq FROM platform_calls c WHERE c.at < ${cutoff} ORDER BY c.seq LIMIT ${i.limit})`;
  const requests = q`DELETE FROM platform_requests WHERE rowid IN (SELECT r.rowid FROM platform_requests r WHERE r.at < (unixepoch('now', '-7 days') * 1000) - 60000 ORDER BY r.at LIMIT ${i.limit})`;
  try {
    const [r, p] = await db.batch([calls, requests]);
    return { platformCalls: r!.meta.changes ?? 0, platformRequests: p!.meta.changes ?? 0 };
  } catch (err) {
    if (noPlatformCallsTable(err)) return { platformCalls: 0, platformRequests: 0 };
    if (!noPlatformRequestsTable(err)) throw err;
  }
  try {
    const [r] = await db.batch([calls]);
    return { platformCalls: r!.meta.changes ?? 0, platformRequests: 0 };
  } catch (err) {
    if (noPlatformCallsTable(err)) return { platformCalls: 0, platformRequests: 0 };
    throw err;
  }
}
