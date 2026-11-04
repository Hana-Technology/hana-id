// The identity token's hourly housekeeping (the cron's run at :00): its counts are kept 24 months (D90's raw-usage
// retention), then deleted. They hold no user data (per signing key and hour, per app and day).
import type { Env } from '../env.ts';
import { log } from '../log.ts';

export const IDENTITY_COUNTS_RETENTION_MS = 2 * 365 * 24 * 3_600_000;

export async function identityMaintenance(env: Env, now: number = Date.now()): Promise<{ pruned: number }> {
  const cutoff = now - IDENTITY_COUNTS_RETENTION_MS;
  const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
  const [hourly, daily] = await env.DB.batch([
    env.DB.prepare('DELETE FROM identity_issuance_hourly WHERE hour < ?1').bind(cutoff),
    env.DB.prepare('DELETE FROM identity_usage WHERE day < ?1').bind(cutoffDay),
  ]);
  const pruned = (hourly?.meta.changes ?? 0) + (daily?.meta.changes ?? 0);
  log({ event: 'identity_maintenance', outcome: 'ok', pruned });
  return { pruned };
}
