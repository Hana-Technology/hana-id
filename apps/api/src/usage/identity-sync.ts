// The identity token's per-app daily counts into the usage ledger (docs/batch-c-build-plan.md "Conventions": the
// ledger counts `identity_tokens` per app and day). The mint path keeps counting in the hot DB (`identity_usage`,
// D172) and never talks to Neon; the hourly cron copies the last IDENTITY_SYNC_DAYS days of counts here with
// `usage.record_identity_tokens` (migrations-usage 0002), which keeps the larger count per app and day, so a failed
// run is repaired by the next one and a replay never lowers a count. Without `USAGE_DB` nothing is sent.
import { usageDay } from '../apps.ts';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { classifyWriteError, usageTransport } from './record.ts';

/** Days copied each run (today included): a Neon outage shorter than this loses nothing. */
export const IDENTITY_SYNC_DAYS = 7;
/** Rows per call (the function's own limit is 1000). */
export const IDENTITY_SYNC_BATCH = 500;
export const RECORD_IDENTITY_SQL = 'SELECT usage.record_identity_tokens($1::jsonb) AS rows';
const DAY_MS = 86_400_000;

interface CountRow {
  app_id: string;
  day: string;
  org_id: string;
  scope_id: string;
  tokens: number;
}

/**
 * Copies the recent per-app identity token counts to the ledger. Returns the rows sent (0 without the binding or with
 * nothing to copy). Never throws: a failure is logged (`identity_usage_sync_failed`) and the next hourly run copies the
 * same days again.
 */
export async function syncIdentityUsage(env: Env, now = Date.now()): Promise<number> {
  const binding = env.USAGE_DB;
  if (!binding) return 0;
  let rows: CountRow[];
  try {
    const since = usageDay(now - (IDENTITY_SYNC_DAYS - 1) * DAY_MS);
    ({ results: rows } = await env.DB.prepare(
      `SELECT u.app_id, u.day, a.org_id, a.scope_id, u.tokens
         FROM identity_usage u JOIN apps a ON a.id = u.app_id
        WHERE u.day >= ?1 ORDER BY u.day, u.app_id`,
    )
      .bind(since)
      .all<CountRow>());
  } catch {
    log({ event: 'identity_usage_sync_failed', code: 'config_unavailable' }, 'error');
    return 0;
  }
  let sent = 0;
  for (let i = 0; i < rows.length; i += IDENTITY_SYNC_BATCH) {
    const batch = rows.slice(i, i + IDENTITY_SYNC_BATCH).map((r) => ({ app_id: r.app_id, day: r.day, org_id: r.org_id, scope_id: r.scope_id, tokens: r.tokens }));
    try {
      await usageTransport.query(binding, RECORD_IDENTITY_SQL, [JSON.stringify(batch)]);
      sent += batch.length;
    } catch (err) {
      log({ event: 'identity_usage_sync_failed', code: classifyWriteError(err).code, synced: sent }, 'error');
      return sent;
    }
  }
  if (sent > 0) log({ event: 'identity_usage_sync', outcome: 'ok', synced: sent });
  return sent;
}
