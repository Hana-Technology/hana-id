// Email logins and new links per app and day (migration 0010 `email_usage`, D233), kept in the hot DB as the identity
// token's counts are (`identity_usage`, D172) and copied hourly to the usage ledger (usage/email-sync.ts, migrations-usage
// 0004), so the login path never waits on Neon for them. Every such request is also one usage event of its endpoint
// (usage/event.ts); this only says how many were email logins and how many made a link. Counted after the response
// when the runtime gives an execution context; never rejects, and a failed write is only logged.
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
      log({ event: 'email_usage_write_failed', requestId: ctx.requestId, appId, endpoint: ctx.endpoint, code: column }, 'error');
    });
  if (exec) {
    exec.waitUntil(write);
    return Promise.resolve();
  }
  return write;
}
