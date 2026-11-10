// AdminRpc's own writes and reads (docs/batch-c-spec.md "Apps, scopes and client mode", "Notice and cancel", "RPC
// interfaces"): creating an app, assigning a legacy scope to an org, the security contacts (hot DB, Hana staff only,
// never ConsoleRpc), and the feeds the admin Worker reads (scopes, the change ledger, security events, the relayer
// pools' public keys).
import { KeyPair } from '@near-js/crypto';
import { type Environment, LEGACY_ORG_ID, newId, newPublishableKey } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { type Pool, parseRelayerKeys } from '../relayer-config.ts';
import { getApp } from './apps.ts';
import { type Writer, actorId, commitOn, committed, refuse, refuseReplay, replayRow, runWrite, expectReplay } from './cas.ts';
import { requireOwnersInOrg } from './chain.ts';
import type { HotDb } from './db.ts';
import { checkOriginRules, normaliseAll, requireChangeConfig } from './origins.ts';
import { appName } from './settings.ts';
import { type Q, q, raw } from './sql.ts';
import { APP_CHANGE_COLUMNS, type AppChangeRow, type SecurityEventRow, appChangeView, scopeView, securityEventView } from './views.ts';

const DEFAULT_PLAN = 'free';

interface ScopeRead {
  replay: string | null;
  contacts: number;
  scope_id: string | null;
  org_id: string | null;
  environment: Environment | null;
  assigned_at: number | null;
}

const readScope = (db: HotDb, w: Writer, scopeId: string, orgId: string) =>
  db.first<ScopeRead>(
    q`SELECT ${replayRow(w.requestId)} AS replay, (SELECT COUNT(*) FROM org_security_contacts WHERE org_id = ${orgId}) AS contacts,
             s.scope_id, s.org_id, s.environment, s.assigned_at
        FROM (SELECT 1) LEFT JOIN scopes s ON s.scope_id = ${scopeId}`,
  );

/**
 * AdminRpc.createApp: refuses `no_security_contact`; reads the scope on chain uncached and refuses `scope_conflict` unless
 * every `Owner::Oidc` is an owner of the org; writes the scope row (or refuses another org or environment for an
 * existing one), the app with its first key (`apps.publishable_key` = that key, the legacy column), and the origins as
 * staff proposals. The `no_session` waiver candidate is recorded only on the origins of a scope row this call creates
 * (granted or not when the notice is acked, lifecycle.ts). On an existing scope, initial origins wait for
 * `appChangeDelayMs` after its last assignment like every staff proposal (D206).
 */
export async function createApp(
  db: HotDb,
  env: Env,
  w: Writer,
  i: { orgId: string; scopeId: string; environment: Environment; name: string; origins: readonly string[]; orgOwnerSubs: readonly string[] },
) {
  expectReplay(w, ['app.created']);
  const config = requireChangeConfig(env);
  const name = appName(i.name);
  const origins = normaliseAll(i.origins);
  checkOriginRules(env, i.environment, origins);
  const s = await readScope(db, w, i.scopeId, i.orgId);
  refuseReplay(s?.replay, w);
  if (!s || s.contacts === 0) refuse('no_security_contact', 'The org has no security contact: set them first');
  const createScope = s!.scope_id === null;
  if (!createScope) {
    if (s!.org_id !== i.orgId) refuse('scope_conflict', 'The scope belongs to another org');
    if (s!.environment !== i.environment) refuse('env_mismatch', `The scope is a ${s!.environment} scope`);
    if (origins.length && s!.assigned_at! > w.now - config.delayMs) refuse('conflict', 'The scope was assigned to this org less than appChangeDelayMs ago: staff proposals wait for it');
  }
  await requireOwnersInOrg(env, i.scopeId, i.orgOwnerSubs);

  const appId = newId('app');
  const keyId = newId('key');
  const publishableKey = newPublishableKey(i.environment);
  const waiver = createScope ? 'no_session' : null;
  const changes = origins.map((origin) => ({ changeId: newId('guardedChange'), origin }));
  const scopeHolds: Q = createScope
    ? q`NOT EXISTS (SELECT 1 FROM scopes WHERE scope_id = ${i.scopeId})`
    : q`EXISTS (SELECT 1 FROM scopes WHERE scope_id = ${i.scopeId} AND org_id = ${i.orgId} AND environment = ${i.environment} AND assigned_at = ${s!.assigned_at})`;
  const when = committed(w.requestId);
  const list = JSON.stringify(changes);
  const stmts: Q[] = [
    commitOn(
      w,
      { kind: 'app.created', detail: { name, plan: DEFAULT_PLAN, environment: i.environment, keyId, scopeCreated: createScope, waiver, origins: changes } },
      { orgId: i.orgId, appId, scopeId: i.scopeId },
      q`${scopeHolds} AND EXISTS (SELECT 1 FROM org_security_contacts WHERE org_id = ${i.orgId})`,
    ),
  ];
  if (createScope) {
    stmts.push(
      q`INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) SELECT ${i.scopeId}, ${i.orgId}, ${i.environment}, NULL, ${w.now}, ${w.now} WHERE ${when}`,
    );
  }
  stmts.push(
    q`INSERT INTO apps (id, name, scope_id, org_id, publishable_key, status, plan, created_at, origins_version)
      SELECT ${appId}, ${name}, ${i.scopeId}, ${i.orgId}, ${publishableKey}, 'active', ${DEFAULT_PLAN}, ${w.now}, ${changes.length ? 1 : 0} WHERE ${when}`,
    q`INSERT INTO app_keys (id, app_id, key, created_by, created_at) SELECT ${keyId}, ${appId}, ${publishableKey}, ${actorId(w.actor)}, ${w.now} WHERE ${when}`,
  );
  if (changes.length) {
    stmts.push(
      q`INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, waiver, request_id)
        SELECT json_extract(value, '$.changeId'), ${appId}, 'origin_add', json_extract(value, '$.origin'), 'pending', 'hana', ${actorId(w.actor)}, ${w.now}, ${waiver}, ${w.requestId}
          FROM json_each(${list}) WHERE ${when}`,
      q`INSERT INTO app_origins (app_id, origin, active_from, change_id)
        SELECT ${appId}, json_extract(value, '$.origin'), NULL, json_extract(value, '$.changeId') FROM json_each(${list}) WHERE ${when}`,
    );
  }
  await runWrite(db, w, stmts);
  return { app: await getApp(db, appId, i.orgId, w.now, env.FILES_ORIGIN), publishableKey, createdScope: createScope };
}

/**
 * AdminRpc.assignScopeOrg: only while the scope is in `org_legacy` (staff can't move a scope out of a real org); the same
 * owner check as createApp; every app of the scope moves in the same statement (the scopes_org_update trigger), and
 * `assigned_at` restarts the staff-proposal wait.
 */
export async function assignScopeOrg(db: HotDb, env: Env, w: Writer, i: { scopeId: string; orgId: string; orgOwnerSubs: readonly string[] }) {
  expectReplay(w, ['scope.assigned'], null);
  if (i.orgId === LEGACY_ORG_ID) refuse('bad_request', `A scope can't be assigned to ${LEGACY_ORG_ID}`);
  const s = await readScope(db, w, i.scopeId, i.orgId);
  refuseReplay(s?.replay, w);
  if (!s || s.scope_id === null) return refuse('not_found', 'No such scope');
  if (s.org_id !== LEGACY_ORG_ID) refuse('scope_conflict', 'The scope already belongs to an org');
  await requireOwnersInOrg(env, i.scopeId, i.orgOwnerSubs);
  const results = await runWrite(db, w, [
    commitOn(
      w,
      { kind: 'scope.assigned', detail: q`json_object('from', ${LEGACY_ORG_ID}, 'to', ${i.orgId}, 'apps', (SELECT COUNT(*) FROM apps WHERE scope_id = ${i.scopeId}))` },
      { orgId: i.orgId, scopeId: i.scopeId },
      q`EXISTS (SELECT 1 FROM scopes WHERE scope_id = ${i.scopeId} AND org_id = ${LEGACY_ORG_ID})`,
    ),
    q`UPDATE scopes SET org_id = ${i.orgId}, assigned_at = ${w.now} WHERE scope_id = ${i.scopeId} AND org_id = ${LEGACY_ORG_ID} AND ${committed(w.requestId)}`,
    q`SELECT COUNT(*) AS n FROM apps WHERE scope_id = ${i.scopeId}`,
  ]);
  return { apps: (results[2]!.results[0] as { n: number }).n };
}

// ---- security contacts ----

export async function getSecurityContacts(db: HotDb, orgId: string): Promise<string[]> {
  return (await db.all<{ email: string }>(q`SELECT email FROM org_security_contacts WHERE org_id = ${orgId} ORDER BY email`)).map((r) => r.email);
}

/**
 * AdminRpc.setSecurityContacts: replaces the org's contacts (1–10, lowercased) as one CAS write on the set as read;
 * `app_changes org.security_contacts` lists the old and the new set (the admin feed emails both).
 */
export async function setSecurityContacts(db: HotDb, w: Writer, i: { orgId: string; emails: readonly string[] }) {
  expectReplay(w, ['org.security_contacts'], null);
  const emails = [...new Set(i.emails)].sort();
  const r = await db.first<{ replay: string | null; current: string }>(
    q`SELECT ${replayRow(w.requestId)} AS replay, (SELECT json_group_array(email) FROM (SELECT email FROM org_security_contacts WHERE org_id = ${i.orgId} ORDER BY email)) AS current`,
  );
  refuseReplay(r?.replay, w);
  const old = JSON.parse(r?.current ?? '[]') as string[];
  if (JSON.stringify(old) === JSON.stringify(emails)) return { emails };
  const list = JSON.stringify(emails);
  await runWrite(db, w, [
    commitOn(
      w,
      { kind: 'org.security_contacts', detail: { old, new: emails } },
      { orgId: i.orgId },
      q`(SELECT json_group_array(email) FROM (SELECT email FROM org_security_contacts WHERE org_id = ${i.orgId} ORDER BY email)) = ${JSON.stringify(old)}`,
    ),
    q`DELETE FROM org_security_contacts WHERE org_id = ${i.orgId} AND ${committed(w.requestId)}`,
    q`INSERT INTO org_security_contacts (org_id, email, added_by, added_at) SELECT ${i.orgId}, value, ${actorId(w.actor)}, ${w.now} FROM json_each(${list}) WHERE ${committed(w.requestId)}`,
  ]);
  return { emails };
}

// ---- feeds ----

export async function listScopes(db: HotDb, cursor: string | undefined, limit: number) {
  const after = cursor === undefined ? raw('1') : q`scope_id > ${cursor}`;
  const rows = await db.all<{ scope_id: string; org_id: string; environment: Environment; assigned_at: number }>(
    q`SELECT scope_id, org_id, environment, assigned_at FROM scopes WHERE ${after} ORDER BY scope_id LIMIT ${limit + 1}`,
  );
  const page = rows.slice(0, limit).map(scopeView);
  return rows.length > limit ? { scopes: page, next: page[page.length - 1]!.scopeId } : { scopes: page };
}

export async function changesSince(db: HotDb, seq: number, limit: number) {
  const rows = await db.all<AppChangeRow>(q`SELECT ${raw(APP_CHANGE_COLUMNS)} FROM app_changes WHERE seq > ${seq} ORDER BY seq LIMIT ${limit}`);
  return rows.map(appChangeView);
}

export async function securityEvents(db: HotDb, unnotifiedOnly: boolean, limit: number) {
  const rows = await db.all<SecurityEventRow>(
    q`SELECT id, detected_at, kind, org_id, app_id, scope_id, detail_json, notified_at FROM security_events
       WHERE ${unnotifiedOnly ? raw('notified_at IS NULL') : raw('1')} ORDER BY detected_at, id LIMIT ${limit}`,
  );
  return rows.map(securityEventView);
}

/** Marks events emailed (once: an event already marked keeps its first time). Not an app change: no ledger row. */
export async function markSecurityEventNotified(db: HotDb, ids: readonly string[], now: number): Promise<void> {
  await db.batch([q`UPDATE security_events SET notified_at = ${now} WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)})) AND notified_at IS NULL`]);
}

/**
 * The public keys of every relayer pool (never a secret), for the admin Worker's nonce check, settlement and status
 * page. The Home pool's are here too (readiness 7.4a), so a Home key spending outside the API is seen.
 */
export function relayerKeys(env: Env): { pool: Pool; publicKey: string }[] {
  const pub = (secret: string) => KeyPair.fromString(secret as `ed25519:${string}`).getPublicKey().toString();
  return [
    ...parseRelayerKeys(env.RELAYER_KEYS, 'RELAYER_KEYS').map((k) => ({ pool: 'session' as const, publicKey: pub(k) })),
    ...parseRelayerKeys(env.OWNER_RELAYER_KEYS, 'OWNER_RELAYER_KEYS').map((k) => ({ pool: 'owner' as const, publicKey: pub(k) })),
    ...parseRelayerKeys(env.HOME_RELAYER_KEYS, 'HOME_RELAYER_KEYS').map((k) => ({ pool: 'home' as const, publicKey: pub(k) })),
  ];
}
