// The staff BFF's retention screen (docs/batch-c-spec.md "Admin BFF routes" `GET /api/retention`, "Hana admin console"
// screens: "retention (each monthly purge run: time, rows per table, failures, next run; D90)"; batch C13):
//
//   GET /api/retention   the month's state (due, done, next run), a warning until a run succeeds, the last runs with
//                        their rows per table and errors, what waits for a person (statements and rates past 7 years)
//                        and the recent erasures (ticket, operator, scope, counts; never whom)
//
// Read only: staff never start or change a run here (the job runs on the 15-minute trigger, retention.ts).
import { json } from './http.ts';
import { log } from './log.ts';
import { withLedger } from './report-routes.ts';
import { RETENTION_MAX_CALLS, dueAt, dueState, monthKey } from './retention.ts';
import type { RouteCtx } from './routes.ts';

export const RETENTION_RUNS_SHOWN = 24;
export const ERASURES_SHOWN = 20;
/** Past the due time by this much with no complete run, the screen warns (the job itself retries every 15 min). */
export const WARN_AFTER_DUE_MS = 60 * 60_000;

export async function retentionRoute(c: RouteCtx): Promise<Response> {
  return withLedger(c, 'GET /api/retention', async (store) => {
    const now = Date.now();
    const r = store.retention;
    const [state, runs, erasures] = await Promise.all([dueState(r, now), r.runs(RETENTION_RUNS_SHOWN), r.erasures(ERASURES_SHOWN)]);
    const month = monthKey(now);
    const done = !state.due && state.why === 'done';
    const latest = runs[0] ?? null;
    let warning: string | null = null;
    if (latest?.status === 'failed') warning = `The last run (${latest.month}, #${latest.id}) failed: ${latest.error ?? 'no error recorded'}. It is retried an hour after the failure.`;
    else if (!done && now >= dueAt(now) + WARN_AFTER_DUE_MS) warning = `No run of ${month} has completed yet${latest?.status === 'partial' ? ' (the last one ran out of its calls and continues every 15 minutes)' : ''}.`;
    const due = runs.find((x) => x.rows && typeof x.rows.due === 'object')?.rows.due ?? null;
    log({ event: 'bff', route: 'GET /api/retention', requestId: c.staff.requestId, outcome: 'ok', count: runs.length });
    return json(200, {
      month,
      dueAt: dueAt(now),
      done,
      state: state.due ? (state.continuing ? 'continuing' : 'due') : state.why,
      nextRunAt: state.due ? now : state.nextAt,
      maxCallsPerRun: RETENTION_MAX_CALLS,
      warning,
      runs,
      due,
      erasures,
    });
  });
}
