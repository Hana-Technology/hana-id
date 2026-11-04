// SQL for the admin CLI's app:* commands, against the hot DB after migration 0006 (docs/batch-c-spec.md §Hot DB and
// §CLI): scopes (one org and environment each), apps (suspended_by, origins_version, settings_version), app_keys,
// app_origins (active_from NULL until announced), guarded_changes and the append-only app_changes ledger. Every value
// goes through the escaping `sql` tag. The CLI is a Hana staff tool: its writes are staff proposals (`hana` kind,
// full delay, announced by the admin Worker or, in envs without one, by `app:changes:announce`), exactly what
// AdminRpc writes; removals and suspensions are immediate.
//
// Each write is a list of statements run as one `wrangler d1 execute` call. The first is the compare-and-swap guard
// (the version the CLI read, bumped); the write's `app_changes` row, with its own request id, follows only if the guard
// changed a row, and every other statement only if that row exists; the CLI reads it back (`committedSql`). A write
// planned from a stale read changes nothing and says so ("writes" below).
import {
  type Environment,
  LEGACY_ORG_ID,
  MAX_APP_ORIGINS,
  normaliseOrigin as normaliseOriginCore,
  OriginError,
  originProblem,
} from '@hana-id/console-core';
import { sql } from './sql.ts';

export { LOCALHOST_WILDCARD, MAX_APP_ORIGINS } from '@hana-id/console-core';

/** A write: its statements in order, and the request id of the `app_changes` row that marks it applied. */
export interface HotWrite {
  statements: string[];
  requestId: string;
}

/** The orgs `--org` accepts: only `org_legacy` until batch C7 creates CONSOLE_DB (then any org it holds). */
export const CLI_ORGS: readonly string[] = [LEGACY_ORG_ID];

/** Joins a write's statements for `wrangler d1 execute --command`, with the read-back of its commit row last. */
export function writeCommand(write: HotWrite): string {
  return `${[...write.statements, committedSql(write.requestId)].join(';\n')};`;
}

/** How many `app_changes` rows carry this request id (1 once the write applied, else 0). */
export function committedSql(requestId: string): string {
  return sql`SELECT COUNT(*) AS committed FROM app_changes WHERE request_id = ${requestId}`;
}

/** The origin as stored (console-core's normaliseOrigin, the one form the API, console and CLI share). */
export function normaliseOrigin(input: string): string {
  try {
    return normaliseOriginCore(input);
  } catch (e) {
    throw new Error(e instanceof OriginError ? `Origin ${input}: ${e.message}` : `Invalid origin: ${input}`);
  }
}

/** Scope ids: "global" or contract-assigned "s" + base36. */
export function assertScopeId(s: string): string {
  if (!/^(global|s[0-9a-z]{1,13})$/u.test(s)) throw new Error(`Invalid scope id: ${s}`);
  return s;
}

export function assertOrgId(s: string): string {
  if (!CLI_ORGS.includes(s)) throw new Error(`--org must be ${CLI_ORGS.join(' or ')} until the console database exists (batch C7), got ${JSON.stringify(s)}`);
  return s;
}

export function assertEnvironment(s: string): Environment {
  if (s !== 'test' && s !== 'live') throw new Error("--environment must be 'test' or 'live'");
  return s;
}

/**
 * What can't be in an app name (OPER-11, AUTH-2): controls, format characters (bidi overrides and isolates, zero-width
 * characters), line and paragraph separators, private-use and unassigned code points. The name is shown beside the
 * verified origin in the consent and approval popups, and printed to the operator's terminal.
 */
const UNSAFE_NAME_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;

/** A trimmed, NFC-normalised app name of 1..100 characters with nothing UNSAFE_NAME_RE refuses. */
export function assertAppName(s: string): string {
  const name = s.normalize('NFC').trim();
  if (name.length < 1 || name.length > 100) throw new Error('App name must be 1..100 characters');
  if (UNSAFE_NAME_RE.test(name)) throw new Error('App name must not contain control, format (bidi, zero-width), separator or unassigned characters');
  return name;
}

/** A D1 value as the CLI prints it: anything UNSAFE_NAME_RE matches (ANSI escapes, bidi overrides) shown as \u{…}. */
export function printable(s: string): string {
  return s.replace(new RegExp(UNSAFE_NAME_RE.source, 'gu'), (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

export function assertPlanId(s: string): string {
  if (!/^[a-z0-9_-]{1,32}$/u.test(s)) throw new Error(`Invalid plan id: ${s}`);
  return s;
}

/** What the origin rules need (console-core `originProblem`): the env, its network and every Hana origin. */
export interface OriginContext {
  envName: string;
  network: string;
  refusedOrigins: readonly string[];
}

/**
 * Refuses origins the API would refuse or misuse for an app on a scope of `environment` (console-core `originProblem`,
 * the rules the console and AdminRpc apply). Checked on create and add, never on remove (removing must always work).
 */
export function assertAppOrigins(ctx: OriginContext, environment: Environment, origins: readonly string[]): void {
  for (const origin of origins) {
    const problem = originProblem(origin, { envName: ctx.envName, network: ctx.network, environment, refusedOrigins: ctx.refusedOrigins });
    if (problem) throw new Error(`Origin ${origin} refused (${problem.reason}): ${problem.message}`);
  }
}

// ---- reads ----

export interface ScopeRow {
  scope_id: string;
  org_id: string;
  environment: Environment;
  first_session_at: number | null;
  created_at: number;
  assigned_at: number;
}

export function scopeSql(scopeId: string): string {
  return sql`SELECT scope_id, org_id, environment, first_session_at, created_at, assigned_at FROM scopes WHERE scope_id = ${scopeId}`;
}

export function planExistsSql(plan: string): string {
  return sql`SELECT id FROM plans WHERE id = ${plan}`;
}

export interface AppRow {
  id: string;
  name: string;
  scope_id: string;
  org_id: string;
  status: string;
  suspended_by: number;
  plan: string;
  origins_version: number;
  settings_version: number;
  deleted_at: number | null;
  environment: Environment;
  first_session_at: number | null;
  assigned_at: number;
}

const APP_COLUMNS =
  'a.id, a.name, a.scope_id, a.org_id, a.status, a.suspended_by, a.plan, a.origins_version, a.settings_version, a.deleted_at, s.environment, s.first_session_at, s.assigned_at';

/** An app by id or by any of its publishable keys (app_keys; `apps.publishable_key` is never read). */
export function findAppSql(idOrKey: string): string {
  return `SELECT ${APP_COLUMNS} FROM apps a JOIN scopes s ON s.scope_id = a.scope_id WHERE ${sql`a.id = ${idOrKey} OR a.id IN (SELECT app_id FROM app_keys WHERE key = ${idOrKey})`}`;
}

export interface OriginRow {
  origin: string;
  active_from: number | null;
  change_id: string | null;
}

export function originsSql(appId: string): string {
  return sql`SELECT origin, active_from, change_id FROM app_origins WHERE app_id = ${appId} ORDER BY origin`;
}

export interface ChangeRow {
  id: string;
  app_id: string;
  kind: 'origin_add' | 'policy_set' | 'raw_sign_on';
  origin: string | null;
  policy_json: string | null;
  policy_id: string | null;
  status: 'pending' | 'active' | 'cancelled' | 'ended';
  proposed_by_kind: string;
  proposed_by: string;
  proposed_at: number;
  waiver: 'loopback' | 'no_session' | null;
  notified_at: number | null;
  active_from: number | null;
}

const CHANGE_COLUMNS = 'id, app_id, kind, origin, policy_json, policy_id, status, proposed_by_kind, proposed_by, proposed_at, waiver, notified_at, active_from';

export function changeSql(changeId: string): string {
  return `SELECT ${CHANGE_COLUMNS} FROM guarded_changes WHERE ${sql`id = ${changeId}`}`;
}

/** Pending and active guarded changes of an app (what a removal or a new proposal must take into account). */
export function openChangesSql(appId: string): string {
  return `SELECT ${CHANGE_COLUMNS} FROM guarded_changes WHERE ${sql`app_id = ${appId}`} AND status IN ('pending', 'active') ORDER BY proposed_at, id`;
}

export function listAppsSql(now: number): string {
  return (
    `SELECT a.id, a.name, a.scope_id, a.org_id, a.status, a.suspended_by, a.plan, a.created_at, a.deleted_at, s.environment,
       (SELECT group_concat(origin, ' ') FROM (SELECT origin FROM app_origins WHERE app_id = a.id AND active_from IS NOT NULL AND ${sql`active_from <= ${now}`} ORDER BY origin)) AS origins,
       (SELECT group_concat(k, ' ') FROM (SELECT key || CASE WHEN revoked_at IS NULL THEN '' WHEN ${sql`revoked_at > ${now}`} THEN ' (revoked from ' || revoked_at || ')' ELSE ' (revoked)' END AS k
                                            FROM app_keys WHERE app_id = a.id ORDER BY created_at, id)) AS keys,
       (SELECT json_group_array(json_object('id', id, 'kind', kind, 'origin', origin, 'policyId', policy_id, 'proposedAt', proposed_at, 'notifiedAt', notified_at, 'activeFrom', active_from, 'waiver', waiver))
          FROM guarded_changes WHERE app_id = a.id AND status = 'pending') AS pending
     FROM apps a JOIN scopes s ON s.scope_id = a.scope_id ORDER BY a.created_at, a.id`
  );
}

// ---- writes ----
//
// The commit protocol of every write that has a guard (D207): first the write's commit row in `app_changes`, with its
// own request id, inserted only if the compare-and-swap predicate holds (the version the CLI read, or for settings also
// every settings column as read); then the guarded UPDATE, with the same predicate and only if that commit row exists;
// then every other statement only if the commit row exists. No statement depends on another's row count (`changes()`).
// The CAS is safe because D1 runs each query (one `--command`, all its statements) as one implicit transaction: no
// other write runs between the predicate and the bump, and a statement failing aborts the whole write. The M1
// rehearsal (docs/operations.md) checks that on remote D1. A write planned from a stale read commits nothing, even if
// another writer moved the version to the same number, and the CLI reads the commit row back (`committedSql`) to tell.

/** Who wrote: the CLI acts as Hana staff (`hana`), identified by the operator's login name. */
export interface CliActor {
  id: string;
}

/** This write's commit row exists. */
export const committed = (requestId: string): string => `EXISTS (SELECT 1 FROM app_changes WHERE ${sql`request_id = ${requestId}`})`;

/** An `app_changes` row (`detail` is allowlisted fields only), written only when `when` holds. */
function ledger(
  r: { at: number; orgId: string; appId: string | null; scopeId: string | null; kind: string; detail: Record<string, unknown>; actor: CliActor; requestId: string },
  when?: string,
): string {
  const values = sql`${r.at}, ${r.orgId}, ${r.appId}, ${r.scopeId}, ${r.kind}, ${JSON.stringify(r.detail)}, ${'hana'}, ${r.actor.id}, ${r.requestId}`;
  return `INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id) SELECT ${values}${when ? ` WHERE ${when}` : ''}`;
}

type LedgerRow = { at: number; orgId: string; appId: string; scopeId: string; kind: string; detail: Record<string, unknown>; actor: CliActor; requestId: string };

/** A guarded write on one `apps` row: commit row if `where` holds, then `UPDATE apps SET <set> WHERE <where>`, then `rest`. */
function guardedAppWrite(appId: string, where: string, set: readonly string[], row: LedgerRow, rest: readonly string[]): HotWrite {
  const holds = `EXISTS (SELECT 1 FROM apps WHERE ${sql`id = ${appId}`} AND ${where})`;
  return {
    statements: [ledger(row, holds), `UPDATE apps SET ${set.join(', ')} WHERE ${sql`id = ${appId}`} AND ${where} AND ${committed(row.requestId)}`, ...rest],
    requestId: row.requestId,
  };
}

/** In force by the API's predicate: recorded active, or pending with its clock passed (the cron records it later). */
const IN_FORCE = (now: number) => `(status = 'active' OR (status = 'pending' AND active_from IS NOT NULL AND active_from <= ${now}))`;

/**
 * Closes an app's guarded changes of `kind`, when `when` holds. `all` (a turn-off: raw signing off, the policy
 * removed, an origin removed): those in force end, the others are cancelled. `not_in_force` (the policy in force set
 * again over a pending one): only the changes not yet in force are cancelled.
 */
function closeChanges(where: string, mode: 'all' | 'not_in_force', opts: { now: number; actor: CliActor }, when: string): string {
  const { now, actor } = opts;
  if (mode === 'not_in_force') {
    return `UPDATE guarded_changes SET status = 'cancelled', cancelled_at = ${now}, ${sql`cancelled_by = ${actor.id}`}
      WHERE ${where} AND status = 'pending' AND (active_from IS NULL OR active_from > ${now}) AND ${when}`;
  }
  return `UPDATE guarded_changes SET status = CASE WHEN ${IN_FORCE(now)} THEN 'ended' ELSE 'cancelled' END,
            ended_at = CASE WHEN ${IN_FORCE(now)} THEN ${now} END,
            cancelled_at = CASE WHEN ${IN_FORCE(now)} THEN NULL ELSE ${now} END,
            cancelled_by = CASE WHEN ${IN_FORCE(now)} THEN NULL ELSE ${sql`${actor.id}`} END
      WHERE ${where} AND status IN ('pending', 'active') AND ${when}`;
}

export function closeChangesSql(appId: string, kind: 'policy_set' | 'raw_sign_on', mode: 'all' | 'not_in_force', opts: { now: number; actor: CliActor }, when: string): string {
  return closeChanges(sql`app_id = ${appId} AND kind = ${kind}`, mode, opts, when);
}

export interface NewApp {
  id: string;
  name: string;
  orgId: string;
  scopeId: string;
  environment: Environment;
  keyId: string;
  publishableKey: string;
  plan: string;
  origins: { changeId: string; origin: string }[];
}

/**
 * app:create (as AdminRpc.createApp): the scope row when `createScope` (a plain INSERT, first, so a scope created
 * meanwhile stops the write before anything else runs), the app with its first key (`apps.publishable_key` = that key,
 * kept for the legacy column), the origins as staff proposals (`active_from` NULL; the `no_session` waiver candidate
 * only on a scope this call creates, granted or not at the announcement), and the ledger. The 0006 triggers refuse
 * another org or environment for an existing scope. Nothing to guard: every row is new.
 */
export function createAppWrite(app: NewApp, opts: { createScope: boolean; now: number; actor: CliActor; requestId: string }): HotWrite {
  const { now, actor, requestId } = opts;
  const s: string[] = [];
  if (opts.createScope) {
    s.push(sql`INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES (${app.scopeId}, ${app.orgId}, ${app.environment}, ${null}, ${now}, ${now})`);
  }
  s.push(
    sql`INSERT INTO apps (id, name, scope_id, org_id, publishable_key, status, plan, created_at, origins_version) VALUES (${app.id}, ${app.name}, ${app.scopeId}, ${app.orgId}, ${app.publishableKey}, ${'active'}, ${app.plan}, ${now}, ${app.origins.length ? 1 : 0})`,
    sql`INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES (${app.keyId}, ${app.id}, ${app.publishableKey}, ${actor.id}, ${now})`,
  );
  const waiver = opts.createScope ? 'no_session' : null;
  for (const { changeId, origin } of app.origins) {
    s.push(
      sql`INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, waiver, request_id) VALUES (${changeId}, ${app.id}, ${'origin_add'}, ${origin}, ${'pending'}, ${'hana'}, ${actor.id}, ${now}, ${waiver}, ${requestId})`,
      sql`INSERT INTO app_origins (app_id, origin, active_from, change_id) VALUES (${app.id}, ${origin}, ${null}, ${changeId})`,
    );
  }
  s.push(
    ledger({
      at: now,
      orgId: app.orgId,
      appId: app.id,
      scopeId: app.scopeId,
      kind: 'app.created',
      detail: { name: app.name, plan: app.plan, environment: app.environment, keyId: app.keyId, scopeCreated: opts.createScope, waiver, origins: app.origins },
      actor,
      requestId,
    }),
  );
  return { statements: s, requestId };
}

type AppRef = Pick<AppRow, 'id' | 'org_id' | 'scope_id'>;

/** app:origins:add: each origin a staff proposal (guarded change, `app_origins` row with `active_from` NULL), one version bump. */
export function addOriginsWrite(app: AppRef & Pick<AppRow, 'origins_version'>, origins: { changeId: string; origin: string }[], opts: { now: number; actor: CliActor; requestId: string }): HotWrite {
  const { now, actor, requestId } = opts;
  const when = committed(requestId);
  const rest = origins.flatMap(({ changeId, origin }) => [
    `INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id) SELECT ${sql`${changeId}, ${app.id}, ${'origin_add'}, ${origin}, ${'pending'}, ${'hana'}, ${actor.id}, ${now}, ${requestId}`} WHERE ${when}`,
    `INSERT INTO app_origins (app_id, origin, active_from, change_id) SELECT ${sql`${app.id}, ${origin}, ${null}, ${changeId}`} WHERE ${when}`,
  ]);
  return guardedAppWrite(
    app.id,
    `${sql`origins_version = ${app.origins_version}`} AND deleted_at IS NULL`,
    [sql`origins_version = ${app.origins_version + 1}`],
    { at: now, orgId: app.org_id, appId: app.id, scopeId: app.scope_id, kind: 'origin.proposed', detail: { changes: origins }, actor, requestId },
    rest,
  );
}

/**
 * app:origins:remove: immediate. The rows go; an origin_add for them that is in force ends, one that is not yet in
 * force is cancelled (its origin never went live); one version bump.
 */
export function removeOriginsWrite(app: AppRef & Pick<AppRow, 'origins_version'>, origins: OriginRow[], opts: { now: number; actor: CliActor; requestId: string }): HotWrite {
  const { now, actor, requestId } = opts;
  const when = committed(requestId);
  const detail = { origins: origins.map((o) => ({ origin: o.origin, wasInForce: o.active_from !== null && o.active_from <= now })) };
  const rest = origins.flatMap(({ origin }) => [
    closeChanges(sql`app_id = ${app.id} AND kind = ${'origin_add'} AND origin = ${origin}`, 'all', { now, actor }, when),
    `DELETE FROM app_origins WHERE ${sql`app_id = ${app.id} AND origin = ${origin}`} AND ${when}`,
  ]);
  return guardedAppWrite(
    app.id,
    sql`origins_version = ${app.origins_version}`,
    [sql`origins_version = ${app.origins_version + 1}`],
    { at: now, orgId: app.org_id, appId: app.id, scopeId: app.scope_id, kind: 'origin.removed', detail, actor, requestId },
    rest,
  );
}

/** Hana's suspension bit (spec §Apps: hana = 1, org = 2, partner = 4). */
export const HANA_SUSPENSION_BIT = 1;

/**
 * app:suspend sets bit 1, app:resume clears it (and only it): `status` follows by trigger, so an app suspended by
 * another bit stays suspended. No version bump (suspensions aren't guarded changes).
 */
export function suspensionWrite(app: AppRef & Pick<AppRow, 'suspended_by'>, suspend: boolean, opts: { now: number; actor: CliActor; requestId: string }): HotWrite {
  const { now, actor, requestId } = opts;
  const next = suspend ? app.suspended_by | HANA_SUSPENSION_BIT : app.suspended_by & ~HANA_SUSPENSION_BIT;
  return guardedAppWrite(
    app.id,
    // A deleted app keeps Hana's bit for good (AdminRpc.deleteApp; D225): never resumed, never rewritten.
    `${sql`suspended_by = ${app.suspended_by}`} AND deleted_at IS NULL`,
    [sql`suspended_by = ${next}`],
    { at: now, orgId: app.org_id, appId: app.id, scopeId: app.scope_id, kind: suspend ? 'suspension.set' : 'suspension.cleared', detail: { bit: HANA_SUSPENSION_BIT, suspendedBy: next }, actor, requestId },
    [],
  );
}

/**
 * Whether change `t` (a `guarded_changes` row reference) gets the `no_session` waiver at its announcement (spec
 * "Waivers"), decided in the announcing statement itself, so nothing can change in between: it was proposed with it
 * (the initial origins of an app:create that created the scope row), and the scope shows no sign that a user has a
 * key in it: `first_session_at` is NULL, no origin of any app of the scope is or was in force other than this
 * app:create's own initial ones (a guarded `origin_add` announced and due, or an `app_origins` row in force), and no
 * app of the scope has a vault share, a session marker (migration 0009, written by the API once a session-pool relay
 * settled; it replaced the legacy `usage` counters in batch C4, D205) or an identity count. Any one of these signs
 * means the full delay. Nothing here reads the usage ledger (Neon): the waiver depends on the hot DB only.
 */
function noSessionWaiver(t: string, now: number): string {
  const scope = `(SELECT scope_id FROM apps WHERE id = ${t}.app_id)`;
  const scopeApps = `(SELECT id FROM apps WHERE scope_id = ${scope})`;
  return `(${t}.waiver = 'no_session'
    AND (SELECT first_session_at FROM scopes WHERE scope_id = ${scope}) IS NULL
    AND NOT EXISTS (SELECT 1 FROM guarded_changes o WHERE o.app_id IN ${scopeApps} AND o.kind = 'origin_add'
                     AND o.active_from IS NOT NULL AND o.active_from <= ${now} AND o.request_id != ${t}.request_id)
    AND NOT EXISTS (SELECT 1 FROM app_origins ao WHERE ao.app_id IN ${scopeApps} AND ao.active_from IS NOT NULL AND ao.active_from <= ${now}
                     AND (ao.change_id IS NULL OR ao.change_id NOT IN (SELECT gr.id FROM guarded_changes gr WHERE gr.request_id = ${t}.request_id)))
    AND NOT EXISTS (SELECT 1 FROM vault_shares WHERE app_id IN ${scopeApps})
    AND NOT EXISTS (SELECT 1 FROM session_markers WHERE app_id IN ${scopeApps})
    AND NOT EXISTS (SELECT 1 FROM identity_usage WHERE app_id IN ${scopeApps}))`;
}

/**
 * app:changes:announce (envs with no admin Worker): what AdminRpc.ackNotice does once the notice is accepted, with no
 * email sent. The commit row first (only for a change still pending and unannounced), then `notified_at` and
 * `active_from` (now under the `no_session` waiver as decided in SQL, else now + `delayMs`), then the origin row's
 * `active_from`, or the app's pending policy or raw signing with `*_effective_at = active_from` (a matured pending
 * value is first kept as the stored one, so the announcement never takes a policy or raw signing in force away). No
 * version bump (announcements never invalidate a step-up in flight). The CLI reads the change back for what it got.
 */
export function announceWrite(change: ChangeRow, app: AppRef, delayMs: number, opts: { now: number; actor: CliActor; requestId: string }): HotWrite {
  const { now, actor, requestId } = opts;
  const when = committed(requestId);
  const waived = (t: string) => noSessionWaiver(t, now);
  const activeFrom = `(SELECT active_from FROM guarded_changes WHERE ${sql`id = ${change.id}`})`;
  const detail = `json_object('changeId', g.id, 'kind', g.kind, 'origin', g.origin, 'policyId', g.policy_id,
      'activeFrom', CASE WHEN ${waived('g')} THEN ${now} ELSE ${now + delayMs} END,
      'waiver', CASE WHEN ${waived('g')} THEN 'no_session' END, 'channel', 'cli', 'emailed', 'none')`;
  const s = [
    `INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id)
     SELECT ${now}, ${sql`${app.org_id}, ${app.id}, ${app.scope_id}, ${'change.announced'}`}, ${detail}, 'hana', ${sql`${actor.id}, ${requestId}`}
       FROM guarded_changes g WHERE ${sql`g.id = ${change.id}`} AND g.status = 'pending' AND g.notified_at IS NULL`,
    `UPDATE guarded_changes SET notified_at = ${now},
            active_from = CASE WHEN ${waived('guarded_changes')} THEN ${now} ELSE ${now + delayMs} END,
            waiver = CASE WHEN ${waived('guarded_changes')} THEN 'no_session' END
      WHERE ${sql`id = ${change.id}`} AND status = 'pending' AND notified_at IS NULL AND ${when}`,
  ];
  if (change.kind === 'origin_add') {
    s.push(`UPDATE app_origins SET active_from = ${activeFrom} WHERE ${sql`app_id = ${app.id} AND change_id = ${change.id}`} AND active_from IS NULL AND ${when}`);
  } else if (change.kind === 'policy_set') {
    s.push(
      `UPDATE apps SET auto_approve_policy = CASE WHEN auto_approve_pending IS NOT NULL AND ${sql`auto_approve_effective_at <= ${now}`} THEN auto_approve_pending ELSE auto_approve_policy END,
              ${sql`auto_approve_pending = ${change.policy_json}`}, auto_approve_effective_at = ${activeFrom}
        WHERE ${sql`id = ${app.id}`} AND ${when}`,
    );
  } else {
    s.push(
      `UPDATE apps SET raw_sign = CASE WHEN raw_sign_pending = 'approval' AND ${sql`raw_sign_effective_at <= ${now}`} THEN 'approval' ELSE raw_sign END,
              raw_sign_pending = 'approval', raw_sign_effective_at = ${activeFrom}
        WHERE ${sql`id = ${app.id}`} AND ${when}`,
    );
  }
  return { statements: s, requestId };
}

/** A staff proposal of a policy or raw-signing enable (nothing in `apps` until it is announced), when `when` holds. */
export function proposalSql(
  p: { changeId: string; appId: string; kind: 'policy_set' | 'raw_sign_on'; policyJson: string | null; policyId: string | null },
  opts: { now: number; actor: CliActor; requestId: string },
  when: string,
): string {
  return `INSERT INTO guarded_changes (id, app_id, kind, policy_json, policy_id, status, proposed_by_kind, proposed_by, proposed_at, request_id) SELECT ${sql`${p.changeId}, ${p.appId}, ${p.kind}, ${p.policyJson}, ${p.policyId}, ${'pending'}, ${'hana'}, ${opts.actor.id}, ${opts.now}, ${opts.requestId}`} WHERE ${when}`;
}

/**
 * A settings write (admin-settings.ts): its commit row (`kind`, `detail`) if `where` (the version and every settings
 * column as read) holds, then `UPDATE apps SET <set> WHERE <where>`, then `rest`, each of which the caller conditions
 * on `committed(requestId)`.
 */
export function settingsWrite(
  app: { id: string; org_id: string; scope_id: string },
  guard: { where: string; set: readonly string[] },
  commitRow: { kind: string; detail: Record<string, unknown> },
  rest: string[],
  opts: { now: number; actor: CliActor; requestId: string },
): HotWrite {
  const { now, actor, requestId } = opts;
  return guardedAppWrite(app.id, guard.where, guard.set, { at: now, orgId: app.org_id, appId: app.id, scopeId: app.scope_id, kind: commitRow.kind, detail: commitRow.detail, actor, requestId }, rest);
}

// ---- rollback parking (docs/operations.md "Rolling the API back below batch C3") ----

/** Origin rows not in force: a pre-C3 API would treat each as in force. */
const NOT_IN_FORCE_ORIGIN = (now: number) => `(active_from IS NULL OR active_from > ${now})`;

/** The rows `app:origins:park` would delete (read). */
export function parkableOriginsSql(now: number): string {
  return `SELECT app_id, origin, active_from, change_id FROM app_origins WHERE ${NOT_IN_FORCE_ORIGIN(now)} ORDER BY app_id, origin`;
}

/**
 * app:origins:park: before an API from before batch C3 runs on the 0006 database, deletes every origin row not yet in
 * force, after one `origin.parked` row per app that lists each deleted row (`rows`: origin and change id).
 * `app:origins:unpark` restores exactly those rows, and only while their change is still open.
 */
export function parkOriginsWrite(opts: { now: number; actor: CliActor; requestId: string }): HotWrite {
  const { now, actor, requestId } = opts;
  return {
    statements: [
      `INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id)
       SELECT ${now}, a.org_id, a.id, a.scope_id, 'origin.parked',
              (SELECT json_object('rows', json_group_array(json_object('origin', origin, 'changeId', change_id)))
                 FROM app_origins WHERE app_id = a.id AND ${NOT_IN_FORCE_ORIGIN(now)}),
              'hana', ${sql`${actor.id}, ${requestId}`} || ':' || a.id
         FROM apps a WHERE EXISTS (SELECT 1 FROM app_origins WHERE app_id = a.id AND ${NOT_IN_FORCE_ORIGIN(now)})`,
      `DELETE FROM app_origins WHERE ${NOT_IN_FORCE_ORIGIN(now)}`,
    ],
    requestId,
  };
}

/**
 * The changes `app:origins:unpark` restores a row for: listed in an `origin.parked` row with no later `origin.unparked`
 * row listing them (so a row restored once isn't restored again from an older park), still `pending` or `active` (a
 * removal or a cancel since closes the change: `app:origins:remove` closes it even without a row), with no origin row
 * now. An origin row deleted any other way is never in a park list, so it is never brought back.
 */
const PARKED = `SELECT DISTINCT g.id, g.app_id, g.origin, g.active_from
    FROM app_changes p, json_each(p.detail_json, '$.rows') r, guarded_changes g
   WHERE p.kind = 'origin.parked' AND g.id = json_extract(r.value, '$.changeId') AND g.app_id = p.app_id
     AND g.kind = 'origin_add' AND g.origin = json_extract(r.value, '$.origin') AND g.status IN ('pending', 'active')
     AND NOT EXISTS (SELECT 1 FROM app_changes u, json_each(u.detail_json, '$.changes') c
                      WHERE u.kind = 'origin.unparked' AND u.app_id = p.app_id AND u.seq > p.seq AND c.value = g.id)
     AND NOT EXISTS (SELECT 1 FROM app_origins o WHERE o.app_id = g.app_id AND o.origin = g.origin)`;

/** The parked origins `app:origins:unpark` would restore (read). */
export function unparkableSql(): string {
  return `${PARKED} ORDER BY g.app_id, g.origin`;
}

/**
 * app:origins:unpark: once the API is back at batch C3 or later, restores the parked rows (above) with their change's
 * `active_from` (NULL while unannounced), after one `origin.unparked` row per app listing the changes.
 */
export function unparkOriginsWrite(opts: { now: number; actor: CliActor; requestId: string }): HotWrite {
  const { now, actor, requestId } = opts;
  return {
    // First the ledger rows (from PARKED), then the origin rows of exactly the changes this request's ledger rows list.
    statements: [
      `INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id)
       SELECT ${now}, a.org_id, a.id, a.scope_id, 'origin.unparked',
              (SELECT json_object('changes', json_group_array(x.id)) FROM (${PARKED}) x WHERE x.app_id = a.id),
              'hana', ${sql`${actor.id}, ${requestId}`} || ':' || a.id
         FROM apps a WHERE EXISTS (SELECT 1 FROM (${PARKED}) x WHERE x.app_id = a.id)`,
      `INSERT INTO app_origins (app_id, origin, active_from, change_id)
       SELECT g.app_id, g.origin, g.active_from, g.id
         FROM app_changes u, json_each(u.detail_json, '$.changes') c, guarded_changes g
        WHERE u.kind = 'origin.unparked' AND u.request_id = ${sql`${requestId}`} || ':' || u.app_id AND g.id = c.value
          AND NOT EXISTS (SELECT 1 FROM app_origins o WHERE o.app_id = g.app_id AND o.origin = g.origin)`,
    ],
    requestId,
  };
}
