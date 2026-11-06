// admin console:remove-audience (D416) against the simulated chain: retiring a console client from its sink.
import { beforeEach, describe, expect, it } from 'vitest';
import { loadEnv, type Manifest } from '@hana-id/env';
import { KeyPair } from '@near-js/crypto';
import { assertCommandPositionals } from '../lib/admin-args.ts';
import { consoleRemoveAudienceCmd } from '../lib/admin-console-sink.ts';
import { OWNER_DRY_RUN_LINE } from '../lib/admin-owner.ts';
import { parseCli } from '../lib/cli.ts';
import { writeCouncilKey } from '../lib/council.ts';
import { councilPolicy, readPin } from '../lib/sputnik.ts';
import { SimChain } from './sim-chain.ts';
import { fullEntry, keychainKey, NOW, secretFragments, tempRoots } from './sim-fixtures.ts';

const base = loadEnv('sandbox-dev');
const council = base.council!;
const [, B] = council.members as [string, string, string];
const dao = council.dao;
const NEW = 'new-console.apps.googleusercontent.com';
const OLD = 'old-console.apps.googleusercontent.com';
const m: Manifest = { ...base, owner: dao, ownerKind: 'sputnik', consoleAudiences: [['google', NEW]] };

let roots: ReturnType<typeof tempRoots>;
let chain: SimChain;
let keys: KeyPair[];
let out: string[];
let rpcCalls: number;

const sink = (clients: [string, string][], over: Record<string, unknown> = {}) => ({ id: 's3', owners: [{ Near: { account_id: dao } }], clients, allow_shared: false, ...over });

beforeEach(() => {
  roots = tempRoots();
  chain = new SimChain(base.signer, { now: NOW, daoCodeHash: readPin().code_hash });
  keys = [];
  out = [];
  rpcCalls = 0;
  chain.addAccount(base.signer, [fullEntry(keychainKey(roots.home, base.signer))]);
  for (const member of council.members) {
    const k = KeyPair.fromRandom('ed25519');
    writeCouncilKey(base.name, member, k, roots.secretsRoot);
    chain.addAccount(member, [fullEntry(k)]);
    keys.push(k);
  }
  chain.addDao(dao, councilPolicy(council.members));
  chain.initV2({ owner: dao, governance_delay_ms: 60_000, issuer_key_delay_ms: 120_000, change_delay_ms: 60_000, paused: false });
  chain.scopes = { s3: sink([['google', NEW], ['google', OLD]]) };
});

const argv = (a: string[]) => parseCli(a, { strings: ['provider', 'member', 'approve-with'], booleans: ['yes'] });
const deps = () => {
  const rpc = chain.rpc();
  return {
    rpc: new Proxy(rpc, {
      get(target, p) {
        rpcCalls++;
        return target[p as keyof typeof target];
      },
    }),
    log: (l: string) => out.push(l),
    home: roots.home,
    secretsRoot: roots.secretsRoot,
    now: () => chain.now,
  };
};

describe('admin console:remove-audience (D416)', () => {
  it('dry run: names the sink, the remove_client proposal and what stays; changes nothing', async () => {
    await consoleRemoveAudienceCmd(m, OLD, argv(['--approve-with', B]), deps());
    const text = out.join('\n');
    expect(text).toContain(`Console sink "s3" holds google/${NEW}, google/${OLD}; google/${OLD} is no longer a console audience.`);
    expect(text).toContain(`remove_client({"scope_id":"s3","auth":"Near","provider":"google","aud":"${OLD}"}) [DAO proposal on ${dao}`);
    expect(text).toContain(`"s3" keeps google/${NEW}`);
    expect(out.at(-1)).toBe(OWNER_DRY_RUN_LINE);
    expect(chain.scopes.s3!.clients).toEqual([['google', NEW], ['google', OLD]]);
  });

  it('--yes --approve-with removes it through the council and confirms on chain', async () => {
    await consoleRemoveAudienceCmd(m, OLD, argv(['--approve-with', B, '--yes']), deps());
    expect(chain.scopes.s3!.clients).toEqual([['google', NEW]]);
    expect(out.at(-1)).toBe(`Done: "s3" holds google/${NEW}. Next: deploy-contract ${m.name} (set_console_audiences to the manifest's list).`);
    for (const s of secretFragments(keys)) expect(out.join('\n')).not.toContain(s);
  });

  it('without --approve-with only proposes (the council votes later)', async () => {
    await consoleRemoveAudienceCmd(m, OLD, argv(['--yes']), deps());
    expect(chain.scopes.s3!.clients).toEqual([['google', NEW], ['google', OLD]]);
    expect(out.at(-1)).toMatch(/^Proposed #0: waiting for 2 more approval\(s\)\./u);
  });

  it('refuses an audience still in consoleAudiences, before reading the chain', async () => {
    const stillListed: Manifest = { ...m, consoleAudiences: [['google', NEW], ['google', OLD]] };
    await expect(consoleRemoveAudienceCmd(stillListed, OLD, argv([]), deps())).rejects.toThrow(/still in envs\/sandbox-dev\.json consoleAudiences: drop it there first/u);
    expect(rpcCalls).toBe(0);
  });

  it('nothing to do for an audience in no scope', async () => {
    await consoleRemoveAudienceCmd(m, 'gone.apps.googleusercontent.com', argv(['--yes']), deps());
    expect(out.at(-1)).toBe(`google/gone.apps.googleusercontent.com is not a client of any scope on ${m.signer}: nothing to do.`);
  });

  it('refuses "global"', async () => {
    chain.scopes = {};
    chain.globalScope = { id: 'global', owners: [{ Near: { account_id: dao } }], clients: [['google', OLD], ['google', 'hana.apps.googleusercontent.com']], allow_shared: true };
    await expect(consoleRemoveAudienceCmd(m, OLD, argv([]), deps())).rejects.toThrow(/is a client of "global", not of a console sink/u);
  });

  it('refuses a scope that is not a Hana console sink: another owner, shared login, or a client that is neither a console audience nor the one retired', async () => {
    const notSinks = [
      sink([['google', NEW], ['google', OLD]], { owners: [{ Near: { account_id: 'mallory.testnet' } }] }),
      sink([['google', NEW], ['google', OLD]], { owners: [{ Near: { account_id: dao } }, { Oidc: { provider: 'google', sub: '1' } }] }),
      sink([['google', NEW], ['google', OLD]], { allow_shared: true }),
      sink([['google', NEW], ['google', OLD], ['google', 'partner.apps.googleusercontent.com']]),
    ];
    for (const s3 of notSinks) {
      chain.scopes = { s3 };
      await expect(consoleRemoveAudienceCmd(m, OLD, argv([]), deps()), JSON.stringify(s3)).rejects.toThrow(/is not a Hana console sink/u);
    }
  });

  it('refuses a sink the manifest owner is not an Owner::Near of (a known Hana account, but not the predecessor)', async () => {
    const accountOwned: Manifest = { ...m, owner: 'hana-id-admin-dev1.testnet', ownerKind: 'account' };
    chain.scopes = { s3: sink([['google', NEW], ['google', OLD]], { owners: [{ Near: { account_id: dao } }] }) };
    await expect(consoleRemoveAudienceCmd(accountOwned, OLD, argv([]), deps())).rejects.toThrow(/not hana-id-admin-dev1\.testnet: remove_client must come from an Owner::Near/u);
  });

  it("refuses the sink's last client", async () => {
    chain.scopes = { s3: sink([['google', OLD]]) };
    await expect(consoleRemoveAudienceCmd(m, OLD, argv([]), deps())).rejects.toThrow(/is the last client of "s3"/u);
  });

  it('refuses malformed input and a missing or extra positional', async () => {
    await expect(consoleRemoveAudienceCmd(m, 'a b', argv([]), deps())).rejects.toThrow('Invalid audience');
    await expect(consoleRemoveAudienceCmd(m, OLD, argv(['--provider', 'x y']), deps())).rejects.toThrow('Invalid provider');
    expect(() => assertCommandPositionals('console:remove-audience', [])).toThrow('console:remove-audience takes exactly one <aud>');
    expect(() => assertCommandPositionals('console:remove-audience', ['a', 'b'])).toThrow('exactly one <aud>');
  });
});
