// The admin Worker's cron triggers (docs/batch-c-spec.md "Crons"), shared by the Worker's dispatch (index.ts) and the
// config generator (scripts/gen-wrangler.ts). Each trigger is its own invocation with its own subrequest limit, so each
// run has its own budget of 40 outbound calls (D280). The spec's daily 00:30 UTC work runs in the 15-minute trigger's
// 00:30 tick (ledger-cron.ts isDailyTick; D329) and the monthly retention job from the 1st 01:00 UTC until a run of the
// month completes (retention.ts; D360): two triggers per env, not three or four.
/** Blocking notices, the feed, the watcher (C8). */
export const FIVE_MINUTES = '*/5 * * * *';
/** The ledger's alerts, statement notices and gas settlement; at 00:30 UTC also the daily checks and rate (C12); monthly retention (C13). */
export const FIFTEEN_MINUTES = '*/15 * * * *';
export const CRONS = [FIVE_MINUTES, FIFTEEN_MINUTES] as const;
