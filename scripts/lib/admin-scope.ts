// admin.ts scope:register: print the admin_register_scope call, and send it only with --yes. --allow-shared lets
// the scope log in through Hana's shared Google client (then --client is optional). The call goes through the
// manifest's owner (owner-tx.ts): the owner account signs it, or, for a council owner, it becomes a DAO proposal
// (--member, and on dev envs --approve-with to approve it in the same command).
import type { Manifest } from '@hana-id/env';
import { clientsFromArgs, ownersFromArgs } from './admin-args.ts';
import type { Args } from './cli.ts';
import { NearRpc, TGAS } from './near.ts';
import { describeOwnerCall, sendOwnerCall } from './owner-tx.ts';

export const SCOPE_DRY_RUN_LINE = 'Dry run: re-run with --yes to send.';

export interface ScopeRegisterDeps {
  rpc: (url: string) => Pick<NearRpc, 'chainId' | 'sendTx' | 'view'>;
  log: (line: string) => void;
  /** Home directory holding ~/.near-credentials (default: the user's home). */
  home?: string;
  /** Directory holding .secrets/ (council keys on dev envs). */
  secretsRoot?: string;
}

export const defaultScopeRegisterDeps = (): ScopeRegisterDeps => ({ rpc: (url) => new NearRpc(url), log: (line) => console.log(line) });

export async function scopeRegister(m: Manifest, args: Args, deps: ScopeRegisterDeps = defaultScopeRegisterDeps()): Promise<void> {
  const { log } = deps;
  const owners = ownersFromArgs(args.list('owner-near'), args.list('owner-google'));
  const allowShared = args.flag('allow-shared');
  const clients = clientsFromArgs(args.list('client'), { allowShared, sharedClientIds: m.sharedGoogleClientIds });
  const callArgs = { owners, clients, scope_id: null, allow_shared: allowShared };
  const call = { method: 'admin_register_scope' as const, args: callArgs, gas: 100n * TGAS };
  const opts = { member: args.str('member'), approveWith: args.str('approve-with') };
  log(`${describeOwnerCall(m, call, opts)} on ${m.signer}`);
  log(
    clients.length && allowShared
      ? 'Logins: through the app\'s own Google client(s) and through Hana\'s shared client, into this one scope.'
      : clients.length
        ? 'Logins: through the app\'s own Google client(s) only.'
        : 'Logins: through Hana\'s shared Google client only (the app can add its own client later with propose_change(AddClient)).',
  );
  if (allowShared && (!m.sharedGoogleClientIds.length || m.sharedGoogleClientIds.some((id) => /UNSET/u.test(id)))) {
    log(`Note: envs/${m.name}.json has no shared Google client yet, so shared login won't work until it is set and deploy-contract has run set_shared_clients.`);
  }
  if (!args.flag('yes')) return void log(SCOPE_DRY_RUN_LINE);
  const rpc = deps.rpc(m.rpc);
  if ((await rpc.chainId()) !== 'testnet') throw new Error(`${m.rpc} is not a testnet RPC`);
  const r = await sendOwnerCall(m, call, opts, { rpc, log, home: deps.home, secretsRoot: deps.secretsRoot });
  if (r.kind === 'executed') log(`Registered scope: ${typeof r.value === 'string' ? r.value : JSON.stringify(r.value)}`);
  else if (r.kind === 'approved') log(`Registered through proposal #${r.proposalId}: read the new scope id from the vote transaction's logs (scope_registered event) or get_scope.`);
  else log(`Proposed #${r.proposalId}: the scope is registered when the council approves it.`);
}
