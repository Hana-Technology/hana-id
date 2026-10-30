// council-setup against the simulated chain: three member accounts (keys saved to .secrets/<env>/council/ 0600 before
// they exist on chain), the DAO from the testnet factory with contracts/sputnik/policy.json, plan first, dev envs only.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadEnv, type Manifest } from '@hana-id/env';
import { KeyPair } from '@near-js/crypto';
import { councilDir, councilKeyFile, readCouncilKey, writeCouncilKey } from '../lib/council.ts';
import { buildCouncilPlan, COUNCIL_DRY_RUN_LINE, type CouncilObserved, councilSetupMain, memberVia } from '../lib/council-setup.ts';
import { councilPolicy, daoCreateDeposit, daoInitArgs, readPin } from '../lib/sputnik.ts';
import { SimChain } from './sim-chain.ts';
import { ACCOUNT_OWNER, fullEntry, keychainKey, NEAR, NOW, secretFragments, tempRoots } from './sim-fixtures.ts';

const m: Manifest = { ...loadEnv('sandbox-dev'), ...ACCOUNT_OWNER };
const council = m.council!;
const PIN = readPin();
const mode = (p: string) => statSync(p).mode & 0o777;

let roots: ReturnType<typeof tempRoots>;
let chain: SimChain;
let funderKey: KeyPair;

beforeEach(() => {
  roots = tempRoots();
  chain = new SimChain(m.signer, { now: NOW, factory: council.factory, daoCodeHash: PIN.code_hash });
  chain.addAccount(council.factory, [], 100n * NEAR, 'FACTORYCODE');
  funderKey = keychainKey(roots.home, m.owner);
  chain.addAccount(m.owner, [fullEntry(funderKey)], 50n * NEAR);
});

async function setup(argv: string[], manifest: Manifest = m) {
  const out: string[] = [];
  const before = chain.sent.length;
  const code = await councilSetupMain(argv, { rpc: () => chain.rpc(), log: (l) => out.push(l), home: roots.home, secretsRoot: roots.secretsRoot, loadManifest: () => manifest });
  return { code, out: out.join('\n'), sent: chain.sent.slice(before) };
}

const observed = (over: Partial<CouncilObserved> = {}): CouncilObserved => ({
  chainId: 'testnet',
  factory: { exists: true, defaultCodeHash: PIN.code_hash },
  dao: { exists: false, codeHash: '', policy: null },
  members: Object.fromEntries(council.members.map((a) => [a, { exists: false, keyInFile: null, keyFullAccessOnChain: false }])),
  funder: { account: m.owner, exists: true, balanceYocto: 50n * NEAR, credentialFound: true, fullAccessOnChain: true },
  ...over,
});

describe('council-setup plan', () => {
  it('creates three members through the registrar, then the DAO', () => {
    const p = buildCouncilPlan(m, observed(), { memberBalanceYocto: 2n * NEAR }, PIN);
    expect(p.blockers).toEqual([]);
    expect(p.steps).toEqual([
      ...council.members.map((account) => ({ kind: 'member', account, generate: true, via: { kind: 'registrar', registrar: 'testnet' }, depositYocto: 2n * NEAR })),
      { kind: 'dao', depositYocto: daoCreateDeposit(PIN) },
    ]);
  });

  it('is for dev envs on testnet only', () => {
    expect(buildCouncilPlan({ ...m, name: 'staging', allowSignerFullAccessKey: undefined }, observed(), { memberBalanceYocto: NEAR }, PIN).blockers.join()).toContain('dev envs (local*, sandbox*) on testnet only');
  });

  it('blocks when the factory deploys other code than the pin, or a member name is taken, or the DAO differs', () => {
    expect(buildCouncilPlan(m, observed({ factory: { exists: true, defaultCodeHash: 'NEW' } }), { memberBalanceYocto: NEAR }, PIN).blockers.join()).toContain('Re-pin it and re-run the sandbox DAO test');
    const taken = observed({ members: { ...observed().members, [council.members[0]!]: { exists: true, keyInFile: null, keyFullAccessOnChain: false } } });
    expect(buildCouncilPlan(m, taken, { memberBalanceYocto: NEAR }, PIN).blockers.join()).toContain('the name is taken or its key is lost');
    const otherCode = observed({ dao: { exists: true, codeHash: 'X', policy: null } });
    expect(buildCouncilPlan(m, otherCode, { memberBalanceYocto: NEAR }, PIN).blockers.join()).toContain('not the pinned Sputnik DAO');
    const wrongPolicy = observed({ dao: { exists: true, codeHash: PIN.code_hash, policy: councilPolicy(['x.testnet', 'y.testnet', 'z.testnet']) } });
    expect(buildCouncilPlan(m, wrongPolicy, { memberBalanceYocto: NEAR }, PIN).blockers.join()).toContain('the council is x.testnet, y.testnet, z.testnet');
    const ok = observed({ dao: { exists: true, codeHash: PIN.code_hash, policy: councilPolicy(council.members) } });
    expect(buildCouncilPlan(m, ok, { memberBalanceYocto: NEAR }, PIN).done.join()).toContain('2 of 3 for every proposal kind');
  });

  it('sub-accounts of the funder are created directly; other names are refused', () => {
    expect(memberVia('a.funder.testnet', 'funder.testnet')).toEqual({ kind: 'subaccount' });
    expect(memberVia('a.testnet', 'funder.testnet')).toEqual({ kind: 'registrar', registrar: 'testnet' });
    expect(memberVia('a.b.other.testnet', 'funder.testnet')).toBeNull();
  });

  it('warns when the funder looks short', () => {
    const poor = observed({ funder: { ...observed().funder, balanceYocto: NEAR } });
    expect(buildCouncilPlan(m, poor, { memberBalanceYocto: 2n * NEAR }, PIN).warnings.join()).toContain('Top it up');
  });
});

describe('council-setup run', () => {
  it('without --yes sends nothing and writes no key', async () => {
    const r = await setup([m.name]);
    expect(r.code).toBe(0);
    expect(r.out.trimEnd().endsWith(COUNCIL_DRY_RUN_LINE)).toBe(true);
    expect(r.sent).toEqual([]);
    expect(existsSync(councilDir(m.name, roots.secretsRoot))).toBe(false);
  });

  it('--yes creates the members with keys in .secrets (0600) and the DAO with the council policy; a re-run has nothing to do', async () => {
    const r = await setup([m.name, '--yes']);
    expect(r.code).toBe(0);
    expect(r.sent.map((t) => `${t.signer}→${t.receiver}:${t.actions[0]!.functionCall!.methodName}`)).toEqual([
      ...council.members.map(() => `${m.owner}→testnet:create_account`),
      `${m.owner}→${council.factory}:create`,
    ]);
    const keys: KeyPair[] = [];
    for (const [i, member] of council.members.entries()) {
      const key = readCouncilKey(m.name, member, roots.secretsRoot)!;
      keys.push(key.keyPair);
      expect(mode(councilKeyFile(m.name, member, roots.secretsRoot))).toBe(0o600);
      const args = JSON.parse(Buffer.from(r.sent[i]!.actions[0]!.functionCall!.args).toString()) as Record<string, string>;
      expect(args).toEqual({ new_account_id: member, new_public_key: key.publicKey });
      expect(r.sent[i]!.actions[0]!.functionCall!.deposit).toBe(2n * NEAR);
      expect(chain.keysOf(member).map((k) => k.public_key)).toEqual([key.publicKey]);
    }
    expect(mode(join(roots.secretsRoot, '.secrets', m.name))).toBe(0o700);
    const create = r.sent[3]!.actions[0]!.functionCall!;
    expect(create.deposit).toBe(6n * NEAR);
    const createArgs = JSON.parse(Buffer.from(create.args).toString()) as { name: string; args: string };
    expect(createArgs.name).toBe('hana-id-council-dev1');
    expect(JSON.parse(Buffer.from(createArgs.args, 'base64').toString())).toEqual(daoInitArgs(council, `hana-signer owner council for ${m.name} (D81)`));
    expect(chain.daos.get(council.dao)!.policy).toEqual(councilPolicy(council.members));
    for (const s of secretFragments([...keys, funderKey])) expect(r.out).not.toContain(s);

    const again = await setup([m.name, '--yes']);
    expect(again.sent).toEqual([]);
    expect(again.out).toContain('Nothing to do.');
  });

  it('fails when the factory left no DAO, although its transaction succeeded with an empty value', async () => {
    chain.opts.factoryRefuses = true;
    await expect(setup([m.name, '--yes'])).rejects.toThrow(`${council.factory}.create did not create ${council.dao} (deposit refunded)`);
    expect(chain.daos.has(council.dao)).toBe(false);
  });

  it('reuses a key saved by an interrupted run instead of generating another', async () => {
    const saved = KeyPair.fromRandom('ed25519');
    writeCouncilKey(m.name, council.members[0]!, saved, roots.secretsRoot);
    await setup([m.name, '--yes']);
    expect(chain.keysOf(council.members[0]!).map((k) => k.public_key)).toEqual([saved.getPublicKey().toString()]);
  });

  it('refuses non-dev envs and bad flags before touching the chain', async () => {
    await expect(setup(['staging'], { ...m, name: 'staging', allowSignerFullAccessKey: undefined })).rejects.toThrow('dev envs (local*, sandbox*) on testnet only');
    await expect(setup([m.name, '--member-balance', '0.1'])).rejects.toThrow('at least 0.5 NEAR');
    expect(chain.sent).toEqual([]);
  });
});
