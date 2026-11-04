// The admin Worker's cron triggers (docs/batch-c-spec.md "Crons"), shared by the Worker's dispatch (index.ts) and the
// config generator (scripts/gen-wrangler.ts). Each trigger is its own invocation with its own subrequest limit, so each
// run has its own budget of 40 outbound calls (D280).
/** Blocking notices, the feed, the watcher (C8). */
export const FIVE_MINUTES = '*/5 * * * *';
/** The ledger's alerts, statement notices and gas settlement (C12). */
export const FIFTEEN_MINUTES = '*/15 * * * *';
/** The nonce cross-check, the rejection-rate check, the partitions, the NEAR/USD rate (C12). */
export const DAILY = '30 0 * * *';
export const CRONS = [FIVE_MINUTES, FIFTEEN_MINUTES, DAILY] as const;
