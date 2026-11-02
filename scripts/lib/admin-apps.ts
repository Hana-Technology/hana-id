// admin.ts app:* commands on the hot DB after migration 0006 (docs/batch-c-spec.md §CLI): app:create, app:origins:add
// and app:origins:remove, app:suspend and app:resume, app:list, and app:changes:announce. The SQL is admin-sql.ts's;
// this file reads, checks and prints. Every write is a staff action (`hana`, the operator's login as the actor) with
// its `app_changes` rows; origin adds are staff proposals that go live only after an announcement plus
// `appChangeDelayMs` (or at once under the `no_session` waiver for the initial origins of an app whose scope row the
// same app:create created).
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { type Environment, MAX_APP_ORIGINS, newId, newPublishableKey } from '@hana-id/console-core';
import { hanaOwnOrigins, isDevEnv, type Manifest } from '@hana-id/env';
import {
  type AppRow,
  type ChangeRow,
  type CliActor,
  type HotWrite,
  type OriginContext,
  type OriginRow,
  type ScopeRow,
  addOriginsWrite,
  announceWrite,
  announcedAt,
  assertAppName,
  assertAppOrigins,
  assertEnvironment,
  assertOrgId,
  assertPlanId,
  assertScopeId,
  changeSql,
  createAppWrite,
  findAppSql,
  listAppsSql,
  normaliseOrigin,
  originsSql,
  planExistsSql,
  printable,
  removeOriginsWrite,
  scopeSql,
  suspensionWrite,
  writeCommand,
} from './admin-sql.ts';
import { announceHint } from './admin-settings.ts';
import { type Args, CliError } from './cli.ts';
import { newAppId } from './pk.ts';

/** Fresh ids for one command (tests pass fixed ones). */
export interface CliIds {
  request: () => string;
  change: () => string;
  app: () => string;
  key: () => string;
  publishableKey: (environment: Environment) => string;
}

export const cliIds: CliIds = {
  request: () => `cli_${randomUUID()}`,
  change: () => newId('guardedChange'),
  app: () => newAppId(),
  key: () => newId('key'),
  publishableKey: (environment) => newPublishableKey(environment),
};

/** The CLI's actor: Hana staff, by the operator's login name. */
export function cliActor(): CliActor {
  let login = 'unknown';
  try {
    login = userInfo().username || login;
  } catch {
    // no passwd entry: keep 'unknown'
  }
  return { id: `cli:${login.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 64)}` };
}

export interface AppCmdDeps {
  /** Runs SQL on the env's D1 (local or remote) and returns the rows of every statement, concatenated. */
  d1: (statement: string) => Record<string, unknown>[];
  /** Whether the scope is registered on the env's signer. */
  scopeOnChain: (scopeId: string) => Promise<boolean>;
  now: () => number;
  log: (line: string) => void;
  actor: CliActor;
  ids: CliIds;
}

type M = Pick<Manifest, 'name' | 'network' | 'signer' | 'apiUrl' | 'vaultOrigin' | 'authOrigin' | 'appChangeDelayMs' | 'admin' | 'console' | 'files'>;

export const originContext = (m: M): OriginContext => ({ envName: m.name, network: m.network, refusedOrigins: hanaOwnOrigins(m) });

const at = (ms: number): string => new Date(ms).toISOString();

/** Runs a write and reports whether it applied (its commit row is there). */
function commit(deps: Pick<AppCmdDeps, 'd1'>, write: HotWrite): boolean {
  const rows = deps.d1(writeCommand(write));
  return Number(rows[rows.length - 1]?.committed ?? 0) === 1;
}

export const STALE_WRITE = 'The app changed since it was read (another admin command or a D1 edit): nothing was written. Run the command again.';

/** --origin values, normalised and de-duplicated; at least one. */
export function originArgs(args: Args): string[] {
  const list = args.list('origin').map(normaliseOrigin);
  if (!list.length) throw new CliError('At least one --origin is required');
  return [...new Set(list)];
}

export function findApp(deps: Pick<AppCmdDeps, 'd1'>, idOrKey: string): AppRow {
  const rows = deps.d1(findAppSql(idOrKey)) as unknown as AppRow[];
  if (rows.length !== 1 || !rows[0]) throw new Error(`No app ${idOrKey}`);
  return rows[0];
}

function liveApp(deps: Pick<AppCmdDeps, 'd1'>, idOrKey: string): AppRow {
  const app = findApp(deps, idOrKey);
  if (app.deleted_at !== null) throw new Error(`App ${app.id} is deleted`);
  return app;
}

/** Staff proposals wait `appChangeDelayMs` after a scope's last org assignment (spec "Staff proposals"). */
function assertAssignedLongEnough(m: M, scope: Pick<ScopeRow, 'scope_id' | 'assigned_at'>, now: number): void {
  const from = scope.assigned_at + m.appChangeDelayMs;
  if (now < from) throw new Error(`Scope ${scope.scope_id} was assigned to its org less than appChangeDelayMs ago: staff proposals on it are refused until ${at(from)}`);
}

/** app:create --org <org> --name <name> --scope <id> [--environment test|live] --origin <o>… [--plan free] */
export async function appCreate(m: M, args: Args, where: string, deps: AppCmdDeps): Promise<void> {
  const orgId = assertOrgId(args.required('org'));
  const name = assertAppName(args.required('name'));
  const scopeId = assertScopeId(args.required('scope'));
  const plan = assertPlanId(args.str('plan') ?? 'free');
  const given = args.str('environment');
  const wanted = given === undefined ? undefined : assertEnvironment(given);
  const origins = originArgs(args);
  const now = deps.now();
  if (!(await deps.scopeOnChain(scopeId))) throw new Error(`Scope ${scopeId} is not registered on ${m.signer} (admin.ts ${m.name} scope:register …)`);
  if (!deps.d1(planExistsSql(plan)).length) throw new Error(`No plan "${plan}" in ${where}`);
  const scope = (deps.d1(scopeSql(scopeId)) as unknown as ScopeRow[])[0];
  let environment: Environment;
  if (scope) {
    if (scope.org_id !== orgId) throw new Error(`Scope ${scopeId} belongs to ${scope.org_id}, not ${orgId}`);
    if (wanted !== undefined && wanted !== scope.environment) throw new Error(`Scope ${scopeId} is a ${scope.environment} scope (test and live apps never share a scope)`);
    environment = scope.environment;
    assertAssignedLongEnough(m, scope, now);
  } else {
    if (wanted === undefined) throw new CliError(`Scope ${scopeId} has no apps yet: pass --environment test|live (fixed for the scope from then on)`);
    environment = wanted;
  }
  if (origins.length > MAX_APP_ORIGINS) throw new Error(`At most ${MAX_APP_ORIGINS} origins per app`);
  assertAppOrigins(originContext(m), environment, origins);
  const requestId = deps.ids.request();
  const app = {
    id: deps.ids.app(),
    name,
    orgId,
    scopeId,
    environment,
    keyId: deps.ids.key(),
    publishableKey: deps.ids.publishableKey(environment),
    plan,
    origins: origins.map((origin) => ({ changeId: deps.ids.change(), origin })),
  };
  if (!commit(deps, createAppWrite(app, { createScope: !scope, now, actor: deps.actor, requestId }))) throw new Error(STALE_WRITE);
  deps.log(`${at(now)} Created app ${app.id} "${printable(name)}" (org ${orgId}, ${environment} scope ${scopeId}${scope ? '' : ', new'}, plan ${plan}) in ${where}`);
  deps.log(`Publishable key: ${app.publishableKey}`);
  deps.log(`Origins (staff proposals, not in force until announced${scope ? ' and appChangeDelayMs has passed' : '; the no_session waiver applies while the scope has no login'}):`);
  for (const o of app.origins) deps.log(`  ${o.changeId}  ${o.origin}`);
  for (const o of app.origins) deps.log(`  ${announceHint(m, o.changeId)}`);
}

/** app:origins:add --app <app> --origin <o>…: staff proposals. */
export function appOriginsAdd(m: M, args: Args, where: string, deps: AppCmdDeps): void {
  const app = liveApp(deps, args.required('app'));
  const wanted = originArgs(args);
  const now = deps.now();
  assertAssignedLongEnough(m, { scope_id: app.scope_id, assigned_at: app.assigned_at }, now);
  const rows = deps.d1(originsSql(app.id)) as unknown as OriginRow[];
  const listed = new Map(rows.map((r) => [r.origin, r]));
  const fresh = wanted.filter((o) => {
    const row = listed.get(o);
    if (!row) return true;
    deps.log(`${o}: already ${row.active_from === null ? 'proposed, not announced' : row.active_from <= now ? 'in force' : `pending until ${at(row.active_from)}`} (${row.change_id ?? 'from before 0006'})`);
    return false;
  });
  if (!fresh.length) return void deps.log(`${app.id}: no change (${where})`);
  if (rows.length + fresh.length > MAX_APP_ORIGINS) throw new Error(`At most ${MAX_APP_ORIGINS} active or pending origins per app (${app.id} has ${rows.length})`);
  assertAppOrigins(originContext(m), app.environment, fresh);
  const proposals = fresh.map((origin) => ({ changeId: deps.ids.change(), origin }));
  if (!commit(deps, addOriginsWrite(app, proposals, { now, actor: deps.actor, requestId: deps.ids.request() }))) throw new Error(STALE_WRITE);
  deps.log(`${at(now)} Proposed for ${app.id} "${printable(app.name)}" (${where}); not in force until announced and appChangeDelayMs has passed:`);
  for (const p of proposals) deps.log(`  ${p.changeId}  ${p.origin}`);
  for (const p of proposals) deps.log(`  ${announceHint(m, p.changeId)}`);
}

/** app:origins:remove --app <app> --origin <o>…: immediate (pending proposals for them are cancelled). */
export function appOriginsRemove(args: Args, where: string, deps: AppCmdDeps): void {
  const app = findApp(deps, args.required('app'));
  // Removing must always work, even for an entry the rules would now refuse: a value that doesn't normalise is
  // matched as given.
  const wanted = [
    ...new Set(
      args.list('origin').map((o) => {
        try {
          return normaliseOrigin(o);
        } catch {
          return o;
        }
      }),
    ),
  ];
  if (!wanted.length) throw new CliError('At least one --origin is required');
  const now = deps.now();
  const rows = deps.d1(originsSql(app.id)) as unknown as OriginRow[];
  const present = rows.filter((r) => wanted.includes(r.origin));
  for (const o of wanted) if (!present.some((r) => r.origin === o)) deps.log(`${o}: not listed for ${app.id}`);
  if (!present.length) return void deps.log(`${app.id}: no change (${where})`);
  if (!commit(deps, removeOriginsWrite(app, present, { now, actor: deps.actor, requestId: deps.ids.request() }))) throw new Error(STALE_WRITE);
  deps.log(`${at(now)} Removed ${present.map((r) => r.origin).join(' ')} from ${app.id} "${printable(app.name)}" (immediate; ${where})`);
}

const BIT_NAMES: [number, string][] = [
  [1, 'hana'],
  [2, 'org'],
  [4, 'partner'],
];
export const suspensionBits = (bits: number): string => BIT_NAMES.filter(([b]) => bits & b).map(([, n]) => n).join('+') || 'none';

/** app:suspend / app:resume --app <app>: Hana's bit (1), immediate. Resume never clears the org or partner bits. */
export function appSuspension(suspend: boolean, args: Args, where: string, deps: AppCmdDeps): void {
  const app = findApp(deps, args.required('app'));
  const now = deps.now();
  const has = (app.suspended_by & 1) === 1;
  if (suspend === has && (suspend || app.status === 'active')) {
    return void deps.log(`${app.id} "${printable(app.name)}": already ${suspend ? 'suspended by Hana' : 'not suspended by Hana'} (suspended_by ${suspensionBits(app.suspended_by)}; ${where})`);
  }
  const write = suspensionWrite(app, suspend, { now, actor: deps.actor, requestId: deps.ids.request() });
  if (!commit(deps, write)) throw new Error(STALE_WRITE);
  const next = suspend ? app.suspended_by | 1 : app.suspended_by & ~1;
  deps.log(`${at(now)} ${app.id} "${printable(app.name)}" is now ${next === 0 ? 'active' : `suspended (suspended_by ${suspensionBits(next)})`} (${where})`);
  if (!suspend && next !== 0) deps.log('  Still suspended by another bit: only the org or partner side (or AdminRpc) clears it.');
}

interface ListRow {
  id: string;
  name: string;
  scope_id: string;
  org_id: string;
  status: string;
  suspended_by: number;
  plan: string;
  deleted_at: number | null;
  environment: string;
  origins: string | null;
  keys: string | null;
  pending: string | null;
}

/** app:list: every app with its scope, org, suspension, keys, origins in force and pending changes. */
export function appList(where: string, deps: AppCmdDeps): void {
  const now = deps.now();
  const rows = deps.d1(listAppsSql(now)) as unknown as ListRow[];
  if (!rows.length) return void deps.log(`No apps in ${where}.`);
  for (const r of rows) {
    const state = r.deleted_at !== null ? 'deleted' : r.suspended_by !== 0 || r.status !== 'active' ? `suspended(${suspensionBits(r.suspended_by)})` : 'active';
    deps.log(`${r.id}  ${state.padEnd(9)} org=${r.org_id} ${r.environment} scope=${r.scope_id} plan=${r.plan}  "${printable(r.name)}"`);
    deps.log(`    keys: ${printable(r.keys ?? '(none)')}`);
    deps.log(`    origins: ${printable(r.origins ?? '(none)')}`);
    const pending = JSON.parse(r.pending ?? '[]') as { id: string; kind: string; origin: string | null; policyId: string | null; activeFrom: number | null; waiver: string | null }[];
    for (const p of pending) {
      const what = p.kind === 'origin_add' ? printable(p.origin ?? '') : p.kind === 'policy_set' ? `policy ${p.policyId}` : 'raw signing approval';
      deps.log(`    pending ${p.id} ${p.kind} ${what}: ${p.activeFrom === null ? 'not announced' : `in force from ${at(p.activeFrom)}`}${p.waiver ? ` (waiver ${p.waiver})` : ''}`);
    }
  }
}

/**
 * app:changes:announce <change id>: in an env with no admin Worker, does what its acknowledged notice does (nobody is
 * emailed). Refused where an admin Worker exists (it announces) and on a production network.
 */
export function appChangesAnnounce(m: M, changeId: string, where: string, deps: AppCmdDeps): void {
  if (m.admin) throw new Error(`${m.name} has an admin Worker: it announces changes once their notice is accepted (app:changes:announce is only for envs without one)`);
  if ((m.network as string) === 'mainnet') throw new Error('app:changes:announce is refused on a production network');
  const change = (deps.d1(changeSql(changeId)) as unknown as ChangeRow[])[0];
  if (!change) throw new Error(`No guarded change ${changeId}`);
  if (change.status !== 'pending') throw new Error(`${changeId} is ${change.status}, not pending`);
  if (change.notified_at !== null) throw new Error(`${changeId} was already announced at ${at(change.notified_at)} (in force from ${at(change.active_from ?? change.notified_at)})`);
  const app = findApp(deps, change.app_id);
  const now = deps.now();
  const scope = { first_session_at: app.first_session_at, environment: app.environment };
  const when = announcedAt(change, scope, { now, delayMs: m.appChangeDelayMs, network: m.network, devEnv: isDevEnv(m.name) });
  if (!commit(deps, announceWrite(change, app, when, { now, actor: deps.actor, requestId: deps.ids.request() }))) throw new Error(`${changeId} changed since it was read: nothing was written`);
  const what = change.kind === 'origin_add' ? `origin ${printable(change.origin ?? '')}` : change.kind === 'policy_set' ? `policy ${change.policy_id}` : 'raw signing approval';
  deps.log(`${at(now)} Announced ${changeId} (${what}) for ${app.id} "${printable(app.name)}" by the CLI (${where}).`);
  deps.log('  Nobody was emailed: this env has no admin Worker (app_changes records channel cli, emailed none).');
  deps.log(`  In force from ${at(when.activeFrom)}${when.waiver ? ` (waiver ${when.waiver})` : ` (appChangeDelayMs ${m.appChangeDelayMs} ms)`}.`);
}
