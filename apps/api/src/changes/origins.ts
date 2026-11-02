// Origin writes (docs/batch-c-spec.md "Guarded changes"): removals are immediate everywhere (ConsoleRpc.removeOrigins
// and the AdminRpc org method); additions are guarded changes: Hana staff proposals (AdminRpc.addOrigins: no step-up,
// the full delay and the blocking notice, never a waiver, refused for `appChangeDelayMs` after a scope assignment) and
// member proposals (ConsoleRpc.changeOrigins: the API-verified step-up, changes/step-up.ts; removes sent with them
// apply at once in the same batch).
import { type Environment, MAX_APP_ORIGINS, newId, nonceOf, normaliseOrigin, OriginError, originChangeDigest, originProblem } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { changeConfig } from '../guarded/config.ts';
import { expectVersion, planApp } from './apps.ts';
import { type Writer, actorId, closeChanges, commitOnApp, committed, refuse, runWrite, expectReplay } from './cas.ts';
import type { HotDb } from './db.ts';
import { type Q, q, raw } from './sql.ts';
import { type StepUpToken, confirmStepUp, releaseStepUp, verifyStepUpToken } from './step-up.ts';
import { type ChangeRow, changeView } from './views.ts';

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
export async function addOrigins(db: HotDb, env: Env, w: Writer, i: { orgId: string; appId: string; add: readonly string[]; expectedVersion: number }) {
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
  i: { orgId: string; appId: string; add: readonly string[]; remove: readonly string[]; expectedVersion: number; stepUpJwt: string },
) {
  const token = await verifyStepUpToken(env, i.stepUpJwt, w.actor, w.now);
  return proposeOrigins(db, env, w, i, token);
}

/**
 * The write behind addOrigins (staff: `token` null) and changeOrigins (a member's verified token). Staff proposals are
 * refused for `appChangeDelayMs` after the scope's assignment; a member's are not (spec "Staff proposals").
 */
async function proposeOrigins(
  db: HotDb,
  env: Env,
  w: Writer,
  i: { orgId: string; appId: string; add: readonly string[]; remove: readonly string[]; expectedVersion: number },
  token: StepUpToken | null,
): Promise<{ version: number; changes: ReturnType<typeof changeView>[] }> {
  expectReplay(w, ['origin.proposed']);
  const config = requireChangeConfig(env);
  const add = normaliseAll(i.add);
  const remove = normaliseAll(i.remove);
  const both = add.filter((o) => remove.includes(o));
  if (both.length) refuse('bad_request', `Both added and removed: ${both.join(', ')}`);
  const plan = await planApp(db, { appId: i.appId, orgId: i.orgId, w, with: { origins: true, changes: true } });
  expectVersion(plan.app.origins_version, i.expectedVersion);
  if (!token && plan.app.assigned_at > w.now - config.delayMs) refuse('conflict', 'The scope was assigned to this org less than appChangeDelayMs ago: staff proposals wait for it');
  checkOriginRules(env, plan.app.environment, add);
  // The app's origins: its rows and every open origin_add (one whose row was parked has no row but still counts).
  const rows = new Map(plan.origins.map((o) => [o.origin, o]));
  const have = new Set([...rows.keys(), ...plan.openChanges.filter((c) => c.kind === 'origin_add' && c.origin !== null).map((c) => c.origin!)]);
  const unknown = remove.filter((o) => !have.has(o));
  if (unknown.length) refuse('bad_request', `Not an origin of this app: ${unknown.join(', ')}`);
  const dup = add.filter((o) => have.has(o));
  if (dup.length) refuse('conflict', `Already an origin of this app (in force or pending): ${dup.join(', ')}`);
  if (have.size - remove.length + add.length > MAX_APP_ORIGINS) refuse('conflict', `At most ${MAX_APP_ORIGINS} active or pending origins per app`);
  if (token) {
    // Steps 4–6 of the API verification, after the version check and every input and state check (a refusal before
    // the reservation leaves the token unused).
    const expectedNonce = nonceOf(await originChangeDigest({ signer: env.SIGNER_ACCOUNT, appId: i.appId, add, remove, originsVersion: plan.app.origins_version }));
    await confirmStepUp(env, token, { expectedNonce, scopeId: plan.app.scope_id });
    w.sub = token.sub;
  }
  const by = token ? { kind: 'member' as const, id: actorId(w.actor), sub: token.sub } : { kind: 'hana' as const, id: actorId(w.actor), sub: null };
  const changes = add.map((origin) => ({ id: newId('guardedChange'), origin }));
  const list = JSON.stringify(changes);
  const origins = JSON.stringify(add);
  const removed = JSON.stringify(remove);
  const detail: Record<string, unknown> = { changes: changes.map((c) => ({ changeId: c.id, origin: c.origin })) };
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
                         AND origin IN (SELECT value FROM json_each(${origins})))`,
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
  stmts.push(
    q`INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposer_sub, proposed_at, request_id)
      SELECT json_extract(value, '$.id'), ${i.appId}, 'origin_add', json_extract(value, '$.origin'), 'pending', ${by.kind}, ${by.id}, ${by.sub}, ${w.now}, ${w.requestId}
        FROM json_each(${list}) WHERE ${committed(w.requestId)}`,
    q`INSERT INTO app_origins (app_id, origin, active_from, change_id)
      SELECT ${i.appId}, json_extract(value, '$.origin'), NULL, json_extract(value, '$.id') FROM json_each(${list}) WHERE ${committed(w.requestId)}`,
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
  }));
  return { version: i.expectedVersion + 1, changes: proposed.map(changeView) };
}
