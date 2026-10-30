// Sputnik DAO v2: the owner council (docs/governance-spec.md "Owner = multisig", D81). Everything here follows the
// pinned DAO code (contracts/sputnik/pin.json, near-daos/sputnik-dao-contract at that commit) and the policy the
// sandbox tests check (contracts/sputnik/policy.json): the scripts read those files rather than build their own.
//
// Interface used, as in that commit (sputnikdao2/src/proposals.rs, views.rs, sputnikdao-factory2/src/lib.rs):
// - factory `create(name, args: base64(JSON {config, policy}))`, payable: creates `<name>.<factory>`, deploys the
//   factory's default code and calls `new(config, policy)`; the deposit must cover (code bytes + 32) × storage cost
//   (`ERR_NOT_ENOUGH_DEPOSIT`), is moved to the DAO, and is refunded to the caller if `new` fails. `get_default_code_hash`.
// - DAO `add_proposal({proposal: {description, kind}})` with the policy's `proposal_bond` attached (`ERR_MIN_BOND`,
//   `ERR_PERMISSION_DENIED`); returns the id. The proposer's call is not a vote.
// - DAO `act_proposal(id, action: "VoteApprove" | "VoteReject" | …, memo)`; the vote that reaches the threshold
//   executes the proposal in the same call (`FunctionCall` → status `Approved`, or `Failed` if the call panicked) and
//   refunds the bond; reject votes reaching it make it `Rejected` (bond refunded too). Each member votes once
//   (`ERR_ALREADY_VOTED`). The threshold is recomputed from the group's size at every vote (`proposal_status`).
// - `AddMemberToRole {member_id, role}` / `RemoveMemberFromRole {member_id, role}` proposals change the role's Group.
// - views `get_policy`, `get_last_proposal_id` (the number of proposals = next id), `get_proposals(from_index, limit)`,
//   `get_proposal(id)` → `{id, proposer, description, kind, status, vote_counts, votes, submission_time}`.
// - Threshold `Ratio(a, b)` on a group of n: min(⌊a·n/b⌋ + 1, n) votes (policy.rs `to_weight`): [1, 2] on 3 → 2.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '@hana-id/env';
import type { NearRpc } from './near.ts';
import { STORAGE_YOCTO_PER_BYTE, TGAS } from './near.ts';

export const SPUTNIK_DIR = join(repoRoot, 'contracts', 'sputnik');

export interface SputnikPin {
  repo: string;
  commit: string;
  url: string;
  version: [number, number];
  sha256: string;
  /** NEAR account `code_hash` of the wasm (base58 sha256): the factory's `get_default_code_hash` must equal it. */
  code_hash: string;
  /** Size of the wasm, for the factory deposit. */
  bytes: number;
}

export interface VotePolicy {
  weight_kind: string;
  quorum: string;
  threshold: [number, number] | string;
}

export interface SputnikRole {
  name: string;
  kind: { Group: string[] } | string | Record<string, unknown>;
  permissions: string[];
  vote_policy: Record<string, VotePolicy>;
}

export interface SputnikPolicy {
  roles: SputnikRole[];
  default_vote_policy: VotePolicy;
  proposal_bond: string;
  proposal_period: string;
  bounty_bond: string;
  bounty_forgiveness_period: string;
}

export function readPin(dir: string = SPUTNIK_DIR): SputnikPin {
  const pin = JSON.parse(readFileSync(join(dir, 'pin.json'), 'utf8')) as SputnikPin;
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/u.test(pin.code_hash) || !Number.isInteger(pin.bytes) || pin.bytes <= 0) throw new Error(`${dir}/pin.json: bad code_hash or bytes`);
  return pin;
}

export function readPolicyTemplate(dir: string = SPUTNIK_DIR): SputnikPolicy {
  const { about: _about, ...policy } = JSON.parse(readFileSync(join(dir, 'policy.json'), 'utf8')) as SputnikPolicy & { about?: unknown };
  return policy;
}

/** contracts/sputnik/policy.json with `members` as the council (the same substitution the sandbox tests make). */
export function councilPolicy(members: readonly string[], template: SputnikPolicy = readPolicyTemplate()): SputnikPolicy {
  if (template.roles.length !== 1 || typeof template.roles[0]?.kind !== 'object' || !('Group' in (template.roles[0].kind as object))) {
    throw new Error('contracts/sputnik/policy.json must have exactly one Group role (the council)');
  }
  const [role] = template.roles as [SputnikRole];
  return { ...template, roles: [{ ...role, kind: { Group: [...members] } }] };
}

/** The deposit the factory refuses below: (code bytes + 32) × storage cost (factory_manager.rs `create_contract`). */
export function factoryMinDeposit(pin: SputnikPin): bigint {
  return BigInt(pin.bytes + 32) * STORAGE_YOCTO_PER_BYTE;
}

/** What council-setup attaches to `create`: the code's storage plus 0.5 NEAR for the DAO's own state and gas. */
export function daoCreateDeposit(pin: SputnikPin): bigint {
  const min = factoryMinDeposit(pin) + 5n * 10n ** 23n;
  const near = 10n ** 24n;
  return ((min + near - 1n) / near) * near; // whole NEAR, rounded up (6 NEAR for the pinned 539,647-byte wasm)
}

export const FACTORY_CREATE_GAS = 300n * TGAS;
export const ADD_PROPOSAL_GAS = 100n * TGAS;
/** The vote that reaches the threshold runs the proposal's call: room for it plus the DAO's callback. */
export const VOTE_GAS = 300n * TGAS;
/** Gas the DAO attaches to the hana-signer call inside a `FunctionCall` proposal. */
export const PROPOSAL_CALL_GAS = 100n * TGAS;

export interface Council {
  factory: string;
  dao: string;
  members: string[];
}

/** The `name` argument of factory `create`: the DAO account without `.<factory>`. */
export function daoName(council: Council): string {
  const suffix = `.${council.factory}`;
  if (!council.dao.endsWith(suffix)) throw new Error(`${council.dao} is not an account of the factory ${council.factory}`);
  return council.dao.slice(0, -suffix.length);
}

/** DAO `new` arguments: config plus the council policy. */
export function daoInitArgs(council: Council, purpose: string, template?: SputnikPolicy) {
  return { config: { name: daoName(council), purpose, metadata: '' }, policy: councilPolicy(council.members, template) };
}

/** Factory `create` arguments. */
export function factoryCreateArgs(council: Council, purpose: string, template?: SputnikPolicy) {
  return { name: daoName(council), args: Buffer.from(JSON.stringify(daoInitArgs(council, purpose, template))).toString('base64') };
}

export interface FunctionCallKind {
  FunctionCall: { receiver_id: string; actions: { method_name: string; args: string; deposit: string; gas: string }[] };
}

/** A `FunctionCall` proposal kind: one call to `receiver` with JSON `args`, no deposit. */
export function functionCallKind(receiver: string, method: string, args: object, gas: bigint = PROPOSAL_CALL_GAS): FunctionCallKind {
  return { FunctionCall: { receiver_id: receiver, actions: [{ method_name: method, args: Buffer.from(JSON.stringify(args)).toString('base64'), deposit: '0', gas: gas.toString() }] } };
}

export interface DaoProposal {
  id: number;
  proposer: string;
  description: string;
  kind: unknown;
  status: string;
  votes: Record<string, string>;
  submission_time: string;
}

export interface DecodedCall {
  receiver: string;
  method: string;
  /** Parsed JSON args, or the raw base64 if they aren't JSON. */
  args: unknown;
  argsBase64: string;
}

/** The calls of a `FunctionCall` proposal, or null for any other kind. */
export function decodeFunctionCall(kind: unknown): DecodedCall[] | null {
  const fc = (kind as Partial<FunctionCallKind> | null)?.FunctionCall;
  if (!fc || !Array.isArray(fc.actions)) return null;
  return fc.actions.map((a) => {
    let args: unknown = a.args;
    try {
      args = JSON.parse(Buffer.from(a.args, 'base64').toString('utf8')) as unknown;
    } catch {
      // keep base64
    }
    return { receiver: fc.receiver_id, method: a.method_name, args, argsBase64: a.args };
  });
}

/** Canonical JSON (sorted keys) for comparing call arguments. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** True if the proposal is exactly one call of `method` on `receiver` with these args. */
export function isCall(p: DaoProposal, receiver: string, method: string, args: object): boolean {
  const calls = decodeFunctionCall(p.kind);
  return !!calls && calls.length === 1 && calls[0]!.receiver === receiver && calls[0]!.method === method && canonical(calls[0]!.args) === canonical(args);
}

/** The full call a proposal is expected to carry: `functionCallKind(receiver, method, args, gas)` with `deposit`. */
export interface ExpectedCall {
  receiver: string;
  method: string;
  args: object;
  /** yoctoNEAR (the owner calls attach none). */
  deposit: bigint;
  gas: bigint;
  /** The description must start with this (the scripts' own `hana-id <env>: ` prefix). */
  descriptionPrefix: string;
}

/**
 * How a proposal differs from `want`: null when it isn't a single `FunctionCall` of `want.method` on `want.receiver`
 * (not a candidate at all); otherwise the fields that differ among args, deposit, gas and description (empty: an
 * exact match that may be reused). A proposal that differs in any of them executes something else than asked
 * (another argument, gas too small for the call, a deposit), so it is never reused.
 */
export function callDifferences(p: DaoProposal, want: ExpectedCall): ('args' | 'deposit' | 'gas' | 'description')[] | null {
  const fc = (p.kind as Partial<FunctionCallKind> | null)?.FunctionCall;
  const calls = decodeFunctionCall(p.kind);
  if (!fc || !calls || calls.length !== 1 || calls[0]!.receiver !== want.receiver || calls[0]!.method !== want.method) return null;
  const action = fc.actions[0]!;
  const asBigInt = (v: unknown): bigint | null => {
    try {
      return typeof v === 'string' && /^\d+$/u.test(v) ? BigInt(v) : null;
    } catch {
      return null;
    }
  };
  const diffs: ('args' | 'deposit' | 'gas' | 'description')[] = [];
  if (canonical(calls[0]!.args) !== canonical(want.args)) diffs.push('args');
  if (asBigInt(action.deposit) !== want.deposit) diffs.push('deposit');
  if (asBigInt(action.gas) !== want.gas) diffs.push('gas');
  if (typeof p.description !== 'string' || !p.description.startsWith(want.descriptionPrefix)) diffs.push('description');
  return diffs;
}

/**
 * A council membership change (sputnikdao2 proposals.rs `ProposalKind::AddMemberToRole` / `RemoveMemberFromRole`):
 * executing it adds or removes `member_id` in the role's `Group` (policy.rs; a missing role only logs
 * `ERR_ROLE_NOT_FOUND`, adding a present member or removing an absent one is a no-op).
 */
export type MemberChangeKind = { AddMemberToRole: { member_id: string; role: string } } | { RemoveMemberFromRole: { member_id: string; role: string } };

export function memberChangeKind(op: 'add' | 'remove', member: string, role: string): MemberChangeKind {
  return op === 'add' ? { AddMemberToRole: { member_id: member, role } } : { RemoveMemberFromRole: { member_id: member, role } };
}

/** A proposal's membership change, or null for any other kind. */
export function decodeMemberChange(kind: unknown): { op: 'add' | 'remove'; member: string; role: string } | null {
  if (!kind || typeof kind !== 'object') return null;
  const k = kind as { AddMemberToRole?: { member_id?: unknown; role?: unknown }; RemoveMemberFromRole?: { member_id?: unknown; role?: unknown } };
  const body = k.AddMemberToRole ?? k.RemoveMemberFromRole;
  if (!body || typeof body.member_id !== 'string' || typeof body.role !== 'string' || Object.keys(kind).length !== 1) return null;
  return { op: k.AddMemberToRole ? 'add' : 'remove', member: body.member_id, role: body.role };
}

/** True if the proposal is exactly this membership change, and its description starts with `descriptionPrefix`. */
export function isMemberChange(p: DaoProposal, want: MemberChangeKind, descriptionPrefix: string): boolean {
  return canonical(p.kind) === canonical(want) && typeof p.description === 'string' && p.description.startsWith(descriptionPrefix);
}

/** The council role's members (the policy's first role's `Group`), or null when it isn't a Group. */
export function councilGroup(policy: SputnikPolicy): string[] | null {
  const kind = policy.roles?.[0]?.kind;
  return kind && typeof kind === 'object' && Array.isArray((kind as { Group?: unknown }).Group) ? [...(kind as { Group: string[] }).Group] : null;
}

/** Members who voted to approve. */
export const approvers = (p: DaoProposal): string[] => Object.entries(p.votes ?? {}).filter(([, v]) => v === 'Approve').map(([a]) => a);

/** Still open for votes: InProgress and not past the proposal period. */
export function isOpen(p: DaoProposal, policy: Pick<SputnikPolicy, 'proposal_period'>, nowMs: number): boolean {
  if (p.status !== 'InProgress') return false;
  const endNs = BigInt(p.submission_time) + BigInt(policy.proposal_period);
  return BigInt(nowMs) * 1_000_000n < endNs;
}

/** Votes a `Ratio` threshold needs on a group of `n` (policy.rs `to_weight`). */
export function votesNeeded(threshold: VotePolicy['threshold'], n: number): number {
  if (!Array.isArray(threshold)) throw new Error(`Unsupported threshold ${JSON.stringify(threshold)} (expected a ratio)`);
  const [a, b] = threshold;
  return Math.min(Math.floor((a * n) / b) + 1, n);
}

const sortedGroup = (role: SputnikRole | undefined): string[] | null => {
  const kind = role?.kind;
  return kind && typeof kind === 'object' && Array.isArray((kind as { Group?: unknown }).Group) ? [...((kind as { Group: string[] }).Group)].sort() : null;
};

/**
 * Compares a DAO's `get_policy` with the council policy for `members`. Blockers: anything that changes who can act
 * or how many votes it takes (roles, permissions, members, vote policies). Warnings: bond and period (a later
 * `ChangePolicy` may legitimately change them).
 */
export function policyProblems(onChain: SputnikPolicy, members: readonly string[], template: SputnikPolicy = readPolicyTemplate()): { blockers: string[]; warnings: string[] } {
  const want = councilPolicy(members, template);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (onChain.roles?.length !== 1) blockers.push(`the policy has ${onChain.roles?.length ?? 0} roles; the council policy has exactly one (no Everyone role)`);
  const role = onChain.roles?.[0];
  const wantRole = want.roles[0]!;
  if (role) {
    if (role.name !== wantRole.name) blockers.push(`the role is "${role.name}", not "${wantRole.name}"`);
    const group = sortedGroup(role);
    if (!group || canonical(group) !== canonical([...members].sort())) blockers.push(`the council is ${group ? group.join(', ') : 'not a Group'}; the manifest says ${[...members].sort().join(', ')}`);
    if (canonical([...role.permissions].sort()) !== canonical([...wantRole.permissions].sort())) blockers.push(`council permissions are ${role.permissions.join(', ')}; expected ${wantRole.permissions.join(', ')}`);
    if (canonical(role.vote_policy) !== canonical(wantRole.vote_policy)) blockers.push(`the council has per-kind vote policies ${JSON.stringify(role.vote_policy)}; every kind must use the default 2-of-3`);
  }
  if (canonical(onChain.default_vote_policy) !== canonical(want.default_vote_policy)) blockers.push(`default_vote_policy is ${JSON.stringify(onChain.default_vote_policy)}; expected ${JSON.stringify(want.default_vote_policy)}`);
  for (const k of ['proposal_bond', 'proposal_period'] as const) if (onChain[k] !== want[k]) warnings.push(`${k} is ${onChain[k]}, contracts/sputnik/policy.json says ${want[k]}`);
  return { blockers, warnings };
}

export type DaoRpc = Pick<NearRpc, 'view'>;

/** The last `limit` proposals, newest last. */
export async function recentProposals(rpc: DaoRpc, dao: string, limit = 50): Promise<DaoProposal[]> {
  const count = await rpc.view<number>(dao, 'get_last_proposal_id');
  const from = Math.max(0, count - limit);
  return rpc.view<DaoProposal[]>(dao, 'get_proposals', { from_index: from, limit });
}
