import { describe, expect, it } from 'vitest';
import { loadEnv } from '@hana-id/env';
import { OWNER_RELAYER_METHODS, SESSION_RELAYER_METHODS, sharedClientsOf } from '../lib/contract.ts';
import { buildDeployPlan, checkFunctionKey, type DeployObserved, type DeployOptions, type DeployStep, describeStep } from '../lib/deploy-plan.ts';
import { type AccessKeyListEntry, EMPTY_CODE_HASH } from '../lib/near.ts';
import { POOL_METHODS as API_POOL_METHODS } from '../../apps/api/src/relayer-config.ts';

const base = {
  ...loadEnv('sandbox-dev'),
  // The Google fields as an undeployed manifest has them; the real envs/sandbox-dev.json changes as it is deployed.
  googleClientIds: ['UNSET.apps.googleusercontent.com'],
  sharedGoogleClientIds: ['UNSET-shared.apps.googleusercontent.com'],
  consoleAudiences: [],
};
const SHARED = 'shared.apps.googleusercontent.com';
const m = { ...base, googleClientIds: ['hana.apps.googleusercontent.com'], sharedGoogleClientIds: [SHARED] };
const NEAR = 10n ** 24n;

/** Batch B allowlist state 1 (docs/batch-b-spec.md, "Relayer allowlists"). */
const SESSION = ['create_session', 'create_session_and_derive', 'derive_key', 'revoke_session', 'prune_sessions'];
const OWNER = ['propose_change', 'cancel_change', 'remove_client', 'disable_shared_login', 'execute_change', 'register_scope', 'apply_pending_config'];
const UPDATER = ['set_issuer_key', 'remove_issuer_key'];
/** Batch A's single relayer pool. */
const BATCH_A = ['create_session', 'derive_key', 'revoke_session', 'prune_sessions', 'register_scope', 'propose_change', 'cancel_change', 'remove_client', 'execute_change'];

/** A function-call key; the default allowance (0.1 NEAR, partly spent) is below every configured maximum. */
const fc = (public_key: string, receiver_id: string, method_names: string[], allowance: string | null = String(NEAR / 10n)): AccessKeyListEntry => ({
  public_key,
  access_key: { nonce: 1, permission: { FunctionCall: { allowance, receiver_id, method_names } } },
});
const full = (public_key: string): AccessKeyListEntry => ({ public_key, access_key: { nonce: 1, permission: 'FullAccess' } });

const deployedSigner = { exists: true, balanceYocto: 10n * NEAR, codeHash: 'abc' };
const configOk = {
  owner: m.owner,
  mpc: m.mpc,
  ckd_domain_id: 2,
  sponsors: [m.relayer],
  change_delay_ms: m.changeDelayMs,
  console_audiences: [],
  shared_clients: [['google', SHARED]] as [string, string][],
  pending_shared_clients: [],
};

function fresh(over: Partial<DeployObserved> = {}): DeployObserved {
  const acct = { exists: true, balanceYocto: 10n * NEAR, codeHash: EMPTY_CODE_HASH };
  const cred = { found: true, publicKey: 'ed25519:K', fullAccessOnChain: true };
  return {
    chainId: 'testnet',
    accounts: { signer: acct, relayer: acct, owner: acct },
    credentials: { signer: cred, relayer: cred, owner: cred },
    config: null,
    relayerAccessKeys: [],
    signerAccessKeys: [],
    poolKeysInFile: { session: [], owner: [] },
    updaterKeyInFile: null,
    googleIssuer: null,
    globalScope: null,
    sharedClientScopes: {},
    wasmBytes: null,
    ...over,
  };
}

/** A deployed, fully configured env; override pieces to test one thing. */
function deployed(over: Partial<DeployObserved> = {}): DeployObserved {
  return fresh({
    accounts: { signer: deployedSigner, relayer: fresh().accounts.relayer, owner: fresh().accounts.owner },
    config: configOk,
    relayerAccessKeys: [full('ed25519:R'), fc('ed25519:s1', m.signer, SESSION), fc('ed25519:s2', m.signer, SESSION), fc('ed25519:s3', m.signer, SESSION), fc('ed25519:o1', m.signer, OWNER)],
    signerAccessKeys: [full('ed25519:S'), fc('ed25519:U', m.signer, UPDATER)],
    poolKeysInFile: { session: ['ed25519:s1', 'ed25519:s2', 'ed25519:s3'], owner: ['ed25519:o1'] },
    updaterKeyInFile: 'ed25519:U',
    googleIssuer: { iss_values: ['accounts.google.com', 'https://accounts.google.com'], kids: [] },
    globalScope: { id: 'global' },
    sharedClientScopes: { [SHARED]: null },
    ...over,
  });
}

const opts: DeployOptions = {
  pools: { session: { count: 3, allowanceYocto: 2n * NEAR }, owner: { count: 1, allowanceYocto: NEAR / 2n } },
  updaterAllowanceYocto: NEAR,
  upgrade: false,
  skipBuild: false,
};

const pool = (steps: DeployStep[], p: 'session' | 'owner') => steps.find((s) => s.kind === 'relayer-keys' && s.pool === p);

describe('buildDeployPlan', () => {
  it('plans a full fresh deploy in order', () => {
    const p = buildDeployPlan(m, fresh(), opts);
    expect(p.blockers).toEqual([]);
    expect(p.steps.map((s) => s.kind)).toEqual(['build', 'deploy', 'relayer-keys', 'relayer-keys', 'updater-key', 'set-issuer', 'set-sponsors', 'set-shared-clients', 'register-global']);
    expect(p.steps[1]).toEqual({ kind: 'deploy', init: { owner: m.owner, mpc: m.mpc, ckd_domain_id: 2, change_delay_ms: m.changeDelayMs } });
    expect(p.steps[2]).toEqual({ kind: 'relayer-keys', pool: 'session', generate: 3, reuse: [], methods: SESSION, allowanceYocto: 2n * NEAR });
    expect(p.steps[3]).toEqual({ kind: 'relayer-keys', pool: 'owner', generate: 1, reuse: [], methods: OWNER, allowanceYocto: NEAR / 2n });
    expect(p.steps[4]).toMatchObject({ kind: 'updater-key', reuse: null, methods: UPDATER });
    expect(p.steps[5]).toEqual({ kind: 'set-issuer', provider: 'google', iss_values: ['https://accounts.google.com', 'accounts.google.com'] });
    expect(p.steps[6]).toEqual({ kind: 'set-sponsors', sponsors: [m.relayer] });
    expect(p.steps[7]).toEqual({ kind: 'set-shared-clients', clients: [['google', SHARED]], added: [['google', SHARED]], removed: [] });
    expect(p.steps[8]).toEqual({ kind: 'register-global', owners: [{ Near: { account_id: m.owner } }], clients: [['google', 'hana.apps.googleusercontent.com']], allowShared: false });
  });

  it('pool method lists are exactly the spec lists, and disjoint', () => {
    expect([...SESSION_RELAYER_METHODS]).toEqual(SESSION);
    expect([...OWNER_RELAYER_METHODS]).toEqual(OWNER);
    expect(SESSION.filter((x) => OWNER.includes(x))).toEqual([]);
  });

  it('the API relays exactly the methods the deployed access keys allow, per pool', () => {
    expect([...API_POOL_METHODS.session].sort()).toEqual([...SESSION_RELAYER_METHODS].sort());
    expect([...API_POOL_METHODS.owner].sort()).toEqual([...OWNER_RELAYER_METHODS].sort());
  });

  it('uses each pool its own count and allowance', () => {
    const p = buildDeployPlan(m, fresh(), { ...opts, pools: { session: { count: 5, allowanceYocto: 3n * NEAR }, owner: { count: 2, allowanceYocto: NEAR / 10n } } });
    expect(pool(p.steps, 'session')).toMatchObject({ generate: 5, allowanceYocto: 3n * NEAR });
    expect(pool(p.steps, 'owner')).toMatchObject({ generate: 2, allowanceYocto: NEAR / 10n });
  });

  // Steps hold public keys only; that no secret reaches the output is checked end to end in deploy-run.test.ts.
  it('descriptions name accounts, pools, files and arguments', () => {
    const p = buildDeployPlan(m, fresh(), opts);
    const text = p.steps.map((s) => describeStep(m, s)).join('\n');
    expect(text).toContain(m.signer);
    expect(text).toContain(`Add 3 session-pool function-call key(s)`);
    expect(text).toContain(`generate 3 new key(s) into .secrets/${m.name}/relayer-keys.json`);
    expect(text).toContain(`generate 1 new key(s) into .secrets/${m.name}/owner-relayer-keys.json`);
    expect(text).toContain(`methods ${OWNER.join(', ')}`);
    expect(text).toContain(`set_shared_clients({"clients":[["google","${SHARED}"]]}) (adds google/${SHARED} after the ${m.changeDelayMs} ms timelock)`);
    expect(text).toContain('"scope_id":"global","allow_shared":false');
  });

  it('plans nothing when everything is in place', () => {
    const p = buildDeployPlan(m, deployed(), opts);
    expect(p.blockers).toEqual([]);
    expect(p.warnings).toEqual([]);
    expect(p.steps).toEqual([]);
    expect(p.done).toContain('3 session-pool relayer key(s) in place.');
    expect(p.done).toContain('1 owner-pool relayer key(s) in place.');
    expect(p.done).toContain(`Shared clients set: google/${SHARED}.`);
  });

  it('resumes a partial deploy: re-adds saved keys, tops each pool up to its count', () => {
    const p = buildDeployPlan(
      m,
      deployed({
        relayerAccessKeys: [fc('ed25519:s1', m.signer, SESSION)],
        signerAccessKeys: [],
        poolKeysInFile: { session: ['ed25519:s1', 'ed25519:s2'], owner: ['ed25519:o1'] },
      }),
      { ...opts, pools: { ...opts.pools, session: { count: 4, allowanceYocto: 2n * NEAR } } },
    );
    expect(p.blockers).toEqual([]);
    expect(p.steps.map((s) => s.kind)).toEqual(['relayer-keys', 'relayer-keys', 'updater-key']);
    expect(pool(p.steps, 'session')).toMatchObject({ reuse: ['ed25519:s2'], generate: 2 });
    expect(pool(p.steps, 'owner')).toMatchObject({ reuse: ['ed25519:o1'], generate: 0 });
    expect(p.steps[2]).toMatchObject({ reuse: 'ed25519:U' });
  });

  describe('access key permissions', () => {
    it('blocks on file keys with the wrong receiver, wrong methods, ANY method, or full access', () => {
      const p = buildDeployPlan(
        m,
        deployed({
          relayerAccessKeys: [
            fc('ed25519:s1', m.signer, SESSION),
            fc('ed25519:s2', 'old-signer.testnet', SESSION),
            fc('ed25519:s3', m.signer, BATCH_A),
            fc('ed25519:o1', m.signer, []),
            full('ed25519:o2'),
            full('ed25519:9'),
          ],
          poolKeysInFile: { session: ['ed25519:s1', 'ed25519:s2', 'ed25519:s3', 'ed25519:s4'], owner: ['ed25519:o1', 'ed25519:o2'] },
        }),
        opts,
      );
      const text = p.blockers.join('\n');
      expect(text).toContain(`relayer-keys.json holds 2 key(s) that are on ${m.relayer} with the wrong permission for the session pool`);
      expect(text).toContain(`ed25519:s2 is a function-call key for old-signer.testnet (methods ${SESSION.join(', ')}), not for ${m.signer}`);
      expect(text).toContain(`ed25519:s3 has methods ${BATCH_A.join(', ')}; expected ${SESSION.join(', ')}`);
      expect(text).toContain(`owner-relayer-keys.json holds 2 key(s)`);
      expect(text).toContain(`ed25519:o1 may call ANY method on ${m.signer} (empty method list)`);
      expect(text).toContain('ed25519:o2 is a full-access key');
      expect(text).not.toContain('ed25519:9'); // not in a file: not ours to mention
      expect(text).toContain(`near account delete-keys ${m.relayer}`);
      expect(text).not.toContain('ed25519:s1 ');
      // Only the genuinely absent key would be re-added; no pool counts as "in place".
      expect(pool(p.steps, 'session')).toMatchObject({ reuse: ['ed25519:s4'], generate: 0 });
      expect(p.done.join()).not.toContain('owner-pool relayer key(s) in place');
    });

    it('blocks a key listed in both pool files', () => {
      const p = buildDeployPlan(m, deployed({ poolKeysInFile: { session: ['ed25519:s1', 'ed25519:s2', 'ed25519:s3'], owner: ['ed25519:o1', 'ed25519:s1'] } }), opts);
      expect(p.blockers.join()).toContain('ed25519:s1 is in both');
    });

    it('blocks stray ANY-method keys for the signer; only warns about other strays', () => {
      const p = buildDeployPlan(m, deployed({ relayerAccessKeys: [...deployed().relayerAccessKeys, fc('ed25519:x', m.signer, []), fc('ed25519:y', m.signer, ['create_session']), fc('ed25519:z', 'other.testnet', [])] }), opts);
      expect(p.blockers.join()).toContain('ed25519:x (a function-call key for');
      expect(p.blockers.join()).not.toContain('ed25519:y');
      expect(p.warnings.join()).toContain('ed25519:y (a function-call key for');
      expect(p.warnings.join()).toContain(`delete it: near account delete-keys ${m.relayer} public-keys ed25519:y `);
      expect(p.blockers.join() + p.warnings.join()).not.toContain('ed25519:z'); // another receiver: not this deploy's business
    });

    it('checks the keys-updater key and blocks other signer keys that can rotate issuer keys', () => {
      const wrong = buildDeployPlan(m, deployed({ signerAccessKeys: [fc('ed25519:U', m.signer, [])] }), opts);
      expect(wrong.blockers.join()).toContain('keys-updater.json (ed25519:U) may call ANY method');
      expect(wrong.steps.map((s) => s.kind)).not.toContain('updater-key');
      const extraMethod = buildDeployPlan(m, deployed({ signerAccessKeys: [fc('ed25519:U', m.signer, [...UPDATER, 'set_owner'])] }), opts);
      expect(extraMethod.blockers.join()).toContain('has methods set_issuer_key, remove_issuer_key, set_owner');
      const stray = buildDeployPlan(m, deployed({ signerAccessKeys: [...deployed().signerAccessKeys, fc('ed25519:old', m.signer, UPDATER), fc('ed25519:v', m.signer, ['get_config'])] }), opts);
      expect(stray.blockers.join()).toContain('ed25519:old (a function-call key for');
      expect(stray.blockers.join()).toContain('can rotate issuer keys');
      expect(stray.warnings.join()).toContain('ed25519:v');
    });

    it('checkFunctionKey', () => {
      const keys = [fc('ed25519:a', 'x.testnet', ['b', 'a']), fc('ed25519:b', 'x.testnet', []), full('ed25519:c'), fc('ed25519:d', 'y.testnet', ['a', 'b'])];
      const max = NEAR;
      expect(checkFunctionKey(keys, 'ed25519:a', 'x.testnet', ['a', 'b'], max)).toEqual({ kind: 'ok' });
      expect(checkFunctionKey(keys, 'ed25519:a', 'x.testnet', ['a'], max)).toMatchObject({ kind: 'mismatch' });
      expect(checkFunctionKey(keys, 'ed25519:a', 'x.testnet', ['a', 'b', 'c'], max)).toMatchObject({ kind: 'mismatch' });
      expect(checkFunctionKey(keys, 'ed25519:b', 'x.testnet', ['a', 'b'], max)).toMatchObject({ kind: 'mismatch', reason: expect.stringContaining('ANY method') });
      expect(checkFunctionKey(keys, 'ed25519:c', 'x.testnet', ['a', 'b'], max)).toMatchObject({ kind: 'mismatch', reason: 'is a full-access key' });
      expect(checkFunctionKey(keys, 'ed25519:d', 'x.testnet', ['a', 'b'], max)).toMatchObject({ kind: 'mismatch', reason: expect.stringContaining('not for x.testnet') });
      expect(checkFunctionKey(keys, 'ed25519:e', 'x.testnet', ['a', 'b'], max)).toEqual({ kind: 'absent' });
    });

    it('checkFunctionKey bounds the allowance: unlimited or above the maximum is a mismatch, spent-down is fine', () => {
      const keys = [
        fc('ed25519:unlimited', 'x.testnet', ['a'], null),
        fc('ed25519:big', 'x.testnet', ['a'], String(50n * NEAR)),
        fc('ed25519:exact', 'x.testnet', ['a'], String(NEAR)),
        fc('ed25519:spent', 'x.testnet', ['a'], '1'),
      ];
      expect(checkFunctionKey(keys, 'ed25519:unlimited', 'x.testnet', ['a'], NEAR)).toMatchObject({ kind: 'mismatch', reason: expect.stringContaining('unlimited allowance') });
      expect(checkFunctionKey(keys, 'ed25519:big', 'x.testnet', ['a'], NEAR)).toMatchObject({ kind: 'mismatch', reason: expect.stringContaining('expected at most') });
      expect(checkFunctionKey(keys, 'ed25519:exact', 'x.testnet', ['a'], NEAR)).toEqual({ kind: 'ok' });
      expect(checkFunctionKey(keys, 'ed25519:spent', 'x.testnet', ['a'], NEAR)).toEqual({ kind: 'ok' });
    });

    it('does not count a pool key with an unlimited or too-large allowance as in place', () => {
      const p = buildDeployPlan(
        m,
        deployed({
          relayerAccessKeys: [
            full('ed25519:R'),
            fc('ed25519:s1', m.signer, SESSION),
            fc('ed25519:s2', m.signer, SESSION),
            fc('ed25519:s3', m.signer, SESSION, String(3n * NEAR)),
            fc('ed25519:o1', m.signer, OWNER, null),
          ],
        }),
        opts,
      );
      const text = p.blockers.join('\n');
      expect(text).toContain('owner-relayer-keys.json holds 1 key(s)');
      expect(text).toContain('ed25519:o1 has an unlimited allowance');
      expect(text).toContain('relayer-keys.json holds 1 key(s)');
      expect(text).toContain('ed25519:s3 has an allowance of');
      expect(text).toContain(`near account delete-keys ${m.relayer} public-keys ed25519:o1 `);
      expect(p.done.join()).not.toContain('owner-pool relayer key(s) in place');
      expect(p.done.join()).not.toContain('session-pool relayer key(s) in place');
    });

    it('does not count a keys-updater key with an unlimited allowance as in place', () => {
      const p = buildDeployPlan(m, deployed({ signerAccessKeys: [full('ed25519:S'), fc('ed25519:U', m.signer, UPDATER, null)] }), opts);
      expect(p.blockers.join()).toContain('keys-updater.json (ed25519:U) has an unlimited allowance');
      expect(p.done).not.toContain('Keys-updater key in place.');
    });

    it('blocks stray keys that mix session and owner methods (e.g. batch A keys left after moving the file aside)', () => {
      // The pool file was moved aside: new keys are in the file, the old batch A keys are still on chain.
      const p = buildDeployPlan(m, deployed({ relayerAccessKeys: [...deployed().relayerAccessKeys, fc('ed25519:a1', m.signer, BATCH_A), fc('ed25519:a2', m.signer, ['derive_key', 'execute_change'])] }), opts);
      const text = p.blockers.join('\n');
      expect(text).toContain('ed25519:a1 (a function-call key for');
      expect(text).toContain('may call methods of both pools');
      expect(text).toContain(`near account delete-keys ${m.relayer} public-keys ed25519:a1 `);
      expect(text).toContain(`near account delete-keys ${m.relayer} public-keys ed25519:a2 `);
      expect(p.warnings.join()).not.toContain('ed25519:a1');
    });

    it('the move-aside advice says to delete the old keys too', () => {
      const p = buildDeployPlan(m, deployed({ relayerAccessKeys: [full('ed25519:R'), fc('ed25519:s1', m.signer, BATCH_A), fc('ed25519:s2', m.signer, SESSION), fc('ed25519:s3', m.signer, SESSION), fc('ed25519:o1', m.signer, OWNER)] }), opts);
      const text = p.blockers.join('\n');
      expect(text).toContain(`near account delete-keys ${m.relayer} public-keys ed25519:s1 `);
      expect(text).toContain('Delete them even if you instead move');
    });
  });

  describe('shared clients', () => {
    it('skips set_shared_clients while sharedGoogleClientIds is a placeholder', () => {
      const p = buildDeployPlan({ ...m, sharedGoogleClientIds: ['UNSET-shared.apps.googleusercontent.com'] }, fresh(), opts);
      expect(p.steps.map((s) => s.kind)).not.toContain('set-shared-clients');
      expect(p.warnings.join()).toContain('sharedGoogleClientIds is a placeholder');
    });

    it('counts pending additions as set, and shows when they apply', () => {
      // hana-signer's get_config shape.
      const config = { ...configOk, shared_clients: [], pending_shared_clients: [{ provider: 'google', aud: SHARED, effective_at_ms: 1_800_000_000_000 }] };
      const p = buildDeployPlan(m, deployed({ config }), opts);
      expect(p.steps).toEqual([]);
      expect(p.done.join()).toContain(`pending: google/${SHARED} from 2027-01-15T08:00:00.000Z`);
    });

    it('replaces the list when the manifest changes: removals and additions', () => {
      const p = buildDeployPlan({ ...m, sharedGoogleClientIds: ['new.apps'] }, deployed(), opts);
      expect(p.steps).toEqual([{ kind: 'set-shared-clients', clients: [['google', 'new.apps']], added: [['google', 'new.apps']], removed: [['google', SHARED]] }]);
      expect(describeStep(m, p.steps[0]!)).toContain(`removes google/${SHARED} at once`);
      const cleared = buildDeployPlan({ ...m, sharedGoogleClientIds: [] }, deployed(), opts);
      expect(cleared.steps).toEqual([{ kind: 'set-shared-clients', clients: [], added: [], removed: [['google', SHARED]] }]);
      const none = buildDeployPlan({ ...m, sharedGoogleClientIds: [] }, deployed({ config: { ...configOk, shared_clients: [] } }), opts);
      expect(none.steps).toEqual([]);
    });

    it('blocks a shared client that is registered as a scope client', () => {
      const p = buildDeployPlan(m, deployed({ config: { ...configOk, shared_clients: [] }, sharedClientScopes: { [SHARED]: 's4' } }), opts);
      expect(p.blockers.join()).toContain(`Shared client ${SHARED} is registered as a client of scope "s4"`);
    });

    it('blocks on a contract without shared clients, unless --upgrade (then warns)', () => {
      const { shared_clients: _s, pending_shared_clients: _p, ...old } = configOk;
      const p = buildDeployPlan(m, deployed({ config: old }), opts);
      expect(p.blockers.join()).toContain('predates batch A.2');
      expect(p.steps.find((s) => s.kind === 'set-shared-clients')).toMatchObject({ added: [['google', SHARED]] });
      const up = buildDeployPlan(m, deployed({ config: old }), { ...opts, upgrade: true, skipBuild: true });
      expect(up.blockers).toEqual([]);
      expect(up.warnings.join()).toContain('must be able to read the old state');
    });

    it('reads the plausible get_config shapes for pending additions', () => {
      const c = (pending: unknown) => sharedClientsOf({ shared_clients: [['google', 'a']], pending_shared_clients: pending });
      expect(c([['google', 'b']])).toEqual({ effective: [['google', 'a']], pending: [{ client: ['google', 'b'], unlockAtMs: null }] });
      expect(c([{ provider: 'google', aud: 'b', effective_at_ms: 5 }])?.pending).toEqual([{ client: ['google', 'b'], unlockAtMs: 5 }]);
      expect(c([{ provider: 'google', aud: 'b', unlock_at_ms: 6 }])?.pending).toEqual([{ client: ['google', 'b'], unlockAtMs: 6 }]);
      expect(c({ clients: [['google', 'b']], unlock_at_ms: 7 })?.pending).toEqual([{ client: ['google', 'b'], unlockAtMs: 7 }]);
      expect(sharedClientsOf({ shared_clients: [], shared_clients_pending: [{ client: ['google', 'b'], unlock_at_ms: 9 }] })?.pending).toEqual([{ client: ['google', 'b'], unlockAtMs: 9 }]);
      expect(sharedClientsOf({ shared_clients: [] })).toEqual({ effective: [], pending: [] });
      expect(sharedClientsOf({})).toBeNull();
      expect(() => c([42])).toThrow('Unexpected pending shared clients');
    });
  });

  it('--upgrade redeploys code without init', () => {
    const p = buildDeployPlan(m, deployed(), { ...opts, upgrade: true, skipBuild: true });
    expect(p.steps).toEqual([{ kind: 'deploy', init: null }]);
  });

  it('blocks on missing accounts, missing keys, wrong chain, foreign code and owner mismatch', () => {
    const missing = buildDeployPlan(m, fresh({ accounts: { ...fresh().accounts, relayer: { exists: false, balanceYocto: 0n, codeHash: '' } } }), opts);
    expect(missing.blockers.join('\n')).toContain('create-account sponsor-by-faucet-service');
    const noKey = buildDeployPlan(m, fresh({ credentials: { ...fresh().credentials, owner: { found: false, fullAccessOnChain: false } } }), opts);
    expect(noKey.blockers.join('\n')).toContain('.near-credentials');
    const fnKey = buildDeployPlan(m, fresh({ credentials: { ...fresh().credentials, signer: { found: true, publicKey: 'ed25519:X', fullAccessOnChain: false } } }), opts);
    expect(fnKey.blockers.join('\n')).toContain('not a full-access key');
    expect(buildDeployPlan(m, fresh({ chainId: 'mainnet' }), opts).blockers.join()).toContain('not testnet');
    const foreign = buildDeployPlan(m, fresh({ accounts: { ...fresh().accounts, signer: deployedSigner } }), opts);
    expect(foreign.blockers.join()).toContain('fresh signer account');
    const owner = buildDeployPlan(m, fresh({ config: { ...configOk, owner: 'someone.testnet' } }), opts);
    expect(owner.blockers.join()).toContain('Contract owner is someone.testnet');
    expect(buildDeployPlan({ ...m, relayer: m.signer }, fresh(), opts).blockers.join()).toContain('three different accounts');
  });

  it('skips the global scope while googleClientIds is a placeholder', () => {
    const p = buildDeployPlan(base, fresh(), opts);
    expect(p.steps.map((s) => s.kind)).not.toContain('register-global');
    expect(p.warnings.join()).toContain('googleClientIds');
  });

  it('sets console audiences when the manifest has them', () => {
    const p = buildDeployPlan({ ...m, consoleAudiences: [['google', 'console.apps.googleusercontent.com']] }, fresh(), opts);
    expect(p.steps).toContainEqual({ kind: 'set-console-audiences', audiences: [['google', 'console.apps.googleusercontent.com']] });
  });

  it('registers console audiences in the global scope (deduplicated) so no scope owner can claim them', () => {
    const aud: [string, string][] = [['google', 'console.apps.googleusercontent.com'], ['google', 'hana.apps.googleusercontent.com']];
    const p = buildDeployPlan({ ...m, consoleAudiences: aud }, fresh(), opts);
    expect(p.steps).toContainEqual({
      kind: 'register-global',
      owners: [{ Near: { account_id: m.owner } }],
      clients: [['google', 'hana.apps.googleusercontent.com'], ['google', 'console.apps.googleusercontent.com']],
      allowShared: false,
    });
  });

  it('warns when an existing global scope lacks a console audience', () => {
    const aud: [string, string][] = [['google', 'console.apps.googleusercontent.com']];
    const missing = buildDeployPlan({ ...m, consoleAudiences: aud }, fresh({ globalScope: { id: 'global', clients: [['google', 'hana.apps.googleusercontent.com']] } }), opts);
    expect(missing.warnings.join()).toContain('google/console.apps.googleusercontent.com');
    const present = buildDeployPlan({ ...m, consoleAudiences: aud }, fresh({ globalScope: { id: 'global', clients: aud } }), opts);
    expect(present.warnings.join()).not.toContain('Console audience');
  });

  it('warns when the signer balance looks too low for the wasm', () => {
    const p = buildDeployPlan(m, fresh({ wasmBytes: 400_000, accounts: { ...fresh().accounts, signer: { exists: true, balanceYocto: 2n * NEAR, codeHash: EMPTY_CODE_HASH } } }), opts);
    expect(p.warnings.join()).toContain('locks');
  });
});
