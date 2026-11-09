// admin.ts home:client:add and home:listing (docs/hana-home-build-plan.md H2, D502, D503): the two staff writes behind
// GET /v1/home/apps. home:client:add records that Hana holds a scope's Google client (Enterprise onboarding, D42), after
// checking the chain lists that client in that scope; home:listing turns a scope's quieter listing on or off (D98 item 8).
// Both touch only the API's D1, dry run without --yes, testnet envs only. Neither changes a path, a key or a client on chain.
import type { Manifest } from '@hana-id/env';
import { assertScopeId } from './admin-sql.ts';
import { type Args, CliError } from './cli.ts';
import { tryView } from './contract.ts';
import type { NearRpc } from './near.ts';
import { sql } from './sql.ts';

export const HOME_DRY_RUN_LINE = 'Dry run: re-run with --yes to write.';
const GOOGLE = 'google';

export interface HomeCmdDeps {
  d1: (statement: string) => Record<string, unknown>[];
  rpc: Pick<NearRpc, 'chainId' | 'view'>;
  now: () => number;
  log: (line: string) => void;
}

type M = Pick<Manifest, 'name' | 'network' | 'signer' | 'rpc'>;

function assertTestnet(m: M): void {
  if (m.network !== 'testnet') throw new CliError(`envs/${m.name}.json is not a testnet env`);
}

/** The exactly-one Google client id of --client. */
function clientArg(args: Args): string {
  const clients = args.list('client');
  if (clients.length !== 1) throw new CliError('home:client:add takes exactly one --client <google client id>');
  const client = clients[0] as string;
  if (!client || client.length > 256 || /\s/u.test(client)) throw new CliError(`Invalid client id: ${client}`);
  return client;
}

/**
 * Records `(google, client, scope)` in hana_held_clients, once `get_scope` lists the client in the scope. A row for
 * another scope is refused rather than moved: the operator looks at why first (a client is in at most one scope on chain).
 */
export async function homeClientAdd(m: M, args: Args, where: string, deps: HomeCmdDeps): Promise<void> {
  assertTestnet(m);
  const scopeId = assertScopeId(args.required('scope'));
  const client = clientArg(args);
  if ((await deps.rpc.chainId()) !== 'testnet') throw new Error(`${m.rpc} is not a testnet RPC`);
  const scope = await tryView<{ clients?: [string, string][] }>(deps.rpc, m.signer, 'get_scope', { scope_id: scopeId });
  if (!scope) throw new Error(`No scope ${scopeId} on ${m.signer}`);
  if (!scope.clients?.some(([p, a]) => p === GOOGLE && a === client)) throw new Error(`Scope ${scopeId} doesn't list the Google client ${client} on chain: add it to the scope first`);
  const existing = deps.d1(sql`SELECT scope_id FROM hana_held_clients WHERE provider = ${GOOGLE} AND aud = ${client}`)[0]?.scope_id;
  if (existing === scopeId) return void deps.log(`${client} is already recorded as Hana-held for scope ${scopeId} in ${where}: nothing to do.`);
  if (existing !== undefined) throw new Error(`${client} is recorded as Hana-held for scope ${String(existing)} in ${where}, not ${scopeId}: check that row first (nothing was written)`);
  deps.log(`home:client:add on ${m.name}: Hana-held Google client ${client} for scope ${scopeId} in ${where} (chain checked: the scope lists it)`);
  if (!args.flag('yes')) return void deps.log(HOME_DRY_RUN_LINE);
  deps.d1(sql`INSERT INTO hana_held_clients (provider, aud, scope_id, added_at) VALUES (${GOOGLE}, ${client}, ${scopeId}, ${deps.now()})`);
  deps.log('Recorded. Hana Home shows the scope as covered by a Hana-held client while the chain lists it.');
}

/** Turns a scope's quieter listing on (--quiet) or off (--normal). */
export function homeListing(m: M, args: Args, where: string, deps: Pick<HomeCmdDeps, 'd1' | 'log'>): void {
  assertTestnet(m);
  const scopeId = assertScopeId(args.required('scope'));
  const quiet = args.flag('quiet');
  if (quiet === args.flag('normal')) throw new CliError('home:listing takes exactly one of --quiet or --normal');
  const row = deps.d1(sql`SELECT home_quiet FROM scopes WHERE scope_id = ${scopeId}`)[0];
  if (!row) throw new Error(`No scope ${scopeId} in ${where}`);
  if (Number(row.home_quiet) === Number(quiet)) return void deps.log(`Scope ${scopeId} is already ${quiet ? 'quieter' : 'normally'} listed in ${where}: nothing to do.`);
  deps.log(`home:listing on ${m.name}: scope ${scopeId} becomes ${quiet ? 'quieter (only by its whole name, its link or for its own users)' : 'normally listed'} in ${where}`);
  if (!args.flag('yes')) return void deps.log(HOME_DRY_RUN_LINE);
  deps.d1(sql`UPDATE scopes SET home_quiet = ${quiet ? 1 : 0} WHERE scope_id = ${scopeId}`);
  deps.log('Written.');
}
