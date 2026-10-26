// admin.ts <env> <command> [options]
//
// Partner-app admin for one environment. App rows live in the env's D1 database (wrangler d1 execute, local by
// default, --remote for the deployed database). scope:register calls admin_register_scope on the contract with
// the owner's full-access key from ~/.near-credentials/testnet/<owner>.json.
import { loadEnv, type Manifest } from '@hana-id/env';
import {
  addOriginsSql,
  assertAppName,
  assertPlanId,
  assertScopeId,
  createAppSql,
  findAppSql,
  listAppsSql,
  normaliseOrigin,
  planExistsSql,
  removeOriginsSql,
  setStatusSql,
} from './lib/admin-sql.ts';
import { type Args, CliError, parseCli, run } from './lib/cli.ts';
import { scopeRegister } from './lib/admin-scope.ts';
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
  scope:register --client <google client id> [--client …] (--owner-near <account> | --owner-google <sub>) […] [--yes]

  --remote   act on the deployed D1 database (default: local, apps/api/.wrangler/state)
  --yes      scope:register only: send the transaction (without it, only print it)`;

const COMMANDS = ['app:create', 'app:origins:add', 'app:origins:remove', 'app:suspend', 'app:resume', 'app:list', 'scope:register'] as const;
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

async function scopeExists(m: Manifest, scopeId: string): Promise<boolean> {
  return (await tryView<unknown>(new NearRpc(m.rpc), m.signer, 'get_scope', { scope_id: scopeId })) !== null;
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2), {
    strings: ['name', 'scope', 'plan', 'app'],
    multiple: ['origin', 'client', 'owner-near', 'owner-google'],
    booleans: ['remote', 'yes', 'help'],
  });
  if (args.flag('help')) return void console.log(USAGE);
  const [envName, command, ...rest] = args.positionals;
  if (!envName || !command || rest.length) throw new CliError('Expected <env> <command>');
  if (!COMMANDS.includes(command as Command)) throw new CliError(`Unknown command ${command}`);
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
      d1Execute(m, command === 'app:origins:add' ? addOriginsSql(app.id, list) : removeOriginsSql(app.id, list), { remote });
      console.log(`${command === 'app:origins:add' ? 'Added' : 'Removed'} ${list.join(' ')} ${command === 'app:origins:add' ? 'to' : 'from'} ${app.id} (${where})`);
      return;
    }
    case 'app:suspend':
    case 'app:resume': {
      const app = findApp(m, args.required('app'), remote);
      const status = command === 'app:suspend' ? 'suspended' : 'active';
      d1Execute(m, setStatusSql(app.id, status), { remote });
      console.log(`${app.id} "${app.name}" is now ${status} (${where})`);
      return;
    }
    case 'app:list': {
      const rows = d1Execute<AppRow>(m, listAppsSql(), { remote });
      if (!rows.length) return void console.log(`No apps in ${where}.`);
      for (const r of rows) {
        console.log(`${r.id}  ${r.status.padEnd(9)} scope=${r.scope_id} plan=${r.plan}  ${r.publishable_key}  "${r.name}"\n    origins: ${r.origins ?? '(none)'}`);
      }
      return;
    }
    case 'scope:register':
      await scopeRegister(m, args);
      return;
  }
}

run(main, USAGE);
