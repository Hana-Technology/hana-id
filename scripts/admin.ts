// admin.ts <env> <command> [options]
//
// Partner-app admin for one environment. App rows live in the env's D1 database (wrangler d1 execute, local by
// default, --remote for the deployed database). app:settings sets the per-app vault settings (lib/admin-settings.ts).
// scope:register calls admin_register_scope (with allow_shared from
// --allow-shared) through the manifest's owner (lib/owner-tx.ts: the owner's full-access key from
// ~/.near-credentials/testnet/<owner>.json, or a council DAO proposal). owner:* and governance:status drive and read
// the governance contract (lib/admin-owner.ts). issuer-keys:lead-times reads the issuer key observations
// (lib/admin-lead-times.ts) for D33's issuer-key delay.
import { loadEnv, type Manifest } from '@hana-id/env';
import { assertCommandPositionals } from './lib/admin-args.ts';
import {
  addOriginsSql,
  assertAppName,
  assertAppOrigins,
  assertPlanId,
  assertScopeId,
  createAppSql,
  findAppSql,
  listAppsSql,
  normaliseOrigin,
  planExistsSql,
  printable,
  removeOriginsSql,
  scopeConflictSql,
  setStatusSql,
} from './lib/admin-sql.ts';
import { LEAD_TIMES_SQL, type ObservationRow, leadTimesReport } from './lib/admin-lead-times.ts';
import { appSettings, defaultAppSettingsDeps, settingsAppArg } from './lib/admin-settings.ts';
import { type Args, CliError, parseCli, run } from './lib/cli.ts';
import { scopeRegister } from './lib/admin-scope.ts';
import { governanceStatusCmd, ownerCallCmd, ownerProposalsCmd, ownerVoteCmd } from './lib/admin-owner.ts';
import { tryView } from './lib/contract.ts';
import { d1Execute } from './lib/d1.ts';
import { NearRpc } from './lib/near.ts';
import { newAppId, publishableKey } from './lib/pk.ts';

const USAGE = `Usage: admin.ts <env> <command> [options] [--remote]
  app:create --name <name> --scope <scope_id> --origin <origin> [--origin …] [--plan free]
  app:origins:add    --app <app id | publishable key> --origin <origin> [--origin …]
  app:origins:remove --app <app id | publishable key> --origin <origin> [--origin …]
  app:suspend        --app <app id | publishable key>
  app:resume         --app <app id | publishable key>
  app:list
  app:settings <app id | publishable key> [--persistence session|none] [--session-ttl <1h..23h50m>]
               [--idle-ttl <15m..session TTL>] [--raw-sign off|approval] [--google-web-client <client id>|default]
               [--auto-approve <policy.json>|off]   (no setting flags: show the settings)
  scope:register [--client <google client id> …] [--allow-shared] (--owner-near <account> | --owner-google <sub>) […]
                 [--member <council member>] [--approve-with <council member>] [--yes]
  issuer-keys:lead-times   per Google kid: first seen in the JWKS, first token, lead time, lifetime in the JWKS
  owner:call <method> [--args '<json>'] [--gas <Tgas, default 100>] [--member <m>] [--approve-with <m>] [--yes]
               an owner call on the contract through the manifest's owner: signed by the owner account, or a
               council DAO proposal by --member; --approve-with (dev envs on testnet only) approves it with a
               second member in the same command, so it executes; elsewhere it prints what members must sign
  owner:vote <proposal id> --member <m> [--yes]    approve a council proposal (dev envs: key from .secrets)
  owner:proposals [--limit 20] [--json]           the council's recent proposals, decoded
  governance:status [--json]                       contract governance state, signer keys, council, findings

  --remote   act on the deployed D1 database (default: local, apps/api/.wrangler/state)
  --yes      scope:register, owner:call, owner:vote: send the transaction (without it, only print it)
  --allow-shared  scope:register only: the app may log in through Hana's shared Google client; with it, --client is
                  optional (an app with no Google client of its own)

  app:settings: --raw-sign approval and a new --auto-approve policy apply after a 24 h delay (the manifest's
  changeDelayMs in local*/sandbox* envs); --raw-sign off and --auto-approve off are immediate. Durations: 12h, 23h50m,
  15m, 3600000ms. --google-web-client must be one of the scope's Google clients on chain (default: the first one).`;

const COMMANDS = [
  'app:create',
  'app:origins:add',
  'app:origins:remove',
  'app:suspend',
  'app:resume',
  'app:list',
  'app:settings',
  'scope:register',
  'issuer-keys:lead-times',
  'owner:call',
  'owner:vote',
  'owner:proposals',
  'governance:status',
] as const;
type Command = (typeof COMMANDS)[number];

interface AppRow {
  id: string;
  name: string;
  scope_id: string;
  publishable_key: string;
  status: string;
  plan: string;
  created_at?: number;
  origins?: string | null;
}

function findApp(m: Manifest, idOrKey: string, remote: boolean): AppRow {
  const rows = d1Execute<AppRow>(m, findAppSql(idOrKey), { remote });
  if (rows.length !== 1 || !rows[0]) throw new Error(`No app ${idOrKey}`);
  return rows[0];
}

function origins(args: Args): string[] {
  const list = args.list('origin').map(normaliseOrigin);
  if (!list.length) throw new CliError('At least one --origin is required');
  return [...new Set(list)];
}

const ownerDeps = (m: Manifest) => ({ rpc: new NearRpc(m.rpc), log: (line: string) => console.log(line) });

async function scopeExists(m: Manifest, scopeId: string): Promise<boolean> {
  return (await tryView<unknown>(new NearRpc(m.rpc), m.signer, 'get_scope', { scope_id: scopeId })) !== null;
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2), {
    strings: ['name', 'scope', 'plan', 'app', 'persistence', 'session-ttl', 'idle-ttl', 'raw-sign', 'google-web-client', 'auto-approve', 'args', 'gas', 'member', 'approve-with', 'limit'],
    multiple: ['origin', 'client', 'owner-near', 'owner-google'],
    booleans: ['remote', 'yes', 'allow-shared', 'json', 'help'],
  });
  if (args.flag('help')) return void console.log(USAGE);
  const [envName, command, ...rest] = args.positionals;
  if (!envName || !command) throw new CliError('Expected <env> <command>');
  if (!COMMANDS.includes(command as Command)) throw new CliError(`Unknown command ${command}`);
  // app:settings names its app positionally (docs/batch-b-spec.md) or with --app (settingsAppArg).
  assertCommandPositionals(command, rest);
  const m = loadEnv(envName);
  const remote = args.flag('remote');
  const where = remote ? `remote D1 ${m.cloudflare.d1Name}` : `local D1 ${m.cloudflare.d1Name}`;

  switch (command as Command) {
    case 'app:create': {
      const name = assertAppName(args.required('name'));
      const scopeId = assertScopeId(args.required('scope'));
      const plan = assertPlanId(args.str('plan') ?? 'free');
      const list = origins(args);
      if (!(await scopeExists(m, scopeId))) throw new Error(`Scope ${scopeId} is not registered on ${m.signer} (admin.ts ${m.name} scope:register …)`);
      if (!d1Execute(m, planExistsSql(plan), { remote }).length) throw new Error(`No plan "${plan}" in ${where}`);
      const app = { id: newAppId(), name, scopeId, publishableKey: publishableKey(), plan, createdAt: Date.now(), origins: list };
      assertAppOrigins(m, app.publishableKey, list);
      // Test and live keys never share a scope (the API would refuse the test key: scope_conflict).
      const conflict = d1Execute<{ id: string }>(m, scopeConflictSql(scopeId, app.publishableKey), { remote });
      if (conflict.length) throw new Error(`Scope ${scopeId} is used by ${conflict.map((r) => r.id).join(', ')} with the other key type (pk_test_ and pk_live_ apps can't share a scope)`);
      d1Execute(m, createAppSql(app), { remote });
      console.log(`Created app ${app.id} "${name}" (scope ${scopeId}, plan ${plan}) in ${where}`);
      console.log(`Origins: ${list.join(' ')}`);
      console.log(`Publishable key: ${app.publishableKey}`);
      return;
    }
    case 'app:origins:add':
    case 'app:origins:remove': {
      const app = findApp(m, args.required('app'), remote);
      const list = origins(args);
      // Checked when adding only: removing an entry the API would drop must always work.
      if (command === 'app:origins:add') assertAppOrigins(m, app.publishable_key, list);
      d1Execute(m, command === 'app:origins:add' ? addOriginsSql(app.id, list) : removeOriginsSql(app.id, list), { remote });
      console.log(`${command === 'app:origins:add' ? 'Added' : 'Removed'} ${list.join(' ')} ${command === 'app:origins:add' ? 'to' : 'from'} ${app.id} (${where})`);
      return;
    }
    case 'app:suspend':
    case 'app:resume': {
      const app = findApp(m, args.required('app'), remote);
      const status = command === 'app:suspend' ? 'suspended' : 'active';
      d1Execute(m, setStatusSql(app.id, status), { remote });
      console.log(`${app.id} "${printable(app.name)}" is now ${status} (${where})`);
      return;
    }
    case 'app:list': {
      const rows = d1Execute<AppRow>(m, listAppsSql(), { remote });
      if (!rows.length) return void console.log(`No apps in ${where}.`);
      for (const r of rows) {
        console.log(`${r.id}  ${r.status.padEnd(9)} scope=${r.scope_id} plan=${r.plan}  ${r.publishable_key}  "${printable(r.name)}"\n    origins: ${printable(r.origins ?? '(none)')}`);
      }
      return;
    }
    case 'app:settings': {
      await appSettings(m, settingsAppArg(rest, args.str('app')), args, where, defaultAppSettingsDeps(m, remote));
      return;
    }
    case 'scope:register':
      await scopeRegister(m, args);
      return;
    case 'issuer-keys:lead-times':
      for (const line of leadTimesReport(d1Execute<ObservationRow>(m, LEAD_TIMES_SQL, { remote }), Date.now(), where)) console.log(line);
      return;
    case 'owner:call':
      await ownerCallCmd(m, rest[0]!, args, ownerDeps(m));
      return;
    case 'owner:vote':
      await ownerVoteCmd(m, rest[0]!, args, ownerDeps(m));
      return;
    case 'owner:proposals':
      await ownerProposalsCmd(m, args, ownerDeps(m));
      return;
    case 'governance:status':
      await governanceStatusCmd(m, args, ownerDeps(m));
      return;
  }
}

run(main, USAGE);
