// The platform API's app operations (D929; docs/partner-platform-spec.md A1, A4, A5, A8, A9, piece P4; findings H1,
// H2, L3, L4, L15, L16, M7). What a network's backend may do with its platform key, only on apps its org created
// through the platform, on a test scope its key names, not deleted (the reach, H1): create an app on a shared scope,
// list and read its apps (an allowlisted view), propose web addresses (each waits, the live-scope rules, no waiver),
// remove them (at once), cancel its own waiting ones (H2), suspend and resume (who holds the partner bit, L4), and
// create and revoke publishable keys. Each write reuses the console's and staff's writer with the platform's reach
// added to its plan read and to its commit predicate (`Writer.reach`, changes/cas.ts), so the reach, the key still in
// force and the org's switch on and not frozen (a kill switch excepted) are checked again inside the batch that
// writes; anything outside the reach answers `not_found`, exactly like an app that doesn't exist.
//
// Nothing here registers, accepts or confirms a key, confirms a web address or brings one into force early, reaches a
// policy, raw signing, settings, labels or the mainnet demo, or calls ConsoleRpc or AdminRpc (the import allowlist,
// test/platform-ops.test.ts "what the operations may import").
//
// Idempotency (A9, L3): every write carries an Idempotency-Key; its ledger request id is `pf_` + base64url(sha256(org
// ‖ 0x00 ‖ key))[0..32] and its `platform_requests` row is written in the same batch. A retry with the same key, method,
// path and body from the same credential within 7 days answers 200 with the current state and `replayed: true`;
// another method, path or body `idempotency_conflict`; another credential `conflict`; after 7 days the ledger answers
// `already_applied` (the same write by the same credential) or `conflict`.
import {
  type Actor,
  type PlatformApp,
  type PlatformChange,
  type PlatformOrigin,
  PLATFORM_OPS_LIMITS,
  SUSPENSION_BITS,
  appIdInput,
  b64url,
  hex,
  namesLookAlike,
  newId,
  newPublishableKey,
  originDisplay,
  platformAddOriginsBody,
  platformCreateAppBody,
  platformRemoveOriginsBody,
  scopeIdInput,
  sha256,
  utf8,
} from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { placedStub } from '../placement.ts';
import type { Limit } from '../rate-limiter.ts';
import { platformMinDelayMs } from '../guarded/config.ts';
import { RpcRefusal, type Writer, actorId, commitOn, committed, expectReplay, refuse, refuseReplay, replayRow, runWrite } from '../changes/cas.ts';
import type { HotDb } from '../changes/db.ts';
import { createKey, revokeKey } from '../changes/keys.ts';
import { cancelChange } from '../changes/lifecycle.ts';
import { checkOriginRules, normaliseAll, platformProposeOrigins, platformWaits, removeOrigins, requireChangeConfig } from '../changes/origins.ts';
import { appName } from '../changes/settings.ts';
import { type Q, q, raw } from '../changes/sql.ts';
import { type PartnerBitBy, setSuspensionBit } from '../changes/suspension.ts';
import { platformQuotaEvent } from './events.ts';
import { KEY_IN_FORCE } from './keys.ts';
import { PlatformRefusal } from './refusal.ts';
import type { AuthRow } from './request.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const L = PLATFORM_OPS_LIMITS;
/** The database's clock in ms, as migration 0028's and 0033's triggers read it. */
const DB_NOW = raw(`((julianday('now') - 2440587.5) * 86400000.0)`);

/** What an operation gets from its route: the authenticated key and the request as sent. */
export interface OpContext {
  env: Env;
  db: HotDb;
  key: AuthRow;
  now: number;
  /** A write's Idempotency-Key (the route requires one); null for a read. */
  idempotencyKey: string | null;
  /** The path and query exactly as sent (what `platform_requests` records). */
  path: string;
  /** sha256 of the exact body bytes, lowercase hex. */
  bodySha256Hex: string;
  waitUntil(p: Promise<unknown>): void;
}

/** An operation's answer, as a route gives it to request.ts. */
export interface OpAnswer {
  status: number;
  body: Record<string, unknown>;
  appId?: string;
  wrote?: boolean;
}

/**
 * The ledger request id of a platform write (A9): `pf_` + base64url(sha256(org ‖ 0x00 ‖ Idempotency-Key)), its first
 * 32 characters, so a retry from the org's other key is `conflict` (the ledger row names the first key). The
 * self-revoke passes its key id too (D927 after PR 156's review, F4): sha256(org ‖ 0x00 ‖ key id ‖ 0x00 ‖
 * Idempotency-Key), so stopping each of the org's keys is its own operation even under one Idempotency-Key.
 */
export async function platformRequestId(orgId: string, idempotencyKey: string, keyId?: string): Promise<string> {
  const input = keyId === undefined ? `${orgId}\u0000${idempotencyKey}` : `${orgId}\u0000${keyId}\u0000${idempotencyKey}`;
  return `pf_${b64url(await sha256(utf8(input))).slice(0, 32)}`;
}

/** The writer of a platform write: the `platform` actor, its id the key's (`app_changes.actor_kind = 'platform'`, D916). */
export const platformWriter = (keyId: string, requestId: string, now: number): Writer => ({ actor: { kind: 'platform', id: keyId } as unknown as Actor, requestId, now });

// ---- the reach (H1) ----

/**
 * The platform's reach over the apps row `a` (A4.2, H1): the key's org; created through the platform; not deleted; on a
 * test scope of the org that the key names; the key still in force (by the request's clock and, for its expiry, by the
 * database's, so a key that expires between the read and the batch writes nothing); the org's switch on and, except for
 * a kill switch, the org not frozen. And over the guarded change `g` (H2): a web address the platform proposed (any of
 * the org's keys), never a member's, staff's or another kind of change. Every plan read and commit predicate of a
 * platform write holds both (changes/cas.ts `Writer.reach`), and the reads hold the app's.
 */
export function platformReach(key: Pick<AuthRow, 'id' | 'org_id'>, now: number, allowFrozen = false): { app: Q; change: Q } {
  const org = key.org_id;
  return {
    app: q`(a.org_id = ${org} AND a.created_by_kind = 'platform' AND a.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM scopes rs WHERE rs.scope_id = a.scope_id AND rs.org_id = ${org} AND rs.environment = 'test')
      AND EXISTS (SELECT 1 FROM platform_keys rk, json_each(rk.scopes_json) rj
                   WHERE rk.id = ${key.id} AND rk.org_id = ${org} AND ${KEY_IN_FORCE('rk', now)} AND rk.expires_at > ${DB_NOW} AND rj.value = a.scope_id)
      AND EXISTS (SELECT 1 FROM platform_orgs ro WHERE ro.org_id = ${org} AND ro.enabled = 1${allowFrozen ? raw('') : raw(' AND ro.frozen = 0')}))`,
    change: raw(`(g.kind = 'origin_add' AND g.proposed_by_kind = 'platform')`),
  };
}

// ---- the app view (A8) ----

/** One app as JSON for the view, from the apps row `a`: its own columns, its web addresses and its 20 newest keys. */
const APP_JSON = raw(
  `json_object('id', a.id, 'name', a.name, 'scope_id', a.scope_id, 'created_at', a.created_at, 'user_ids', a.user_ids,
     'suspended_by', a.suspended_by, 'partner_bit_by', a.partner_bit_by, 'origins_version', a.origins_version,
     'origins', json((SELECT json_group_array(json_object('origin', o.origin, 'active_from', o.active_from, 'change_id', o.change_id))
                        FROM (SELECT origin, active_from, change_id FROM app_origins WHERE app_id = a.id ORDER BY origin) o)),
     'keys', json((SELECT json_group_array(json_object('id', k.id, 'key', k.key, 'created_at', k.created_at, 'revoked_at', k.revoked_at))
                     FROM (SELECT id, key, created_at, revoked_at FROM app_keys WHERE app_id = a.id ORDER BY created_at DESC, id DESC LIMIT ${L.keysShown}) k)))`,
);

interface AppJson {
  id: string;
  name: string;
  scope_id: string;
  created_at: number;
  user_ids: string;
  suspended_by: number;
  partner_bit_by: PartnerBitBy;
  origins_version: number;
  origins: { origin: string; active_from: number | null; change_id: string | null }[];
  keys: { id: string; key: string; created_at: number; revoked_at: number | null }[];
}

/** Who holds which suspension, as the platform may see it (A8): Journear's bits together, never why or who. */
export function suspendedView(suspendedBy: number, holder: PartnerBitBy): PlatformApp['suspended'] {
  const partner = (suspendedBy & SUSPENSION_BITS.partner) !== 0;
  const byYou = partner && holder === 'platform';
  return { byJournear: (suspendedBy & (SUSPENSION_BITS.hana | SUSPENSION_BITS.org)) !== 0, byOrganisation: partner && !byYou, byYou, youCanResume: byYou };
}

function originView(o: { origin: string; active_from: number | null; change_id: string | null }, now: number): PlatformOrigin {
  const state = o.active_from === null ? 'waiting_announcement' : o.active_from > now ? 'waiting' : 'active';
  return { ...originDisplay(o.origin), state, activeFrom: o.active_from, confirmedAt: null, ...(o.change_id === null ? {} : { changeId: o.change_id }) };
}

/** The allowlisted view of an app (A8) from its JSON. */
export function appView(json: string, now: number): PlatformApp {
  const a = JSON.parse(json) as AppJson;
  return {
    id: a.id,
    name: a.name,
    scopeId: a.scope_id,
    environment: 'test',
    createdBy: 'platform',
    createdAt: a.created_at,
    userIds: a.user_ids === 'scope' ? 'scope' : 'app',
    suspended: suspendedView(a.suspended_by, a.partner_bit_by),
    originsVersion: a.origins_version,
    origins: a.origins.map((o) => originView(o, now)),
    keys: [...a.keys].reverse().map((k) => ({ id: k.id, key: k.key, createdAt: k.created_at, revokedAt: k.revoked_at })),
  };
}

// ---- reads ----

/** `GET /v1/platform/apps?scopeId=&cursor=`: the apps in the reach, 50 a page by id, from after `cursor`. One read. */
export async function listPlatformApps(c: OpContext, query: URLSearchParams): Promise<OpAnswer> {
  const names = [...query.keys()];
  if (names.some((n) => n !== 'scopeId' && n !== 'cursor') || new Set(names).size !== names.length) refuse('bad_request', 'The query takes scopeId and cursor, each at most once');
  const scopeId = query.get('scopeId');
  const cursor = query.get('cursor');
  if (scopeId !== null && !scopeIdInput.safeParse(scopeId).success) refuse('bad_request', 'scopeId is not a scope id');
  if (cursor !== null && !appIdInput.safeParse(cursor).success) refuse('bad_request', 'cursor is not an app id');
  if (scopeId !== null && !(JSON.parse(c.key.scopes_json) as string[]).includes(scopeId)) refuse('forbidden', 'Your platform key doesn’t name this scope');
  const reach = platformReach(c.key, c.now);
  const rows = await c.db.all<{ app_json: string }>(
    q`SELECT ${APP_JSON} AS app_json FROM apps a
       WHERE a.org_id = ${c.key.org_id} AND ${reach.app}${scopeId === null ? raw('') : q` AND a.scope_id = ${scopeId}`}${cursor === null ? raw('') : q` AND a.id > ${cursor}`}
       ORDER BY a.id LIMIT ${L.listPage + 1}`,
  );
  const apps = rows.slice(0, L.listPage).map((r) => appView(r.app_json, c.now));
  return { status: 200, body: { apps, ...(rows.length > L.listPage ? { next: apps[apps.length - 1]!.id } : {}) } };
}

/** `GET /v1/platform/apps/:appId`: one app in the reach, or `not_found`. One read. */
export async function getPlatformApp(c: OpContext, appId: string): Promise<OpAnswer> {
  const reach = platformReach(c.key, c.now);
  const r = await c.db.first<{ app_json: string }>(q`SELECT ${APP_JSON} AS app_json FROM apps a WHERE a.id = ${appId} AND ${reach.app}`);
  if (!r) return refuse('not_found', 'No such app');
  return { status: 200, body: { app: appView(r.app_json, c.now) }, appId };
}

// ---- writes: the writer, the record, the replay ----

const idemHash = async (key: string): Promise<string> => hex(await sha256(utf8(key)));

/**
 * The writer of a platform write: the `platform` actor, the A9 request id, the reach (unless `noReach`: the create,
 * whose predicate is on the scope), and the `platform_requests` row in the same batch, written only if the write
 * committed and only beside a ledger row of this credential (migration 0033's trigger holds that too).
 */
async function opWriter(c: OpContext, o: { allowFrozen?: boolean; noReach?: boolean } = {}): Promise<{ w: Writer; hash: string }> {
  if (c.idempotencyKey === null) return refuse('bad_request', 'This write needs an Idempotency-Key');
  const requestId = await platformRequestId(c.key.org_id, c.idempotencyKey);
  const hash = await idemHash(c.idempotencyKey);
  const w = platformWriter(c.key.id, requestId, c.now);
  if (!o.noReach) w.reach = platformReach(c.key, c.now, o.allowFrozen === true);
  w.batchTail = [
    q`INSERT INTO platform_requests (org_id, idem_hash, key_id, method, path, body_sha256, request_id, at)
      SELECT ${c.key.org_id}, ${hash}, ${c.key.id}, 'POST', ${c.path}, ${c.bodySha256Hex}, ${requestId}, ${c.now} WHERE ${committed(requestId)}`,
  ];
  return { w, hash };
}

interface ReplayRead {
  pr_key: string | null;
  pr_method: string | null;
  pr_path: string | null;
  pr_body: string | null;
  kind: string | null;
  app_id: string | null;
  detail_json: string | null;
  app_json: string | null;
  change_json: string | null;
}

/** What a replay answers, from the first write's ledger detail and the app as it is now (null: no longer in reach). */
type Replayer = (detail: Record<string, unknown>, app: PlatformApp | null, change: Record<string, unknown> | null) => Record<string, unknown>;

/**
 * Runs a platform write; when its plan read finds the request id already used (refuseReplay's `already_applied` or
 * `conflict`, or the batch's on a concurrent duplicate), tells a retry from another call (A9): one read of the
 * `platform_requests` row (7 days), the ledger row and the app now. Another method, path or body within 7 days:
 * `idempotency_conflict`; another credential: `conflict`; the same: the first result again, `replayed: true`, with the
 * app as it is now; after 7 days the ledger's answer as refuseReplay gave it. A real conflict (no ledger row with this
 * request id) is answered as it was thrown; so is a duplicate whose diagnostic read used the call's last read.
 */
async function withReplay(c: OpContext, w: Writer, hash: string, run: () => Promise<OpAnswer>, replay: Replayer): Promise<OpAnswer> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof RpcRefusal) || (err.code !== 'already_applied' && err.code !== 'conflict')) throw err;
    if (c.db.limits && c.db.reads >= c.db.limits.reads) throw err;
    const reach = platformReach(c.key, c.now, true);
    const r = await c.db.first<ReplayRead>(
      q`SELECT pr.key_id AS pr_key, pr.method AS pr_method, pr.path AS pr_path, pr.body_sha256 AS pr_body,
               ac.kind, ac.app_id, ac.detail_json,
               (SELECT ${APP_JSON} FROM apps a WHERE a.id = ac.app_id AND ${reach.app}) AS app_json,
               (SELECT json_object('id', g.id, 'app_id', g.app_id, 'origin', g.origin, 'status', g.status, 'active_from', g.active_from, 'cancelled_at', g.cancelled_at)
                  FROM guarded_changes g WHERE g.id = json_extract(ac.detail_json, '$.changeId')) AS change_json
          FROM (SELECT 1) LEFT JOIN app_changes ac ON ac.request_id = ${w.requestId}
          LEFT JOIN platform_requests pr ON pr.org_id = ${c.key.org_id} AND pr.idem_hash = ${hash} AND pr.at > ${c.now - L.idempotencyMs}`,
    );
    if (!r || r.kind === null) throw err;
    if (r.pr_key === null) throw err;
    if (r.pr_method !== 'POST' || r.pr_path !== c.path || r.pr_body !== c.bodySha256Hex) {
      throw new PlatformRefusal('idempotency_conflict', 'This Idempotency-Key was used in the last 7 days for another request: use a new key for a new operation');
    }
    if (r.pr_key !== c.key.id) {
      refuse('conflict', 'This Idempotency-Key was used by your organisation’s other platform key: read the app to see whether the operation applied, and if it didn’t, use a new Idempotency-Key');
    }
    const app = r.app_json === null ? null : appView(r.app_json, c.now);
    const detail = JSON.parse(r.detail_json ?? '{}') as Record<string, unknown>;
    const change = r.change_json === null ? null : (JSON.parse(r.change_json) as Record<string, unknown>);
    return { status: 200, body: { ...replay(detail, app, change), replayed: true }, ...(r.app_id ? { appId: r.app_id } : {}) };
  }
}

/** A replay's app, or `not_found` when it has left the reach since (deleted, its scope dropped from the key). */
const replayApp = (app: PlatformApp | null): PlatformApp => app ?? refuse('not_found', 'No such app');

// ---- the quota windows (A5) ----

const orgLimiter = (c: OpContext) => placedStub(c.env, c.env.RATE_LIMITER, `platform:${c.key.org_id}`);

/**
 * Takes `n` from the org's windows (`platform:<orgId>`, pinned), or refuses `429 rate_limited` with the window's name
 * and `retry-after`; the first refusal of a window in a clock hour writes a `platform_quota` event. Returns the give-back
 * for a write that then doesn't commit, so only committed creations and proposals count.
 */
async function takeQuota(c: OpContext, limits: Limit[], n: number, what: string): Promise<() => Promise<void>> {
  if (n === 0) return async () => undefined;
  const obj = orgLimiter(c);
  const r = await obj.hit(limits, c.now, n);
  if (!r.ok) {
    const hour = Math.floor(c.now / HOUR) * HOUR;
    const limit = `platform:${r.limit}`;
    c.waitUntil(
      obj
        .reserve(`quota-noticed:${r.limit}@${hour}`, hour + HOUR, c.now)
        .then((first) => (first ? platformQuotaEvent(c.env, c.key.org_id, c.key.id, limit, c.now) : undefined))
        .catch(() => undefined),
    );
    throw new PlatformRefusal('rate_limited', `Your organisation has reached its limit of ${what}: try again later`, { limit, retryAfterS: r.retryAfterS }, { 'retry-after': String(r.retryAfterS) });
  }
  return async () => {
    try {
      await obj.unhit(limits, c.now, n);
    } catch {
      // A window not given back counts one write too many against the org's own quota, never someone else's.
    }
  };
}

const creationWindows = (key: AuthRow): Limit[] => [
  { name: 'creations:hour', windowMs: HOUR, max: L.creationsPerHour },
  { name: 'creations:day', windowMs: DAY, max: key.creations_per_day ?? 5 },
];
const proposalWindows = (key: AuthRow): Limit[] => [
  { name: 'proposals:hour', windowMs: HOUR, max: L.proposalsPerHour },
  { name: 'proposals:day', windowMs: DAY, max: key.proposals_per_day ?? 30 },
];

/** A platform proposal's wait from its announcement: the greater of the env's delay and the platform minimum (24 h; a `local*` test env's own delay). */
const proposalWait = (env: Env): number => Math.max(requireChangeConfig(env).delayMs, platformMinDelayMs(env));

/** Runs `write` with its quota taken; gives it back when the write doesn't commit (any refusal or failure). */
async function withQuota<T>(give: () => Promise<void>, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    await give();
    throw err;
  }
}

// ---- create (A4.4) ----

interface CreatePlan {
  replay: string | null;
  contacts: number;
  scope_org: string | null;
  environment: string | null;
  app_user_ids: number | null;
  assigned_at: number | null;
  on_key: number;
  platform_apps: number;
  max_apps: number | null;
  scope_apps: string;
  waiting: number;
}

/** The org's web addresses the platform proposed that still wait, across its apps. */
const WAITING = (orgId: string, now: number): Q =>
  q`(SELECT COUNT(*) FROM guarded_changes wg WHERE wg.kind = 'origin_add' AND wg.proposed_by_kind = 'platform' AND wg.status = 'pending'
      AND (wg.active_from IS NULL OR wg.active_from > ${now}) AND wg.app_id IN (SELECT id FROM apps WHERE org_id = ${orgId}))`;

/**
 * `POST /v1/platform/apps` (A4.4, L15, L16): a test app on a scope the key names and staff marked as shared, never a
 * new scope (no chain read). Its name passes the app name rules and must not read like another app's name on the same
 * scope (any creator; other scopes and orgs are never compared). Its first web addresses are platform proposals (the
 * key's id as proposer, the live-scope rules, the platform's wait, never a waiver: not createApp's staff proposals).
 * Its User ID mode and creator come from the scope's row inside the batch (`INSERT … SELECT`), which also holds the
 * key in force with the scope, the org's switch on and not frozen, a security contact, the app limit, the scope's apps
 * as read (two creates racing on one scope: one writes) and the org's waiting web addresses.
 */
export async function createPlatformApp(c: OpContext, body: unknown): Promise<OpAnswer> {
  const b = platformCreateAppBody.parse(body);
  const { w, hash } = await opWriter(c, { noReach: true });
  expectReplay(w, ['app.created']);
  const org = c.key.org_id;
  const name = appName(b.name);
  const origins = normaliseAll(b.origins ?? []);
  checkOriginRules(c.env, 'live', origins);
  const config = requireChangeConfig(c.env);
  const minDelayMs = proposalWait(c.env);
  return withReplay(
    c,
    w,
    hash,
    async () => {
      const keyHolds = q`EXISTS (SELECT 1 FROM platform_keys rk, json_each(rk.scopes_json) rj
          WHERE rk.id = ${c.key.id} AND rk.org_id = ${org} AND ${KEY_IN_FORCE('rk', c.now)} AND rk.expires_at > ${DB_NOW} AND rj.value = ${b.scopeId})`;
      const scopeApps = q`(SELECT json_group_array(json_object('id', id, 'name', name)) FROM (SELECT id, name FROM apps WHERE scope_id = ${b.scopeId} AND deleted_at IS NULL ORDER BY id))`;
      const p = await c.db.first<CreatePlan>(
        q`SELECT ${replayRow(w.requestId)} AS replay, (SELECT COUNT(*) FROM org_security_contacts WHERE org_id = ${org}) AS contacts,
                 s.org_id AS scope_org, s.environment, s.app_user_ids, s.assigned_at, ${keyHolds} AS on_key,
                 (SELECT COUNT(*) FROM apps WHERE org_id = ${org} AND created_by_kind = 'platform' AND deleted_at IS NULL) AS platform_apps,
                 (SELECT max_apps FROM platform_orgs WHERE org_id = ${org}) AS max_apps,
                 ${scopeApps} AS scope_apps, ${WAITING(org, c.now)} AS waiting
            FROM (SELECT 1) LEFT JOIN scopes s ON s.scope_id = ${b.scopeId}`,
      );
      refuseReplay(p?.replay, w);
      if (!p || p.scope_org !== org || p.environment !== 'test' || p.on_key !== 1 || p.app_user_ids !== 1) {
        refuse('forbidden', 'Your platform key can create apps only on its own scopes that Journear marked as a shared wallet');
      }
      if (p!.contacts === 0) refuse('no_security_contact', 'Your organisation has no security contact: ask Journear to set them first');
      const others = JSON.parse(p!.scope_apps) as { id: string; name: string }[];
      const alike = others.find((o) => namesLookAlike(o.name, name));
      if (alike) refuse('conflict', `The name reads like another app’s on this scope ("${alike.name}"): choose a name that can’t be taken for it`);
      if (origins.length && p!.assigned_at! > c.now - config.delayMs) refuse('conflict', 'The scope was given to your organisation only just now: web addresses can be proposed a little later');
      const maxApps = p!.max_apps ?? 10;
      if (p!.platform_apps >= maxApps) throw new PlatformRefusal('app_limit', `Your organisation has ${maxApps} apps created through the platform, its limit: ask Journear to raise it`, { maxApps });
      if (p!.waiting + origins.length > L.waitingPerOrg) {
        throw new PlatformRefusal('rate_limited', `At most ${L.waitingPerOrg} web addresses may wait at once across your organisation’s apps: wait for some to come into force, or cancel some`, { limit: 'platform:waiting_origins', retryAfterS: 3600 }, { 'retry-after': '3600' });
      }
      const giveCreation = await takeQuota(c, creationWindows(c.key), 1, 'app creations');
      let giveProposals: () => Promise<void> = async () => undefined;
      try {
        giveProposals = await takeQuota(c, proposalWindows(c.key), origins.length, 'web address proposals');
      } catch (err) {
        await giveCreation();
        throw err;
      }
      return withQuota(
        async () => {
          await giveCreation();
          await giveProposals();
        },
        () => writeCreate(c, w, { scopeId: b.scopeId, name, origins, others, minDelayMs, assignedBefore: c.now - config.delayMs, keyHolds }),
      );
    },
    (detail, app) => {
      const view = replayApp(app);
      const keyId = detail.keyId as string;
      return { app: view, publishableKey: view.keys.find((k) => k.id === keyId)?.key ?? null, changes: detail.origins ?? [] };
    },
  );
}

async function writeCreate(
  c: OpContext,
  w: Writer,
  i: { scopeId: string; name: string; origins: string[]; others: { id: string }[]; minDelayMs: number; assignedBefore: number; keyHolds: Q },
): Promise<OpAnswer> {
  const org = c.key.org_id;
  const appId = newId('app');
  const keyId = newId('key');
  const publishableKey = newPublishableKey('test');
  const changes = i.origins.map((origin) => ({ changeId: newId('guardedChange'), origin }));
  const when = committed(w.requestId);
  const list = JSON.stringify(changes);
  const othersIds = JSON.stringify(i.others.map((o) => o.id));
  const stmts: Q[] = [
    commitOn(
      w,
      { kind: 'app.created', detail: { name: i.name, plan: 'free', environment: 'test', keyId, scopeCreated: false, waiver: null, origins: changes, userIds: 'app', createdBy: 'platform' } },
      { orgId: org, appId, scopeId: i.scopeId },
      q`EXISTS (SELECT 1 FROM scopes s WHERE s.scope_id = ${i.scopeId} AND s.org_id = ${org} AND s.environment = 'test' AND s.app_user_ids = 1
                ${i.origins.length ? q`AND s.assigned_at <= ${i.assignedBefore}` : raw('')})
        AND ${i.keyHolds}
        AND EXISTS (SELECT 1 FROM platform_orgs ro WHERE ro.org_id = ${org} AND ro.enabled = 1 AND ro.frozen = 0)
        AND EXISTS (SELECT 1 FROM org_security_contacts WHERE org_id = ${org})
        AND (SELECT COUNT(*) FROM apps WHERE org_id = ${org} AND created_by_kind = 'platform' AND deleted_at IS NULL) < COALESCE((SELECT max_apps FROM platform_orgs WHERE org_id = ${org}), 10)
        AND (SELECT json_group_array(id) FROM (SELECT id FROM apps WHERE scope_id = ${i.scopeId} AND deleted_at IS NULL ORDER BY id)) = ${othersIds}
        AND ${WAITING(org, c.now)} + ${i.origins.length} <= ${L.waitingPerOrg}`,
    ),
    // L16: the app's User ID mode from the scope's mark as the batch sees it ('app' on a marked scope; the predicate
    // holds the mark, and migration 0030's trigger refuses a mode that contradicts it), its creator the platform.
    q`INSERT INTO apps (id, name, scope_id, org_id, publishable_key, status, plan, created_at, origins_version, user_ids, created_by_kind)
      SELECT ${appId}, ${i.name}, ${i.scopeId}, ${org}, ${publishableKey}, 'active', 'free', ${c.now}, ${changes.length ? 1 : 0},
             (SELECT CASE s.app_user_ids WHEN 1 THEN 'app' WHEN 0 THEN 'scope' END FROM scopes s WHERE s.scope_id = ${i.scopeId}), 'platform'
       WHERE ${when}`,
    q`INSERT INTO app_keys (id, app_id, key, created_by, created_at) SELECT ${keyId}, ${appId}, ${publishableKey}, ${actorId(w.actor)}, ${c.now} WHERE ${when}`,
  ];
  if (changes.length) {
    // The first web addresses are platform proposals with the platform's wait (A4.4): never staff proposals, never a
    // waiver; each one's wait first (migration 0033).
    stmts.push(
      platformWaits(w, appId, list, i.minDelayMs, 'changeId'),
      q`INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id)
        SELECT json_extract(value, '$.changeId'), ${appId}, 'origin_add', json_extract(value, '$.origin'), 'pending', 'platform', ${actorId(w.actor)}, ${c.now}, ${w.requestId}
          FROM json_each(${list}) WHERE ${when}`,
      q`INSERT INTO app_origins (app_id, origin, active_from, change_id)
        SELECT ${appId}, json_extract(value, '$.origin'), NULL, json_extract(value, '$.changeId') FROM json_each(${list}) WHERE ${when}`,
    );
  }
  await runWrite(c.db, w, stmts);
  const app: PlatformApp = {
    id: appId,
    name: i.name,
    scopeId: i.scopeId,
    environment: 'test',
    createdBy: 'platform',
    createdAt: c.now,
    userIds: 'app',
    suspended: suspendedView(0, null),
    originsVersion: changes.length ? 1 : 0,
    origins: changes.map((ch) => originView({ origin: ch.origin, active_from: null, change_id: ch.changeId }, c.now)),
    keys: [{ id: keyId, key: publishableKey, createdAt: c.now, revokedAt: null }],
  };
  return { status: 201, body: { app, publishableKey, changes }, appId, wrote: true };
}

// ---- origins (A4.5) ----

/** `POST /v1/platform/apps/:appId/origins`: web addresses proposed, each waiting (A4.5, M7, N3). `202`. */
export async function addPlatformOrigins(c: OpContext, appId: string, body: unknown): Promise<OpAnswer> {
  const b = platformAddOriginsBody.parse(body);
  const { w, hash } = await opWriter(c);
  const add = normaliseAll(b.add);
  return withReplay(
    c,
    w,
    hash,
    async () => {
      const give = await takeQuota(c, proposalWindows(c.key), add.length, 'web address proposals');
      const r = await withQuota(give, () =>
        platformProposeOrigins(c.db, c.env, w, { orgId: c.key.org_id, appId, add, expectedVersion: b.expectedVersion, minDelayMs: proposalWait(c.env), waitingMax: L.waitingPerOrg }),
      );
      return { status: 202, body: { version: r.version, changes: r.changes.map((ch) => ({ changeId: ch.id, origin: ch.origin })) }, appId, wrote: true };
    },
    (detail, app) => ({ version: replayApp(app).originsVersion, changes: detail.changes ?? [] }),
  );
}

/** `POST /v1/platform/apps/:appId/origins/remove`: web addresses stopped at once (a kill switch, allowed while frozen). */
export async function removePlatformOrigins(c: OpContext, appId: string, body: unknown): Promise<OpAnswer> {
  const b = platformRemoveOriginsBody.parse(body);
  const { w, hash } = await opWriter(c, { allowFrozen: true });
  return withReplay(
    c,
    w,
    hash,
    async () => {
      const r = await removeOrigins(c.db, w, { orgId: c.key.org_id, appId, remove: b.remove, expectedVersion: b.expectedVersion });
      return { status: 200, body: { version: r.version }, appId, wrote: true };
    },
    (_d, app) => ({ version: replayApp(app).originsVersion }),
  );
}

/** A cancelled change as the platform sees it. */
function changeOut(ch: { id: string; app_id: string; origin: string | null; status: PlatformChange['status']; active_from: number | null; cancelled_at: number | null }): PlatformChange {
  const d = originDisplay(ch.origin ?? '');
  return { changeId: ch.id, appId: ch.app_id, origin: d.origin, display: d.display, idn: d.idn, status: ch.status, activeFrom: ch.active_from, cancelledAt: ch.cancelled_at };
}

/**
 * `POST /v1/platform/changes/:changeId/cancel` (H2): only a waiting web address a platform key of the org proposed, on
 * an app in the reach; a member's, staff's or any other kind of change is `not_found`. Allowed while frozen.
 */
export async function cancelPlatformChange(c: OpContext, changeId: string): Promise<OpAnswer> {
  const { w, hash } = await opWriter(c, { allowFrozen: true });
  return withReplay(
    c,
    w,
    hash,
    async () => {
      const r = await cancelChange(c.db, w, { orgId: c.key.org_id, changeId });
      const ch = r.change;
      return {
        status: 200,
        body: { change: changeOut({ id: ch.id, app_id: ch.appId, origin: ch.origin ?? null, status: ch.status, active_from: ch.activeFrom ?? null, cancelled_at: ch.cancelledAt ?? null }) },
        appId: ch.appId,
        wrote: true,
      };
    },
    (_d, _app, change) => {
      if (!change) return refuse('not_found', 'No such change');
      return { change: changeOut(change as unknown as Parameters<typeof changeOut>[0]) };
    },
  );
}

// ---- suspension (A4.6, L4) ----

/**
 * `POST /v1/platform/apps/:appId/suspend` `{suspended}`: the partner bit. Suspending sets it (holding it only if it was
 * clear; a kill switch, allowed while frozen); resuming clears it only while the platform holds it (`forbidden` for a
 * member's suspension, or one a member took over). Already in that state: nothing written.
 */
export async function suspendPlatformApp(c: OpContext, appId: string, suspended: boolean): Promise<OpAnswer> {
  const { w, hash } = await opWriter(c, { allowFrozen: suspended });
  return withReplay(
    c,
    w,
    hash,
    async () => {
      const r = await setSuspensionBit(c.db, w, { orgId: c.key.org_id, appId, bit: SUSPENSION_BITS.partner, suspended });
      return { status: 200, body: { suspended: suspendedView(r.suspendedBy, r.partnerBitBy) }, appId, wrote: w.wrote === true };
    },
    (_d, app) => ({ suspended: replayApp(app).suspended }),
  );
}

// ---- publishable keys ----

/** `POST /v1/platform/apps/:appId/keys`: a new publishable key (at most 5 unrevoked: `key_limit`). `201`. */
export async function createPublishableKey(c: OpContext, appId: string): Promise<OpAnswer> {
  const { w, hash } = await opWriter(c);
  return withReplay(
    c,
    w,
    hash,
    async () => {
      const r = await createKey(c.db, w, { orgId: c.key.org_id, appId });
      return { status: 201, body: { key: { id: r.key.id, key: r.key.key, createdAt: r.key.createdAt, revokedAt: null } }, appId, wrote: true };
    },
    (detail, app) => {
      const k = replayApp(app).keys.find((x) => x.id === detail.keyId);
      return { key: k ?? null };
    },
  );
}

/** `POST /v1/platform/apps/:appId/keys/:keyId/revoke`: at once (a kill switch, allowed while frozen); the last key too. */
export async function revokePublishableKey(c: OpContext, appId: string, keyId: string): Promise<OpAnswer> {
  const { w, hash } = await opWriter(c, { allowFrozen: true });
  return withReplay(
    c,
    w,
    hash,
    async () => {
      const r = await revokeKey(c.db, w, { orgId: c.key.org_id, appId, keyId });
      return { status: 200, body: { ...r }, appId, wrote: true };
    },
    (detail, app) => {
      replayApp(app);
      return detail.lastKey === true ? { warning: 'last_key' } : {};
    },
  );
}

