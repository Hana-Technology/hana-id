// The council DAO encoding the scripts send (D81): the policy is contracts/sputnik/policy.json with the members filled
// in (the same JSON contracts/integration-tests checks in sandbox), the threshold arithmetic, proposal decoding.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '@hana-id/env';
import { STORAGE_YOCTO_PER_BYTE, TGAS } from '../lib/near.ts';
import {
  approvers,
  councilPolicy,
  daoCreateDeposit,
  daoInitArgs,
  daoName,
  type DaoProposal,
  decodeFunctionCall,
  factoryCreateArgs,
  factoryMinDeposit,
  functionCallKind,
  isCall,
  isOpen,
  policyProblems,
  readPin,
  readPolicyTemplate,
  votesNeeded,
} from '../lib/sputnik.ts';

const council = { factory: 'sputnikv2.testnet', dao: 'hana-council.sputnikv2.testnet', members: ['a.testnet', 'b.testnet', 'c.testnet'] };
const policyFile = () => JSON.parse(readFileSync(join(repoRoot, 'contracts', 'sputnik', 'policy.json'), 'utf8')) as Record<string, unknown>;

describe('council policy', () => {
  it('is contracts/sputnik/policy.json with the council filled in, nothing else changed', () => {
    const want = policyFile();
    (want.roles as { kind: { Group: string[] } }[])[0]!.kind.Group = council.members;
    expect(councilPolicy(council.members)).toEqual(want);
  });

  it('2 of 3 for every kind: one council role, no per-kind vote policies, RoleWeight [1, 2], no Everyone role, no RemoveProposal', () => {
    const p = councilPolicy(council.members);
    expect(p.roles).toHaveLength(1);
    expect(p.roles[0]!.vote_policy).toEqual({});
    expect(p.default_vote_policy).toEqual({ weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] });
    expect(p.roles[0]!.permissions).not.toContain('*:RemoveProposal');
    expect(votesNeeded(p.default_vote_policy.threshold, 3)).toBe(2);
  });

  it('threshold arithmetic follows policy.rs to_weight: min(⌊a·n/b⌋ + 1, n)', () => {
    expect(votesNeeded([1, 2], 1)).toBe(1);
    expect(votesNeeded([1, 2], 2)).toBe(2);
    expect(votesNeeded([1, 2], 3)).toBe(2);
    expect(votesNeeded([1, 2], 4)).toBe(3);
    expect(() => votesNeeded('100', 3)).toThrow('ratio');
  });

  it('policyProblems: blocks on anything that changes who acts or how many votes; warns on bond and period', () => {
    const ok = councilPolicy(['c.testnet', 'a.testnet', 'b.testnet']);
    expect(policyProblems(ok, council.members)).toEqual({ blockers: [], warnings: [] });
    const everyone = { ...ok, roles: [...ok.roles, { name: 'all', kind: 'Everyone', permissions: ['*:AddProposal'], vote_policy: {} }] };
    expect(policyProblems(everyone, council.members).blockers.join()).toContain('2 roles');
    const one = { ...ok, default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 3] as [number, number] } };
    expect(policyProblems(one, council.members).blockers.join()).toContain('default_vote_policy');
    const otherMembers = councilPolicy(['a.testnet', 'b.testnet', 'x.testnet']);
    expect(policyProblems(otherMembers, council.members).blockers.join()).toContain('the council is a.testnet, b.testnet, x.testnet');
    const perKind = { ...ok, roles: [{ ...ok.roles[0]!, vote_policy: { call: { weight_kind: 'RoleWeight', quorum: '0', threshold: [0, 1] as [number, number] } } }] };
    expect(policyProblems(perKind, council.members).blockers.join()).toContain('per-kind vote policies');
    const remover = { ...ok, roles: [{ ...ok.roles[0]!, permissions: [...ok.roles[0]!.permissions, '*:RemoveProposal'] }] };
    expect(policyProblems(remover, council.members).blockers.join()).toContain('permissions');
    expect(policyProblems({ ...ok, proposal_period: '1' }, council.members)).toEqual({ blockers: [], warnings: [expect.stringContaining('proposal_period is 1')] });
  });
});

describe('factory create', () => {
  it('names the DAO <name>.<factory> and sends base64 JSON {config, policy}', () => {
    expect(daoName(council)).toBe('hana-council');
    expect(() => daoName({ ...council, dao: 'x.other.testnet' })).toThrow('not an account of the factory');
    const args = factoryCreateArgs(council, 'purpose');
    expect(args.name).toBe('hana-council');
    expect(JSON.parse(Buffer.from(args.args, 'base64').toString('utf8'))).toEqual(daoInitArgs(council, 'purpose'));
    expect(daoInitArgs(council, 'purpose').config).toEqual({ name: 'hana-council', purpose: 'purpose', metadata: '' });
  });

  it('deposits at least the code storage the factory checks ((bytes + 32) × storage cost), in whole NEAR', () => {
    const pin = readPin();
    expect(pin.code_hash).toBe('AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH');
    expect(factoryMinDeposit(pin)).toBe(BigInt(pin.bytes + 32) * STORAGE_YOCTO_PER_BYTE);
    expect(daoCreateDeposit(pin)).toBe(6n * 10n ** 24n);
    expect(daoCreateDeposit(pin)).toBeGreaterThan(factoryMinDeposit(pin));
  });

  it('reads the template without its comment field', () => {
    expect(Object.keys(readPolicyTemplate()).sort()).toEqual(['bounty_bond', 'bounty_forgiveness_period', 'default_vote_policy', 'proposal_bond', 'proposal_period', 'roles']);
  });
});

describe('proposals', () => {
  const kind = functionCallKind('signer.testnet', 'propose_owner', { owner: 'dao.testnet' });
  const p = (over: Partial<DaoProposal> = {}): DaoProposal => ({ id: 3, proposer: 'a.testnet', description: 'd', kind, status: 'InProgress', votes: {}, submission_time: String(1_000n * 1_000_000n), ...over });

  it('a FunctionCall kind: base64 JSON args, no deposit, 100 Tgas by default', () => {
    expect(kind).toEqual({ FunctionCall: { receiver_id: 'signer.testnet', actions: [{ method_name: 'propose_owner', args: Buffer.from('{"owner":"dao.testnet"}').toString('base64'), deposit: '0', gas: (100n * TGAS).toString() }] } });
    expect(decodeFunctionCall(kind)).toEqual([{ receiver: 'signer.testnet', method: 'propose_owner', args: { owner: 'dao.testnet' }, argsBase64: kind.FunctionCall.actions[0]!.args }]);
    expect(decodeFunctionCall({ ChangePolicy: {} })).toBeNull();
  });

  it('matches a call by receiver, method and canonical args', () => {
    expect(isCall(p(), 'signer.testnet', 'propose_owner', { owner: 'dao.testnet' })).toBe(true);
    expect(isCall(p({ kind: functionCallKind('signer.testnet', 'f', { a: 1, b: [2, { c: 3, d: 4 }] }) }), 'signer.testnet', 'f', { b: [2, { d: 4, c: 3 }], a: 1 })).toBe(true);
    expect(isCall(p(), 'signer.testnet', 'propose_owner', { owner: 'other.testnet' })).toBe(false);
    expect(isCall(p(), 'other.testnet', 'propose_owner', { owner: 'dao.testnet' })).toBe(false);
  });

  it('is open while InProgress and inside the proposal period', () => {
    const policy = { proposal_period: String(10_000n * 1_000_000n) };
    expect(isOpen(p(), policy, 5_000)).toBe(true);
    expect(isOpen(p(), policy, 11_000)).toBe(false);
    expect(isOpen(p({ status: 'Approved' }), policy, 5_000)).toBe(false);
  });

  it('approvers are the members who voted Approve', () => {
    expect(approvers(p({ votes: { 'a.testnet': 'Approve', 'b.testnet': 'Reject', 'c.testnet': 'Approve' } }))).toEqual(['a.testnet', 'c.testnet']);
  });
});
