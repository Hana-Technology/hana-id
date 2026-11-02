// The usage ledger's monthly partitions, kept ahead by the API's hourly cron (batch C4 review M1; migrations-usage
// 0003 lets the writer execute `usage.ensure_partitions`, the owner's bounded SECURITY DEFINER function that only
// creates missing months). Without a partition for its month an event is lost (`usage_write_failed` `pg_23514`), so
// this no longer waits for the admin Worker's daily cron (C12). Without `USAGE_DB` nothing is sent; a failure is logged
// and the next hour tries again: it never fails the cron run.
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { classifyWriteError, usageTransport } from './record.ts';

/** Months kept ahead of the current one (the function allows 0..24); 0003 created this many. */
export const USAGE_PARTITION_MONTHS = 12;
export const ENSURE_PARTITIONS_SQL = 'SELECT usage.ensure_partitions($1) AS created';

/** Never throws. True when the call succeeded (or there is no binding). */
export async function ensureUsagePartitions(env: Env): Promise<boolean> {
  const binding = env.USAGE_DB;
  if (!binding) return true;
  try {
    await usageTransport.query(binding, ENSURE_PARTITIONS_SQL, [USAGE_PARTITION_MONTHS]);
    return true;
  } catch (err) {
    log({ event: 'usage_partitions_failed', code: classifyWriteError(err).code }, 'error');
    return false;
  }
}
