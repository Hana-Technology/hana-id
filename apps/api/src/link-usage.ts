// The links view's counts (build plan batch 9, spec "Admin portal hooks", D445): per app and UTC day how many links
// were proposed, linked at once, activated, cancelled and unlinked, and how many were automatic or explicit. They come
// from the contract's own NEP-297 log lines of each relayed transaction (`linkTallyOf`, in the settled outcome the
// relayer already has), counted after the response like the email counts (`email-usage.ts`), so no request ever waits
// for this and a failed write is only logged. Counts only: a log line's `root`, `member` and `by` keys are never read
// out of it, kept or logged.
import type { LinkStatsRow } from '@hana-id/console-core';
import { usageDay } from './apps.ts';
import type { Env } from './env.ts';
import { log } from './log.ts';

export interface LinkTally {
  proposed: number;
  linked: number;
  activated: number;
  cancelled: number;
  unlinked: number;
  auto: number;
  explicit: number;
}

const EVENT_PREFIX = 'EVENT_JSON:';

const zero = (): LinkTally => ({ proposed: 0, linked: 0, activated: 0, cancelled: 0, unlinked: 0, auto: 0, explicit: 0 });

/** Adds one log line's link events to `t`: a line that isn't the signer's NEP-297 `identity_link*` event adds nothing. */
function addLogLine(t: LinkTally, line: string): void {
  if (!line.startsWith(EVENT_PREFIX)) return;
  let event: unknown;
  try {
    event = JSON.parse(line.slice(EVENT_PREFIX.length));
  } catch {
    return;
  }
  const e = event as { standard?: unknown; event?: unknown; data?: unknown };
  if (e.standard !== 'hana-id' || typeof e.event !== 'string') return;
  const auto = Array.isArray(e.data) && (e.data[0] as { auto?: unknown } | undefined)?.auto === true;
  switch (e.event) {
    case 'identity_link_proposed':
      t.proposed++;
      break;
    case 'identity_linked':
      t.linked++;
      break;
    case 'identity_link_activated':
      t.activated++;
      return;
    case 'identity_link_cancelled':
      t.cancelled++;
      return;
    case 'identity_unlinked':
      t.unlinked++;
      return;
    default:
      return;
  }
  if (auto) t.auto++;
  else t.explicit++;
}

/**
 * The tally of a settled transaction's receipts: only receipts the signer contract executed (a promise it called, the
 * MPC's, can't speak for it). Null when the transaction carries no link event (nothing to write).
 */
export function linkTallyOf(receipts: readonly { outcome: { logs?: readonly string[]; executor_id?: string } }[], signer: string): LinkTally | null {
  const t = zero();
  for (const r of receipts) {
    if (r.outcome.executor_id !== signer) continue;
    for (const line of r.outcome.logs ?? []) addLogLine(t, line);
  }
  return Object.values(t).some((n) => n > 0) ? t : null;
}

export function countLinkUsage(env: Env, appId: string, tally: LinkTally | undefined, ctx: { requestId: string; endpoint: string }, exec?: ExecutionContext, now: number = Date.now()): Promise<void> {
  if (!tally) return Promise.resolve();
  const write = env.DB.prepare(
    `INSERT INTO link_usage (app_id, day, proposed, linked, activated, cancelled, unlinked, auto, explicit) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (app_id, day) DO UPDATE SET proposed = proposed + ?3, linked = linked + ?4, activated = activated + ?5, cancelled = cancelled + ?6, unlinked = unlinked + ?7, auto = auto + ?8, explicit = explicit + ?9`,
  )
    .bind(appId, usageDay(now), tally.proposed, tally.linked, tally.activated, tally.cancelled, tally.unlinked, tally.auto, tally.explicit)
    .run()
    .then(() => undefined)
    .catch(() => {
      log({ event: 'link_usage_write_failed', requestId: ctx.requestId, appId, endpoint: ctx.endpoint }, 'error');
    });
  if (exec) {
    exec.waitUntil(write);
    return Promise.resolve();
  }
  return write;
}

/** The newest `days` of an env's link counts (AdminRpc.linkStats), optionally for one app: counts per app and day. */
export async function linkStats(db: D1Database, days: number, appId: string | undefined, now: number): Promise<LinkStatsRow[]> {
  const from = usageDay(now - (days - 1) * 86_400_000);
  const rows = await db
    .prepare(
      `SELECT l.app_id, l.day, a.name, a.org_id, s.environment, l.proposed, l.linked, l.activated, l.cancelled, l.unlinked, l.auto, l.explicit
         FROM link_usage l JOIN apps a ON a.id = l.app_id JOIN scopes s ON s.scope_id = a.scope_id
        WHERE l.day >= ?1 ${appId === undefined ? '' : 'AND l.app_id = ?2'}
        ORDER BY l.day DESC, l.app_id ASC LIMIT 2000`,
    )
    .bind(...(appId === undefined ? [from] : [from, appId]))
    .all<{ app_id: string; day: string; name: string; org_id: string; environment: 'test' | 'live'; proposed: number; linked: number; activated: number; cancelled: number; unlinked: number; auto: number; explicit: number }>();
  return rows.results.map((r) => ({ appId: r.app_id, day: r.day, appName: r.name, orgId: r.org_id, environment: r.environment, proposed: r.proposed, linked: r.linked, activated: r.activated, cancelled: r.cancelled, unlinked: r.unlinked, auto: r.auto, explicit: r.explicit }));
}
