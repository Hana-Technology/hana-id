// admin council:replace-member and owner:vote --reject against the simulated chain (a Sputnik DAO with the 2-of-3
// council policy that executes AddMemberToRole / RemoveMemberFromRole and counts rejections).
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, type Manifest, manifestPath, manifestSchema } from '@hana-id/env';
import { KeyPair } from '@near-js/crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { OWNER_DRY_RUN_LINE, ownerCallCmd, ownerProposalsCmd, ownerVoteCmd } from '../lib/admin-owner.ts';
import { parseCli } from '../lib/cli.ts';
import { writeCouncilKey } from '../lib/council.ts';
import { checkReplaceRequest, COUNCIL_DRY_RUN_LINE, councilReplaceMember, councilReplaceMemberCmd, replaceState, replacedMembers } from '../lib/council-members.ts';
import { setCouncilMembers } from '../lib/manifest-edit.ts';
import { councilGroup, councilPolicy, decodeMemberChange, memberChangeKind, policyProblems, readPin } from '../lib/sputnik.ts';
import { SimChain } from './sim-chain.ts';
import { fullEntry, keychainKey, NOW, secretFragments, tempRoots } from './sim-fixtures.ts';

const base = loadEnv('sandbox-dev');
const council = base.council!;
const [A, B, C] = council.members as [string, string, string];
const D = 'hana-id-council-d-dev1.testnet';
const dao = council.dao;
/** The same council on a non-dev env: members sign with their own keys, no --approve-with. (Without the dev-only
 * workers.dev origins, which a non-dev manifest refuses on one site.) */
const { vaultOrigin: _v, authOrigin: _a, ...noOrigins } = base;
const staging: Manifest = { ...noOrigins, name: 'staging' };

let roots: ReturnType<typeof tempRoots>;
let chain: SimChain;
let keys: KeyPair[];
let out: string[];
let manifestFile: string;

beforeEach(() => {
  roots = tempRoots();
  chain = new SimChain(base.signer, { now: NOW, daoCodeHash: readPin().code_hash });
  keys = [];
  out = [];
  chain.addAccount(base.signer);
  for (const member of council.members) {
    const k = KeyPair.fromRandom('ed25519');
    writeCouncilKey(base.name, member, k, roots.secretsRoot);
    chain.addAccount(member, [fullEntry(k)]);
    keys.push(k);
  }
  chain.addAccount(D, [fullEntry(KeyPair.fromRandom('ed25519'))]);
  chain.addDao(dao, councilPolicy(council.members));
  chain.initV2({ owner: dao, governance_delay_ms: 60_000 });
  manifestFile = join(roots.dir, 'sandbox-dev.json');
  copyFileSync(manifestPath('sandbox-dev'), manifestFile);
});

const argv = (a: string[]) => parseCli(a, { strings: ['args', 'gas', 'member', 'approve-with', 'limit', 'remove', 'add'], booleans: ['yes', 'json', 'reject'] });
const deps = () => ({ rpc: chain.rpc(), log: (l: string) => out.push(l), home: roots.home, secretsRoot: roots.secretsRoot, now: () => chain.now, manifestFile });
const group = () => councilGroup(chain.daos.get(dao)!.policy)!.sort();
const proposals = () => chain.daos.get(dao)!.proposals;
const manifestMembers = () => (JSON.parse(readFileSync(manifestFile, 'utf8')) as { council: { members: string[] } }).council.members;

describe('owner:vote --reject', () => {
  it('rejects a proposal: two rejections close it without executing', async () => {
    await ownerCallCmd(base, 'pause', argv(['--yes']), deps());
    out = [];
    await ownerVoteCmd(base, '0', argv(['--member', B, '--reject']), deps());
    expect(out).toContain(`VoteReject #0 on ${dao} by ${B}`);
    expect(out.at(-1)).toBe(OWNER_DRY_RUN_LINE);
    expect(proposals()[0]!.votes).toEqual({});
    await ownerVoteCmd(base, '0', argv(['--member', B, '--reject', '--yes']), deps());
    expect(out.at(-1)).toBe('#0 is InProgress.');
    await ownerProposalsCmd(base, argv([]), deps());
    expect(out.join('\n')).toContain(`rejections 1/2 (${B})`);
    await ownerVoteCmd(base, '0', argv(['--member', B, '--yes']), deps());
    expect(out.at(-1)).toBe(`${B} already voted Reject on #0.`);
    await ownerVoteCmd(base, '0', argv(['--member', C, '--reject', '--yes']), deps());
    expect(out.at(-1)).toBe("#0 rejected: it will not execute (the proposer's bond is refunded).");
    expect(proposals()[0]!.status).toBe('Rejected');
    const act = chain.sent.at(-1)!.actions[0]!.functionCall!;
    expect(JSON.parse(Buffer.from(act.args).toString('utf8'))).toEqual({ id: 0, action: 'VoteReject', memo: null });
    await expect(ownerVoteCmd(base, '0', argv(['--member', A, '--reject', '--yes']), deps())).rejects.toThrow('not open for votes');
    for (const s of secretFragments(keys)) expect(out.join('\n')).not.toContain(s);
  });
});

describe('council:replace-member: checks before anything is read', () => {
  it('refuses unknown members, the removed member signing, bad accounts and --approve-with outside dev envs', () => {
    const r = (o: Partial<Parameters<typeof checkReplaceRequest>[1]> = {}) => ({ remove: C, add: D, yes: false, ...o });
    expect(checkReplaceRequest(base, r())).toEqual({ proposer: A, newMembers: [A, B, D] });
    expect(checkReplaceRequest(base, r({ remove: A })).proposer).toBe(B);
    expect(() => checkReplaceRequest(base, r({ remove: 'x.testnet' }))).toThrow('--remove x.testnet is not a council member');
    expect(() => checkReplaceRequest(base, r({ add: B }))).toThrow('already a council member');
    expect(() => checkReplaceRequest(base, r({ add: 'Not An Account' }))).toThrow('not a valid NEAR account id');
    expect(() => checkReplaceRequest(base, r({ member: C }))).toThrow('a remaining member');
    expect(() => checkReplaceRequest(base, r({ approveWith: C }))).toThrow('a remaining member');
    expect(() => checkReplaceRequest(base, r({ approveWith: A }))).toThrow('different member from the proposer');
    expect(() => checkReplaceRequest(staging, r({ member: A, approveWith: B }))).toThrow('dev envs on testnet only');
    expect(() => checkReplaceRequest(staging, r())).toThrow('--member <council member> is required');
    // The new manifest must still validate (a member can't be the env's own account).
    expect(() => checkReplaceRequest(base, r({ add: base.relayer }))).toThrow('would not validate');
  });

  it('knows the four on-chain states of a replacement', () => {
    const m = [A, B, C];
    expect(replacedMembers(m, B, D)).toEqual([A, D, C]);
    expect(replaceState([C, A, B], m, C, D)).toBe('none');
    expect(replaceState([A, B], m, C, D)).toBe('removed');
    expect(replaceState([A, B, C, D], m, C, D)).toBe('added');
    expect(replaceState([D, A, B], m, C, D)).toBe('done');
    expect(replaceState([A, D], m, C, D)).toBeNull();
    expect(decodeMemberChange(memberChangeKind('add', D, 'council'))).toEqual({ op: 'add', member: D, role: 'council' });
    expect(decodeMemberChange({ FunctionCall: {} })).toBeNull();
  });

  it("edits only council.members in the manifest, and refuses an edit that doesn't validate", () => {
    const text = readFileSync(manifestFile, 'utf8');
    const edited = setCouncilMembers(text, [A, B, D]);
    expect(edited).toBe(text.replace(`"${C}"`, `"${D}"`));
    expect(manifestSchema.parse(JSON.parse(edited)).council?.members).toEqual([A, B, D]);
    expect(() => setCouncilMembers(text, [A, B])).toThrow();
  });
});

describe('council:replace-member on a dev env', () => {
  it('without --yes prints the plan and the manifest edit and sends nothing', async () => {
    await councilReplaceMemberCmd(base, argv(['--remove', C, '--add', D, '--approve-with', B]), deps());
    const text = out.join('\n');
    expect(text).toContain(`Replace council member ${C} with ${D} on ${dao} (role "council"`);
    expect(text).toContain(`1. RemoveMemberFromRole(${C}) [DAO proposal by ${A}, approved by ${A} and ${B} in the same run]`);
    expect(text).toContain(`2. AddMemberToRole(${D})`);
    expect(text).toContain(`envs/sandbox-dev.json "council": "members": ["${A}","${B}","${C}"] -> ["${A}","${B}","${D}"]`);
    expect(text).toContain(`no .secrets/sandbox-dev/council/${D}.json`);
    expect(out.at(-1)).toBe(COUNCIL_DRY_RUN_LINE);
    expect(chain.sent).toEqual([]);
    expect(manifestMembers()).toEqual([A, B, C]);
  });

  it('--yes --approve-with removes, then adds, keeps 2 of 3, and writes the manifest', async () => {
    const r = await councilReplaceMember(base, { remove: C, add: D, approveWith: B, yes: true }, deps());
    expect(r).toEqual({ state: 'done', proposals: [0, 1], manifestUpdated: true });
    expect(group()).toEqual([A, B, D].sort());
    expect(policyProblems(chain.daos.get(dao)!.policy, [A, B, D]).blockers).toEqual([]);
    expect(proposals().map((p) => [Object.keys(p.kind as object)[0], p.status, Object.keys(p.votes).sort()])).toEqual([
      ['RemoveMemberFromRole', 'Approved', [A, B]],
      ['AddMemberToRole', 'Approved', [A, B]],
    ]);
    expect(proposals()[0]!.description).toBe(`hana-id sandbox-dev: RemoveMemberFromRole(${C}, council) on ${dao}, replaced by ${D}`);
    expect(manifestMembers()).toEqual([A, B, D]);
    expect(out.join('\n')).toContain('Updated envs/sandbox-dev.json');
    for (const s of secretFragments(keys)) expect(out.join('\n')).not.toContain(s);
  });

  it('carries on from a half-done replacement and reuses an open proposal', async () => {
    // Only the removal executed so far (an earlier run stopped half-way).
    chain.daos.get(dao)!.policy = councilPolicy([A, B]);
    const r = await councilReplaceMember(base, { remove: C, add: D, approveWith: B, yes: true }, deps());
    expect(out.join('\n')).toContain(`on chain already: ${C} removed`);
    expect(r.proposals).toEqual([0]);
    expect(group()).toEqual([A, B, D].sort());
    expect(manifestMembers()).toEqual([A, B, D]);
  });

  it('only writes the manifest when both changes have executed', async () => {
    chain.daos.get(dao)!.policy = councilPolicy([A, B, D]);
    await councilReplaceMember(base, { remove: C, add: D, yes: false }, deps());
    expect(out.join('\n')).toContain('on chain already: both changes executed');
    expect(manifestMembers()).toEqual([A, B, C]);
    await councilReplaceMember(base, { remove: C, add: D, yes: true }, deps());
    expect(chain.sent).toEqual([]);
    expect(manifestMembers()).toEqual([A, B, D]);
  });

  it('refuses a DAO whose council is something else, or whose policy is no longer 2 of 3', async () => {
    chain.daos.get(dao)!.policy = councilPolicy([A, D]);
    await expect(councilReplaceMember(base, { remove: C, add: D, yes: true }, deps())).rejects.toThrow('nor a half-done replacement');
    const policy = councilPolicy([A, B, C]);
    policy.default_vote_policy = { ...policy.default_vote_policy, threshold: [1, 3] };
    chain.daos.get(dao)!.policy = policy;
    await expect(councilReplaceMember(base, { remove: C, add: D, yes: true }, deps())).rejects.toThrow('not the council policy');
    expect(chain.sent).toEqual([]);
  });

  it('refuses a new member account that does not exist', async () => {
    chain.accounts.delete(D);
    await expect(councilReplaceMember(base, { remove: C, add: D, yes: false }, deps())).rejects.toThrow(`${D} does not exist`);
  });
});

describe('council:replace-member elsewhere (members sign their own votes)', () => {
  it('proposes both changes, prints each remaining member’s act_proposal, and leaves the manifest alone', async () => {
    chain.accounts.get(A)!.keys.push(fullEntry(keychainKey(roots.home, A)));
    const r = await councilReplaceMember(staging, { remove: C, add: D, member: A, yes: true }, { ...deps(), manifestFile });
    expect(r).toEqual({ state: 'none', proposals: [0, 1], manifestUpdated: false });
    expect(group()).toEqual([A, B, C].sort());
    const text = out.join('\n');
    for (const id of [0, 1]) {
      for (const voter of [A, B]) {
        expect(text).toContain(`near contract call-function as-transaction ${dao} act_proposal json-args '{"id":${id},"action":"VoteApprove","memo":null}' prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as ${voter} network-config testnet sign-with-ledger send`);
      }
      expect(text).not.toContain(`sign-as ${C} network-config`);
    }
    expect(text).toContain('Approve #0 first, then #1');
    expect(manifestMembers()).toEqual([A, B, C]);
    // Re-running reuses both open proposals instead of duplicating them.
    out = [];
    const again = await councilReplaceMember(staging, { remove: C, add: D, member: A, yes: true }, { ...deps(), manifestFile });
    expect(again.proposals).toEqual([0, 1]);
    expect(proposals()).toHaveLength(2);
    expect(out.join('\n')).toContain('is already open');
  });
});
