// Origin writes (docs/batch-c-spec.md "Guarded changes"): removals are immediate everywhere (ConsoleRpc.removeOrigins
// and the AdminRpc org method); additions are guarded changes: Hana staff proposals (AdminRpc.addOrigins: no step-up,
// the full delay and the blocking notice, never a waiver, refused for `appChangeDelayMs` after a scope assignment) and
// member proposals (ConsoleRpc.changeOrigins: the API-verified step-up, changes/step-up.ts; removes sent with them
// apply at once in the same batch).
import { type Environment, LOCALHOST_WILDCARD, MAX_APP_ORIGINS, NO_ANYWHERE_ORIGIN, newId, nonceOf, normaliseOrigin, OriginError, originChangeDigest, originProblem, personEmailKey } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { changeConfig, platformMinDelayMs } from '../guarded/config.ts';
import { expectVersion, planApp } from './apps.ts';
import { type Writer, actorId, closeChanges, commitOnApp, committed, refuse, runWrite, expectReplay } from './cas.ts';
import type { HotDb } from './db.ts';
import { type Q, q, raw } from './sql.ts';
import { type StepUpToken, confirmStepUp, releaseStepUp, verifyStepUpToken } from './step-up.ts';
import { type ChangeRow, changeView } from './views.ts';
import { PlatformRefusal } from '../platform/refusal.ts';

/** The stored (ASCII) form of each origin, deduplicated and sorted; `bad_request` for one that isn't an origin. */
export function normaliseAll(input: readonly string[]): string[] {
  const out = new Set<string>();
  for (const o of input) {
    try {
      out.add(normaliseOrigin(o));
    } catch (e) {
      refuse('bad_request', e instanceof OriginError ? `Origin ${JSON.stringify(o.slice(0, 200))}: ${e.message}` : 'Invalid origin');
    }
  }
  return [...out].sort();
}

/**
 * D934: the stored form of each web address marked frame-only, which must each be one of `add` (already normalised);
 * `bad_request` otherwise, or for the localhost wildcard (a pattern, never a page's address). Sorted.
 */
export function normaliseFrameOnly(add: readonly string[], input: readonly string[] | undefined): string[] {
  const frameOnly = normaliseAll(input ?? []);
  const stray = frameOnly.filter((o) => !add.includes(o));
  if (stray.length) refuse('bad_request', `Marked frame-only but not added: ${stray.join(', ')}`);
  if (frameOnly.includes(LOCALHOST_WILDCARD)) refuse('bad_request', `${LOCALHOST_WILDCARD} can't be frame-only: it is a pattern, not a page's web address`);
  return frameOnly;
}

/**
 * D934: the JSON list a proposal's batch inserts from: each change's id (under `idField`) and web address, and
 * `frameOnly: true` for one the app may use only inside its other web addresses (never `false`: the ledger's detail
 * then reads as before for every other add).
 */
export function changeList<K extends 'id' | 'changeId'>(add: readonly string[], frameOnly: readonly string[], idField: K): ({ origin: string; frameOnly?: true } & Record<K, string>)[] {
  return add.map((origin) => ({ [idField]: newId('guardedChange'), origin, ...(frameOnly.includes(origin) ? { frameOnly: true as const } : {}) }) as { origin: string; frameOnly?: true } & Record<K, string>);
}

/** The gate rows of a proposal's changes (`list`, changeList's JSON): each waiting, frame-only as marked. */
export function gateRows(w: Writer, appId: string, list: string, idField: 'id' | 'changeId'): Q {
  return q`INSERT INTO app_origins (app_id, origin, active_from, change_id, frame_only)
    SELECT ${appId}, json_extract(value, '$.origin'), NULL, json_extract(value, ${`$.${idField}`}), CASE WHEN json_extract(value, '$.frameOnly') = 1 THEN 1 ELSE 0 END
      FROM json_each(${list}) WHERE ${committed(w.requestId)}`;
}

/**
 * D934 (ConsoleRpc and AdminRpc `frameOnlyOrigins`): web addresses of the app set to work only inside its other web
 * addresses, at once (a tightening: a page that used one on its own stops at its next load), one origins_version
 * bump and one `origin.frame_only` ledger row. Each must be a row of the app (in force or waiting), not the localhost
 * wildcard, and not frame-only already. Never the other way: migration 0035 refuses clearing the flag in place.
 */
export async function frameOnlyOrigins(db: HotDb, w: Writer, i: { orgId: string | null; appId: string; origins: readonly string[]; expectedVersion: number }): Promise<{ version: number }> {
  expectReplay(w, ['origin.frame_only']);
  const list = normaliseAll(i.origins);
  if (list.includes(LOCALHOST_WILDCARD)) refuse('bad_request', `${LOCALHOST_WILDCARD} can't be frame-only: it is a pattern, not a page's web address`);
  const plan = await planApp(db, { appId: i.appId, orgId: i.orgId, w, with: { origins: true } });
  expectVersion(plan.app.origins_version, i.expectedVersion);
  const rows = new Map(plan.origins.map((o) => [o.origin, o]));
  const unknown = list.filter((o) => !rows.has(o));
  if (unknown.length) refuse('bad_request', `Not an origin of this app: ${unknown.join(', ')}`);
  const already = list.filter((o) => rows.get(o)!.frame_only === 1);
  if (already.length) refuse('conflict', `Already frame-only: ${already.join(', ')}`);
  // At least one web address that works on its own page stays (in force or waiting), also as the batch sees it.
  if (!plan.origins.some((o) => o.frame_only !== 1 && !list.includes(o.origin))) refuse('conflict', NO_ANYWHERE_ORIGIN);
  const json = JSON.stringify(list);
  await runWrite(db, w, [
    commitOnApp(
      w,
      { kind: 'origin.frame_only', detail: { origins: list.map((o) => ({ origin: o, wasInForce: (rows.get(o)!.active_from ?? null) !== null && rows.get(o)!.active_from! <= w.now })) } },
      i.appId,
      i.orgId,
      q`a.origins_version = ${i.expectedVersion} AND a.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM app_origins ka WHERE ka.app_id = a.id AND ka.frame_only = 0 AND ka.origin NOT IN (SELECT value FROM json_each(${json})))`,
    ),
    q`UPDATE apps SET origins_version = origins_version + 1 WHERE id = ${i.appId} AND ${committed(w.requestId)}`,
    q`UPDATE app_origins SET frame_only = 1 WHERE app_id = ${i.appId} AND origin IN (SELECT value FROM json_each(${json})) AND ${committed(w.requestId)}`,
  ]);
  return { version: i.expectedVersion + 1 };
}

/** The guarded-change configuration, or `internal` (spec "Topology and config": a missing or out-of-range delay refuses every guarded change). */
export function requireChangeConfig(env: Env) {
  const r = changeConfig(env);
  if (!r.ok) return refuse('internal', 'Guarded changes are not configured in this environment');
  return r.config;
}

/** `origin_refused` unless every origin may be added to an app on a scope of `environment` (console-core originProblem). */
export function checkOriginRules(env: Env, environment: Environment, origins: readonly string[]): void {
  const config = requireChangeConfig(env);
  for (const origin of origins) {
    const p = originProblem(origin, { envName: env.ENV_NAME, network: config.network, environment, refusedOrigins: config.refusedOrigins });
    if (p) refuse('origin_refused', `${origin}: ${p.message} (${p.reason})`);
  }
}

/**
 * removeOrigins: the rows go at once; an origin_add for them in force ends, one not yet in force is cancelled; one
 * origins_version bump. Each origin must be one of the app's (a row, or an open origin_add whose row was parked).
 */
export async function removeOrigins(db: HotDb, w: Writer, i: { orgId: string | null; appId: string; remove: readonly string[]; expectedVersion: number }): Promise<{ version: number }> {
  expectReplay(w, ['origin.removed']);
  const remove = normaliseAll(i.remove);
  const plan = await planApp(db, { appId: i.appId, orgId: i.orgId, w, with: { origins: true, changes: true } });
  expectVersion(plan.app.origins_version, i.expectedVersion);
  const rows = new Map(plan.origins.map((o) => [o.origin, o]));
  const open = new Set(plan.openChanges.filter((c) => c.kind === 'origin_add').map((c) => c.origin));
  const unknown = remove.filter((o) => !rows.has(o) && !open.has(o));
  if (unknown.length) refuse('bad_request', `Not an origin of this app: ${unknown.join(', ')}`);
  const list = JSON.stringify(remove);
  const detail = { origins: remove.map((o) => ({ origin: o, wasInForce: (rows.get(o)?.active_from ?? null) !== null && rows.get(o)!.active_from! <= w.now })) };
  await runWrite(db, w, [
    commitOnApp(w, { kind: 'origin.removed', detail }, i.appId, i.orgId, q`a.origins_version = ${i.expectedVersion} AND a.deleted_at IS NULL`),
    q`UPDATE apps SET origins_version = origins_version + 1 WHERE id = ${i.appId} AND ${committed(w.requestId)}`,
    closeChanges(q`app_id = ${i.appId} AND kind = 'origin_add' AND origin IN (SELECT value FROM json_each(${list}))`, w),
    q`DELETE FROM app_origins WHERE app_id = ${i.appId} AND origin IN (SELECT value FROM json_each(${list})) AND ${committed(w.requestId)}`,
  ]);
  return { version: i.expectedVersion + 1 };
}

/**
 * AdminRpc.addOrigins: each origin a staff proposal (a pending origin_add, an `app_origins` row with `active_from` NULL
 * that never matches until the notice is acked and the delay passes), one origins_version bump. Never a waiver.
 */
export async function addOrigins(db: HotDb, env: Env, w: Writer, i: { orgId: string; appId: string; add: readonly string[]; frameOnly?: readonly string[]; expectedVersion: number }) {
  const { changes } = await proposeOrigins(db, env, w, { ...i, remove: [] }, null);
  return { changes };
}

/**
 * ConsoleRpc.changeOrigins: a member's origin adds, with any removes sent with them, bound to the member's step-up
 * token (changes/step-up.ts; the origin-change layout over the sorted adds and removes and the stored origins_version).
 * The adds are pending guarded changes like a staff proposal's, recorded with the verified `proposer_sub` (the
 * `no_session` waiver's precondition for a member) and `actor_sub`; the removes take effect at once in the same batch.
 */
export async function changeOrigins(
  db: HotDb,
  env: Env,
  w: Writer,
  i: { orgId: string; appId: string; add: readonly string[]; remove: readonly string[]; frameOnly?: readonly string[]; expectedVersion: number; stepUpJwt: string },
) {
  const token = await verifyStepUpToken(env, i.stepUpJwt, w.actor, w.now);
  return proposeOrigins(db, env, w, i, token);
}

/**
 * The platform's origin proposals (D929, docs/partner-platform-spec.md A4.5; `POST /v1/platform/apps/:appId/origins`):
 * adds only, each a guarded change proposed by the `platform` (its id the key's), on an app in the writer's reach
 * (`w.reach`, H1). Checked with the live-scope rules even on a test scope (M7: no loopback, no localhost wildcard, no
 * http, no mixed-script host label); refused within `appChangeDelayMs` of the scope's assignment, as staff proposals
 * are; the 20 web addresses per app as for everyone (a partner on the network's widget spends one on the widget's
 * origin; two apps may list the same origin). Each records its wait (`min_delay_ms`), which the ack and the database
 * hold (migration 0033): no waiver and no expedite. At most `waitingMax` of the org's web addresses waiting at once, in
 * the commit predicate.
 */
export async function platformProposeOrigins(
  db: HotDb,
  env: Env,
  w: Writer,
  i: { orgId: string; appId: string; add: readonly string[]; frameOnly?: readonly string[]; expectedVersion: number; minDelayMs: number; waitingMax: number },
) {
  if (!w.reach || (w.actor.kind as string) !== 'platform') return refuse('forbidden', 'Only the platform proposes this way');
  return proposeOrigins(db, env, w, { ...i, remove: [] }, null, { minDelayMs: i.minDelayMs, waitingMax: i.waitingMax });
}

/**
 * D929: the waits of the platform's proposals in `list` (JSON objects with the change id under `idField` and the
 * origin), written in the proposal's batch before the guarded changes (migration 0033's `platform_origin_waits`): the
 * proposing key (the writer's actor), the wait from the announcement, the earliest time left for the ack.
 */
export function platformWaits(w: Writer, appId: string, list: string, minDelayMs: number, idField: 'id' | 'changeId'): Q {
  return q`INSERT INTO platform_origin_waits (change_id, app_id, origin, key_id, min_delay_ms, at)
    SELECT json_extract(value, ${`$.${idField}`}), ${appId}, json_extract(value, '$.origin'), ${actorId(w.actor)}, ${minDelayMs}, ${w.now}
      FROM json_each(${list}) WHERE ${committed(w.requestId)}`;
}

/**
 * D931 (A15, four eyes, D917): the waits of staff proposals on a platform-created app or on any app of a scope marked
 * as shared, written in the proposal's batch before the guarded changes, only if the app is such an app **as the batch
 * sees it** (`INSERT … SELECT`, so a mark set between the plan read and the batch is not missed; migration 0034's
 * trigger refuses such a staff proposal without its wait): the proposing staff member and their email key (a second
 * staff member must differ in both), and the wait from the announcement, the greater of the env's delay and the 24 h
 * platform minimum (`local*` test envs: the env's delay). For any other app it writes nothing.
 */
export function staffWaits(env: Env, w: Writer, appId: string, list: string, idField: 'id' | 'changeId', delayMs: number): Q {
  const email = w.actor.kind === 'hana' ? personEmailKey(w.actor.email) : null;
  const wait = Math.max(delayMs, platformMinDelayMs(env));
  return q`INSERT INTO staff_origin_waits (change_id, app_id, origin, proposed_by, proposer_email_key, min_delay_ms, at)
    SELECT json_extract(value, ${`$.${idField}`}), ${appId}, json_extract(value, '$.origin'), ${actorId(w.actor)}, ${email}, ${wait}, ${w.now}
      FROM json_each(${list})
     WHERE ${committed(w.requestId)}
       AND EXISTS (SELECT 1 FROM apps a JOIN scopes s ON s.scope_id = a.scope_id WHERE a.id = ${appId} AND (a.created_by_kind = 'platform' OR s.app_user_ids = 1))`;
}

/**
 * The write behind addOrigins (staff: `token` null), changeOrigins (a member's verified token) and the platform's
 * proposals (`platform`). Staff and platform proposals are refused for `appChangeDelayMs` after the scope's assignment;
 * a member's are not (spec "Staff proposals").
 */
async function proposeOrigins(
  db: HotDb,
  env: Env,
  w: Writer,
  i: { orgId: string; appId: string; add: readonly string[]; remove: readonly string[]; frameOnly?: readonly string[]; expectedVersion: number },
  token: StepUpToken | null,
  platform?: { minDelayMs: number; waitingMax: number },
): Promise<{ version: number; changes: ReturnType<typeof changeView>[] }> {
  expectReplay(w, ['origin.proposed']);
  const config = requireChangeConfig(env);
  const add = normaliseAll(i.add);
  const remove = normaliseAll(i.remove);
  const frameOnly = normaliseFrameOnly(add, i.frameOnly);
  const both = add.filter((o) => remove.includes(o));
  if (both.length) refuse('bad_request', `Both added and removed: ${both.join(', ')}`);
  const plan = await planApp(db, { appId: i.appId, orgId: i.orgId, w, with: { origins: true, changes: true, ...(platform ? { platformWaiting: i.orgId } : {}) } });
  expectVersion(plan.app.origins_version, i.expectedVersion);
  if (!token && plan.app.assigned_at > w.now - config.delayMs) refuse('conflict', 'The scope was assigned to this org less than appChangeDelayMs ago: staff proposals wait for it');
  // M7: the platform's web addresses follow the live-scope rules on every scope.
  checkOriginRules(env, platform ? 'live' : plan.app.environment, add);
  // The app's origins: its rows and every open origin_add (one whose row was parked has no row but still counts).
  const rows = new Map(plan.origins.map((o) => [o.origin, o]));
  const have = new Set([...rows.keys(), ...plan.openChanges.filter((c) => c.kind === 'origin_add' && c.origin !== null).map((c) => c.origin!)]);
  const unknown = remove.filter((o) => !have.has(o));
  if (unknown.length) refuse('bad_request', `Not an origin of this app: ${unknown.join(', ')}`);
  const dup = add.filter((o) => have.has(o));
  if (dup.length) refuse('conflict', `Already an origin of this app (in force or pending): ${dup.join(', ')}`);
  if (have.size - remove.length + add.length > MAX_APP_ORIGINS) refuse('conflict', `At most ${MAX_APP_ORIGINS} active or pending origins per app`);
  // D934: a proposal with frame-only adds keeps at least one web address that works on its own page (a usable-anywhere
  // add, or a row of the app not removed here). Without frame-only adds nothing changes.
  const anywhereAdd = add.some((o) => !frameOnly.includes(o));
  if (frameOnly.length > 0 && !anywhereAdd && !plan.origins.some((o) => o.frame_only !== 1 && !remove.includes(o.origin))) refuse('conflict', NO_ANYWHERE_ORIGIN);
  // The platform's cap on waiting web addresses across the org (A5), checked before the batch as its create checks it
  // (platform/ops.ts): a full cap is a 429 with the hour to wait, not the commit predicate's version_conflict, which a
  // client would answer by reading again and resending (after PR 160's review, M1). The predicate below keeps the rule
  // for a race; no quota window has been taken yet (withQuota takes them just before the batch).
  if (platform && (plan.platformWaiting ?? 0) + add.length > platform.waitingMax) {
    throw new PlatformRefusal(
      'rate_limited',
      `At most ${platform.waitingMax} web addresses may wait at once across your organisation’s apps: wait for some to come into force, or cancel some`,
      { limit: 'platform:waiting_origins', retryAfterS: 3600 },
      { 'retry-after': '3600' },
    );
  }
  if (token) {
    // Steps 4–6 of the API verification, after the version check and every input and state check (a refusal before
    // the reservation leaves the token unused).
    const expectedNonce = nonceOf(await originChangeDigest({ signer: env.SIGNER_ACCOUNT, appId: i.appId, add, remove, frameOnly, originsVersion: plan.app.origins_version }));
    await confirmStepUp(env, token, { expectedNonce, scopeId: plan.app.scope_id });
    w.sub = token.sub;
  }
  const by = token
    ? { kind: 'member' as const, id: actorId(w.actor), sub: token.sub }
    : platform
      ? { kind: 'platform' as const, id: actorId(w.actor), sub: null }
      : { kind: 'hana' as const, id: actorId(w.actor), sub: null };
  // The org's web addresses the platform proposed that still wait (any of its keys, any of its apps), with these.
  const waitingHolds = platform
    ? q` AND (SELECT COUNT(*) FROM guarded_changes wg WHERE wg.kind = 'origin_add' AND wg.proposed_by_kind = 'platform' AND wg.status = 'pending'
                AND (wg.active_from IS NULL OR wg.active_from > ${w.now}) AND wg.app_id IN (SELECT id FROM apps WHERE org_id = ${i.orgId})) + ${add.length} <= ${platform.waitingMax}`
    : raw('');
  const changes = changeList(add, frameOnly, 'id');
  const list = JSON.stringify(changes);
  const origins = JSON.stringify(add);
  const removed = JSON.stringify(remove);
  const detail: Record<string, unknown> = { changes: changes.map((c) => ({ changeId: c.id, origin: c.origin, ...(c.frameOnly ? { frameOnly: true } : {}) })) };
  if (remove.length) detail.removed = remove.map((o) => ({ origin: o, wasInForce: (rows.get(o)?.active_from ?? null) !== null && rows.get(o)!.active_from! <= w.now }));
  const stmts: Q[] = [
    commitOnApp(
      w,
      { kind: 'origin.proposed', detail },
      i.appId,
      i.orgId,
      q`a.origins_version = ${i.expectedVersion} AND a.deleted_at IS NULL
        AND (${token ? raw('1') : q`(SELECT assigned_at FROM scopes WHERE scope_id = a.scope_id) <= ${w.now - config.delayMs}`})
        AND (SELECT COUNT(*) FROM (SELECT origin FROM app_origins WHERE app_id = a.id
                                   UNION SELECT origin FROM guarded_changes WHERE app_id = a.id AND kind = 'origin_add' AND status IN ('pending', 'active'))) - ${remove.length} + ${add.length} <= ${MAX_APP_ORIGINS}
        AND NOT EXISTS (SELECT 1 FROM app_origins WHERE app_id = a.id AND origin IN (SELECT value FROM json_each(${origins})))
        AND NOT EXISTS (SELECT 1 FROM guarded_changes WHERE app_id = a.id AND kind = 'origin_add' AND status IN ('pending', 'active')
                         AND origin IN (SELECT value FROM json_each(${origins})))${waitingHolds}${
                           frameOnly.length > 0 && !anywhereAdd
                             ? q` AND EXISTS (SELECT 1 FROM app_origins ka WHERE ka.app_id = a.id AND ka.frame_only = 0 AND ka.origin NOT IN (SELECT value FROM json_each(${removed})))`
                             : raw('')
                         }`,
    ),
    q`UPDATE apps SET origins_version = origins_version + 1 WHERE id = ${i.appId} AND ${committed(w.requestId)}`,
  ];
  if (remove.length) {
    // The removes first, so the adds' rows are never the ones removed (an add and a remove of one origin is refused).
    stmts.push(
      closeChanges(q`app_id = ${i.appId} AND kind = 'origin_add' AND origin IN (SELECT value FROM json_each(${removed}))`, w),
      q`DELETE FROM app_origins WHERE app_id = ${i.appId} AND origin IN (SELECT value FROM json_each(${removed})) AND ${committed(w.requestId)}`,
    );
  }
  // A platform proposal's wait first (migration 0033: its guarded change can't be written without it); a staff one's on
  // a platform-created app or a shared wallet likewise (migration 0034, four eyes).
  if (platform) stmts.push(platformWaits(w, i.appId, list, platform.minDelayMs, 'id'));
  else if (!token) stmts.push(staffWaits(env, w, i.appId, list, 'id', config.delayMs));
  stmts.push(
    q`INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposer_sub, proposed_at, request_id)
      SELECT json_extract(value, '$.id'), ${i.appId}, 'origin_add', json_extract(value, '$.origin'), 'pending', ${by.kind}, ${by.id}, ${by.sub}, ${w.now}, ${w.requestId}
        FROM json_each(${list}) WHERE ${committed(w.requestId)}`,
    gateRows(w, i.appId, list, 'id'),
  );
  try {
    await runWrite(db, w, stmts);
  } catch (err) {
    // Nothing was written (the batch is all or nothing): the token may be used again.
    if (token && !w.wrote) await releaseStepUp(env, token);
    throw err;
  }
  const proposed: ChangeRow[] = changes.map((c) => ({
    id: c.id,
    app_id: i.appId,
    kind: 'origin_add',
    origin: c.origin,
    policy_json: null,
    policy_id: null,
    status: 'pending',
    proposed_by_kind: by.kind,
    proposed_by: by.id,
    proposer_sub: by.sub,
    proposed_at: w.now,
    request_country: null,
    waiver: null,
    notified_at: null,
    active_from: null,
    expedited_by: null,
    cancelled_by: null,
    cancelled_at: null,
    request_id: w.requestId,
    frame_only: c.frameOnly ? 1 : 0,
  }));
  return { version: i.expectedVersion + 1, changes: proposed.map(changeView) };
}
