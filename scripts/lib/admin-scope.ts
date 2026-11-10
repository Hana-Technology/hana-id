// admin.ts scope:register: print the admin_register_scope call, and send it only with --yes. --allow-shared lets
// the scope log in through Hana's shared Google client (then --client is optional). The call goes through the
// manifest's owner (owner-tx.ts): the owner account signs it, or, for a council owner, it becomes a DAO proposal
// (--member, and on dev envs --approve-with to approve it in the same command). Either way it prints the new scope id
// once the call ran: the call's return value, or on the council path the `scope_registered` event the executing vote
// logged (the admin console's "Register a scope" panel prepares this command and tells staff to copy that id).
import type { Manifest } from '@hana-id/env';
import { clientsFromArgs, ownersFromArgs } from './admin-args.ts';
import type { Args } from './cli.ts';
import { NearRpc, TGAS } from './near.ts';
import { describeOwnerCall, sendOwnerCall } from './owner-tx.ts';

export const SCOPE_DRY_RUN_LINE = 'Dry run: re-run with --yes to send.';

/**
 * The scope id of the `scope_registered` event in a transaction's logs (NEP-297 `EVENT_JSON:` lines, standard
 * `hana-id`), or null when there is none. With `owners`, only an event for exactly those owners counts.
 */
export function registeredScopeId(logs: readonly string[], owners?: readonly unknown[]): string | null {
  for (const line of logs) {
    if (!line.startsWith('EVENT_JSON:')) continue;
    let e: { standard?: unknown; event?: unknown; data?: unknown };
    try {
      e = JSON.parse(line.slice('EVENT_JSON:'.length)) as typeof e;
    } catch {
      continue;
    }
    if (e.standard !== 'hana-id' || e.event !== 'scope_registered' || !Array.isArray(e.data)) continue;
    const d = e.data[0] as { scope_id?: unknown; owners?: unknown } | undefined;
    if (typeof d?.scope_id !== 'string' || !/^[a-z0-9]{1,64}$/u.test(d.scope_id)) continue;
    if (owners && JSON.stringify(d.owners) !== JSON.stringify(owners)) continue;
    return d.scope_id;
  }
  return null;
}

/** What to tell staff once the scope id is known: the next step is an app on it. */
export const nextStepLine = (m: Pick<Manifest, 'name'>, scopeId: string) =>
  `Next: in the admin console (${m.name}), open the organisation and use "Create an app" with scope ${scopeId}.`;

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
  if (r.kind === 'executed') {
    const id = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
    log(`Registered scope: ${id}`);
    if (typeof r.value === 'string') log(nextStepLine(m, r.value));
  } else if (r.kind === 'approved') {
    const id = registeredScopeId(r.logs ?? [], owners);
    if (id) {
      log(`Registered scope: ${id} (proposal #${r.proposalId})`);
      log(nextStepLine(m, id));
    } else log(`Registered through proposal #${r.proposalId}, but its vote logged no scope_registered event: read the new scope id from the vote transaction on the explorer (above).`);
  } else log(`Proposed #${r.proposalId}: the scope is registered when the council approves it; the member whose vote passes it sees the scope id in that vote's scope_registered event (owner:vote prints it).`);
}
