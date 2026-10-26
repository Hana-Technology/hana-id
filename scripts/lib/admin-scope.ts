// admin.ts scope:register: print the admin_register_scope call, and send it only with --yes.
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
  const clients = clientsFromArgs(args.list('client'));
  const callArgs = { owners, clients, scope_id: null };
  log(`admin_register_scope(${JSON.stringify(callArgs)}) on ${m.signer}, signed by ${m.owner}`);
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
