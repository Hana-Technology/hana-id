// Email login's per-app daily counts into the usage ledger (docs/email-login-spec.md "API changes": usage counts email
// logins and links per app; D233), as the identity token's are (identity-sync.ts, D223): the login and link paths keep
// counting in the hot DB (`email_usage`, migration 0010) and never talk to Neon for them; the hourly cron copies the last
// EMAIL_SYNC_DAYS days here with `usage.record_email_counts` (migrations-usage 0004), which keeps the larger count of
// each column per app and day, so a failed run is repaired by the next one and a replay never lowers a count. Without
// `USAGE_DB` nothing is sent.
import { usageDay } from '../apps.ts';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { IDENTITY_SYNC_BATCH, IDENTITY_SYNC_DAYS } from './identity-sync.ts';
import { classifyWriteError, usageTransport } from './record.ts';

/** Days copied each run (today included), as the identity counts. */
export const EMAIL_SYNC_DAYS = IDENTITY_SYNC_DAYS;
export const EMAIL_SYNC_BATCH = IDENTITY_SYNC_BATCH;
export const RECORD_EMAIL_SQL = 'SELECT usage.record_email_counts($1::jsonb) AS rows';
const DAY_MS = 86_400_000;

interface CountRow {
  app_id: string;
  day: string;
  org_id: string;
  scope_id: string;
  email_sessions: number;
  links: number;
}

/**
 * Copies the recent per-app email counts to the ledger. Returns the rows sent (0 without the binding or with nothing to
 * copy). Never throws: a failure is logged (`email_usage_sync_failed`) and the next hourly run copies the same days again.
 */
export async function syncEmailUsage(env: Env, now = Date.now()): Promise<number> {
  const binding = env.USAGE_DB;
  if (!binding) return 0;
  let rows: CountRow[];
  try {
    const since = usageDay(now - (EMAIL_SYNC_DAYS - 1) * DAY_MS);
    ({ results: rows } = await env.DB.prepare(
      `SELECT u.app_id, u.day, a.org_id, a.scope_id, u.email_sessions, u.links
         FROM email_usage u JOIN apps a ON a.id = u.app_id
        WHERE u.day >= ?1 ORDER BY u.day, u.app_id`,
    )
      .bind(since)
      .all<CountRow>());
  } catch {
    // Before migration 0010 there is no table: nothing to copy (the same answer as an empty one).
    log({ event: 'email_usage_sync_failed', code: 'config_unavailable' }, 'error');
    return 0;
  }
  let sent = 0;
  for (let i = 0; i < rows.length; i += EMAIL_SYNC_BATCH) {
    const batch = rows
      .slice(i, i + EMAIL_SYNC_BATCH)
      .map((r) => ({ app_id: r.app_id, day: r.day, org_id: r.org_id, scope_id: r.scope_id, email_sessions: r.email_sessions, links: r.links }));
    try {
      await usageTransport.query(binding, RECORD_EMAIL_SQL, [JSON.stringify(batch)]);
      sent += batch.length;
    } catch (err) {
      log({ event: 'email_usage_sync_failed', code: classifyWriteError(err).code, synced: sent }, 'error');
      return sent;
    }
  }
  if (sent > 0) log({ event: 'email_usage_sync', outcome: 'ok', synced: sent });
  return sent;
}
