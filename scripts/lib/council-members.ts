// admin.ts council:replace-member: replace one member of the owner council (a Sputnik DAO v2, D81) with another,
// keeping the policy the scripts verify (one `council` Group role of three, 2 of 3 for every kind: policyProblems).
//
// Two DAO proposals, in this order (Sputnik has no proposal kind that swaps a member):
//   1. RemoveMemberFromRole(<old>, council): the council is then 2 members, threshold min(⌊2/2⌋ + 1, 2) = 2 of 2;
//   2. AddMemberToRole(<new>, council): back to 3 members, 2 of 3.
// Removing first cuts a lost or stolen key off at once; between the two the council needs both remaining members
// (losing one more key then would leave nobody able to act, so the addition follows straight away). If members
// approve the addition first anyway (4 members, threshold 3 of 4), the removal then needs three of the four,
// the new member included; the command recognises either half-way state and carries on.
//
// Dev envs on testnet (keys in .secrets/<env>/council/): `--approve-with <member>` approves both proposals with the
// proposer and that member in the same command, so they execute. Elsewhere it only proposes (open identical
// proposals are reused) and prints what each remaining member must sign. The old member never proposes or approves.
// Once the DAO's group is the new council, `--yes` writes `council.members` in envs/<env>.json (the new member in the
// old one's place; the schema and policyProblems are checked first); without `--yes` it prints exactly that edit.
// Nothing here prints a secret key. Testnet only.
import { readFileSync, writeFileSync } from 'node:fs';
import { type Manifest, manifestPath, manifestSchema } from '@hana-id/env';
import { actionCreators } from '@near-js/transactions';
import { type Args, CliError } from './cli.ts';
import { councilKeysOnDisk, loadMemberKey, readCouncilKey } from './council.ts';
import { setCouncilMembers } from './manifest-edit.ts';
import { explorerTx, type NearRpc } from './near.ts';
import { castVote, descriptionPrefix, type OwnerTxDeps, voteCommands } from './owner-tx.ts';
import {
  ADD_PROPOSAL_GAS,
  approvers,
  councilGroup,
  type DaoProposal,
  isMemberChange,
  isOpen,
  type MemberChangeKind,
  memberChangeKind,
  policyProblems,
  recentProposals,
  type SputnikPolicy,
  votesNeeded,
} from './sputnik.ts';

const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/u;
export const COUNCIL_DRY_RUN_LINE = 'Dry run: re-run with --yes to send.';

export interface CouncilMemberDeps extends Omit<OwnerTxDeps, 'rpc'> {
  rpc: Pick<NearRpc, 'chainId' | 'view' | 'sendTx' | 'account'>;
  /** The manifest file to update (default envs/<env>.json). */
  manifestFile?: string;
}

export interface ReplaceRequest {
  remove: string;
  add: string;
  /** The proposing member (default on dev envs: the first member that isn't `remove`). */
  member?: string | undefined;
  /** Dev envs only: a second remaining member who approves in the same command. */
  approveWith?: string | undefined;
  yes: boolean;
}

/** Where the replacement stands on chain, from the DAO's group. */
export type ReplaceState = 'none' | 'removed' | 'added' | 'done';

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

/** The manifest's members with `remove` replaced by `add` in its place. */
export function replacedMembers(members: readonly string[], remove: string, add: string): string[] {
  return members.map((x) => (x === remove ? add : x));
}

/** Which half of the replacement the DAO's group shows, or null when it is none of the expected four. */
export function replaceState(group: readonly string[], members: readonly string[], remove: string, add: string): ReplaceState | null {
  const remaining = members.filter((x) => x !== remove);
  if (sameSet(group, members)) return 'none';
  if (sameSet(group, remaining)) return 'removed';
  if (sameSet(group, [...members, add])) return 'added';
  if (sameSet(group, [...remaining, add])) return 'done';
  return null;
}

/** The group each state should have: what policyProblems checks the rest of the policy against. */
function expectedGroup(state: ReplaceState, members: readonly string[], remove: string, add: string): string[] {
  const remaining = members.filter((x) => x !== remove);
  return state === 'none' ? [...members] : state === 'removed' ? remaining : state === 'added' ? [...members, add] : [...remaining, add];
}

/** Checks the request against the manifest before anything is read: members, accounts, who signs, the new manifest. */
export function checkReplaceRequest(m: Manifest, r: ReplaceRequest): { proposer: string; newMembers: string[] } {
  if (m.network !== 'testnet') throw new CliError('council:replace-member is testnet only');
  if (!m.council) throw new CliError(`envs/${m.name}.json has no council`);
  const { members } = m.council;
  if (!members.includes(r.remove)) throw new CliError(`--remove ${r.remove} is not a council member (${members.join(', ')})`);
  if (!ACCOUNT.test(r.add)) throw new CliError(`--add ${r.add} is not a valid NEAR account id`);
  if (members.includes(r.add)) throw new CliError(`--add ${r.add} is already a council member`);
  const proposer = r.member ?? (councilKeysOnDisk(m) ? members.find((x) => x !== r.remove) : undefined);
  if (!proposer) throw new CliError('--member <council member> is required (a remaining member who signs the proposals)');
  if (!members.includes(proposer)) throw new CliError(`--member ${proposer} is not a council member (${members.join(', ')})`);
  if (proposer === r.remove) throw new CliError('--member must be a remaining member, not the one being removed');
  if (r.approveWith !== undefined) {
    if (!councilKeysOnDisk(m)) throw new CliError(`--approve-with is for dev envs on testnet only (D81); on ${m.name} each member approves with their own key`);
    if (!members.includes(r.approveWith)) throw new CliError(`--approve-with ${r.approveWith} is not a council member`);
    if (r.approveWith === r.remove) throw new CliError('--approve-with must be a remaining member, not the one being removed');
    if (r.approveWith === proposer) throw new CliError('--approve-with must be a different member from the proposer');
  }
  const newMembers = replacedMembers(members, r.remove, r.add);
  const parsed = manifestSchema.safeParse({ ...m, council: { ...m.council, members: newMembers } });
  if (!parsed.success) throw new CliError(`envs/${m.name}.json would not validate with council.members ${JSON.stringify(newMembers)}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  return { proposer, newMembers };
}

/** The exact manifest edit, as one line for the plan. */
export const manifestEditLine = (m: Manifest, newMembers: readonly string[]) =>
  `envs/${m.name}.json "council": "members": ${JSON.stringify(m.council!.members)} -> ${JSON.stringify(newMembers)}`;

interface Step {
  op: 'remove' | 'add';
  account: string;
  kind: MemberChangeKind;
  description: string;
}

async function openMatch(rpc: CouncilMemberDeps['rpc'], dao: string, step: Step, prefix: string, policy: SputnikPolicy, nowMs: number): Promise<DaoProposal | null> {
  let match: DaoProposal | null = null;
  for (const p of await recentProposals(rpc, dao)) if (isOpen(p, policy, nowMs) && isMemberChange(p, step.kind, prefix)) match = p;
  return match;
}

/** The DAO's group and policy, checked: one of the four expected groups, and otherwise exactly the council policy. */
async function readCouncil(m: Manifest, dao: string, r: ReplaceRequest, rpc: CouncilMemberDeps['rpc']): Promise<{ policy: SputnikPolicy; group: string[]; state: ReplaceState; role: string }> {
  const policy = await rpc.view<SputnikPolicy>(dao, 'get_policy');
  const group = councilGroup(policy);
  const members = m.council!.members;
  const state = group ? replaceState(group, members, r.remove, r.add) : null;
  if (!group || !state) {
    throw new Error(`The council DAO ${dao} has members ${group ? group.join(', ') : '(not a Group)'}: not the manifest's (${members.join(', ')}) nor a half-done replacement of ${r.remove} by ${r.add}. Check owner:proposals and governance:status first.`);
  }
  const problems = policyProblems(policy, expectedGroup(state, members, r.remove, r.add)).blockers;
  if (problems.length) throw new Error(`The council DAO ${dao}'s policy is not the council policy: ${problems.join('; ')}`);
  return { policy, group, state, role: policy.roles[0]!.name };
}

function hasCouncilKeyFile(env: string, account: string, secretsRoot: string | undefined): boolean {
  try {
    return readCouncilKey(env, account, secretsRoot) !== null;
  } catch {
    return false;
  }
}

export async function councilReplaceMember(m: Manifest, r: ReplaceRequest, deps: CouncilMemberDeps): Promise<{ state: ReplaceState; proposals: number[]; manifestUpdated: boolean }> {
  const { proposer, newMembers } = checkReplaceRequest(m, r);
  const council = m.council!;
  const dao = m.ownerKind === 'sputnik' ? m.owner : council.dao;
  const { rpc, log } = deps;
  const file = deps.manifestFile ?? manifestPath(m.name);
  const nowMs = deps.now?.() ?? Date.now();
  const prefix = descriptionPrefix(m);

  if (!(await rpc.account(dao))) throw new Error(`The council DAO ${dao} does not exist`);
  if (!(await rpc.account(r.add))) throw new Error(`${r.add} does not exist on ${m.network}: the new member creates and funds their account first (a Ledger key on mainnet)`);
  let { policy, state, role } = await readCouncil(m, dao, r, rpc);

  const votes = r.approveWith ? `approved by ${proposer} and ${r.approveWith} in the same run` : 'then the remaining members approve';
  log(`Replace council member ${r.remove} with ${r.add} on ${dao} (role "${role}"; 2 of 3 for every kind before and after):`);
  const steps: Step[] = [];
  if (state === 'none' || state === 'added') steps.push({ op: 'remove', account: r.remove, kind: memberChangeKind('remove', r.remove, role), description: `${prefix}RemoveMemberFromRole(${r.remove}, ${role}) on ${dao}, replaced by ${r.add}` });
  if (state === 'none' || state === 'removed') steps.push({ op: 'add', account: r.add, kind: memberChangeKind('add', r.add, role), description: `${prefix}AddMemberToRole(${r.add}, ${role}) on ${dao}, replacing ${r.remove}` });
  if (state !== 'none') log(`  on chain already: ${state === 'removed' ? `${r.remove} removed` : state === 'added' ? `${r.add} added` : 'both changes executed'}`);
  for (const [i, s] of steps.entries()) log(`  ${i + 1}. ${s.op === 'remove' ? `RemoveMemberFromRole(${r.remove})` : `AddMemberToRole(${r.add})`} [DAO proposal by ${proposer}, ${votes}]`);
  if (steps.length === 2) log('  The removal goes first: until the addition executes the council is 2 of 2 (both remaining members must approve it).');
  log(`  then ${manifestEditLine(m, newMembers)}`);
  log("  Each executed change raises the watchdog's critical governance_change (owner_policy): expected, acknowledge it.");
  if (councilKeysOnDisk(m) && !hasCouncilKeyFile(m.name, r.add, deps.secretsRoot)) {
    log(`  Note: no .secrets/${m.name}/council/${r.add}.json: the scripts can't sign as ${r.add} on this dev env until it exists.`);
  }
  if (!r.yes) {
    log(COUNCIL_DRY_RUN_LINE);
    return { state, proposals: [], manifestUpdated: false };
  }
  if ((await rpc.chainId()) !== 'testnet') throw new Error(`${m.rpc} is not a testnet RPC`);

  const proposals: number[] = [];
  for (const step of steps) {
    let p = await openMatch(rpc, dao, step, prefix, policy, nowMs);
    let id: number;
    if (p) {
      id = p.id;
      log(`  proposal #${id} (${step.op} ${step.account}) is already open (approved by ${approvers(p).join(', ') || 'nobody yet'}); not proposing it again`);
    } else {
      const key = loadMemberKey(m, proposer, deps);
      const { hash, value } = await rpc.sendTx({ accountId: key.accountId, keyPair: key.keyPair }, dao, [
        actionCreators.functionCall('add_proposal', { proposal: { description: step.description, kind: step.kind } }, ADD_PROPOSAL_GAS, BigInt(policy.proposal_bond)),
      ]);
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`add_proposal returned ${JSON.stringify(value)}, not a proposal id (tx ${hash})`);
      id = value;
      log(`  proposed #${id} (${step.op} ${step.account}) by ${proposer} (bond ${policy.proposal_bond} yocto, refunded on approval): ${explorerTx(hash)}`);
      p = { id, proposer, description: step.description, kind: step.kind, status: 'InProgress', votes: {}, submission_time: '0' };
    }
    proposals.push(id);
    if (!r.approveWith) continue;
    let status = p.status;
    for (const voter of [proposer, r.approveWith]) {
      if (p.votes?.[voter]) continue;
      status = await castVote(m, dao, id, voter, 'VoteApprove', deps);
      if (status !== 'InProgress') break;
    }
    if (status === 'InProgress' && state === 'added') {
      throw new Error(`Proposal #${id} (remove ${r.remove}) needs a third approval: the council has 4 members now (threshold 3 of 4), so ${r.add} approves it too (near CLI act_proposal VoteApprove), then re-run this command`);
    }
    if (status !== 'Approved') throw new Error(`Proposal #${id} (${step.op} ${step.account}) is ${status} after both approvals (expected Approved)`);
    log(`  #${id} approved and executed: ${step.op === 'remove' ? `${r.remove} removed` : `${r.add} added`}`);
    ({ policy, state } = await readCouncil(m, dao, r, rpc));
  }

  if (!r.approveWith && steps.length) {
    const group = councilGroup(policy) ?? [];
    const needed = votesNeeded(policy.default_vote_policy.threshold, group.length);
    for (const id of proposals) {
      const p = await rpc.view<DaoProposal>(dao, 'get_proposal', { id });
      const pending = group.filter((x) => x !== r.remove && !p.votes?.[x]);
      log(`  #${id} needs ${needed} approvals of the current ${group.length} members (proposing is not a vote; ${r.remove} must not vote); approved so far: ${approvers(p).join(', ') || 'nobody'}. Approving members run one of:`);
      for (const line of voteCommands(m, dao, id, pending)) log(line);
    }
    log(`  Approve #${proposals[0]} first${proposals.length > 1 ? `, then #${proposals[1]}` : ''}. Once both executed, re-run this command with --yes: it checks the DAO and writes ${manifestEditLine(m, newMembers)}.`);
  }

  if (state !== 'done') return { state, proposals, manifestUpdated: false };
  const final = policyProblems(policy, newMembers).blockers;
  if (final.length) throw new Error(`The council DAO ${dao} has the new members but not the council policy: ${final.join('; ')}`);
  writeFileSync(file, setCouncilMembers(readFileSync(file, 'utf8'), newMembers));
  log(`  Updated ${manifestEditLine(m, newMembers)}. Commit it (code-owner review); governance:status should now report no findings.`);
  return { state, proposals, manifestUpdated: true };
}

/** The admin CLI entry: flags → request. */
export async function councilReplaceMemberCmd(m: Manifest, args: Args, deps: CouncilMemberDeps): Promise<void> {
  await councilReplaceMember(m, { remove: args.required('remove'), add: args.required('add'), member: args.str('member'), approveWith: args.str('approve-with'), yes: args.flag('yes') }, deps);
}
