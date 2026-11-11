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
// (lib/admin-lead-times.ts) for D33's issuer-key delay. scope:add-email-client (dev envs only, D253) adds a scope's
// email client with a locally minted client proof through the scope's NEAR owner (lib/admin-email-client.ts).
// user:list and user:find read the user directory (D269) from the email issuer's own D1, read only, with each
// identity's user id, Support ID and wallets from the wallet directory in the API's D1 (D310, D316; both read without
// the statement in a process argument), and user:find --address / --user start from the wallet directory
// (lib/admin-users.ts): Hana staff only; addresses and subs go to this terminal and nowhere else. retention:issuer
// is the email issuer's part of the monthly retention (lib/admin-retention.ts, D365): the admin Worker has no binding
// to the issuer's D1. support:lookup is the Support ID lookup (lib/admin-support.ts, C15): the wallet directory, apps,
// shares and changes from the API's D1, addresses from the issuer's, and the ledger as usage_admin over
// .secrets/<env>/neon-usage-admin.url ("ledger unavailable" without it).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
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
import { scopeAddEmailClient } from './lib/admin-email-client.ts';
import { homeClientAdd, homeListing } from './lib/admin-home.ts';
import { consoleRemoveAudienceCmd } from './lib/admin-console-sink.ts';
import { governanceStatusCmd, issuerIssCmd, ownerCallCmd, ownerProposalsCmd, ownerVoteCmd } from './lib/admin-owner.ts';
import { councilReplaceMemberCmd } from './lib/council-members.ts';
import { tryView } from './lib/contract.ts';
import { apiPrivateD1Execute, d1Execute, issuerD1Execute } from './lib/d1.ts';
import { type UserCmdDeps, userFindCommand, userList } from './lib/admin-users.ts';
import { retentionIssuer } from './lib/admin-retention.ts';
import { statusTokenFromSecrets, watchdogTestPage } from './lib/admin-test-page.ts';
import { type SupportLedgerConn, supportLookupCommand } from './lib/admin-support.ts';
import { secretsDir } from './lib/secrets.ts';
import { ROLE_FILES, readRoleUrl } from './lib/usage-setup.ts';
import { redact } from './lib/usage-migrate.ts';
import pg from 'pg';
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
               [--auto-approve <policy.json>|off] [--identity-email off|on_request|at_login]
               (no setting flags: show the settings)
               [--mainnet-demo on|off]   (alone; a test app in a dev env on testnet only: D428)
  scope:register [--client <google client id> …] [--allow-shared] (--owner-near <account> | --owner-google <sub>) […]
                 [--member <council member>] [--approve-with <council member>] [--yes]
  scope:add-email-client --scope <scope id> [--yes]
               dev envs (local*, sandbox*) only, D253: adds the scope's email client ("email", "email:<scope>"): mints
               the client proof locally with .secrets/<env>/email-issuer-signing-key.json (checked against the manifest's
               and the chain's email keys), the scope's NEAR owner sends propose_change (0.01 NEAR), then once due
               (waited here up to 10 min) execute_change, and get_scope is checked. Elsewhere the proof comes from the
               issuer's staff route behind Cloudflare Access
  issuer-keys:lead-times   per Google kid: first seen in the JWKS, first token, lead time, lifetime in the JWKS
  home:client:add --scope <scope id> --client <google client id> [--yes]
               records that Hana holds this Google client for the scope (Enterprise onboarding), which Hana Home's
               coverage reads; the chain must list the client in the scope. Dry run without --yes
  home:listing --scope <scope id> (--quiet | --normal) [--yes]
               a scope's quieter listing in Hana Home (D98): it then appears only for a search of its full app name, by
               its link, or for its own users; never removed. Dry run without --yes
  user:list [--app <app id>] [--provider email|google] [--search <part of the address> | -] [--limit 50] [--json]
               the user directory (D269, the email issuer's D1, read only), newest first by last seen: each user's
               address, provider, sub, verified, first and last seen, and per app its scope and on-chain path
               ({scope}#{provider}#{sub}#0), and per scope its User ID (u1_…, the identity token's sub), Support ID,
               internal id (hu_…), role in the account and wallets (the wallet directory, D310, D346, in the API's
               D1). --search -: the text on stdin (kept out of the shell history)
  user:find [--email <address> | --sub <sub> | --address <G…|0x…|NEAR account> | --user <u1_…|hu_…|HANA-XXXX-XXXX>] [--provider email|google] [--json]
               one user by exact address (as typed, or normalized as email logins store it) or by sub, with its user
               ids and wallets; --address: every user listing that wallet, --user: a User ID, internal id or Support ID, each with
               its accounts (provider, sub, role, status, address); with no flag, any of these is read from stdin.
               Addresses are printed here only: never redirect the output to a file outside .secrets/
  support:lookup <HANA-XXXX-XXXX | u1_… | hu_… | -> [--request-id <id>]… [--days 30] [--json]
               the Support ID lookup (C15): every user the code (any case, dashes optional), User ID or internal id
               names, each with its ids, accounts and addresses, wallets, the scope's apps, the vault shares not
               expired, the apps' changes, and from the usage ledger (as usage_admin over
               .secrets/<env>/neon-usage-admin.url; "ledger unavailable" without it) the user's ok login, session and
               derive events by uid over --days (1–731), and the events of each --request-id (errors included; up to
               20). -: the code on stdin. Printed here only: never redirect the output to a file outside .secrets/
  retention:issuer [--yes]
               the email issuer's part of the monthly retention (D90): user_email_apps rows of apps deleted 30 days
               ago or more, email_admin_audit rows older than 60 months; dry run without --yes. Run after each
               month's retention job (docs/operations.md "Retention"). An end user's erasure is scripts/uid-erase.ts
  owner:call <method> [--args '<json>'] [--gas <Tgas, default 100>] [--member <m>] [--approve-with <m>] [--yes]
               an owner call on the contract through the manifest's owner: signed by the owner account, or a
               council DAO proposal by --member; --approve-with (dev envs on testnet only) approves it with a
               second member in the same command, so it executes; elsewhere it prints what members must sign
  issuer:iss <provider> --add <iss> | --remove <iss> [--member <m>] [--approve-with <m>] [--yes]
               one set_issuer owner call that adds an iss beside the provider's values on chain, or removes one
               (keys and addresses unchanged: paths name the provider, not the iss); moving an issuer's URL (D404)
  console:remove-audience <aud> [--provider google] [--member <m>] [--approve-with <m>] [--yes]
               retire a console client from its console sink scope (D416): one remove_client through the manifest's
               owner, only once the audience is out of consoleAudiences, its scope is a Hana console sink owned by
               the manifest's owner, and another client stays; then deploy-contract sets console_audiences
  owner:vote <proposal id> --member <m> [--reject] [--yes]
               approve (or with --reject, reject) a council proposal (dev envs: key from .secrets)
  owner:proposals [--limit 20] [--json]           the council's recent proposals, decoded
  governance:status [--json]                       contract governance state, signer keys, council, findings
  watchdog:test-page [--yes]
               a clearly labelled test critical page, sent by the deployed watchdog on every critical channel (D449):
               the channels it would use without --yes; with it, one send, each channel's result reported, and no
               alert opened (no ack, no re-send). At most one per 5 min. Reads .secrets/<env>/watchdog-secrets.json
  council:replace-member --remove <old member> --add <new member> [--member <m>] [--approve-with <m>] [--yes]
               replace a council member: a RemoveMemberFromRole and an AddMemberToRole proposal on the council DAO
               (2 of 3 kept); --approve-with (dev envs on testnet only) approves both in the same command; elsewhere
               it prints what each remaining member must sign. Once the DAO has the new council, --yes writes
               council.members in envs/<env>.json (without --yes: prints that edit)

  --remote   act on the deployed D1 database (default: local, apps/api/.wrangler/state; user:*: the issuer's,
             apps/email-issuer/.wrangler/state, and the API's for the wallet directory)
  --d1-name <name>  act on a rehearsal database (name containing "rehearsal") instead of the env's
  --yes      scope:register, scope:add-email-client, owner:call, issuer:iss, console:remove-audience, owner:vote, council:replace-member: send the transaction (without it, only
             print it); app:origins:park, app:origins:unpark, retention:issuer: write (without it, only list);
             watchdog:test-page: send the page (without it, only show the channels)
  --allow-shared  scope:register only: the app may log in through Hana's shared Google client; with it, --client is
                  optional (an app with no Google client of its own)

  Proposals (app:create's origins, app:origins:add, app:settings --raw-sign approval and a new --auto-approve policy)
  and announcements are refused with --remote until the deployed API reports the batch C3 schema (GET /v1/health
  hotDb ≥ 6).

  app:settings: --raw-sign approval (live apps only) and a new --auto-approve policy are staff proposals that apply
  appChangeDelayMs after their announcement; --raw-sign off, --auto-approve off and the other settings are immediate.
  Durations: 12h, 23h50m, 15m, 3600000ms. --google-web-client must be one of the scope's Google clients on chain
  (default: the first one). --identity-email (D411): when Hana asks users to share their email with the app: off
  (never, the default), on_request (when the app calls requestEmailSharing()), at_login (at their first login); it
  needs migration 0014 on the hot D1. --mainnet-demo on lets a pk_test_ app sign on Base and Stellar's public network, up to
  $9.99 per transaction through the approval popup (the D39 exception for the Sodax demo, D428); immediate, and refused
  unless the manifest is a dev env (local*, sandbox*) on testnet and the app is a test app. Needs migration 0013.`;

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
  'scope:add-email-client',
  'issuer-keys:lead-times',
  'owner:call',
  'issuer:iss',
  'console:remove-audience',
  'owner:vote',
  'owner:proposals',
  'governance:status',
  'council:replace-member',
  'user:list',
  'user:find',
  'retention:issuer',
  'support:lookup',
  'watchdog:test-page',
  'home:client:add',
  'home:listing',
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

function userDeps(m: Manifest, remote: boolean): UserCmdDeps {
  return {
    d1: m.emailIssuer ? (statement) => issuerD1Execute(m, statement, { remote }) : null,
    apiD1: (statement) => apiPrivateD1Execute(m, statement, { remote }),
    log: (line) => console.log(line),
    readLine: async (prompt) => {
      // The prompt on stderr, so --json output stays clean.
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
  };
}

/**
 * The usage ledger as usage_admin (support:lookup), from `.secrets/<env>/neon-usage-admin.url` (written by `usage-setup
 * <env> roles`, read as uid-erase reads it); null without the file. The URL and password never reach an error message.
 */
async function usageAdminLedger(env: string): Promise<SupportLedgerConn | null> {
  const file = join(secretsDir(env), ROLE_FILES.usage_admin);
  if (!existsSync(file)) return null;
  const { url } = readRoleUrl(file, 'usage_admin', `.secrets/${env}/${ROLE_FILES.usage_admin}`);
  const client = new pg.Client({ connectionString: url, application_name: 'hana-id support:lookup' });
  try {
    await client.connect();
  } catch (e) {
    throw new Error(redact(e instanceof Error ? e.message : String(e), url));
  }
  return {
    async query(sql, params) {
      try {
        return (await client.query(sql, params)).rows as Record<string, unknown>[];
      } catch (e) {
        throw new Error(redact(e instanceof Error ? e.message : String(e), url));
      }
    },
    close: () => client.end(),
  };
}

const ownerDeps = (m: Manifest) => ({ rpc: new NearRpc(m.rpc), log: (line: string) => console.log(line) });

async function scopeExists(m: Manifest, scopeId: string): Promise<boolean> {
  return (await tryView<unknown>(new NearRpc(m.rpc), m.signer, 'get_scope', { scope_id: scopeId })) !== null;
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2), {
    strings: ['name', 'scope', 'plan', 'app', 'org', 'environment', 'persistence', 'session-ttl', 'idle-ttl', 'raw-sign', 'google-web-client', 'auto-approve', 'identity-email', 'mainnet-demo', 'args', 'gas', 'member', 'approve-with', 'limit', 'remove', 'add', 'd1-name', 'provider', 'search', 'email', 'sub', 'address', 'user', 'days'],
    multiple: ['origin', 'client', 'owner-near', 'owner-google', 'request-id'],
    booleans: ['remote', 'yes', 'allow-shared', 'json', 'reject', 'help', 'quiet', 'normal'],
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
  if (command.startsWith('user:')) {
    if (args.str('d1-name') !== undefined) throw new CliError('--d1-name is for the API database’s app commands; user:* read the env’s own databases');
    const walletLookup = command === 'user:find' && (args.str('address') !== undefined || args.str('user') !== undefined);
    if (!m.emailIssuer && !walletLookup) throw new CliError(`envs/${m.name}.json has no emailIssuer: no user directory (user:find --address or --user read the wallet directory)`);
    const issuerWhere = m.emailIssuer ? `${remote ? 'remote' : 'local'} D1 ${m.emailIssuer.cloudflare.d1Name}` : 'no email issuer';
    const deps = userDeps(m, remote);
    if (command === 'user:list') await userList(args, issuerWhere, deps);
    else await userFindCommand(args, { issuer: issuerWhere, api: where }, deps);
    return;
  }

  if (command === 'support:lookup') {
    if (args.str('d1-name') !== undefined) throw new CliError('--d1-name is for the API database’s app commands; support:lookup reads the env’s own databases');
    const file = `.secrets/${m.name}/${ROLE_FILES.usage_admin}`;
    await supportLookupCommand(rest[0]!, args, {
      apiD1: (statement) => apiPrivateD1Execute(m, statement, { remote }),
      issuerD1: m.emailIssuer ? (statement) => issuerD1Execute(m, statement, { remote }) : null,
      ledger: () => usageAdminLedger(m.name),
      ledgerFile: file,
      log: (line) => console.log(line),
      readLine: userDeps(m, remote).readLine,
    });
    return;
  }

  if (command === 'retention:issuer') {
    if (args.str('d1-name') !== undefined) throw new CliError('--d1-name is for the API database’s app commands; retention:issuer acts on the env’s own databases');
    if (!m.emailIssuer) throw new CliError(`envs/${m.name}.json has no emailIssuer: nothing to purge`);
    const issuerWhere = `${remote ? 'remote' : 'local'} D1 ${m.emailIssuer.cloudflare.d1Name}`;
    await retentionIssuer(args, { api: where, issuer: issuerWhere }, {
      apiD1: (statement) => d1Execute(m, statement, { remote }),
      issuerD1: (statement) => issuerD1Execute(m, statement, { remote }),
      now: () => Date.now(),
      log: (line) => console.log(line),
    });
    return;
  }

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
    case 'scope:add-email-client':
      await scopeAddEmailClient(m, args, ownerDeps(m));
      return;
    case 'issuer-keys:lead-times':
      for (const line of leadTimesReport(d1Execute<ObservationRow>(m, LEAD_TIMES_SQL, { remote }), Date.now(), where)) console.log(line);
      return;
    case 'owner:call':
      await ownerCallCmd(m, rest[0]!, args, ownerDeps(m));
      return;
    case 'issuer:iss':
      await issuerIssCmd(m, rest[0]!, args, ownerDeps(m));
      return;
    case 'console:remove-audience':
      await consoleRemoveAudienceCmd(m, rest[0]!, args, ownerDeps(m));
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
    case 'watchdog:test-page':
      await watchdogTestPage(m, args.flag('yes'), { fetch, token: () => statusTokenFromSecrets(m.name), log: (line) => console.log(line) });
      return;
    case 'home:client:add':
      await homeClientAdd(m, args, where, { d1: (statement) => d1Execute(m, statement, { remote }), rpc: new NearRpc(m.rpc), now: () => Date.now(), log: (line) => console.log(line) });
      return;
    case 'home:listing':
      homeListing(m, args, where, { d1: (statement) => d1Execute(m, statement, { remote }), log: (line) => console.log(line) });
      return;
    case 'user:list':
    case 'user:find':
    case 'retention:issuer':
    case 'support:lookup':
      return; // handled above, before the API database's commands
  }
}

run(main, USAGE);
