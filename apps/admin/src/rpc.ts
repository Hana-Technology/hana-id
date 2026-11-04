// The `Ctx` of the admin Worker's RPC calls: the staff actor from the Access check, or the cron's system actor, with a
// request id per call (writes are idempotent on it: `app_changes.request_id`, `audit_log (request_id, action)`).
import type { StaffActor } from './access.ts';

export const SYSTEM_ACTOR = { kind: 'system', id: 'admin-cron' } as const;
/** The cron has no client: the RPC context's clientIp is this placeholder (it never reaches a limiter). */
export const CRON_CLIENT_IP = '0.0.0.0';

export const newRequestId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;

/** A context for one cron RPC call: a fresh request id each time, so a retried ack is a new write attempt. */
export const systemCtx = () => ({ actor: SYSTEM_ACTOR, requestId: newRequestId('cron'), clientIp: CRON_CLIENT_IP });

export interface StaffRequest {
  actor: StaffActor;
  requestId: string;
  clientIp: string;
}

export const staffCtx = (s: StaffRequest) => ({ actor: s.actor, requestId: s.requestId, clientIp: s.clientIp });
