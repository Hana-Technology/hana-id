// admin.ts app:* commands on the hot DB after migration 0006 (docs/batch-c-spec.md §CLI): app:create, app:origins:add
// and app:origins:remove, app:suspend and app:resume, app:list, and app:changes:announce. The SQL is admin-sql.ts's;
// this file reads, checks and prints. Every write is a staff action (`hana`, the operator's login as the actor) with
// its `app_changes` rows; origin adds are staff proposals that go live only after an announcement plus
// `appChangeDelayMs` (or at once under the `no_session` waiver for the initial origins of an app whose scope row the
// same app:create created).
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { type Environment, MAX_APP_ORIGINS, newId, newPublishableKey } from '@hana-id/console-core';
import { hanaOwnOrigins, type Manifest } from '@hana-id/env';
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
  openChangesSql,
  originsSql,
  parkableOriginsSql,
  parkOriginsWrite,
  unparkableSql,
  unparkOriginsWrite,
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
  /**
   * Throws unless the API serving this database reads the batch C3 schema (GET /v1/health `hotDb` ≥ 6): an older API
   * would treat a proposed origin as in force. `min` raises the bar (an announcement needs REQUIRED_HOT_DB_ANNOUNCE). A
   * no-op for the local database (`requireC3ApiFor`).
   */
  requireC3Api: (min?: number) => Promise<void>;
}

/**
 * `--d1-name <name>`: run the command on a rehearsal database instead of the env's (docs/operations.md "Hot DB
 * migration 0006", step 3). Only a name containing "rehearsal", so it can't point a command at another env's database.
 */
export function withRehearsalD1<T extends Pick<Manifest, 'cloudflare'>>(m: T, d1Name: string | undefined): T {
  if (d1Name === undefined) return m;
  if (!/^[a-z0-9-]{1,64}$/u.test(d1Name) || !d1Name.includes('rehearsal')) throw new CliError('--d1-name is for rehearsal databases: a D1 name containing "rehearsal"');
  return { ...m, cloudflare: { ...m.cloudflare, d1Name } };
}

/** The hot-DB schema the API must report before the CLI writes a guarded proposal (apps/api/src/apps.ts HOT_DB_SCHEMA). */
export const REQUIRED_HOT_DB = 6;
/**
 * Before an announcement: the batch C4 API (hot DB 0009), the one that writes the session markers the `no_session`
 * waiver reads (D220). An older API writes none, so the waiver would see fewer signs of a user than there are.
 */
export const REQUIRED_HOT_DB_ANNOUNCE = 9;

/** `requireC3Api` for an env: against the deployed API with `--remote`, nothing for the local database. */
export function requireC3ApiFor(m: Pick<Manifest, 'apiUrl' | 'name'>, remote: boolean, fetchFn: typeof fetch = fetch): (min?: number) => Promise<void> {
  return async (min = REQUIRED_HOT_DB) => {
    if (!remote) return;
    const url = new URL('/v1/health', m.apiUrl).toString();
    let hotDb: unknown;
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
      hotDb = res.ok ? ((await res.json()) as { hotDb?: unknown }).hotDb : undefined;
    } catch {
      throw new Error(`Could not read ${url}: guarded proposals need the deployed API to report the batch C3 schema first`);
    }
    if (typeof hotDb !== 'number' || hotDb < min) {
      throw new Error(
        min >= REQUIRED_HOT_DB_ANNOUNCE
          ? `The API of ${m.name} does not report the batch C4 hot DB (GET /v1/health hotDb ${JSON.stringify(hotDb ?? null)}, need ≥ ${min}): deploy it before announcing (the no_session waiver reads the session markers only it writes)`
          : `The API of ${m.name} does not report the batch C3 hot-DB reads (GET /v1/health hotDb ${JSON.stringify(hotDb ?? null)}, need ≥ ${min}): deploy it before proposing origins, policies or raw signing (an older API would treat a proposed origin as in force)`,
      );
    }
  };
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
  await deps.requireC3Api();
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
export async function appOriginsAdd(m: M, args: Args, where: string, deps: AppCmdDeps): Promise<void> {
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
  await deps.requireC3Api();
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
  // An origin whose row was parked (app:origins:park) has no app_origins row but still an open origin_add: removing it
  // closes that change too, so app:origins:unpark never brings it back.
  const open = (deps.d1(openChangesSql(app.id)) as unknown as ChangeRow[]).filter((c) => c.kind === 'origin_add' && c.origin !== null);
  const present: OriginRow[] = [
    ...rows.filter((r) => wanted.includes(r.origin)),
    ...open.filter((c) => wanted.includes(c.origin!) && !rows.some((r) => r.origin === c.origin)).map((c) => ({ origin: c.origin!, active_from: null, change_id: c.id })),
  ];
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
  // A deleted app stays suspended (bit 1) for good: legacy readers of `status` rely on it (D225).
  const app = liveApp(deps, args.required('app'));
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
export async function appChangesAnnounce(m: M, changeId: string, where: string, deps: AppCmdDeps): Promise<void> {
  if (m.admin) throw new Error(`${m.name} has an admin Worker: it announces changes once their notice is accepted (app:changes:announce is only for envs without one)`);
  if ((m.network as string) === 'mainnet') throw new Error('app:changes:announce is refused on a production network');
  const change = (deps.d1(changeSql(changeId)) as unknown as ChangeRow[])[0];
  if (!change) throw new Error(`No guarded change ${changeId}`);
  if (change.status !== 'pending') throw new Error(`${changeId} is ${change.status}, not pending`);
  if (change.notified_at !== null) throw new Error(`${changeId} was already announced at ${at(change.notified_at)} (in force from ${at(change.active_from ?? change.notified_at)})`);
  await deps.requireC3Api(REQUIRED_HOT_DB_ANNOUNCE);
  const app = findApp(deps, change.app_id);
  const now = deps.now();
  // The waiver is decided inside the write (admin-sql.ts noSessionWaiver), from the database as it is then.
  if (!commit(deps, announceWrite(change, app, m.appChangeDelayMs, { now, actor: deps.actor, requestId: deps.ids.request() }))) throw new Error(`${changeId} changed since it was read: nothing was written`);
  const after = (deps.d1(changeSql(changeId)) as unknown as ChangeRow[])[0]!;
  const what = change.kind === 'origin_add' ? `origin ${printable(change.origin ?? '')}` : change.kind === 'policy_set' ? `policy ${change.policy_id}` : 'raw signing approval';
  deps.log(`${at(now)} Announced ${changeId} (${what}) for ${app.id} "${printable(app.name)}" by the CLI (${where}).`);
  deps.log('  Nobody was emailed: this env has no admin Worker (app_changes records channel cli, emailed none).');
  deps.log(`  In force from ${at(after.active_from ?? now)}${after.waiver ? ` (waiver ${after.waiver})` : ` (appChangeDelayMs ${m.appChangeDelayMs} ms)`}.`);
}

/**
 * app:origins:park [--yes]: the mandatory step before an API from before batch C3 runs on the 0006 database (a
 * rollback): such an API reads every `app_origins` row, so a proposed origin would be in force for it. Deletes every
 * origin row not yet in force (`active_from` NULL or in the future); their guarded changes keep everything needed to
 * rebuild them (`app:origins:unpark`). Dry run without `--yes`.
 */
export function appOriginsPark(yes: boolean, where: string, deps: AppCmdDeps): void {
  const now = deps.now();
  const rows = deps.d1(parkableOriginsSql(now)) as unknown as (OriginRow & { app_id: string })[];
  if (!rows.length) return void deps.log(`No origin rows to park in ${where}: an API from before batch C3 sees only origins in force.`);
  for (const r of rows) deps.log(`  ${r.app_id}  ${printable(r.origin)}  ${r.active_from === null ? 'not announced' : `pending until ${at(r.active_from)}`}  (${r.change_id ?? 'no change'})`);
  if (!yes) return void deps.log(`${rows.length} origin row(s) to park in ${where}. Run again with --yes to delete them (app:origins:unpark rebuilds them).`);
  deps.d1(`${parkOriginsWrite({ now, actor: deps.actor, requestId: deps.ids.request() }).statements.join(';\n')};`);
  const left = deps.d1(parkableOriginsSql(now)).length;
  if (left) throw new Error(`${left} origin row(s) not in force are still there: run app:origins:park --yes again before the rollback`);
  deps.log(`${at(now)} Parked ${rows.length} origin row(s) in ${where}. Safe to run an API from before batch C3; after redeploying batch C3 or later, run app:origins:unpark --yes.`);
}

/** app:origins:unpark [--yes]: re-creates the origin rows of pending or active origin_add changes that have none. */
export async function appOriginsUnpark(yes: boolean, where: string, deps: AppCmdDeps): Promise<void> {
  const now = deps.now();
  const missing = deps.d1(unparkableSql()) as unknown as { id: string; app_id: string; origin: string; active_from: number | null }[];
  if (!missing.length) return void deps.log(`No parked origins in ${where}.`);
  for (const c of missing) deps.log(`  ${c.app_id}  ${printable(c.origin)}  ${c.id}  ${c.active_from === null ? 'not announced' : `from ${at(c.active_from)}`}`);
  if (!yes) return void deps.log(`${missing.length} origin row(s) to rebuild in ${where}. Run again with --yes (the API must be at batch C3 or later).`);
  await deps.requireC3Api();
  deps.d1(`${unparkOriginsWrite({ now, actor: deps.actor, requestId: deps.ids.request() }).statements.join(';\n')};`);
  deps.log(`${at(now)} Rebuilt ${missing.length} origin row(s) in ${where}.`);
}
