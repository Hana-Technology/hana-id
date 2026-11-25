// The platform API's security events (D927, D929; docs/partner-platform-spec.md A5): `platform_quota` (the first
// refusal of a limit in a clock hour) and `platform_auth_failures`, which the admin Worker emails to staff. Each is
// written once (its id is deterministic) straight to D1, outside the call's hot-DB budget (it runs after the answer).
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { HOUR_MS, eventId } from '../changes/guard.ts';

/** A security event, written once (its id is deterministic). Never throws. */
export async function platformSecurityEvent(env: Env, kind: 'platform_quota' | 'platform_auth_failures', idParts: string[], orgId: string, detail: Record<string, unknown>, now: number): Promise<void> {
  try {
    await env.DB.prepare('INSERT OR IGNORE INTO security_events (id, detected_at, kind, org_id, detail_json) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(await eventId(kind, ...idParts), now, kind, orgId, JSON.stringify(detail))
      .run();
  } catch {
    log({ event: 'platform', outcome: 'error', code: `${kind}_event_failed` }, 'error');
  }
}

/** The first quota refusal of a limit in a clock hour writes `platform_quota` (the caller decides "first"). */
export const platformQuotaEvent = (env: Env, orgId: string, keyId: string, limit: string, now: number): Promise<void> => {
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  return platformSecurityEvent(env, 'platform_quota', [orgId, limit, String(hour)], orgId, { limit, keyId, windowStart: hour }, now);
};
