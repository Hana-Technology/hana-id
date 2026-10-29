// owner-tx against the simulated chain: the account backend signs with the owner key; the council backend proposes
// through the DAO and, with --approve-with on dev envs, approves with a second member key in the same command (D81);
// elsewhere it only proposes and prints the votes. Open proposals are reused, never duplicated.
import { beforeEach, describe, expect, it } from 'vitest';
import { loadEnv, type Manifest } from '@hana-id/env';
import { KeyPair } from '@near-js/crypto';
import { writeCouncilKey } from '../lib/council.ts';
import { TGAS } from '../lib/near.ts';
import { checkOwnerTxOptions, describeOwnerCall, ownerRoute, sendOwnerCall } from '../lib/owner-tx.ts';
import { councilPolicy, readPin } from '../lib/sputnik.ts';
import { SimChain } from './sim-chain.ts';
import { fullEntry, keychainKey, NOW, secretFragments, tempRoots } from './sim-fixtures.ts';

const base = loadEnv('sandbox-dev');
const council = base.council!;
const [A, B, C] = council.members as [string, string, string];
const dao = council.dao;
const daoOwned: Manifest = { ...base, owner: dao, ownerKind: 'sputnik' };

let roots: ReturnType<typeof tempRoots>;
let chain: SimChain;
let secrets: KeyPair[];
let out: string[];

beforeEach(() => {
  roots = tempRoots();
  chain = new SimChain(base.signer, { now: NOW, daoCodeHash: readPin().code_hash });
  out = [];
  secrets = [];
  const ownerKey = keychainKey(roots.home, base.owner);
  secrets.push(ownerKey);
  chain.addAccount(base.signer);
  chain.addAccount(base.owner, [fullEntry(ownerKey)]);
  for (const member of council.members) {
    const k = KeyPair.fromRandom('ed25519');
    writeCouncilKey(base.name, member, k, roots.secretsRoot);
    chain.addAccount(member, [fullEntry(k)]);
    secrets.push(k);
  }
  chain.addDao(dao, councilPolicy(council.members));
  chain.initV2({ owner: dao, governance_delay_ms: 60_000 });
});

const deps = () => ({ rpc: chain.rpc(), log: (l: string) => out.push(l), home: roots.home, secretsRoot: roots.secretsRoot, now: () => chain.now });
const methods = () => chain.sent.map((t) => `${t.signer}→${t.receiver}.${t.actions[0]?.functionCall?.methodName ?? t.actions[0]?.enum}`);
const watchdog = { method: 'add_watchdog' as const, args: { account_id: 'w.testnet' } };

describe('routes', () => {
  it('account owner signs; a council owner proposes; accept_owner always goes through the council DAO', () => {
    expect(ownerRoute(base, 'set_sponsors')).toEqual({ kind: 'account', account: base.owner });
    expect(ownerRoute(daoOwned, 'set_sponsors')).toEqual({ kind: 'sputnik', dao });
    expect(ownerRoute(base, 'accept_owner')).toEqual({ kind: 'sputnik', dao });
    const { council: _c, ...noCouncil } = base;
    expect(() => ownerRoute({ ...noCouncil, council: undefined }, 'accept_owner')).toThrow('no council');
  });

  it('describes who signs', () => {
    expect(describeOwnerCall(base, watchdog)).toBe(`add_watchdog({"account_id":"w.testnet"}) [signed by ${base.owner}]`);
    expect(describeOwnerCall(daoOwned, watchdog, { approveWith: B })).toBe(`add_watchdog({"account_id":"w.testnet"}) [DAO proposal on ${dao} by ${A}, approved by ${A} and ${B} in the same run]`);
    expect(describeOwnerCall(daoOwned, watchdog, { member: C })).toBe(`add_watchdog({"account_id":"w.testnet"}) [DAO proposal on ${dao} by ${C}, then 2 of 3 council approvals]`);
  });

  it('--approve-with only on dev envs on testnet, never the proposer, only members', () => {
    const r = { kind: 'sputnik' as const, dao };
    expect(() => checkOwnerTxOptions(daoOwned, r, { approveWith: B })).not.toThrow();
    expect(() => checkOwnerTxOptions(daoOwned, r, { approveWith: A })).toThrow('different member');
    expect(() => checkOwnerTxOptions(daoOwned, r, { approveWith: 'x.testnet' })).toThrow('not a council member');
    expect(() => checkOwnerTxOptions(daoOwned, r, { member: 'x.testnet' })).toThrow('not a council member');
    const staging = { ...daoOwned, name: 'staging', allowSignerFullAccessKey: undefined };
    expect(() => checkOwnerTxOptions(staging, r, { member: A, approveWith: B })).toThrow('--approve-with is for dev envs on testnet only (D81)');
    expect(() => checkOwnerTxOptions(staging, r, {})).toThrow('--member <council member> is required');
    expect(() => checkOwnerTxOptions(base, { kind: 'account', account: base.owner }, { member: A })).toThrow('ownerKind "account"');
  });
});

describe('account backend', () => {
  it('signs the call with the owner key from the keychain', async () => {
    chain.initV2({ owner: base.owner, governance_delay_ms: 60_000 });
    const r = await sendOwnerCall(base, watchdog, {}, deps());
    expect(r.kind).toBe('executed');
    expect(methods()).toEqual([`${base.owner}→${base.signer}.add_watchdog`]);
    expect(chain.governance?.watchdogs.map((w) => w.account_id)).toEqual(['w.testnet']);
  });

  it('refuses methods that are not owner methods and out-of-range gas', async () => {
    await expect(sendOwnerCall(base, { method: 'create_session' as never, args: {} }, {}, deps())).rejects.toThrow('not an owner method');
    await expect(sendOwnerCall(base, { ...watchdog, gas: 300n * TGAS }, {}, deps())).rejects.toThrow('between 1 and 250 Tgas');
  });
});

describe('council backend', () => {
  it('--approve-with: proposes with the bond, approves with both members, and the call executes as the DAO', async () => {
    const r = await sendOwnerCall(daoOwned, watchdog, { approveWith: B }, deps());
    expect(r).toEqual({ kind: 'approved', proposalId: 0 });
    expect(methods()).toEqual([`${A}→${dao}.add_proposal`, `${A}→${dao}.act_proposal`, `${B}→${dao}.act_proposal`]);
    expect(chain.sent[0]!.actions[0]!.functionCall!.deposit).toBe(10n ** 23n); // policy.json proposal_bond, 0.1 NEAR
    const proposal = JSON.parse(Buffer.from(chain.sent[0]!.actions[0]!.functionCall!.args).toString()) as { proposal: { description: string; kind: unknown } };
    expect(proposal.proposal.kind).toEqual({
      FunctionCall: { receiver_id: base.signer, actions: [{ method_name: 'add_watchdog', args: Buffer.from('{"account_id":"w.testnet"}').toString('base64'), deposit: '0', gas: (100n * TGAS).toString() }] },
    });
    expect(proposal.proposal.description).toContain('add_watchdog({"account_id":"w.testnet"})');
    expect(chain.governance?.watchdogs.map((w) => w.account_id)).toEqual(['w.testnet']);
    for (const s of secretFragments(secrets)) expect(out.join('\n')).not.toContain(s);
  });

  it('without --approve-with: one proposal, then the vote commands; a re-run reuses it instead of proposing again', async () => {
    const r = await sendOwnerCall(daoOwned, watchdog, {}, deps());
    expect(r).toEqual({ kind: 'proposed', proposalId: 0, approvals: [], needed: 2 });
    expect(methods()).toEqual([`${A}→${dao}.add_proposal`]);
    const text = out.join('\n');
    expect(text).toContain('#0 needs 2 council approvals (proposing is not a vote)');
    for (const member of council.members) expect(text).toContain(`admin sandbox-dev owner:vote 0 --member ${member} --yes`);
    expect(chain.governance?.watchdogs).toEqual([]);

    const again = await sendOwnerCall(daoOwned, watchdog, { approveWith: C }, deps());
    expect(again).toEqual({ kind: 'approved', proposalId: 0 });
    expect(methods()).toEqual([`${A}→${dao}.add_proposal`, `${A}→${dao}.act_proposal`, `${C}→${dao}.act_proposal`]);
    expect(out.join('\n')).toContain('already open');
  });

  it('a different call is a new proposal', async () => {
    await sendOwnerCall(daoOwned, watchdog, {}, deps());
    await sendOwnerCall(daoOwned, { method: 'add_watchdog', args: { account_id: 'w2.testnet' } }, {}, deps());
    expect(chain.daos.get(dao)!.proposals).toHaveLength(2);
  });

  it('an approved proposal whose call the contract refuses fails loudly', async () => {
    await expect(sendOwnerCall(base, { method: 'accept_owner', args: {} }, { approveWith: B }, deps())).rejects.toThrow('the call accept_owner on');
    expect(chain.daos.get(dao)!.proposals[0]!.status).toBe('Failed');
  });

  it('outside dev envs: the member signs with their own keychain key, and the votes are printed for Ledgers', async () => {
    const staging: Manifest = { ...daoOwned, name: 'staging', allowSignerFullAccessKey: undefined };
    await expect(sendOwnerCall(staging, watchdog, { member: A }, deps())).rejects.toThrow(`No key for ${A} in ~/.near-credentials/testnet/`);
    const k = keychainKey(roots.home, A);
    chain.accounts.get(A)!.keys.push(fullEntry(k));
    const r = await sendOwnerCall(staging, watchdog, { member: A }, deps());
    expect(r.kind).toBe('proposed');
    const text = out.join('\n');
    expect(text).toContain(`near contract call-function as-transaction ${dao} act_proposal json-args '{"id":0,"action":"VoteApprove","memo":null}' prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as ${B} network-config testnet sign-with-ledger send`);
    expect(text).not.toContain('owner:vote');
    expect(text).not.toContain(k.toString());
  });
});
