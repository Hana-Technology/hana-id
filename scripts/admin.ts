// admin.ts <env> <command> [options]
//
// Partner-app admin for one environment. App rows live in the env's D1 database (wrangler d1 execute, local by
// default, --remote for the deployed database), in the batch C schema of migration 0006 (lib/admin-apps.ts,
// lib/admin-sql.ts): origin adds, raw-signing enables and auto-approve policies are staff proposals that go live only
// after an announcement (the admin Worker's notice, or app:changes:announce in an env without one) plus
// appChangeDelayMs. app:settings sets the per-app vault settings (lib/admin-settings.ts).
// scope:register calls admin_register_scope (with allow_shared from
// --allow-shared) through the manifest's owner (lib/owner-tx.ts: the owner's full-access key from
// ~/.near-credentials/testnet/<owner>.json, or a council DAO proposal). owner:* and governance:status drive and read
// the governance contract (lib/admin-owner.ts); council:replace-member proposes a council member change
// (lib/council-members.ts). issuer-keys:lead-times reads the issuer key observations
// (lib/admin-lead-times.ts) for D33's issuer-key delay.
import { loadEnv, type Manifest } from '@hana-id/env';
import { assertCommandPositionals } from './lib/admin-args.ts';
import {
  type AppCmdDeps,
  appChangesAnnounce,
  appCreate,
  appList,
  appOriginsAdd,
  appOriginsPark,
  appOriginsRemove,
  appOriginsUnpark,
  appSuspension,
  cliActor,
  cliIds,
  requireC3ApiFor,
  withRehearsalD1,
} from './lib/admin-apps.ts';
import { LEAD_TIMES_SQL, type ObservationRow, leadTimesReport } from './lib/admin-lead-times.ts';
import { appSettings, defaultAppSettingsDeps, settingsAppArg } from './lib/admin-settings.ts';
import { CliError, parseCli, run } from './lib/cli.ts';
import { scopeRegister } from './lib/admin-scope.ts';
import { governanceStatusCmd, ownerCallCmd, ownerProposalsCmd, ownerVoteCmd } from './lib/admin-owner.ts';
import { councilReplaceMemberCmd } from './lib/council-members.ts';
import { tryView } from './lib/contract.ts';
import { d1Execute } from './lib/d1.ts';
import { NearRpc } from './lib/near.ts';

const USAGE = `Usage: admin.ts <env> <command> [options] [--remote]
  app:create --org org_legacy --name <name> --scope <scope_id> [--environment test|live] --origin <origin> [--origin …]
             [--plan free]   (--environment is required for a scope with no app yet; the key is pk_test_/pk_live_ by it)
  app:origins:add    --app <app id | publishable key> --origin <origin> [--origin …]   (staff proposals)
  app:origins:remove --app <app id | publishable key> --origin <origin> [--origin …]   (immediate)
  app:suspend        --app <app id | publishable key>   (sets Hana's suspension bit; immediate)
  app:resume         --app <app id | publishable key>   (clears Hana's bit only)
  app:list           apps with their org, keys, origins in force, suspension bits and pending changes
  app:changes:announce <change id>
               only in an env with no admin Worker, never on a production network: announces a pending staff
               proposal (it goes live appChangeDelayMs later; nobody is emailed)
  app:origins:park [--yes]     before running an API from before batch C3 on this database (a rollback): deletes the
               origin rows not yet in force, which such an API would treat as in force (dry run without --yes)
  app:origins:unpark [--yes]   after redeploying batch C3 or later: rebuilds them from their guarded changes
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
  owner:vote <proposal id> --member <m> [--reject] [--yes]
               approve (or with --reject, reject) a council proposal (dev envs: key from .secrets)
  owner:proposals [--limit 20] [--json]           the council's recent proposals, decoded
  governance:status [--json]                       contract governance state, signer keys, council, findings
  council:replace-member --remove <old member> --add <new member> [--member <m>] [--approve-with <m>] [--yes]
               replace a council member: a RemoveMemberFromRole and an AddMemberToRole proposal on the council DAO
               (2 of 3 kept); --approve-with (dev envs on testnet only) approves both in the same command; elsewhere
               it prints what each remaining member must sign. Once the DAO has the new council, --yes writes
               council.members in envs/<env>.json (without --yes: prints that edit)

  --remote   act on the deployed D1 database (default: local, apps/api/.wrangler/state)
  --d1-name <name>  act on a rehearsal database (name containing "rehearsal") instead of the env's
  --yes      scope:register, owner:call, owner:vote, council:replace-member: send the transaction (without it, only
             print it); app:origins:park, app:origins:unpark: write (without it, only list)
  --allow-shared  scope:register only: the app may log in through Hana's shared Google client; with it, --client is
                  optional (an app with no Google client of its own)

  Proposals (app:create's origins, app:origins:add, app:settings --raw-sign approval and a new --auto-approve policy)
  and announcements are refused with --remote until the deployed API reports the batch C3 schema (GET /v1/health
  hotDb ≥ 6).

  app:settings: --raw-sign approval (live apps only) and a new --auto-approve policy are staff proposals that apply
  appChangeDelayMs after their announcement; --raw-sign off, --auto-approve off and the other settings are immediate.
  Durations: 12h, 23h50m, 15m, 3600000ms. --google-web-client must be one of the scope's Google clients on chain
  (default: the first one).`;

const COMMANDS = [
  'app:create',
  'app:origins:add',
  'app:origins:remove',
  'app:suspend',
  'app:resume',
  'app:list',
  'app:changes:announce',
  'app:origins:park',
  'app:origins:unpark',
  'app:settings',
  'scope:register',
  'issuer-keys:lead-times',
  'owner:call',
  'owner:vote',
  'owner:proposals',
  'governance:status',
  'council:replace-member',
] as const;
type Command = (typeof COMMANDS)[number];

function appDeps(m: Manifest, remote: boolean): AppCmdDeps {
  return {
    d1: (statement) => d1Execute(m, statement, { remote }),
    scopeOnChain: (scopeId) => scopeExists(m, scopeId),
    now: () => Date.now(),
    log: (line) => console.log(line),
    actor: cliActor(),
    ids: cliIds,
    requireC3Api: requireC3ApiFor(m, remote),
  };
}

const ownerDeps = (m: Manifest) => ({ rpc: new NearRpc(m.rpc), log: (line: string) => console.log(line) });

async function scopeExists(m: Manifest, scopeId: string): Promise<boolean> {
  return (await tryView<unknown>(new NearRpc(m.rpc), m.signer, 'get_scope', { scope_id: scopeId })) !== null;
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2), {
    strings: ['name', 'scope', 'plan', 'app', 'org', 'environment', 'persistence', 'session-ttl', 'idle-ttl', 'raw-sign', 'google-web-client', 'auto-approve', 'args', 'gas', 'member', 'approve-with', 'limit', 'remove', 'add', 'd1-name'],
    multiple: ['origin', 'client', 'owner-near', 'owner-google'],
    booleans: ['remote', 'yes', 'allow-shared', 'json', 'reject', 'help'],
  });
  if (args.flag('help')) return void console.log(USAGE);
  const [envName, command, ...rest] = args.positionals;
  if (!envName || !command) throw new CliError('Expected <env> <command>');
  if (!COMMANDS.includes(command as Command)) throw new CliError(`Unknown command ${command}`);
  // app:settings names its app positionally (docs/batch-b-spec.md) or with --app (settingsAppArg).
  assertCommandPositionals(command, rest);
  const m = withRehearsalD1(loadEnv(envName), args.str('d1-name'));
  const remote = args.flag('remote');
  const where = remote ? `remote D1 ${m.cloudflare.d1Name}` : `local D1 ${m.cloudflare.d1Name}`;

  switch (command as Command) {
    case 'app:create':
      await appCreate(m, args, where, appDeps(m, remote));
      return;
    case 'app:origins:add':
      await appOriginsAdd(m, args, where, appDeps(m, remote));
      return;
    case 'app:origins:remove':
      appOriginsRemove(args, where, appDeps(m, remote));
      return;
    case 'app:suspend':
    case 'app:resume':
      appSuspension(command === 'app:suspend', args, where, appDeps(m, remote));
      return;
    case 'app:list':
      appList(where, appDeps(m, remote));
      return;
    case 'app:changes:announce':
      await appChangesAnnounce(m, rest[0]!, where, appDeps(m, remote));
      return;
    case 'app:origins:park':
      appOriginsPark(args.flag('yes'), where, appDeps(m, remote));
      return;
    case 'app:origins:unpark':
      await appOriginsUnpark(args.flag('yes'), where, appDeps(m, remote));
      return;
    case 'app:settings': {
      const deps = appDeps(m, remote);
      await appSettings(m, settingsAppArg(rest, args.str('app')), args, where, {
        ...defaultAppSettingsDeps(m, remote),
        actor: deps.actor,
        newRequestId: deps.ids.request,
        newChangeId: deps.ids.change,
        requireC3Api: deps.requireC3Api,
      });
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
    case 'council:replace-member':
      await councilReplaceMemberCmd(m, args, ownerDeps(m));
      return;
  }
}

run(main, USAGE);
