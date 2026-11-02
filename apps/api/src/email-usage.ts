// Email logins and new links per app and day (migration 0010 `email_usage`). Kept in this one file and called from one
// place per endpoint so batch C4, which moves usage to its Neon ledger, can replace it in one step (as it copies
// `identity_usage`, D223). Counted after the response when the runtime gives an execution context; never rejects, and a
// failed write is only logged (as the legacy `usage` counter).
import { usageDay } from './apps.ts';
import type { Env } from './env.ts';
import { log } from './log.ts';

export type EmailUsageField = 'email_sessions' | 'links';

export function countEmailUsage(env: Env, appId: string, field: EmailUsageField, ctx: { requestId: string; endpoint: string }, exec?: ExecutionContext, now: number = Date.now()): Promise<void> {
  const column = field === 'links' ? 'links' : 'email_sessions';
  const write = env.DB.prepare(
    `INSERT INTO email_usage (app_id, day, ${column}) VALUES (?1, ?2, 1)
     ON CONFLICT (app_id, day) DO UPDATE SET ${column} = ${column} + 1`,
  )
    .bind(appId, usageDay(now))
    .run()
    .then(() => undefined)
    .catch(() => {
      log({ event: 'usage_increment_failed', requestId: ctx.requestId, appId, endpoint: ctx.endpoint, code: `email_usage_${column}` }, 'error');
    });
  if (exec) {
    exec.waitUntil(write);
    return Promise.resolve();
  }
  return write;
}
