// admin scope:register on a council-owned env, against the simulated chain (sim-chain.ts), never a network: with
// --approve-with the one command registers the scope and prints its id (read from the scope_registered event the
// executing vote logged), with the next step; without it, it proposes and prints the votes, and the member whose
// owner:vote passes it sees the id. The event reader ignores anything that isn't exactly that event.
import { beforeEach, describe, expect, it } from 'vitest';
import { loadEnv, type Manifest } from '@hana-id/env';
import { KeyPair } from '@near-js/crypto';
import { ownerVoteCmd } from '../lib/admin-owner.ts';
import { registeredScopeId, scopeRegister } from '../lib/admin-scope.ts';
import { parseCli } from '../lib/cli.ts';
import { sendOwnerCall } from '../lib/owner-tx.ts';
import { writeCouncilKey } from '../lib/council.ts';
import { councilPolicy, readPin } from '../lib/sputnik.ts';
import { SimChain } from './sim-chain.ts';
import { fullEntry, NOW, secretFragments, tempRoots } from './sim-fixtures.ts';

const m: Manifest = loadEnv('sandbox-dev');
const council = m.council!;
const [A, B] = council.members as [string, string, string];
const SUB_1 = '110248495921238986420';
const SUB_2 = '104857739201938475610';
const CLIENT = '123456789012-abcdef0123456789.apps.googleusercontent.com';

let roots: ReturnType<typeof tempRoots>;
let chain: SimChain;
let secrets: KeyPair[];
let out: string[];

beforeEach(() => {
  expect(m.ownerKind).toBe('sputnik');
  roots = tempRoots();
  chain = new SimChain(m.signer, { now: NOW, daoCodeHash: readPin().code_hash });
  out = [];
  secrets = [];
  chain.addAccount(m.signer);
  for (const member of council.members) {
    const k = KeyPair.fromRandom('ed25519');
    writeCouncilKey(m.name, member, k, roots.secretsRoot);
    chain.addAccount(member, [fullEntry(k)]);
    secrets.push(k);
  }
  chain.addDao(council.dao, councilPolicy(council.members));
  chain.initV2({ owner: council.dao, governance_delay_ms: 60_000 });
});

const cli = (argv: string[]) => parseCli(argv, { strings: ['member', 'approve-with'], multiple: ['client', 'owner-near', 'owner-google'], booleans: ['yes', 'allow-shared', 'reject'] });
const deps = () => ({ rpc: () => chain.rpc(), log: (l: string) => out.push(l), home: roots.home, secretsRoot: roots.secretsRoot });
const text = () => out.join('\n');

describe('scope:register through the council', () => {
  it('--approve-with: registers in one command and prints the new scope id and the next step', async () => {
    await scopeRegister(m, cli(['--allow-shared', '--owner-google', SUB_1, '--owner-google', SUB_2, '--member', A, '--approve-with', B, '--yes']), deps());
    const id = Object.keys(chain.scopes)[0]!;
    expect(id).toMatch(/^s[0-9a-z]+$/u);
    expect(chain.scopes[id]).toMatchObject({ owners: [{ Oidc: { provider: 'google', sub: SUB_1 } }, { Oidc: { provider: 'google', sub: SUB_2 } }], clients: [], allow_shared: true });
    expect(text()).toContain(`Registered scope: ${id} (proposal #0)`);
    expect(text()).toContain(`Next: in the admin console (${m.name}), open the organisation and use "Create an app" with scope ${id}.`);
    expect(text()).not.toContain('read the new scope id');
    for (const s of secretFragments(secrets)) expect(text()).not.toContain(s);
  });

  it('with an own client: the client is registered and the id printed the same way', async () => {
    await scopeRegister(m, cli(['--client', CLIENT, '--owner-google', SUB_1, '--member', A, '--approve-with', B, '--yes']), deps());
    const id = Object.keys(chain.scopes)[0]!;
    expect(chain.scopes[id]?.clients).toEqual([['google', CLIENT]]);
    expect(text()).toContain(`Registered scope: ${id}`);
  });

  it('without --approve-with: proposes and prints the votes; the owner:vote that passes it prints the id', async () => {
    await scopeRegister(m, cli(['--allow-shared', '--owner-google', SUB_1, '--member', A, '--yes']), deps());
    expect(Object.keys(chain.scopes)).toEqual([]);
    expect(text()).toContain('Proposed #0: the scope is registered when the council approves it');
    expect(text()).toContain(`owner:vote 0 --member ${B} --yes`);
    out = [];
    const ownerDeps = { rpc: { ...chain.rpc(), accessKeys: async () => [], account: async () => null }, log: (l: string) => out.push(l), home: roots.home, secretsRoot: roots.secretsRoot, now: () => chain.now };
    await ownerVoteCmd(m, '0', cli(['--member', A, '--yes']), ownerDeps);
    expect(text()).not.toContain('Registered scope');
    out = [];
    await ownerVoteCmd(m, '0', cli(['--member', B, '--yes']), ownerDeps);
    const id = Object.keys(chain.scopes)[0]!;
    expect(text()).toContain(`Registered scope: ${id}`);
    expect(text()).toContain('#0 approved and executed.');
  });
});

describe('registeredScopeId', () => {
  const owners = [{ Oidc: { provider: 'google', sub: SUB_1 } }];
  const event = (data: unknown, extra: Record<string, unknown> = {}) => `EVENT_JSON:${JSON.stringify({ standard: 'hana-id', version: '1.3.0', event: 'scope_registered', data: [data], ...extra })}`;
  const at = (executor: string, ...logs: string[]) => ({ executor, logs });

  it('reads the scope id of the scope_registered event the signer logged, for exactly these owners', () => {
    expect(registeredScopeId([at(m.signer, 'Some log', event({ scope_id: 's7', owners }))], m.signer, owners)).toBe('s7');
    expect(registeredScopeId([at(m.signer, event({ scope_id: 's7', owners: [{ Oidc: { provider: 'google', sub: SUB_2 } }] }))], m.signer, owners)).toBeNull();
  });

  it('ignores the same line from any other contract, other events, other standards, malformed lines and ids', () => {
    expect(registeredScopeId([], m.signer, owners)).toBeNull();
    expect(registeredScopeId([at('evil.testnet', event({ scope_id: 's9', owners })), at(council.dao, event({ scope_id: 's9', owners }))], m.signer, owners)).toBeNull();
    expect(registeredScopeId([at(m.signer, 'EVENT_JSON:{not json', event({ scope_id: 's1', owners }, { event: 'change_proposed' }), event({ scope_id: 's1', owners }, { standard: 'nep171' }))], m.signer, owners)).toBeNull();
    expect(registeredScopeId([at(m.signer, event({ scope_id: 'S 1; x', owners }), event({ owners }))], m.signer, owners)).toBeNull();
  });
});

describe('a foreign contract logging a look-alike event', () => {
  const lookAlike = (id: string, subs: string[]) => ({ executor: 'evil.testnet', logs: [`EVENT_JSON:${JSON.stringify({ standard: 'hana-id', version: '1.3.0', event: 'scope_registered', data: [{ scope_id: id, owners: subs.map((sub) => ({ Oidc: { provider: 'google', sub } })) }] })}`] });
  const ownerDeps = () => ({ rpc: { ...chain.rpc(), accessKeys: async () => [], account: async () => null }, log: (l: string) => out.push(l), home: roots.home, secretsRoot: roots.secretsRoot, now: () => chain.now });

  it('scope:register prints only the signer\'s own event', async () => {
    chain.extraReceiptLogs = [lookAlike('sfake', [SUB_1])];
    await scopeRegister(m, cli(['--allow-shared', '--owner-google', SUB_1, '--member', A, '--approve-with', B, '--yes']), deps());
    const id = Object.keys(chain.scopes)[0]!;
    expect(text()).toContain(`Registered scope: ${id} (proposal #0)`);
    expect(text()).not.toContain('sfake');
  });

  it('owner:vote prints nothing for a proposal that isn\'t the signer\'s admin_register_scope, and only the real id for one that is', async () => {
    chain.extraReceiptLogs = [lookAlike('sfake', [SUB_2])];
    // Another owner call (set_sponsors) passed by owner:vote: the look-alike line is never read as a scope.
    await sendOwnerCall(m, { method: 'set_sponsors', args: { sponsors: [] } }, { member: A }, { rpc: chain.rpc(), log: () => {}, home: roots.home, secretsRoot: roots.secretsRoot });
    await ownerVoteCmd(m, '0', cli(['--member', A, '--yes']), ownerDeps());
    await ownerVoteCmd(m, '0', cli(['--member', B, '--yes']), ownerDeps());
    expect(text()).toContain('#0 approved and executed.');
    expect(text()).not.toContain('Registered scope');
    out = [];
    await scopeRegister(m, cli(['--allow-shared', '--owner-google', SUB_2, '--member', A, '--yes']), deps());
    await ownerVoteCmd(m, '1', cli(['--member', A, '--yes']), ownerDeps());
    await ownerVoteCmd(m, '1', cli(['--member', B, '--yes']), ownerDeps());
    const id = Object.keys(chain.scopes)[0]!;
    expect(text()).toContain(`Registered scope: ${id}`);
    expect(text()).not.toContain('sfake');
  });
});
