// Owner calls on hana-signer through the manifest's owner (docs/governance-spec.md "How owner actions work through
// it"). Two backends, by `ownerKind`:
// - `account`: the owner's full-access key from ~/.near-credentials signs the call directly (local envs, tests, and
//   sandbox-dev until the DAO accepts ownership).
// - `sputnik`: a `FunctionCall` proposal to the council DAO, signed by one member (`--member`). It executes when the
//   second approval lands. With `--approve-with <member>` (dev envs on testnet only, keys in .secrets, D81) the
//   proposer and that member approve in the same command; otherwise the command prints what the members must sign.
// `accept_owner` is always sent through the council: the account accepting is the proposed owner, the DAO.
// An open proposal for exactly the same call (receiver, method, args, deposit, gas, and the scripts' description
// prefix) is reused, never duplicated, so re-running a command (or deploy-contract) is safe. One that differs in
// deposit, gas or description is never reused: a new proposal is made and the difference is printed. Nothing here
// prints a secret key.
import type { Manifest } from '@hana-id/env';
import { actionCreators } from '@near-js/transactions';
import { CliError } from './cli.ts';
import { OWNER_METHODS, type OwnerMethod, SCOPE_OWNER_CALLS, type ScopeOwnerCall } from './contract.ts';
import { councilKeysOnDisk, loadMemberKey } from './council.ts';
import { loadLegacyCredential } from './keys.ts';
import { explorerTx, type NearRpc, TGAS } from './near.ts';
import {
  ADD_PROPOSAL_GAS,
  approvers,
  callDifferences,
  type DaoProposal,
  functionCallKind,
  isOpen,
  PROPOSAL_CALL_GAS,
  recentProposals,
  type SputnikPolicy,
  VOTE_GAS,
  votesNeeded,
} from './sputnik.ts';

export type OwnerTxRpc = Pick<NearRpc, 'view' | 'sendTx'>;

export interface OwnerTxDeps {
  rpc: OwnerTxRpc;
  log: (line: string) => void;
  /** Home directory holding ~/.near-credentials. */
  home?: string | undefined;
  /** Directory holding .secrets/. */
  secretsRoot?: string | undefined;
  now?: () => number;
}

export interface OwnerCall {
  method: OwnerMethod | ScopeOwnerCall;
  args: object;
  /** Gas for the hana-signer call (default 100 Tgas). */
  gas?: bigint;
}

export interface OwnerTxOptions {
  /** The council member who proposes (default on dev envs: the first member). */
  member?: string | undefined;
  /** Dev envs only: a second member who approves in the same command. */
  approveWith?: string | undefined;
}

export type OwnerRoute = { kind: 'account'; account: string } | { kind: 'sputnik'; dao: string };

export type OwnerTxResult =
  | { kind: 'executed'; hash: string; value: unknown }
  | { kind: 'approved'; proposalId: number }
  | { kind: 'proposed'; proposalId: number; approvals: string[]; needed: number };

export function isOwnerMethod(method: string): method is OwnerMethod {
  return (OWNER_METHODS as readonly string[]).includes(method);
}

/** Who sends the call: the owner account, or the council DAO (the owner, or for accept_owner the proposed owner). */
export function ownerRoute(m: Manifest, method: OwnerMethod | ScopeOwnerCall): OwnerRoute {
  if (method === 'accept_owner') {
    if (!m.council) throw new CliError(`accept_owner is sent by the proposed owner, the council DAO, but envs/${m.name}.json has no council`);
    return { kind: 'sputnik', dao: m.council.dao };
  }
  if (m.ownerKind === 'sputnik') return { kind: 'sputnik', dao: m.owner };
  return { kind: 'account', account: m.owner };
}

/** The proposing member: --member, or on a dev env the first council member. */
export function proposingMember(m: Manifest, opts: OwnerTxOptions): string {
  if (!m.council) throw new CliError(`envs/${m.name}.json has no council`);
  const member = opts.member ?? (councilKeysOnDisk(m) ? m.council.members[0] : undefined);
  if (!member) throw new CliError('--member <council member> is required (the member who signs the proposal)');
  if (!m.council.members.includes(member)) throw new CliError(`--member ${member} is not a council member (${m.council.members.join(', ')})`);
  return member;
}

/** Refuses options that don't fit the route: --approve-with only on a dev env on testnet, never the proposer twice. */
export function checkOwnerTxOptions(m: Manifest, route: OwnerRoute, opts: OwnerTxOptions): void {
  if (route.kind === 'account') {
    if (opts.member || opts.approveWith) throw new CliError(`--member/--approve-with are for a council owner; envs/${m.name}.json has ownerKind "account" (${m.owner} signs)`);
    return;
  }
  const member = proposingMember(m, opts);
  if (opts.approveWith === undefined) return;
  if (!councilKeysOnDisk(m)) throw new CliError(`--approve-with is for dev envs on testnet only (D81); on ${m.name} each member approves with their own key`);
  if (!m.council!.members.includes(opts.approveWith)) throw new CliError(`--approve-with ${opts.approveWith} is not a council member`);
  if (opts.approveWith === member) throw new CliError('--approve-with must be a different member from the proposer');
}

const callText = (call: OwnerCall) => `${call.method}(${JSON.stringify(call.args)})`;

/** One line for plans: what will be sent, and by whom. */
export function describeOwnerCall(m: Manifest, call: OwnerCall, opts: OwnerTxOptions = {}): string {
  const route = ownerRoute(m, call.method);
  if (route.kind === 'account') return `${callText(call)} [signed by ${route.account}]`;
  let member: string;
  try {
    member = proposingMember(m, opts);
  } catch {
    member = '<--member>';
  }
  const votes = opts.approveWith ? `approved by ${member} and ${opts.approveWith} in the same run` : 'then 2 of 3 council approvals';
  return `${callText(call)} [DAO proposal on ${route.dao} by ${member}, ${votes}]`;
}

/** A council vote the scripts cast (sputnikdao2 `Action`). */
export type VoteAction = 'VoteApprove' | 'VoteReject';

/** What each of `pending` runs to cast `action` on proposal `id`: the admin CLI on dev envs, else near CLI with a Ledger. */
export function voteCommands(m: Manifest, dao: string, id: number, pending: string[], action: VoteAction = 'VoteApprove'): string[] {
  const reject = action === 'VoteReject' ? ' --reject' : '';
  if (councilKeysOnDisk(m)) return pending.map((a) => `    pnpm --filter @hana-id/scripts run admin ${m.name} owner:vote ${id} --member ${a}${reject} --yes`);
  const args = JSON.stringify({ id, action, memo: null });
  return pending.map(
    (a) => `    near contract call-function as-transaction ${dao} act_proposal json-args '${args}' prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as ${a} network-config ${m.network} sign-with-ledger send`,
  );
}

async function councilSize(rpc: OwnerTxRpc, dao: string): Promise<{ policy: SputnikPolicy; needed: number }> {
  const policy = await rpc.view<SputnikPolicy>(dao, 'get_policy');
  const group = policy.roles?.[0]?.kind as { Group?: string[] } | undefined;
  const n = Array.isArray(group?.Group) ? group.Group.length : 0;
  if (!n) throw new Error(`${dao} has no council group in its policy`);
  return { policy, needed: votesNeeded(policy.default_vote_policy.threshold, n) };
}

/** What every proposal of the scripts for `m` starts its description with. */
export const descriptionPrefix = (m: Pick<Manifest, 'name'>) => `hana-id ${m.name}: `;

export interface OpenProposalMatch {
  /** The newest open proposal for exactly this call (receiver, method, args, deposit 0, gas, description prefix). */
  match: DaoProposal | null;
  /** Open proposals for the same method and args that differ in deposit, gas or description: never reused. */
  mismatched: { proposal: DaoProposal; differs: string[] }[];
}

/** Open proposals on `dao` for this call: an exact match to reuse, and near misses to warn about. */
export async function findOpenProposal(
  rpc: OwnerTxRpc,
  dao: string,
  m: Pick<Manifest, 'name' | 'signer'>,
  call: OwnerCall,
  policy: SputnikPolicy,
  nowMs: number,
): Promise<OpenProposalMatch> {
  const want = { receiver: m.signer, method: call.method, args: call.args, deposit: 0n, gas: call.gas ?? PROPOSAL_CALL_GAS, descriptionPrefix: descriptionPrefix(m) };
  let match: DaoProposal | null = null;
  const mismatched: OpenProposalMatch['mismatched'] = [];
  for (const p of await recentProposals(rpc, dao)) {
    if (!isOpen(p, policy, nowMs)) continue;
    const differs = callDifferences(p, want);
    if (differs === null || differs.includes('args')) continue; // another call altogether
    if (differs.length === 0) match = p;
    else mismatched.push({ proposal: p, differs });
  }
  return { match, mismatched };
}

/** One vote by `member` on proposal `id` (key per `loadMemberKey`); returns the proposal's status afterwards. */
export async function castVote(m: Manifest, dao: string, id: number, member: string, action: VoteAction, deps: OwnerTxDeps): Promise<string> {
  const key = loadMemberKey(m, member, deps);
  const { hash } = await deps.rpc.sendTx({ accountId: key.accountId, keyPair: key.keyPair }, dao, [
    actionCreators.functionCall('act_proposal', { id, action, memo: null }, VOTE_GAS, 0n),
  ]);
  deps.log(`    ${member} ${action === 'VoteApprove' ? 'approved' : 'rejected'} #${id}: ${explorerTx(hash)}`);
  const p = await deps.rpc.view<DaoProposal>(dao, 'get_proposal', { id });
  return p.status;
}

/** One VoteApprove by `member` on proposal `id`; returns the proposal's status afterwards. */
export async function voteApprove(m: Manifest, dao: string, id: number, member: string, deps: OwnerTxDeps): Promise<string> {
  return castVote(m, dao, id, member, 'VoteApprove', deps);
}

/** Sends (account) or proposes and, with approveWith, approves (sputnik) one owner call. */
export async function sendOwnerCall(m: Manifest, call: OwnerCall, opts: OwnerTxOptions, deps: OwnerTxDeps): Promise<OwnerTxResult> {
  if (!isOwnerMethod(call.method) && !(SCOPE_OWNER_CALLS as readonly string[]).includes(call.method)) throw new CliError(`${call.method as string} is not an owner method of hana-signer`);
  const route = ownerRoute(m, call.method);
  checkOwnerTxOptions(m, route, opts);
  const gas = call.gas ?? PROPOSAL_CALL_GAS;
  if (gas <= 0n || gas > 250n * TGAS) throw new CliError('The call gas must be between 1 and 250 Tgas (the DAO needs the rest of the vote)');
  const { rpc, log } = deps;

  if (route.kind === 'account') {
    const owner = loadLegacyCredential(route.account, m.network, deps.home);
    const { hash, value } = await rpc.sendTx({ accountId: owner.accountId, keyPair: owner.keyPair }, m.signer, [actionCreators.functionCall(call.method, call.args, gas, 0n)]);
    log(`    tx ${explorerTx(hash)}`);
    return { kind: 'executed', hash, value };
  }

  const dao = route.dao;
  const member = proposingMember(m, opts);
  const { policy, needed } = await councilSize(rpc, dao);
  const nowMs = deps.now?.() ?? Date.now();
  const found = await findOpenProposal(rpc, dao, m, call, policy, nowMs);
  let proposal = found.match;
  let id: number;
  if (!proposal) {
    for (const { proposal: p, differs } of found.mismatched) {
      log(`    WARNING: open proposal #${p.id} on ${dao} is ${call.method} with these args but a different ${differs.join(', ')}; not reusing it (a new proposal follows). Reject or let it expire if it isn't wanted.`);
    }
  }
  if (proposal) {
    id = proposal.id;
    log(`    proposal #${id} on ${dao} for this call is already open (approved by ${approvers(proposal).join(', ') || 'nobody yet'}); not proposing it again`);
  } else {
    const key = loadMemberKey(m, member, deps);
    const description = `${descriptionPrefix(m)}${callText(call)} on ${m.signer}`;
    const { hash, value } = await rpc.sendTx({ accountId: key.accountId, keyPair: key.keyPair }, dao, [
      actionCreators.functionCall('add_proposal', { proposal: { description, kind: functionCallKind(m.signer, call.method, call.args, gas) } }, ADD_PROPOSAL_GAS, BigInt(policy.proposal_bond)),
    ]);
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`add_proposal returned ${JSON.stringify(value)}, not a proposal id (tx ${hash})`);
    id = value;
    log(`    proposed #${id} on ${dao} by ${member} (bond ${policy.proposal_bond} yocto, refunded on approval): ${explorerTx(hash)}`);
    proposal = { id, proposer: member, description, kind: null, status: 'InProgress', votes: {}, submission_time: '0' };
  }

  if (opts.approveWith) {
    let status = proposal.status;
    for (const voter of [member, opts.approveWith]) {
      if (approvers(proposal).includes(voter)) continue;
      status = await voteApprove(m, dao, id, voter, deps);
      if (status !== 'InProgress') break;
    }
    if (status === 'Approved') {
      log(`    #${id} approved and executed: ${callText(call)}`);
      return { kind: 'approved', proposalId: id };
    }
    if (status === 'Failed') throw new Error(`Proposal #${id} was approved but the call ${call.method} on ${m.signer} failed (the contract refused it); see the vote transaction`);
    throw new Error(`Proposal #${id} is ${status} after both approvals (expected Approved)`);
  }

  const have = approvers(proposal);
  const pending = m.council!.members.filter((a) => !have.includes(a));
  log(`    #${id} needs ${needed} council approvals (proposing is not a vote); approved so far: ${have.join(', ') || 'nobody'}. Approving members run one of:`);
  for (const line of voteCommands(m, dao, id, pending)) log(line);
  return { kind: 'proposed', proposalId: id, approvals: have, needed };
}
