// The platform API's routes (D927, D929; docs/partner-platform-spec.md A8). About the key itself (piece P3):
//
//   GET  /v1/platform/credential         the key's own state (its org, scopes, dates and limits)
//   POST /v1/platform/credential/revoke  the key stops itself at once (allowed while the org's switch is off or the org
//                                        is frozen, L5), cancelling in the same batch every web address it proposed that
//                                        is still waiting (D918's revocation, the `platform` actor)
//
// The app operations (piece P4, platform/ops.ts), only on apps the key's org created through the platform, on a scope
// the key names (the reach, H1):
//
//   GET  /v1/platform/apps                               the apps in the reach (?scopeId=&cursor=, 50 a page)
//   POST /v1/platform/apps                               create a test app on a shared scope, its web addresses waiting
//   GET  /v1/platform/apps/:appId                        one app (the allowlisted view)
//   POST /v1/platform/apps/:appId/origins                propose web addresses (each waits: no waiver, no expedite)
//   POST /v1/platform/apps/:appId/origins/remove         stop web addresses at once (a kill switch)
//   POST /v1/platform/changes/:changeId/cancel           cancel a waiting web address the platform proposed (H2)
//   POST /v1/platform/apps/:appId/suspend                {suspended: true} a kill switch; {suspended: false} only its own
//   POST /v1/platform/apps/:appId/keys                   a new publishable key
//   POST /v1/platform/apps/:appId/keys/:keyId/revoke     revoke a publishable key at once (a kill switch)
//
// No route may ever register, accept, confirm or bring back a key, confirm a web address or bring one into force early,
// reach a policy, raw signing, settings, labels, the mainnet demo, staff or member functions, or ConsoleRpc or AdminRpc
// (tests: apps/api/test/platform-request.test.ts "reach" and the import allowlist; platform-ops.test.ts).
// Each route's `cost` is its hot-DB ceiling in statements (the credential's read, the key list's and the call log's
// included), charged to the org's bucket before it runs; the tests check each stays within it and within
// PLATFORM_DB_LIMITS.
import {
  PLATFORM_REQUEST_LIMITS,
  type PlatformCredentialView,
  b64url,
  platformAddOriginsBody,
  platformCreateAppBody,
  platformEmptyBody,
  platformRemoveOriginsBody,
  platformRevokeBody,
  platformSuspendBody,
  randomBytes,
} from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { refuse } from '../changes/cas.ts';
import type { HotDb } from '../changes/db.ts';
import { revokePlatformKeyNow } from './keys.ts';
import {
  addPlatformOrigins,
  cancelPlatformChange,
  createPlatformApp,
  createPublishableKey,
  getPlatformApp,
  listPlatformApps,
  platformRequestId,
  platformWriter,
  removePlatformOrigins,
  revokePublishableKey,
  suspendPlatformApp,
} from './ops.ts';
import type { AuthRow } from './request.ts';

export { platformRequestId };

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
  /** The route's path parameters (`:appId`, `:changeId`, `:keyId`), each already matched by its pattern. */
  params: Record<string, string>;
  /** The path and query exactly as sent and signed. */
  path: string;
  /** A GET's query, as parsed once (request.ts). */
  query: URLSearchParams;
  /** sha256 of the exact body bytes, lowercase hex (what `platform_requests` records). */
  bodySha256Hex: string;
  waitUntil(p: Promise<unknown>): void;
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
  /** The route's template, as `platform_calls.route` and the log record it (`:name` a parameter matched by `params`). */
  path: string;
  /** Each parameter's pattern: a path whose segment doesn't match is no route (404 before any check of the key). */
  params?: Record<string, RegExp>;
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
  /** Counted by the platform's destructive-call breaker (D935: only the web address removal). */
  breaker?: boolean;
  /**
   * Flags that depend on a valid body (the suspend route: suspending is a kill switch, allowed while frozen; resuming is
   * neither). Merged over the static ones.
   */
  flags?(body: Record<string, unknown>): { killSwitch?: boolean; breaker?: boolean; allowFrozen?: boolean };
  run(c: RouteContext): Promise<RouteAnswer>;
}

/** A body's check against a strict schema: null, or what's wrong (`<field>: <problem>`, at most 200 characters). */
const check =
  (schema: { safeParse(v: unknown): { success: true } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }) =>
  (body: Record<string, unknown>): string | null => {
    const b = schema.safeParse(body);
    if (b.success) return null;
    const issue = b.error.issues[0];
    return `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`.slice(0, 200);
  };

const APP_ID = /^app_[A-Za-z0-9]{1,64}$/u;
const CHANGE_ID = /^gc_[A-Za-z0-9]{1,64}$/u;
const KEY_ID = /^key_[A-Za-z0-9_]{1,96}$/u;

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
  // ---- the app operations (piece P4, platform/ops.ts). The costs: the credential's read, the announced keys' list
  // (once every 30 s per isolate), the call log's row and, once an hour, last_used_at (4), plus the operation's own. ----
  {
    method: 'GET',
    path: '/v1/platform/apps',
    // One read: the page of apps with their web addresses and keys.
    cost: 5,
    idempotency: 'none',
    run: (c) => listPlatformApps(c, c.query),
  },
  {
    method: 'POST',
    path: '/v1/platform/apps',
    // The plan read; the batch of seven (commit, app, key, the web addresses' waits, changes, origin rows, the request's
    // record); a failed batch's diagnostic read (or, instead, a retry's one read of what it first did). 12 through the
    // hot DB's own count (PLATFORM_DB_LIMITS), 13 with the announced keys' list.
    cost: 13,
    idempotency: 'required',
    validate: check(platformCreateAppBody),
    run: (c) => createPlatformApp(c, c.body),
  },
  {
    method: 'GET',
    path: '/v1/platform/apps/:appId',
    params: { appId: APP_ID },
    cost: 5,
    idempotency: 'none',
    run: (c) => getPlatformApp(c, c.params.appId!),
  },
  {
    method: 'POST',
    path: '/v1/platform/apps/:appId/origins',
    params: { appId: APP_ID },
    // The plan read; the batch of six (commit, origins version, the waits, changes, origin rows, the request's record);
    // a diagnostic read.
    cost: 12,
    idempotency: 'required',
    validate: check(platformAddOriginsBody),
    run: (c) => addPlatformOrigins(c, c.params.appId!, c.body),
  },
  {
    method: 'POST',
    path: '/v1/platform/apps/:appId/origins/remove',
    params: { appId: APP_ID },
    // The plan read; the batch of five (commit, origins version, the changes closed, the rows removed, the record); a
    // diagnostic read.
    cost: 11,
    idempotency: 'required',
    allowFrozen: true,
    killSwitch: true,
    breaker: true,
    validate: check(platformRemoveOriginsBody),
    run: (c) => removePlatformOrigins(c, c.params.appId!, c.body),
  },
  {
    method: 'POST',
    path: '/v1/platform/changes/:changeId/cancel',
    params: { changeId: CHANGE_ID },
    // The plan read; the batch of five (commit, change, origin row, origins version, the record); a diagnostic read.
    cost: 11,
    idempotency: 'required',
    allowFrozen: true,
    killSwitch: true,
    validate: check(platformEmptyBody),
    run: (c) => cancelPlatformChange(c, c.params.changeId!),
  },
  {
    method: 'POST',
    path: '/v1/platform/apps/:appId/suspend',
    params: { appId: APP_ID },
    // The plan read; the batch of four (commit, app, its read back, the record); a diagnostic read.
    cost: 10,
    idempotency: 'required',
    validate: check(platformSuspendBody),
    // D935: suspending is a stop (it only takes away), outside the breaker; held to the org's 60 suspensions a clock hour instead.
    flags: (body) => (body.suspended === true ? { killSwitch: true, allowFrozen: true } : {}),
    run: (c) => suspendPlatformApp(c, c.params.appId!, platformSuspendBody.parse(c.body).suspended),
  },
  {
    method: 'POST',
    path: '/v1/platform/apps/:appId/keys',
    params: { appId: APP_ID },
    // The plan read; the batch of four (commit, key, the legacy key column, the record); a diagnostic read.
    cost: 10,
    idempotency: 'required',
    validate: check(platformEmptyBody),
    run: (c) => createPublishableKey(c, c.params.appId!),
  },
  {
    method: 'POST',
    path: '/v1/platform/apps/:appId/keys/:keyId/revoke',
    params: { appId: APP_ID, keyId: KEY_ID },
    // The plan read; the batch of four (commit, key, the legacy key column, the record); a diagnostic read.
    cost: 10,
    idempotency: 'required',
    allowFrozen: true,
    // D935: a stop, outside the breaker (the Tech Lead's decision: never blockable by the shared breaker); held to the
    // org's 20 publishable key revocations a clock hour instead (not reversible, so fewer than suspensions).
    killSwitch: true,
    validate: check(platformEmptyBody),
    run: (c) => revokePublishableKey(c, c.params.appId!, c.params.keyId!),
  },
];

/** The route a method and path name, with its parameters, or why not (404: no route; 405: another method's). */
export function matchRoute(method: string, path: string): { route: PlatformRoute; params: Record<string, string> } | { status: 404 | 405; allow?: string } {
  const segs = path.split('/');
  const hits: { route: PlatformRoute; params: Record<string, string> }[] = [];
  for (const route of PLATFORM_ROUTES) {
    const t = route.path.split('/');
    if (t.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let k = 0; k < t.length && ok; k++) {
      const part = t[k]!;
      if (part.startsWith(':')) {
        const name = part.slice(1);
        ok = route.params?.[name]?.test(segs[k]!) === true;
        if (ok) params[name] = segs[k]!;
      } else ok = part === segs[k];
    }
    if (ok) hits.push({ route, params });
  }
  if (hits.length === 0) return { status: 404 };
  const hit = hits.find((h) => h.route.method === method);
  return hit ?? { status: 405, allow: hits.map((h) => h.route.method).join(', ') };
}
