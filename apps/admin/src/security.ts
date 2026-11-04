// `GET /api/security` in C8 (docs/batch-c-spec.md "Admin BFF routes"; D285): the part of the security screen this
// batch can fill. The notice backlog (guarded changes, invites, owner grants not yet announced), the security events
// the feed has still to email, the feed's cursors with their lag (the age of the oldest row not yet emailed), the
// watcher's cursor and the last cron run. Breaker state, nonce checks and rejection-rate alerts come with C12 and the
// "Security & monitoring" view with C14.
import type { Env } from './env.ts';
import { CRON_LAST_RUN } from './cron.ts';
import { FEED_CURSORS } from './feed.ts';
import { json } from './http.ts';
import { errorName, log } from './log.ts';
import { opsSource } from './ops.ts';
import { type StaffRequest, staffCtx } from './rpc.ts';
import { WATCH_CURSOR } from './watcher.ts';

interface FeedSource {
  cursor: number;
  updatedAt: number | null;
  /** ms since the oldest row after the cursor was written; 0 when caught up; null when unreadable. */
  lagMs: number | null;
}

export async function securityView(env: Env, staff: StaffRequest): Promise<Response> {
  const ctx = staffCtx(staff);
  const now = Date.now();
  const settle = async <T>(p: () => Promise<T>): Promise<T | null> => {
    try {
      return await p();
    } catch {
      return null;
    }
  };
  const [changeNotices, memberNotices, events] = await Promise.all([
    settle(() => env.API.pendingNotices({ ...ctx, limit: 100 })),
    settle(() => env.CONSOLE.pendingMemberNotices({ ...ctx, limit: 100 })),
    settle(() => env.API.securityEvents({ ...ctx, unnotifiedOnly: true, limit: 100 })),
  ]);
  let feed: Record<string, FeedSource> | null = null;
  let watcher: { cursor: string | null; updatedAt: number | null } | null = null;
  let lastRun: unknown = null;
  let opsError: string | null = null;
  try {
    const ops = await opsSource.open(env.USAGE_DB);
    if (!ops) opsError = 'USAGE_DB is not bound: the feed and the watcher are off';
    else {
      try {
        const state = await ops.getState([FEED_CURSORS.changes, FEED_CURSORS.audit, WATCH_CURSOR, CRON_LAST_RUN]);
        const cursorOf = (k: string) => Number(state.get(k)?.value ?? '0') || 0;
        const lag = async (read: () => Promise<{ at: number }[] | null>): Promise<number | null> => {
          const rows = await settle(read);
          return rows === null ? null : rows[0] ? Math.max(0, now - rows[0].at) : 0;
        };
        const changesCursor = cursorOf(FEED_CURSORS.changes);
        const auditCursor = cursorOf(FEED_CURSORS.audit);
        feed = {
          app_changes: {
            cursor: changesCursor,
            updatedAt: state.get(FEED_CURSORS.changes)?.updatedAt ?? null,
            lagMs: await lag(async () => {
              const r = await env.API.changesSince({ ...ctx, seq: changesCursor, limit: 1 });
              return r.ok ? r.changes : null;
            }),
          },
          audit_log: {
            cursor: auditCursor,
            updatedAt: state.get(FEED_CURSORS.audit)?.updatedAt ?? null,
            lagMs: await lag(async () => {
              const r = await env.CONSOLE.auditSince({ ...ctx, seq: auditCursor, limit: 1 });
              return r.ok ? r.rows : null;
            }),
          },
        };
        watcher = { cursor: state.get(WATCH_CURSOR)?.value || null, updatedAt: state.get(WATCH_CURSOR)?.updatedAt ?? null };
        const raw = state.get(CRON_LAST_RUN)?.value;
        lastRun = raw ? (JSON.parse(raw) as unknown) : null;
      } finally {
        await ops.close();
      }
    }
  } catch (err) {
    opsError = 'The ops store is unavailable';
    log({ event: 'bff', route: 'GET /api/security', requestId: staff.requestId, outcome: 'error', code: 'ops_unavailable', error: errorName(err) }, 'warn');
  }
  return json(200, {
    notices: {
      changes: changeNotices?.ok ? changeNotices.notices.map((n) => ({ changeId: n.change.id, kind: n.change.kind, appId: n.app.id, orgId: n.app.orgId, proposedAt: n.change.proposedAt, contacts: n.contacts.length })) : null,
      members: memberNotices?.ok ? memberNotices.notices.map((n) => ({ kind: n.kind, id: n.invite?.id ?? n.grant?.id, orgId: n.invite?.orgId ?? n.grant?.orgId ?? null, createdAt: n.grant?.createdAt ?? n.invite?.createdAt })) : null,
    },
    unnotifiedEvents: events?.ok ? events.events : null,
    feed,
    watcher,
    lastRun,
    opsError,
  });
}
