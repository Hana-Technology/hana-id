// Origin writes (docs/batch-c-spec.md "Guarded changes"): removals are immediate everywhere (ConsoleRpc.removeOrigins
// and the AdminRpc org method); additions are guarded changes, here only Hana staff proposals (AdminRpc.addOrigins:
// no step-up, the full delay and the blocking notice, never a waiver, refused for `appChangeDelayMs` after a scope
// assignment). Member-proposed additions (`changeOrigins`, with the API-verified step-up) come with batch C6.
import { type Environment, MAX_APP_ORIGINS, newId, normaliseOrigin, OriginError, originProblem } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { changeConfig } from '../guarded/config.ts';
import { expectVersion, planApp } from './apps.ts';
import { type Writer, actorId, closeChanges, commitOnApp, committed, refuse, runWrite } from './cas.ts';
import type { HotDb } from './db.ts';
import { q } from './sql.ts';
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
  const remove = normaliseAll(i.remove);
  const plan = await planApp(db, { appId: i.appId, orgId: i.orgId, requestId: w.requestId, with: { origins: true, changes: true } });
  expectVersion(plan.app.origins_version, i.expectedVersion);
  const rows = new Map(plan.origins.map((o) => [o.origin, o]));
  const open = new Set(plan.openChanges.filter((c) => c.kind === 'origin_add').map((c) => c.origin));
  const unknown = remove.filter((o) => !rows.has(o) && !open.has(o));
  if (unknown.length) refuse('bad_request', `Not an origin of this app: ${unknown.join(', ')}`);
  const list = JSON.stringify(remove);
  const detail = { origins: remove.map((o) => ({ origin: o, wasInForce: (rows.get(o)?.active_from ?? null) !== null && rows.get(o)!.active_from! <= w.now })) };
  await runWrite(db, w.requestId, [
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
  const config = requireChangeConfig(env);
  const add = normaliseAll(i.add);
  const plan = await planApp(db, { appId: i.appId, orgId: i.orgId, requestId: w.requestId, with: { origins: true } });
  expectVersion(plan.app.origins_version, i.expectedVersion);
  if (plan.app.assigned_at > w.now - config.delayMs) refuse('conflict', 'The scope was assigned to this org less than appChangeDelayMs ago: staff proposals wait for it');
  checkOriginRules(env, plan.app.environment, add);
  const have = new Set(plan.origins.map((o) => o.origin));
  const dup = add.filter((o) => have.has(o));
  if (dup.length) refuse('conflict', `Already an origin of this app (in force or pending): ${dup.join(', ')}`);
  if (plan.origins.length + add.length > MAX_APP_ORIGINS) refuse('conflict', `At most ${MAX_APP_ORIGINS} active or pending origins per app`);
  const changes = add.map((origin) => ({ id: newId('guardedChange'), origin }));
  const list = JSON.stringify(changes);
  const origins = JSON.stringify(add);
  await runWrite(db, w.requestId, [
    commitOnApp(
      w,
      { kind: 'origin.proposed', detail: { changes: changes.map((c) => ({ changeId: c.id, origin: c.origin })) } },
      i.appId,
      i.orgId,
      q`a.origins_version = ${i.expectedVersion} AND a.deleted_at IS NULL
        AND (SELECT assigned_at FROM scopes WHERE scope_id = a.scope_id) <= ${w.now - config.delayMs}
        AND (SELECT COUNT(*) FROM app_origins WHERE app_id = a.id) + ${add.length} <= ${MAX_APP_ORIGINS}
        AND NOT EXISTS (SELECT 1 FROM app_origins WHERE app_id = a.id AND origin IN (SELECT value FROM json_each(${origins})))`,
    ),
    q`UPDATE apps SET origins_version = origins_version + 1 WHERE id = ${i.appId} AND ${committed(w.requestId)}`,
    q`INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id)
      SELECT json_extract(value, '$.id'), ${i.appId}, 'origin_add', json_extract(value, '$.origin'), 'pending', 'hana', ${actorId(w.actor)}, ${w.now}, ${w.requestId}
        FROM json_each(${list}) WHERE ${committed(w.requestId)}`,
    q`INSERT INTO app_origins (app_id, origin, active_from, change_id)
      SELECT ${i.appId}, json_extract(value, '$.origin'), NULL, json_extract(value, '$.id') FROM json_each(${list}) WHERE ${committed(w.requestId)}`,
  ]);
  const proposed: ChangeRow[] = changes.map((c) => ({
    id: c.id,
    app_id: i.appId,
    kind: 'origin_add',
    origin: c.origin,
    policy_json: null,
    policy_id: null,
    status: 'pending',
    proposed_by_kind: 'hana',
    proposed_by: actorId(w.actor),
    proposer_sub: null,
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
  return { changes: proposed.map(changeView) };
}
