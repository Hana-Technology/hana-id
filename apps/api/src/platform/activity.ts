// The platform's activity and the staff queue, as the screens read them (D930; docs/partner-platform-spec.md A11,
// piece P5). Reads only:
//
//   platformCalls  ConsoleRpc (any member of the org; the console's route matrix lets every member read, as the Audit)
//                  and AdminRpc (staff, with the caller's network prefix): one page of the org's `platform_calls`,
//                  newest first. Narrowed to one app, a page looks through at most PLATFORM_CALLS_SCAN of the org's
//                  calls (the table's index is `(org_id, seq)`, so the read is bounded rather than given a new index),
//                  and `next` then moves the window back.
//   platformQueue  AdminRpc only: every web address a platform key proposed that isn't in force yet (waiting for its
//                  announcement or for its time), and every platform key awaiting acceptance or waiting, across orgs,
//                  soonest first, so staff see each before it works; and (D931) every web address a second person
//                  confirmed in the last 7 days, and staff web addresses on a shared wallet waiting for a second person.
//
// No org's rows reach another org: every console read has `org_id = ?` from the caller's org.
import { type ConfirmedQueueRow, type PlatformCallView, type PlatformCallsPage, type PlatformQueue, type PlatformQueueOrigin, type SecondPersonQueueRow, CONFIRMED_QUEUE_MS, PLATFORM_CALLS_SCAN, originDisplay } from '@hana-id/console-core';
import type { HotDb } from '../changes/db.ts';
import { q, raw } from '../changes/sql.ts';
import { KEY_WAITING, PLATFORM_KEY_COLUMNS, type PlatformKeyRow, platformKeyView } from './keys.ts';

interface CallRow {
  window_min: number | null;
  window_n: number;
  seq: number | null;
  at: number;
  key_id: string;
  method: 'GET' | 'POST';
  route: string;
  app_id: string | null;
  status: number;
  code: string | null;
  request_id: string;
  ip_prefix: string | null;
}

/**
 * One page of the org's platform calls, newest first: the org's PLATFORM_CALLS_SCAN calls before `before` (all of
 * them, or those of `appId`), at most `limit`. One read. `next`: the bound of the next page when there are more (the
 * last call shown, or, narrowed to an app with fewer matches, the oldest call looked through).
 */
export async function platformCalls(db: HotDb, i: { orgId: string; appId?: string | undefined; before?: number | undefined; limit: number }, staff: boolean): Promise<PlatformCallsPage> {
  const before = i.before ?? Number.MAX_SAFE_INTEGER;
  const app = i.appId === undefined ? raw('1') : q`app_id = ${i.appId}`;
  const rows = await db.all<CallRow>(
    q`WITH w AS (SELECT seq, app_id FROM platform_calls WHERE org_id = ${i.orgId} AND seq < ${before} ORDER BY seq DESC LIMIT ${PLATFORM_CALLS_SCAN})
      SELECT (SELECT MIN(seq) FROM w) AS window_min, (SELECT COUNT(*) FROM w) AS window_n,
             pc.seq, pc.at, pc.key_id, pc.method, pc.route, pc.app_id, pc.status, pc.code, pc.request_id, pc.ip_prefix
        FROM (SELECT 1) LEFT JOIN platform_calls pc ON pc.seq IN (SELECT seq FROM w WHERE ${app})
       ORDER BY pc.seq DESC LIMIT ${i.limit + 1}`,
  );
  const found = rows.filter((r): r is CallRow & { seq: number } => r.seq !== null);
  const calls = found.slice(0, i.limit).map((r): PlatformCallView => {
    const v: PlatformCallView = { seq: r.seq, at: r.at, keyId: r.key_id, method: r.method, route: r.route, status: r.status, requestId: r.request_id };
    if (r.app_id !== null) v.appId = r.app_id;
    if (r.code !== null) v.code = r.code;
    if (staff && r.ip_prefix !== null) v.ipPrefix = r.ip_prefix;
    return v;
  });
  const head = rows[0];
  const page: PlatformCallsPage = { calls };
  if (found.length > i.limit) page.next = calls[calls.length - 1]!.seq;
  else if (head && head.window_n >= PLATFORM_CALLS_SCAN && head.window_min !== null) page.next = head.window_min;
  return page;
}

interface QueueOriginRow {
  id: string;
  app_id: string;
  origin: string;
  proposed_by: string;
  proposed_at: number;
  notified_at: number | null;
  active_from: number | null;
  app_name: string;
  org_id: string;
  scope_id: string;
  key_label: string | null;
}

/** The staff queue (AdminRpc only): two reads, `limit` rows of each, soonest first. */
export async function platformQueue(db: HotDb, now: number, limit: number): Promise<PlatformQueue> {
  const [origins, keys, confirmed, second] = await db.batch([
    q`SELECT g.id, g.app_id, g.origin, g.proposed_by, g.proposed_at, g.notified_at, g.active_from, a.name AS app_name, a.org_id, a.scope_id,
             (SELECT pk.label FROM platform_keys pk WHERE pk.id = g.proposed_by AND pk.org_id = a.org_id) AS key_label
        FROM guarded_changes g JOIN apps a ON a.id = g.app_id
       WHERE g.status = 'pending' AND g.kind = 'origin_add' AND g.proposed_by_kind = 'platform' AND (g.active_from IS NULL OR g.active_from > ${now}) AND a.deleted_at IS NULL
       ORDER BY g.active_from IS NULL DESC, g.active_from, g.proposed_at, g.id LIMIT ${limit}`,
    q`SELECT ${PLATFORM_KEY_COLUMNS('k')} FROM platform_keys k WHERE ${KEY_WAITING('k', now)} ORDER BY k.proposed_at, k.id LIMIT ${limit}`,
    // D931: confirmed in the last 7 days (newest first); `removed` once its web address no longer works there.
    q`SELECT oc.change_id, oc.app_id, oc.origin, oc.confirmed_by_kind, oc.confirmed_by, oc.confirmed_at, g.proposed_by_kind, g.proposed_by, a.name AS app_name, a.org_id,
             (g.status NOT IN ('pending', 'active') OR NOT EXISTS (SELECT 1 FROM app_origins ao WHERE ao.app_id = oc.app_id AND ao.change_id = oc.change_id)) AS removed
        FROM origin_confirmations oc JOIN guarded_changes g ON g.id = oc.change_id JOIN apps a ON a.id = oc.app_id
       WHERE oc.confirmed_at > ${now - CONFIRMED_QUEUE_MS}
       ORDER BY oc.confirmed_at DESC, oc.change_id LIMIT ${limit}`,
    // D931: staff web addresses on a shared wallet waiting for a second person (or their 24 hours), not confirmed.
    q`SELECT g.id, g.app_id, g.origin, g.request_id, g.proposed_by, g.proposed_at, g.notified_at, g.active_from, a.name AS app_name, a.org_id
        FROM staff_origin_waits sw JOIN guarded_changes g ON g.id = sw.change_id JOIN apps a ON a.id = g.app_id
       WHERE g.status = 'pending' AND (g.active_from IS NULL OR g.active_from > ${now}) AND a.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM origin_confirmations oc WHERE oc.change_id = g.id)
       ORDER BY g.active_from IS NULL DESC, g.active_from, g.proposed_at, g.id LIMIT ${limit}`,
  ]);
  return {
    origins: (origins!.results as unknown as QueueOriginRow[]).map((r): PlatformQueueOrigin => {
      const o: PlatformQueueOrigin = {
        changeId: r.id,
        appId: r.app_id,
        appName: r.app_name,
        orgId: r.org_id,
        scopeId: r.scope_id,
        ...originDisplay(r.origin),
        keyId: r.proposed_by,
        keyLabel: r.key_label,
        proposedAt: r.proposed_at,
      };
      if (r.notified_at !== null) o.notifiedAt = r.notified_at;
      if (r.active_from !== null) o.activeFrom = r.active_from;
      return o;
    }),
    keys: (keys!.results as unknown as PlatformKeyRow[]).map((r) => platformKeyView(r, now, true)),
    confirmed: (confirmed!.results as unknown as ConfirmedRow[]).map(
      (r): ConfirmedQueueRow => ({
        changeId: r.change_id,
        appId: r.app_id,
        appName: r.app_name,
        orgId: r.org_id,
        ...originDisplay(r.origin),
        proposedByKind: r.proposed_by_kind,
        proposedBy: r.proposed_by,
        confirmedByKind: r.confirmed_by_kind,
        confirmedBy: r.confirmed_by,
        confirmedAt: r.confirmed_at,
        removed: r.removed === 1,
      }),
    ),
    secondPerson: (second!.results as unknown as SecondRow[]).map(
      (r): SecondPersonQueueRow => ({
        changeId: r.id,
        appId: r.app_id,
        appName: r.app_name,
        orgId: r.org_id,
        ...originDisplay(r.origin),
        requestId: r.request_id,
        proposedBy: r.proposed_by,
        proposedAt: r.proposed_at,
        notifiedAt: r.notified_at,
        activeFrom: r.active_from,
      }),
    ),
  };
}

interface ConfirmedRow {
  change_id: string;
  app_id: string;
  origin: string;
  confirmed_by_kind: 'member' | 'hana';
  confirmed_by: string;
  confirmed_at: number;
  proposed_by_kind: 'platform' | 'hana';
  proposed_by: string;
  app_name: string;
  org_id: string;
  removed: number;
}

interface SecondRow {
  id: string;
  app_id: string;
  origin: string;
  request_id: string;
  proposed_by: string;
  proposed_at: number;
  notified_at: number | null;
  active_from: number | null;
  app_name: string;
  org_id: string;
}
