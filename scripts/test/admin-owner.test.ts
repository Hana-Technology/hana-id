// admin owner:call / owner:vote / owner:proposals / governance:status against the simulated chain.
import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { loadEnv, type Manifest, rsaJwkThumbprint } from '@hana-id/env';
import { KeyPair } from '@near-js/crypto';
import { assertCommandPositionals } from '../lib/admin-args.ts';
import { emailKeyProblem, governanceStatus, governanceStatusCmd, OWNER_DRY_RUN_LINE, ownerCallCmd, ownerProposalsCmd, ownerVoteCmd } from '../lib/admin-owner.ts';
import { parseCli } from '../lib/cli.ts';
import { writeCouncilKey } from '../lib/council.ts';
import { councilPolicy, readPin } from '../lib/sputnik.ts';
import { SimChain } from './sim-chain.ts';
import { fcEntry, fullEntry, keychainKey, NOW, secretFragments, tempRoots, UPDATER, V1_UPDATER } from './sim-fixtures.ts';

const base = loadEnv('sandbox-dev');
const council = base.council!;
const [A, B, C] = council.members as [string, string, string];
const dao = council.dao;
const daoOwned: Manifest = { ...base, owner: dao, ownerKind: 'sputnik' };

let roots: ReturnType<typeof tempRoots>;
let chain: SimChain;
let keys: KeyPair[];
let out: string[];
let rpcCalls: number;

beforeEach(() => {
  published = ['k'];
  roots = tempRoots();
  chain = new SimChain(base.signer, { now: NOW, daoCodeHash: readPin().code_hash });
  keys = [];
  out = [];
  rpcCalls = 0;
  const signerKey = keychainKey(roots.home, base.signer);
  chain.addAccount(base.signer, [fullEntry(signerKey)]);
  for (const member of council.members) {
    const k = KeyPair.fromRandom('ed25519');
    writeCouncilKey(base.name, member, k, roots.secretsRoot);
    chain.addAccount(member, [fullEntry(k)]);
    keys.push(k);
  }
  chain.addDao(dao, councilPolicy(council.members));
  chain.initV2({ owner: dao, governance_delay_ms: 60_000, issuer_key_delay_ms: 120_000, change_delay_ms: 60_000, paused: false });
});

const argv = (a: string[]) =>
  parseCli(a, { strings: ['args', 'gas', 'member', 'approve-with', 'limit'], booleans: ['yes', 'json'] });

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
    fetchJwks: async () => ({ keys: published.map((kid) => ({ kid, kty: 'RSA', alg: 'RS256', use: 'sig', n: 'AQAB', e: 'AQAB' })) }),
  };
};
/** The kids Google's (stub) JWKS publishes (reset in beforeEach). */
let published: string[] = [];

describe('admin owner:call', () => {
  it('without --yes prints the proposal and touches nothing', async () => {
    await ownerCallCmd(daoOwned, 'add_watchdog', argv(['--args', '{"account_id":"w.testnet"}', '--approve-with', B]), deps());
    expect(out.join('\n')).toContain(`add_watchdog({"account_id":"w.testnet"}) [DAO proposal on ${dao} by ${A}, approved by ${A} and ${B} in the same run] on ${base.signer}`);
    expect(out.at(-1)).toBe(OWNER_DRY_RUN_LINE);
    expect(rpcCalls).toBe(0);
  });

  it('--yes --approve-with proposes and approves in one command (dev envs)', async () => {
    await ownerCallCmd(daoOwned, 'add_watchdog', argv(['--args', '{"account_id":"w.testnet"}', '--approve-with', B, '--yes']), deps());
    expect(chain.governance?.watchdogs.map((w) => w.account_id)).toEqual(['w.testnet']);
    expect(out.join('\n')).toContain('Done: proposal #0 approved and executed.');
    for (const s of secretFragments(keys)) expect(out.join('\n')).not.toContain(s);
  });

  it('refuses unknown methods, non-object args, bad gas and positionals', async () => {
    await expect(ownerCallCmd(daoOwned, 'create_session', argv([]), deps())).rejects.toThrow('not an owner method');
    await expect(ownerCallCmd(daoOwned, 'pause', argv(['--args', '[1]']), deps())).rejects.toThrow('--args must be a JSON object');
    await expect(ownerCallCmd(daoOwned, 'pause', argv(['--args', '{x']), deps())).rejects.toThrow('--args must be a JSON object');
    await expect(ownerCallCmd(daoOwned, 'pause', argv(['--gas', '400']), deps())).rejects.toThrow('--gas must be between 1 and 250');
    expect(() => assertCommandPositionals('owner:call', [])).toThrow('owner:call takes exactly one <method>');
    expect(() => assertCommandPositionals('owner:vote', ['1', '2'])).toThrow('exactly one <proposal id>');
    expect(() => assertCommandPositionals('owner:proposals', ['x'])).toThrow('Unexpected argument');
  });
});

describe('admin owner:vote and owner:proposals', () => {
  it('lists proposals and approves one; the second approval executes it', async () => {
    await ownerCallCmd(daoOwned, 'unpause', argv(['--yes']), deps());
    out = [];
    await ownerProposalsCmd(daoOwned, argv([]), deps());
    expect(out.join('\n')).toContain(`#0 InProgress: ${base.signer}.unpause({})`);
    expect(out.join('\n')).toContain('approvals 0/2');
    await ownerVoteCmd(daoOwned, '0', argv(['--member', B]), deps());
    expect(out.at(-1)).toBe(OWNER_DRY_RUN_LINE);
    await ownerVoteCmd(daoOwned, '0', argv(['--member', B, '--yes']), deps());
    expect(out.at(-1)).toBe('#0 is InProgress.');
    await ownerVoteCmd(daoOwned, '0', argv(['--member', B, '--yes']), deps());
    expect(out.at(-1)).toBe(`${B} already approved #0.`);
    await ownerVoteCmd(daoOwned, '0', argv(['--member', C, '--yes']), deps());
    expect(out.at(-1)).toBe('#0 approved and executed.');
    await expect(ownerVoteCmd(daoOwned, '0', argv(['--member', A, '--yes']), deps())).rejects.toThrow('not open for votes');
    await expect(ownerVoteCmd(daoOwned, 'x', argv(['--member', A]), deps())).rejects.toThrow('takes a proposal id');
    out = [];
    await ownerProposalsCmd(daoOwned, argv(['--json']), deps());
    const json = JSON.parse(out.join('\n')) as { proposals: { status: string; calls: { method: string }[] }[] };
    expect(json.proposals[0]).toMatchObject({ status: 'Approved', calls: [{ method: 'unpause' }] });
  });
});

describe('admin governance:status (the batch C portal source)', () => {
  it('reports state and findings as JSON', async () => {
    chain.config = { ...chain.config, paused: true };
    chain.governance!.updater_keys = ['ed25519:tracked'];
    chain.accounts.get(base.signer)!.keys.push(fcEntry('ed25519:stray', base.signer, V1_UPDATER), fcEntry('ed25519:tracked', base.signer, UPDATER));
    chain.governance!.pending_upgrade = { code_hash: 'H', proposed_at_ms: NOW, executable_at_ms: NOW + 1 };
    chain.keyChanges = [{ id: 2, provider: 'google', kid: 'k', op: 'Add', n: 'n', e: 'AQAB', by: base.signer, proposed_at_ms: NOW - 10, executable_at_ms: NOW - 1 }];
    await ownerCallCmd(daoOwned, 'unpause', argv(['--yes']), deps());
    const s = await governanceStatus(daoOwned, deps());
    expect(s.contract.stateVersion).toBe(2);
    expect(s.council?.openProposals.map((p) => p.id)).toEqual([0]);
    expect(s.signerKeys.find((k) => k.publicKey === 'ed25519:tracked')?.tracked).toBe(true);
    // sandbox-dev may keep the signer full-access key (D86): not a finding there.
    expect(s.findings).toEqual([
      expect.stringContaining("function-call key the contract didn't install: ed25519:stray"),
      `${base.signer} is paused.`,
      expect.stringContaining('Upgrade H pending'),
      'No watchdog: every key change waits governance_delay_ms.',
      'Key change #2 (Add google/k) is due and not executed.',
    ]);
    // A watchdog that can't confirm yet doesn't count (the contract treats it as none for new key changes).
    chain.governance!.watchdogs = [{ account_id: 'w.testnet', confirm_from_ms: NOW + 60_000 }];
    expect((await governanceStatus(daoOwned, deps())).findings).toContain(
      `No watchdog may confirm yet (the first from ${new Date(NOW + 60_000).toISOString()}): every key change proposed until then waits governance_delay_ms.`,
    );
    chain.governance!.watchdogs = [{ account_id: 'w.testnet', confirm_from_ms: NOW }];
    expect((await governanceStatus(daoOwned, deps())).findings.join()).not.toContain('No watchdog');
    chain.governance!.watchdogs = [];
    const staging = await governanceStatus({ ...daoOwned, name: 'staging', allowSignerFullAccessKey: undefined }, deps());
    expect(staging.findings.join()).toContain('none allowed on staging, D86');
    // Delays below the non-dev floors (sandbox-dev's 2 min / 60 s on chain) are findings outside dev envs.
    expect(staging.findings.join()).toContain('On chain: issuer_key_delay_ms 120000 ms is below the security bound');
    expect(staging.findings.join()).toContain('On chain: governance_delay_ms 60000 ms is below 24 h');
    // A council DAO reshaped away from the manifest's 2-of-3 council is a finding.
    const shape = chain.daos.get(dao)!;
    shape.policy = { ...shape.policy, default_vote_policy: { ...shape.policy.default_vote_policy, threshold: [1, 3] } };
    expect((await governanceStatus(daoOwned, deps())).findings.join()).toContain(`The council DAO ${dao}: default_vote_policy is`);
    out = [];
    await governanceStatusCmd(daoOwned, argv(['--json']), deps());
    expect(JSON.parse(out.join('\n'))).toMatchObject({ env: 'sandbox-dev', owner: { account: dao, kind: 'sputnik' } });
    out = [];
    await governanceStatusCmd(daoOwned, argv([]), deps());
    expect(out.join('\n')).toContain('Findings:');
  });

  it('flags google keys Google does not publish: active (the attack) and pending', async () => {
    published = ['real'];
    chain.issuer = { iss_values: ['https://accounts.google.com'], kids: ['real', 'forged'] };
    chain.keyChanges = [{ id: 4, provider: 'google', kid: 'forged2', op: 'Add', n: 'n', e: 'AQAB', by: base.signer, proposed_at_ms: NOW, executable_at_ms: NOW + 120_000 }];
    const findings = (await governanceStatus(daoOwned, deps())).findings.join('\n');
    expect(findings).toContain("Active google key forged is not in Google's JWKS");
    expect(findings).toContain("Key change #4 adds google/forged2, which Google doesn't publish");
    expect(findings).not.toContain('key real');
  });

  it('reports an unreadable JWKS instead of skipping the check', async () => {
    chain.issuer = { iss_values: ['https://accounts.google.com'], kids: ['real'] };
    const s = await governanceStatus(daoOwned, { ...deps(), fetchJwks: async () => { throw new Error('GET jwks: HTTP 503'); } });
    expect(s.findings).toContain("Couldn't read Google's JWKS to check the google keys: GET jwks: HTTP 503.");
  });

  it('flags a v1 contract and a missing DAO', async () => {
    chain.governance = null;
    chain.daos.delete(dao);
    chain.accounts.delete(dao);
    const s = await governanceStatus(base, deps());
    expect(s.contract.stateVersion).toBe(1);
    expect(s.findings.join()).toContain('v1 (pre-governance)');
    expect(s.findings.join()).toContain(`The council DAO ${dao} does not exist yet`);
  });
});

describe('owner:call set_issuer_key for email: only a pinned, published, thumbprint-named key (batch 6 review M3)', () => {
  const key = () => {
    const jwk = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 }).publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    return { kty: 'RSA' as const, n: jwk.n, e: jwk.e, kid: rsaJwkThumbprint(jwk), use: 'sig' as const, alg: 'RS256' as const };
  };
  const pub = key();
  const other = key();
  const base = loadEnv('sandbox-dev');
  const m = {
    ...base,
    emailIssuer: { publicKeys: [pub] },
    watchdog: { ...base.watchdog, pinnedIssuerKeys: { email: { required: 1, signers: { hana: [pub.kid] } } } },
  } as unknown as Manifest;
  const args = (k: { kid: string; n: string; e: string }, signer = 'hana'): Record<string, unknown> => ({ provider: 'email', kid: k.kid, n: k.n, e: k.e, signer });

  it('accepts the pinned published key; refuses unpinned, unpublished, misnamed or unsigned ones; ignores other calls', () => {
    expect(emailKeyProblem(m, 'set_issuer_key', args(pub))).toBeNull();
    expect(emailKeyProblem(m, 'set_issuer_key', args(pub, 'cosign'))).toContain('not pinned for signer cosign');
    expect(emailKeyProblem(m, 'set_issuer_key', args(other))).toContain('not pinned');
    const pinnedOther = { ...m, watchdog: { ...m.watchdog, pinnedIssuerKeys: { email: { required: 1, signers: { hana: [pub.kid, other.kid] } } } } } as unknown as Manifest;
    expect(emailKeyProblem(pinnedOther, 'set_issuer_key', args(other))).toContain('not in emailIssuer.publicKeys');
    expect(emailKeyProblem(pinnedOther, 'set_issuer_key', { ...args(other), kid: pub.kid })).toContain('thumbprint');
    const { signer: _s, ...unsigned } = args(pub);
    expect(emailKeyProblem(m, 'set_issuer_key', unsigned)).toContain('signer');
    const { pinnedIssuerKeys: _pins, ...unpinned } = base.watchdog!;
    expect(emailKeyProblem({ ...m, watchdog: unpinned } as Manifest, 'set_issuer_key', args(pub))).toContain('no watchdog.pinnedIssuerKeys.email');
    expect(emailKeyProblem(m, 'set_issuer_key', { ...args(other), provider: 'google' })).toBeNull();
    expect(emailKeyProblem(m, 'mark_self_issued', { provider: 'email' })).toBeNull();
  });
});
