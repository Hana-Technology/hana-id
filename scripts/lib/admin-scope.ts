// admin.ts scope:register: print the admin_register_scope call, and send it only with --yes. --allow-shared lets
// the scope log in through Hana's shared Google client (then --client is optional).
import type { Manifest } from '@hana-id/env';
import { actionCreators } from '@near-js/transactions';
import { clientsFromArgs, ownersFromArgs } from './admin-args.ts';
import type { Args } from './cli.ts';
import { loadLegacyCredential } from './keys.ts';
import { explorerTx, NearRpc, TGAS } from './near.ts';

export const SCOPE_DRY_RUN_LINE = 'Dry run: re-run with --yes to send.';

export interface ScopeRegisterDeps {
  rpc: (url: string) => Pick<NearRpc, 'chainId' | 'sendTx'>;
  log: (line: string) => void;
  /** Home directory holding ~/.near-credentials (default: the user's home). */
  home?: string;
}

export const defaultScopeRegisterDeps = (): ScopeRegisterDeps => ({ rpc: (url) => new NearRpc(url), log: (line) => console.log(line) });

export async function scopeRegister(m: Manifest, args: Args, deps: ScopeRegisterDeps = defaultScopeRegisterDeps()): Promise<void> {
  const { log } = deps;
  const owners = ownersFromArgs(args.list('owner-near'), args.list('owner-google'));
  const allowShared = args.flag('allow-shared');
  const clients = clientsFromArgs(args.list('client'), { allowShared, sharedClientIds: m.sharedGoogleClientIds });
  const callArgs = { owners, clients, scope_id: null, allow_shared: allowShared };
  log(`admin_register_scope(${JSON.stringify(callArgs)}) on ${m.signer}, signed by ${m.owner}`);
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
  const owner = loadLegacyCredential(m.owner, m.network, deps.home);
  const { hash, value } = await rpc.sendTx({ accountId: owner.accountId, keyPair: owner.keyPair }, m.signer, [
    actionCreators.functionCall('admin_register_scope', callArgs, 100n * TGAS, 0n),
  ]);
  log(`tx ${explorerTx(hash)}`);
  log(`Registered scope: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}
