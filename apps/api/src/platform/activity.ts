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
//                  soonest first, so staff see each before it works.
//
// No org's rows reach another org: every console read has `org_id = ?` from the caller's org.
import { type PlatformCallView, type PlatformCallsPage, type PlatformQueue, type PlatformQueueOrigin, PLATFORM_CALLS_SCAN, originDisplay } from '@hana-id/console-core';
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
  const [origins, keys] = await db.batch([
    q`SELECT g.id, g.app_id, g.origin, g.proposed_by, g.proposed_at, g.notified_at, g.active_from, a.name AS app_name, a.org_id, a.scope_id,
             (SELECT pk.label FROM platform_keys pk WHERE pk.id = g.proposed_by AND pk.org_id = a.org_id) AS key_label
        FROM guarded_changes g JOIN apps a ON a.id = g.app_id
       WHERE g.status = 'pending' AND g.kind = 'origin_add' AND g.proposed_by_kind = 'platform' AND (g.active_from IS NULL OR g.active_from > ${now}) AND a.deleted_at IS NULL
       ORDER BY g.active_from IS NULL DESC, g.active_from, g.proposed_at, g.id LIMIT ${limit}`,
    q`SELECT ${PLATFORM_KEY_COLUMNS('k')} FROM platform_keys k WHERE ${KEY_WAITING('k', now)} ORDER BY k.proposed_at, k.id LIMIT ${limit}`,
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
  };
}
