// The platform API's routes (D927; docs/partner-platform-spec.md A8). Piece P3 has two, both about the key itself:
//
//   GET  /v1/platform/credential         the key's own state (its org, scopes, dates and limits)
//   POST /v1/platform/credential/revoke  the key stops itself at once (allowed while the org's switch is off or the org
//                                        is frozen, L5), cancelling in the same batch every web address it proposed that
//                                        is still waiting (D918's revocation, the `platform` actor)
//
// Nothing else: the app operations are piece P4's, and no route may ever register, accept, confirm or bring back a
// key, confirm a web address, or reach ConsoleRpc or AdminRpc (test: apps/api/test/platform-request.test.ts "reach").
// Each route's `cost` is its hot-DB ceiling in statements (the credential's read included), charged to the org's
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
  /** `limits`: check 8's key windows and org bucket; `none`: the self-revoke, which can succeed once per key. */
  admission: 'limits' | 'none';
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

/** The ledger request id of a write (A9): `pf_` + base64url(sha256(org ‖ 0x00 ‖ Idempotency-Key)), its first 32 characters. */
export async function platformRequestId(orgId: string, idempotencyKey: string): Promise<string> {
  return `pf_${b64url(await sha256(utf8(`${orgId}\u0000${idempotencyKey}`))).slice(0, 32)}`;
}

/** The writer of a platform write: the `platform` actor, its id the key's (`app_changes.actor_kind = 'platform'`, D916). */
const platformWriter = (keyId: string, requestId: string, now: number): Writer => ({ actor: { kind: 'platform', id: keyId } as unknown as Actor, requestId, now });

export const PLATFORM_ROUTES: readonly PlatformRoute[] = [
  {
    method: 'GET',
    path: '/v1/platform/credential',
    // The credential's read; the call log's batch (its row and, once an hour, last_used_at).
    cost: 3,
    admission: 'limits',
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
    // version, origin rows, changes), a failed batch's diagnostic read, the call log's row.
    cost: 10,
    admission: 'none',
    idempotency: 'optional',
    allowOff: true,
    allowFrozen: true,
    killSwitch: true,
    async run({ db, key, body, now, idempotencyKey }) {
      const b = platformRevokeBody.safeParse(body);
      if (!b.success) return refuse('bad_request', `reason: ${b.error.issues[0]?.message ?? 'invalid'}`.slice(0, 200));
      const requestId = idempotencyKey ? await platformRequestId(key.org_id, idempotencyKey) : `pf_${b64url(randomBytes(18))}`;
      const { revokedAt } = await revokePlatformKeyNow(db, platformWriter(key.id, requestId, now), { orgId: key.org_id, keyId: key.id, reason: b.data.reason || 'Stopped by the key itself' });
      return { status: 200, body: { revokedAt }, wrote: true };
    },
  },
];
