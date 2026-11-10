// UsageEvent v1 (docs/batch-c-spec.md "Usage capture"): what the API sends to `usage.record_event` after each
// post-gate request. Never a sub, JWT, email, IP, session key or share id. The Neon function validates the same shape
// (apps/api/migrations-usage); a test sends every event this schema accepts, and the ones it refuses, through both.
import { z } from '@hana-id/env/zod';
import { requestId } from './types.ts';

/**
 * `link`, `link_cancel`, `link_unlink`: the API's link relays (email login batch 6; migrations-usage 0005).
 * `home_login`: a Hana Home derive that reached the relay (migrations-usage 0008). It names a scope and no app.
 */
export const USAGE_ENDPOINTS = ['login', 'session', 'derive', 'revoke', 'unlock', 'owner_action', 'link', 'link_cancel', 'link_unlink', 'home_login'] as const;
/** Endpoints whose events name a scope and no app (`app_id` null): an owner action and a Hana Home derive. */
export const APPLESS_ENDPOINTS = ['owner_action', 'home_login'] as const;
export const USAGE_OUTCOMES = ['ok', 'rejected', 'error'] as const;
/** Endpoints whose ok events carry a uid (MAU and new users). */
export const UID_ENDPOINTS = ['login', 'session', 'derive'] as const;

const I64_MAX = (1n << 63n) - 1n;
const decimalBelow = (max: bigint, digits: number) =>
  z
    .string()
    .regex(new RegExp(`^(0|[1-9]\\d{0,${digits - 1}})$`, 'u'))
    .refine((s) => BigInt(s) <= max, 'Out of range');

export const usageEventV1 = z
  .object({
    v: z.literal(1),
    request_id: requestId,
    /** Request start, unix ms: sets the UTC day and the monthly partition. */
    at_ms: z.number().int().nonnegative().max(8_640_000_000_000_000),
    org_id: z.string().min(1).max(64),
    /** null only for owner actions and Hana Home derives (they belong to a scope, not an app). */
    app_id: z.string().min(1).max(64).nullable(),
    scope_id: z.string().min(1).max(64),
    endpoint: z.enum(USAGE_ENDPOINTS),
    outcome: z.enum(USAGE_OUTCOMES),
    /** The API's error code for rejected and error outcomes; null for ok. */
    code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u).nullable(),
    status: z.number().int().min(100).max(599),
    latency_ms: z.number().int().nonnegative().max(2_147_483_647),
    /** A transaction that can execute was sent (gas may be burnt). */
    relayed: z.boolean(),
    near_tx: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u).optional(),
    relayer_pk: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/u).optional(),
    relayer_nonce: decimalBelow(I64_MAX, 19).optional(),
    /** Provisional (EXECUTED_OPTIMISTIC); never billed. */
    relay_gas_burnt: decimalBelow(I64_MAX, 19).optional(),
    relay_tokens_burnt_yocto: decimalBelow(10n ** 39n - 1n, 39).optional(),
    /** b64url of the 16-byte uid (`uid` in layouts.ts). */
    uid: z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/u).optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (e.relayed && (e.near_tx === undefined || e.relayer_pk === undefined || e.relayer_nonce === undefined)) issue('A relayed event names near_tx, relayer_pk and relayer_nonce');
    if ((APPLESS_ENDPOINTS as readonly string[]).includes(e.endpoint) !== (e.app_id === null)) issue('app_id is null exactly for owner actions and Hana Home derives');
    if (e.uid !== undefined && !(e.outcome === 'ok' && (UID_ENDPOINTS as readonly string[]).includes(e.endpoint))) issue('Only ok login, session and derive events carry a uid');
    if ((e.outcome === 'ok') !== (e.code === null)) issue('code is null exactly for ok outcomes');
  });
export type UsageEventV1 = z.infer<typeof usageEventV1>;
