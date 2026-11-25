// The platform API's routes (D927; docs/partner-platform-spec.md A8). Piece P3 has two, both about the key itself:
//
//   GET  /v1/platform/credential         the key's own state (its org, scopes, dates and limits)
//   POST /v1/platform/credential/revoke  the key stops itself at once (allowed while the org's switch is off or the org
//                                        is frozen, L5), cancelling in the same batch every web address it proposed that
//                                        is still waiting (D918's revocation, the `platform` actor)
//
// Nothing else: the app operations are piece P4's, and no route may ever register, accept, confirm or bring back a
// key, confirm a web address, or reach ConsoleRpc or AdminRpc (test: apps/api/test/platform-request.test.ts "reach").
// Each route's `cost` is its hot-DB ceiling in statements (the credential's read and the key list's included), charged to the org's
// bucket before it runs; the tests check each stays within it and within PLATFORM_DB_LIMITS.
import { type Actor, PLATFORM_REQUEST_LIMITS, type PlatformCredentialView, b64url, platformRevokeBody, randomBytes, sha256, utf8 } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { type Writer, refuse } from '../changes/cas.ts';
import type { HotDb } from '../changes/db.ts';
import { revokePlatformKeyNow } from './keys.ts';
import type { AuthRow } from './request.ts';

export interface RouteContext {
  env: Env;
  db: HotDb;
  /** The authenticated key and its org's row (check 5's read). */
  key: AuthRow;
  /** A POST's parsed JSON object; undefined for a GET. */
  body: unknown;
  now: number;
  idempotencyKey: string | null;
  requestId: string;
}

export interface RouteAnswer {
  status: number;
  body: Record<string, unknown>;
  /** The app the call was about, for `platform_calls` (none in P3). */
  appId?: string;
  /** The call changed something (a write that committed): its breaker slot and reserve tokens are kept. */
  wrote?: boolean;
}

export interface PlatformRoute {
  method: 'GET' | 'POST';
  /** The route's template, as `platform_calls.route` and the log record it (P3's have no parameters). */
  path: string;
  /** Hot-DB statements at most, reads included (A5, L8). */
  cost: number;
  /**
   * The self-revoke (F1): with a valid body it skips check 8 and the nonce cap (it can succeed once per key; charged to
   * the key's windows afterwards if it didn't stop the key); with an invalid one it is an ordinary call.
   */
  selfRevoke?: boolean;
  /** A POST body's check, run before check 7 for the self-revoke and after admission otherwise: null, or what's wrong. */
  validate?(body: Record<string, unknown>): string | null;
  idempotency: 'none' | 'optional' | 'required';
  /** Allowed while the org's platform switch is off (check 6). */
  allowOff?: boolean;
  /** Allowed while the org is frozen (check 6; A4.3: only the kill switches). */
  allowFrozen?: boolean;
  /** May spend the bucket's reserve. */
  killSwitch?: boolean;
  /** Counted by the platform's destructive-call breaker. */
  breaker?: boolean;
  run(c: RouteContext): Promise<RouteAnswer>;
}

/**
 * The ledger request id of a write (A9): `pf_` + base64url(sha256(org ‖ 0x00 ‖ Idempotency-Key)), its first 32
 * characters, so a retry from the org's other key is `conflict` (A9: right for an app write, piece P4). The self-revoke
 * passes its key id too (after PR 156's review, F4): sha256(org ‖ 0x00 ‖ key id ‖ 0x00 ‖ Idempotency-Key), so stopping
 * each of the org's keys is its own operation even under one Idempotency-Key.
 */
export async function platformRequestId(orgId: string, idempotencyKey: string, keyId?: string): Promise<string> {
  const input = keyId === undefined ? `${orgId}\u0000${idempotencyKey}` : `${orgId}\u0000${keyId}\u0000${idempotencyKey}`;
  return `pf_${b64url(await sha256(utf8(input))).slice(0, 32)}`;
}

/** The writer of a platform write: the `platform` actor, its id the key's (`app_changes.actor_kind = 'platform'`, D916). */
const platformWriter = (keyId: string, requestId: string, now: number): Writer => ({ actor: { kind: 'platform', id: keyId } as unknown as Actor, requestId, now });

export const PLATFORM_ROUTES: readonly PlatformRoute[] = [
  {
    method: 'GET',
    path: '/v1/platform/credential',
    // The credential's read; the call log's batch (its row and, once an hour, last_used_at); and, at most every 30 s per
    // isolate, the read of the announced keys' list (known-keys.ts).
    cost: 4,
    idempotency: 'none',
    async run({ key }) {
      const view: PlatformCredentialView = {
        keyId: key.id,
        label: key.label,
        orgId: key.org_id,
        scopes: JSON.parse(key.scopes_json) as string[],
        thumbprint: key.thumbprint,
        activeFrom: key.active_from!,
        expiresAt: key.expires_at!,
        limits: {
          requestsPerMinute: PLATFORM_REQUEST_LIMITS.perKeyPerMinute,
          requestsPerDay: PLATFORM_REQUEST_LIMITS.perKeyPerDay,
          maxApps: key.max_apps ?? 10,
          appCreationsPerDay: key.creations_per_day ?? 5,
          originProposalsPerDay: key.proposals_per_day ?? 30,
        },
      };
      return { status: 200, body: { ...view } };
    },
  },
  {
    method: 'POST',
    path: '/v1/platform/credential/revoke',
    // The credential's read, the revocation's plan read and its batch of six (commit, key, the cancel row, origins
    // version, origin rows, changes), a failed batch's diagnostic read, the call log's row; and the key list's read.
    cost: 11,
    idempotency: 'optional',
    allowOff: true,
    allowFrozen: true,
    killSwitch: true,
    selfRevoke: true,
    validate(body) {
      const b = platformRevokeBody.safeParse(body);
      if (b.success) return null;
      const issue = b.error.issues[0];
      return `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`.slice(0, 200);
    },
    async run({ db, key, body, now, idempotencyKey }) {
      const b = platformRevokeBody.safeParse(body);
      if (!b.success) return refuse('bad_request', 'The body is not a valid revoke');
      const requestId = idempotencyKey ? await platformRequestId(key.org_id, idempotencyKey, key.id) : `pf_${b64url(randomBytes(18))}`;
      const { revokedAt } = await revokePlatformKeyNow(db, platformWriter(key.id, requestId, now), { orgId: key.org_id, keyId: key.id, reason: b.data.reason || 'Stopped by the key itself' });
      return { status: 200, body: { revokedAt }, wrote: true };
    },
  },
];
