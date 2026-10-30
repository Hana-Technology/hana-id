import { describe, expect, it } from 'vitest';
import { loadEnv } from '@hana-id/env';
import { OWNER_RELAYER_METHODS, SESSION_RELAYER_METHODS, sharedClientsOf } from '../lib/contract.ts';
import { type GovernanceView, UPDATER_METHODS } from '../lib/contract.ts';
import { buildDeployPlan, checkFunctionKey, creationPlan, type DeployObserved, type DeployOptions, type DeployStep, describeStep, CLOCK_MARGIN_MS, signerFullAccessAllowed } from '../lib/deploy-plan.ts';
import { type AccessKeyListEntry, EMPTY_CODE_HASH } from '../lib/near.ts';
import { POOL_METHODS as API_POOL_METHODS } from '../../apps/api/src/relayer-config.ts';
import { councilPolicy } from '../lib/sputnik.ts';
import { ACCOUNT_OWNER } from './sim-fixtures.ts';

const base = {
  ...loadEnv('sandbox-dev'),
  ...ACCOUNT_OWNER,
  // The Google fields as an undeployed manifest has them; the real envs/sandbox-dev.json changes as it is deployed.
  googleClientIds: ['UNSET.apps.googleusercontent.com'],
  sharedGoogleClientIds: ['UNSET-shared.apps.googleusercontent.com'],
  consoleAudiences: [],
};
const SHARED = 'shared.apps.googleusercontent.com';
const m = { ...base, googleClientIds: ['hana.apps.googleusercontent.com'], sharedGoogleClientIds: [SHARED] };
const NEAR = 10n ** 24n;
/** Delays at least the non-dev floors (@hana-id/env governanceDelayProblems): 2 h and 72 h, as mainnet (D80). */
const PROD_DELAYS = { issuerKeyDelayMs: 7_200_000, governanceDelayMs: 259_200_000 };

/** Batch B allowlist state 1 (docs/batch-b-spec.md, "Relayer allowlists"). */
const SESSION = ['create_session', 'create_session_and_derive', 'derive_key', 'revoke_session', 'prune_sessions'];
const OWNER = ['propose_change', 'cancel_change', 'remove_client', 'disable_shared_login', 'execute_change', 'register_scope', 'apply_pending_config'];
/** The governance contract's updater key methods (its UPDATER_METHODS) and the v1 key's. */
const UPDATER = ['set_issuer_key', 'propose_issuer_key_removal', 'execute_issuer_key_change'];
const V1_UPDATER = ['set_issuer_key', 'remove_issuer_key'];
const WATCHDOG = m.watchdogs![0]!;
const SPUTNIK_HASH = 'AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH';
const NOW = 1_800_000_000_000;
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
  issuer_key_delay_ms: m.issuerKeyDelayMs,
  pending_issuer_key_delay: null,
  governance_delay_ms: m.governanceDelayMs,
  pending_governance_delay: null,
  paused: false,
};
/** The v1 (batch B) get_config: no governance fields. */
const { issuer_key_delay_ms: _i, pending_issuer_key_delay: _pi, governance_delay_ms: _g, pending_governance_delay: _pg, paused: _p, ...configV1 } = configOk;

const govOk: GovernanceView = {
  state_version: 2,
  watchdogs: [{ account_id: WATCHDOG, confirm_from_ms: NOW - 1 }],
  keys_slow_until_ms: 0,
  updater_keys: ['ed25519:U'],
  updater_methods: UPDATER,
  pending_upgrade: null,
  pending_owner: null,
  pending_withdrawal: null,
};

function fresh(over: Partial<DeployObserved> = {}): DeployObserved {
  const acct = { exists: true, balanceYocto: 10n * NEAR, codeHash: EMPTY_CODE_HASH };
  const cred = { found: true, publicKey: 'ed25519:K', fullAccessOnChain: true };
  return {
    chainId: 'testnet',
    nowMs: NOW,
    accounts: { signer: acct, relayer: acct, owner: acct },
    credentials: { signer: cred, relayer: cred, owner: cred },
    config: null,
    governance: null,
    relayerAccessKeys: [],
    signerAccessKeys: [full('ed25519:S')],
    poolKeysInFile: { session: [], owner: [] },
    updaterKeyInFile: null,
    googleIssuer: null,
    globalScope: null,
    sharedClientScopes: {},
    wasmBytes: null,
    wasmCodeHash: null,
    watchdogAccounts: { [WATCHDOG]: true },
    councilDao: { exists: true, codeHash: SPUTNIK_HASH, policy: councilPolicy(m.council!.members) },
    councilKeys: Object.fromEntries(m.council!.members.map((a) => [a, true])),
    ...over,
  };
}

/** A deployed (governance contract), fully configured env; override pieces to test one thing. */
function deployed(over: Partial<DeployObserved> = {}): DeployObserved {
  return fresh({
    accounts: { signer: deployedSigner, relayer: fresh().accounts.relayer, owner: fresh().accounts.owner },
    config: configOk,
    governance: govOk,
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

/** The same env still on the v1 contract (batch B): no get_governance, the hand-added v1 updater key. */
function deployedV1(over: Partial<DeployObserved> = {}): DeployObserved {
  return deployed({ config: configV1, governance: null, signerAccessKeys: [full('ed25519:S'), fc('ed25519:U', m.signer, V1_UPDATER)], ...over });
}

const opts: DeployOptions = {
  pools: { session: { count: 3, allowanceYocto: 2n * NEAR }, owner: { count: 1, allowanceYocto: NEAR / 2n } },
  upgrade: false,
  skipBuild: false,
  transferOwner: false,
  ownerTx: {},
  sputnikCodeHash: SPUTNIK_HASH,
};

const pool = (steps: DeployStep[], p: 'session' | 'owner') => steps.find((s) => s.kind === 'relayer-keys' && s.pool === p);

describe('buildDeployPlan', () => {
  it('plans a full fresh deploy in order', () => {
    const p = buildDeployPlan(m, fresh(), opts);
    expect(p.blockers).toEqual([]);
    expect(p.steps.map((s) => s.kind)).toEqual(['build', 'deploy', 'relayer-keys', 'relayer-keys', 'add-updater-key', 'set-issuer', 'set-sponsors', 'set-shared-clients', 'register-global']);
    expect(p.steps[1]).toEqual({
      kind: 'deploy',
      init: {
        owner: m.owner,
        mpc: m.mpc,
        ckd_domain_id: 2,
        change_delay_ms: m.changeDelayMs,
        issuer_key_delay_ms: 120_000,
        governance_delay_ms: 60_000,
        watchdogs: [WATCHDOG],
        updater_keys: [],
      },
    });
    expect(p.steps[2]).toEqual({ kind: 'relayer-keys', pool: 'session', generate: 3, reuse: [], methods: SESSION, allowanceYocto: 2n * NEAR });
    expect(p.steps[3]).toEqual({ kind: 'relayer-keys', pool: 'owner', generate: 1, reuse: [], methods: OWNER, allowanceYocto: NEAR / 2n });
    // The updater key is installed by the contract (add_updater_key, owner), never added by hand.
    expect(p.steps[4]).toEqual({ kind: 'add-updater-key', reuse: null });
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
    expect(text).toContain(`set_shared_clients({"clients":[["google","${SHARED}"]]}) [signed by ${m.owner}] (adds google/${SHARED} after the ${m.changeDelayMs} ms timelock)`);
    expect(text).toContain('"scope_id":"global","allow_shared":false');
    expect(text).toContain(`add_updater_key({"public_key":"<new key in keys-updater.json>"}) [signed by ${m.owner}]`);
    expect(text).toContain(`generated into .secrets/${m.name}/keys-updater.json`);
  });

  it('the updater methods are the contract’s UPDATER_METHODS', () => {
    expect([...UPDATER_METHODS]).toEqual(UPDATER);
  });

  it('plans nothing when everything is in place', () => {
    const p = buildDeployPlan(m, deployed(), opts);
    expect(p.blockers).toEqual([]);
    // sandbox-dev's 2-min issuer-key delay is below the security bound on purpose (D80): a warning, not a blocker.
    expect(p.warnings).toEqual([expect.stringContaining('issuer_key_delay_ms 120000 ms is below the security bound')]);
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
    expect(p.steps.map((s) => s.kind)).toEqual(['relayer-keys', 'relayer-keys', 'add-updater-key']);
    expect(pool(p.steps, 'session')).toMatchObject({ reuse: ['ed25519:s2'], generate: 2 });
    expect(pool(p.steps, 'owner')).toMatchObject({ reuse: ['ed25519:o1'], generate: 0 });
    // The saved key isn't on chain: re-added (with a warning to rotate it if it may be compromised).
    expect(p.steps[2]).toEqual({ kind: 'add-updater-key', reuse: 'ed25519:U' });
    expect(p.warnings.join()).toContain('move the file aside first');
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

    it('checks tracked updater keys against UPDATER_METHODS and blocks every signer key the contract did not install', () => {
      const wrong = buildDeployPlan(m, deployed({ signerAccessKeys: [full('ed25519:S'), fc('ed25519:U', m.signer, [])] }), opts);
      expect(wrong.blockers.join()).toContain('Updater key ed25519:U on');
      expect(wrong.blockers.join()).toContain('may call ANY method');
      const extraMethod = buildDeployPlan(m, deployed({ signerAccessKeys: [full('ed25519:S'), fc('ed25519:U', m.signer, [...UPDATER, 'set_owner'])] }), opts);
      expect(extraMethod.blockers.join()).toContain(`has methods ${[...UPDATER, 'set_owner'].join(', ')}`);
      // Untracked keys: even a harmless method list is refused (not in get_governance().updater_keys).
      const stray = buildDeployPlan(m, deployed({ signerAccessKeys: [...deployed().signerAccessKeys, fc('ed25519:old', m.signer, UPDATER), fc('ed25519:v', m.signer, ['get_config'])] }), opts);
      const text = stray.blockers.join('\n');
      expect(text).toContain("function-call key the contract didn't install (not in get_governance().updater_keys): ed25519:old");
      expect(text).toContain('ed25519:v (a function-call key for');
      // sandbox-dev keeps the full-access key, so the fix is a plain DeleteKey with it.
      expect(text).toContain(`near account delete-keys ${m.signer} public-keys ed25519:old `);
      // Without a usable full-access key the owner deletes it (delete_updater_key may delete any key).
      const noFull = buildDeployPlan(m, deployed({ signerAccessKeys: [fc('ed25519:U', m.signer, UPDATER), fc('ed25519:old', m.signer, UPDATER)] }), opts);
      expect(noFull.blockers.join()).toContain('delete_updater_key({"public_key":"ed25519:old"})');
    });

    it('warns when updater_keys lists a key that is not on the account', () => {
      const p = buildDeployPlan(m, deployed({ governance: { ...govOk, updater_keys: ['ed25519:U', 'ed25519:gone'] } }), opts);
      expect(p.warnings.join()).toContain('updater_keys lists ed25519:gone');
      expect(p.steps).toEqual([]);
    });

    it('refuses to add a third updater key', () => {
      const p = buildDeployPlan(m, deployed({ updaterKeyInFile: 'ed25519:N', governance: { ...govOk, updater_keys: ['ed25519:U', 'ed25519:U2'] }, signerAccessKeys: [full('ed25519:S'), fc('ed25519:U', m.signer, UPDATER), fc('ed25519:U2', m.signer, UPDATER)] }), opts);
      expect(p.blockers.join()).toContain('already has 2 updater keys');
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

    it('blocks a tracked updater key with an unlimited allowance', () => {
      const p = buildDeployPlan(m, deployed({ signerAccessKeys: [full('ed25519:S'), fc('ed25519:U', m.signer, UPDATER, null)] }), opts);
      expect(p.blockers.join()).toContain('Updater key ed25519:U on');
      expect(p.blockers.join()).toContain('has an unlimited allowance');
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

    it('blocks on a contract without shared clients, also with --upgrade (migrate_v1 reads only the batch B layout)', () => {
      const { shared_clients: _s, pending_shared_clients: _p, ...old } = configV1;
      const p = buildDeployPlan(m, deployedV1({ config: old }), opts);
      expect(p.blockers.join()).toContain('predates batch A.2');
      expect(p.steps.find((s) => s.kind === 'set-shared-clients')).toMatchObject({ added: [['google', SHARED]] });
      const up = buildDeployPlan(m, deployedV1({ config: old }), { ...opts, upgrade: true, skipBuild: true });
      expect(up.blockers.join()).toContain('migrate_v1 reads only the batch B layout');
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

  describe('v1 → v2 migration (sandbox-dev, docs/governance-spec.md "Migration plan")', () => {
    it('a v1 contract needs --upgrade', () => {
      const p = buildDeployPlan(m, deployedV1(), opts);
      expect(p.blockers.join()).toContain('runs the v1 (pre-governance) contract. Migrate it in place with --upgrade');
    });

    it('--upgrade migrates in place, installs a new updater key, then deletes the v1 one, then adds the watchdog', () => {
      const p = buildDeployPlan(m, deployedV1(), { ...opts, upgrade: true, skipBuild: true });
      expect(p.blockers).toEqual([]);
      expect(p.steps).toEqual([
        { kind: 'migrate-v1', issuer_key_delay_ms: 120_000, governance_delay_ms: 60_000 },
        { kind: 'add-updater-key', reuse: null },
        { kind: 'delete-signer-key', publicKey: 'ed25519:U', why: 'the v1 keys-updater key (set_issuer_key, remove_issuer_key)', via: 'signer' },
        { kind: 'add-watchdog', accountId: WATCHDOG },
      ]);
      expect(describeStep(m, p.steps[0]!)).toBe(
        `Migrate ${m.signer} in place: DeployContract + migrate_v1({"issuer_key_delay_ms":120000,"governance_delay_ms":60000}) in one transaction (same account, so every address stays) [signed by ${m.signer}].`,
      );
      expect(describeStep(m, p.steps[2]!)).toContain(`[signed by ${m.signer}]`);
      expect(describeStep(m, p.steps[3]!)).toBe(`add_watchdog({"account_id":"${WATCHDOG}"}) [signed by ${m.owner}].`);
    });

    it('builds first unless --skip-build, and refuses without the manifest delays or the signer full-access key', () => {
      expect(buildDeployPlan(m, deployedV1(), { ...opts, upgrade: true }).steps.slice(0, 2).map((s) => s.kind)).toEqual(['build', 'migrate-v1']);
      const { issuerKeyDelayMs: _i, ...noDelays } = m;
      expect(buildDeployPlan({ ...noDelays, issuerKeyDelayMs: undefined }, deployedV1(), { ...opts, upgrade: true }).blockers.join()).toContain('needs issuerKeyDelayMs and governanceDelayMs for migrate_v1');
      const noFull = buildDeployPlan(m, deployedV1({ signerAccessKeys: [fc('ed25519:U', m.signer, V1_UPDATER)] }), { ...opts, upgrade: true });
      expect(noFull.blockers.join()).toContain("migrate_v1 is sent with");
    });

    it('after the migration, a re-run sees only what is left (the old key deleted by the owner if there is no full-access key)', () => {
      const migrated = deployed({ governance: { ...govOk, watchdogs: [], updater_keys: ['ed25519:N'] }, updaterKeyInFile: 'ed25519:N', signerAccessKeys: [fc('ed25519:N', m.signer, UPDATER), fc('ed25519:U', m.signer, V1_UPDATER)] });
      const p = buildDeployPlan(m, migrated, opts);
      expect(p.steps).toEqual([
        { kind: 'delete-signer-key', publicKey: 'ed25519:U', why: 'the v1 keys-updater key (set_issuer_key, remove_issuer_key)', via: 'owner' },
        { kind: 'add-watchdog', accountId: WATCHDOG },
      ]);
      expect(describeStep(m, p.steps[0]!)).toContain(`delete_updater_key({"public_key":"ed25519:U"}) [signed by ${m.owner}]`);
      expect(p.done).toContain('Keys-updater key in place (installed by the contract).');
    });
  });

  describe('upgrades of the governance contract: propose_upgrade → wait → execute_upgrade', () => {
    const up = { ...opts, upgrade: true };
    const pending = (code_hash: string, executable_at_ms: number) => deployed({ wasmCodeHash: 'H', governance: { ...govOk, pending_upgrade: { code_hash, proposed_at_ms: NOW - 60_000, executable_at_ms } } });

    it('never plans a raw DeployContract: build, then propose the built hash', () => {
      const p = buildDeployPlan(m, deployed(), up);
      expect(p.steps).toEqual([{ kind: 'build' }, { kind: 'propose-upgrade', codeHash: null, replaces: null, current: 'abc' }]);
      expect(describeStep(m, p.steps[1]!)).toContain(`propose_upgrade({"code_hash":"<hash of the built wasm>"}) [signed by ${m.owner}]`);
      expect(p.steps.some((s) => s.kind === 'deploy' || s.kind === 'migrate-v1')).toBe(false);
    });

    it('with a known wasm: propose it; wait while delayed; execute once due', () => {
      expect(buildDeployPlan(m, deployed({ wasmCodeHash: 'H' }), { ...up, skipBuild: true }).steps).toEqual([{ kind: 'propose-upgrade', codeHash: 'H', replaces: null, current: 'abc' }]);
      const waiting = buildDeployPlan(m, pending('H', NOW + 30_000), { ...up, skipBuild: true });
      expect(waiting.steps).toEqual([]);
      expect(waiting.done.join()).toContain('Upgrade to H proposed; executable from 2027-01-15T08:00:30.000Z');
      // Block time may trail the local clock: "due" waits CLOCK_MARGIN_MS more, so execute_upgrade never panics early.
      expect(buildDeployPlan(m, pending('H', NOW), { ...up, skipBuild: true }).steps).toEqual([]);
      const due = buildDeployPlan(m, pending('H', NOW - CLOCK_MARGIN_MS), { ...up, skipBuild: true });
      expect(due.steps).toEqual([{ kind: 'execute-upgrade', codeHash: 'H' }]);
      expect(describeStep(m, due.steps[0]!)).toContain(`[anyone; signed by ${m.relayer}]`);
    });

    it('a different pending hash is replaced (with a warning); the running code is not proposed again', () => {
      const other = buildDeployPlan(m, pending('OTHER', NOW - CLOCK_MARGIN_MS), { ...up, skipBuild: true });
      expect(other.steps).toEqual([{ kind: 'propose-upgrade', codeHash: 'H', replaces: 'OTHER', current: 'abc' }]);
      expect(other.warnings.join()).toContain('replaces the pending upgrade OTHER');
      const same = buildDeployPlan(m, deployed({ wasmCodeHash: 'abc' }), { ...up, skipBuild: true });
      expect(same.steps).toEqual([]);
      expect(same.done.join()).toContain('already runs abc');
    });

    it('without --upgrade, a pending upgrade is reported', () => {
      expect(buildDeployPlan(m, pending('H', NOW - CLOCK_MARGIN_MS), opts).warnings.join()).toContain('Upgrade H is pending');
    });
  });

  describe('the signer full-access key (D86)', () => {
    const staging = { ...m, ...PROD_DELAYS, name: 'staging', allowSignerFullAccessKey: undefined };

    it('sandbox-dev keeps it; any other env is blocked while one exists', () => {
      expect(buildDeployPlan(m, deployed(), opts).blockers).toEqual([]);
      const p = buildDeployPlan(staging, deployed(), opts);
      expect(p.blockers.join()).toContain(`${m.signer} has 1 full-access key(s) (ed25519:S), and staging may have none (D86)`);
      expect(buildDeployPlan(staging, deployed({ signerAccessKeys: [fc('ed25519:U', m.signer, UPDATER)] }), opts).blockers).toEqual([]);
    });

    it('only a dev env on testnet may set allowSignerFullAccessKey', () => {
      for (const name of ['staging', 'prod', 'mainnet']) {
        const p = buildDeployPlan({ ...m, ...PROD_DELAYS, name, allowSignerFullAccessKey: true }, deployed(), opts);
        expect(p.blockers.join(), name).toContain('sets allowSignerFullAccessKey, which only a dev env (local*, sandbox*) on testnet may');
        expect(p.blockers.join(), name).toContain('may have none (D86)');
      }
      expect(signerFullAccessAllowed(m)).toBe(true);
      expect(signerFullAccessAllowed({ ...m, name: 'local-dev' })).toBe(true);
      expect(signerFullAccessAllowed({ ...m, allowSignerFullAccessKey: undefined })).toBe(false);
    });

    it('a fresh deploy outside sandbox-dev points at the creation batch', () => {
      expect(buildDeployPlan(staging, fresh(), opts).blockers.join()).toContain('--creation-plan prints it (DeployContract + new + DeleteKey)');
    });
  });

  describe('watchdogs and delays', () => {
    it('adds a manifest watchdog that exists on chain; skips one that does not; reports extra on-chain ones', () => {
      expect(buildDeployPlan(m, deployed({ governance: { ...govOk, watchdogs: [] } }), opts).steps).toEqual([{ kind: 'add-watchdog', accountId: WATCHDOG }]);
      const missing = buildDeployPlan(m, deployed({ governance: { ...govOk, watchdogs: [] }, watchdogAccounts: { [WATCHDOG]: false } }), opts);
      expect(missing.steps).toEqual([]);
      expect(missing.warnings.join()).toContain(`Watchdog ${WATCHDOG} does not exist on chain yet`);
      const extra = buildDeployPlan(m, deployed({ governance: { ...govOk, watchdogs: [...govOk.watchdogs, { account_id: 'rogue.testnet', confirm_from_ms: NOW + 1 }] } }), opts);
      expect(extra.warnings.join()).toContain('rogue.testnet is a watchdog on chain but not in envs/sandbox-dev.json');
      expect(extra.done.join()).toContain('Watchdog rogue.testnet may confirm from');
    });

    it('sets a delay that differs from the manifest; a pending decrease to it counts as done', () => {
      const p = buildDeployPlan(m, deployed({ config: { ...configOk, governance_delay_ms: 600_000 } }), opts);
      expect(p.steps).toEqual([{ kind: 'set-delay', which: 'governance', ms: 60_000 }]);
      expect(describeStep(m, p.steps[0]!)).toBe(`set_governance_delay_ms({"governance_delay_ms":60000}) [signed by ${m.owner}].`);
      const pendingDecrease = deployed({ config: { ...configOk, issuer_key_delay_ms: 600_000, pending_issuer_key_delay: { change_delay_ms: 120_000, effective_at_ms: NOW + 1 } } });
      expect(buildDeployPlan(m, pendingDecrease, opts).steps).toEqual([]);
    });
  });

  describe('owner transfer to the council DAO (--transfer-owner)', () => {
    const t = { ...opts, transferOwner: true };
    const dao = m.council!.dao;
    const pendingOwner = (acceptable_at_ms: number) => deployed({ governance: { ...govOk, pending_owner: { owner: dao, acceptable_at_ms } } });

    it('the old owner proposes the DAO, as the last step', () => {
      const p = buildDeployPlan(m, deployed({ governance: { ...govOk, watchdogs: [] } }), t);
      expect(p.steps.map((s) => s.kind)).toEqual(['add-watchdog', 'propose-owner']);
      expect(describeStep(m, p.steps[1]!)).toBe(`propose_owner({"owner":"${dao}"}) [signed by ${m.owner}].`);
    });

    it('the DAO accepts once due, through a council proposal (approved in the same run with --approve-with on dev envs)', () => {
      expect(buildDeployPlan(m, pendingOwner(NOW + 1), t).done.join()).toContain(`the DAO may accept from`);
      const due = buildDeployPlan(m, pendingOwner(NOW - CLOCK_MARGIN_MS), { ...t, ownerTx: { approveWith: m.council!.members[1] } });
      expect(due.blockers).toEqual([]);
      expect(due.steps).toEqual([{ kind: 'accept-owner', owner: dao }]);
      expect(describeStep(m, due.steps[0]!, { approveWith: m.council!.members[1] })).toBe(
        `accept_owner({}) [DAO proposal on ${dao} by ${m.council!.members[0]}, approved by ${m.council!.members[0]} and ${m.council!.members[1]} in the same run].`,
      );
    });

    it('blocks without the DAO, with the pinned code, or without council keys', () => {
      expect(buildDeployPlan(m, deployed({ councilDao: { exists: false, codeHash: '', policy: null } }), t).blockers.join()).toContain('run council-setup sandbox-dev first');
      expect(buildDeployPlan(m, deployed({ councilDao: { exists: true, codeHash: 'X', policy: councilPolicy(m.council!.members) } }), t).blockers.join()).toContain('not the pinned Sputnik DAO');
      const noKey = buildDeployPlan(m, pendingOwner(NOW - CLOCK_MARGIN_MS), { ...t, ownerTx: { approveWith: m.council!.members[1] } });
      expect(noKey.blockers).toEqual([]);
      const keys = { ...fresh().councilKeys, [m.council!.members[1]!]: false };
      expect(buildDeployPlan(m, { ...pendingOwner(NOW - CLOCK_MARGIN_MS), councilKeys: keys }, { ...t, ownerTx: { approveWith: m.council!.members[1] } }).blockers.join()).toContain(`No signing key for council member ${m.council!.members[1]}`);
      expect(buildDeployPlan(m, pendingOwner(NOW - CLOCK_MARGIN_MS), { ...t, ownerTx: { approveWith: m.council!.members[0] } }).blockers.join()).toContain('different member from the proposer');
    });

    it('once the DAO owns the contract, says to update the manifest', () => {
      const p = buildDeployPlan(m, deployed({ config: { ...configOk, owner: dao } }), opts);
      expect(p.blockers.join()).toContain(`set "owner": "${dao}" and "ownerKind": "sputnik" in envs/sandbox-dev.json`);
    });
  });

  describe("the council DAO's policy (D81: exactly the manifest council, 2 of 3 for every kind)", () => {
    const dao = m.council!.dao;
    const members = m.council!.members;
    const sm = { ...m, owner: dao, ownerKind: 'sputnik' as const };
    const cfg = { ...configOk, owner: dao };
    const good = councilPolicy(members);
    const role = good.roles[0]!;
    const bad: [string, typeof good, string][] = [
      ['1 of 3', { ...good, default_vote_policy: { ...good.default_vote_policy, threshold: [1, 3] } }, 'default_vote_policy'],
      ['an Everyone role', { ...good, roles: [role, { name: 'all', kind: 'Everyone', permissions: ['*:AddProposal', '*:VoteApprove'], vote_policy: {} }] }, '2 roles'],
      ['other members', { ...good, roles: [{ ...role, kind: { Group: [members[0]!, members[1]!, 'mallory.testnet'] } }] }, 'mallory.testnet'],
      ['a per-kind 1-vote policy', { ...good, roles: [{ ...role, vote_policy: { policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [0, 1] } } }] }, 'per-kind vote policies'],
    ];

    it.each(bad)('blocks the owner transfer to a DAO with %s', (_name, policy, why) => {
      const p = buildDeployPlan(m, deployed({ councilDao: { exists: true, codeHash: SPUTNIK_HASH, policy } }), { ...opts, transferOwner: true });
      expect(p.blockers.join('\n')).toContain(why);
      expect(p.blockers.join('\n')).toContain(`${dao}:`);
      expect(p.blockers.join('\n')).toContain('D81: exactly');
    });

    it.each(bad)('blocks every run of a council-owned env whose DAO has %s', (_name, policy, why) => {
      const p = buildDeployPlan(sm, deployed({ config: cfg, councilDao: { exists: true, codeHash: SPUTNIK_HASH, policy } }), opts);
      expect(p.blockers.join('\n')).toContain(why);
    });

    it('blocks when get_policy fails; passes the pinned code with the council policy (bond and period only warn)', () => {
      expect(buildDeployPlan(m, deployed({ councilDao: { exists: true, codeHash: SPUTNIK_HASH, policy: null } }), { ...opts, transferOwner: true }).blockers.join()).toContain('get_policy fails');
      expect(buildDeployPlan(sm, deployed({ config: cfg }), opts).blockers).toEqual([]);
      const period = buildDeployPlan(sm, deployed({ config: cfg, councilDao: { exists: true, codeHash: SPUTNIK_HASH, policy: { ...good, proposal_period: '1' } } }), opts);
      expect(period.blockers).toEqual([]);
      expect(period.warnings.join()).toContain('proposal_period is 1');
      // An account owner without --transfer-owner isn't checked against the DAO.
      expect(buildDeployPlan(m, deployed({ councilDao: { exists: true, codeHash: SPUTNIK_HASH, policy: bad[0]![1] } }), opts).blockers).toEqual([]);
    });
  });

  describe('governance delay floors (@hana-id/env governanceDelayProblems)', () => {
    const staging = { ...m, ...PROD_DELAYS, name: 'staging', allowSignerFullAccessKey: undefined };
    const stagingDeployed = (over: Partial<DeployObserved> = {}) => deployed({ signerAccessKeys: [fc('ed25519:U', m.signer, UPDATER)], config: { ...configOk, issuer_key_delay_ms: PROD_DELAYS.issuerKeyDelayMs, governance_delay_ms: PROD_DELAYS.governanceDelayMs }, ...over });

    it('a staging manifest copied from sandbox-dev (2 min / 60 s) is blocked, for a fresh deploy, a migration and a deployed contract', () => {
      const copied = { ...staging, issuerKeyDelayMs: m.issuerKeyDelayMs, governanceDelayMs: m.governanceDelayMs };
      for (const [o, up] of [[fresh(), opts], [deployedV1({ signerAccessKeys: [full('ed25519:S'), fc('ed25519:U', m.signer, V1_UPDATER)] }), { ...opts, upgrade: true }], [stagingDeployed(), opts]] as const) {
        const text = buildDeployPlan(copied, o, up).blockers.join('\n');
        expect(text).toContain('issuer_key_delay_ms 120000 ms is below the security bound 3·(W + T) = 18 min');
        expect(text).toContain('governance_delay_ms 60000 ms is below 24 h for a non-dev env');
      }
    });

    it('a delay of 0 is blocked outside dev envs; the floors themselves pass', () => {
      expect(buildDeployPlan({ ...staging, issuerKeyDelayMs: 0, governanceDelayMs: 0 }, stagingDeployed(), opts).blockers.join()).toMatch(/issuer_key_delay_ms 0 ms.*governance_delay_ms 0 ms/su);
      const atFloor = { ...staging, issuerKeyDelayMs: 18 * 60_000, governanceDelayMs: 24 * 3_600_000 };
      expect(buildDeployPlan(atFloor, stagingDeployed(), opts).blockers).toEqual([]);
    });

    it('without delays in the manifest, the contract’s own are checked', () => {
      const { issuerKeyDelayMs: _i, governanceDelayMs: _g, ...noDelays } = staging;
      const low = stagingDeployed({ config: { ...configOk, issuer_key_delay_ms: 60_000, governance_delay_ms: 3_600_000 } });
      expect(buildDeployPlan(noDelays, low, opts).blockers).toHaveLength(2);
    });

    it('dev envs only warn on an issuer-key delay below the bound', () => {
      const p = buildDeployPlan({ ...m, issuerKeyDelayMs: 0, governanceDelayMs: 0 }, fresh(), opts);
      expect(p.blockers).toEqual([]);
      expect(p.warnings).toEqual([expect.stringContaining('Accepted only in dev envs (D80')]);
    });

    it('the creation batch refuses delays below the floors outside dev envs, and warns in dev envs', () => {
      const input = { wasm: null, updaterPublicKey: null, creationPublicKey: null };
      expect(creationPlan({ ...staging, issuerKeyDelayMs: 60_000 }, input).problems.join()).toContain('below the security bound');
      expect(creationPlan({ ...staging, governanceDelayMs: 3_600_000 }, input).problems.join()).toContain('below 24 h');
      expect(creationPlan({ ...staging, name: 'mainnet', network: 'mainnet' as 'testnet', governanceDelayMs: 24 * 3_600_000 }, input).problems.join()).toContain('below 72 h (mainnet, D80)');
      expect(creationPlan(staging, input).problems).toEqual([]);
      expect(creationPlan(m, input).lines.join('\n')).toContain('WARNING: issuer_key_delay_ms 120000 ms is below the security bound');
    });
  });

  describe('a council owner (ownerKind sputnik)', () => {
    const dao = m.council!.dao;
    const sm = { ...m, owner: dao, ownerKind: 'sputnik' as const };
    const cfg = { ...configOk, owner: dao };

    it('every owner step is a DAO proposal; no owner keychain key is needed', () => {
      const p = buildDeployPlan(sm, deployed({ config: cfg, governance: { ...govOk, watchdogs: [] }, credentials: { ...fresh().credentials, owner: { found: false, fullAccessOnChain: false } } }), opts);
      expect(p.blockers).toEqual([]);
      expect(describeStep(sm, p.steps[0]!)).toBe(`add_watchdog({"account_id":"${WATCHDOG}"}) [DAO proposal on ${dao} by ${m.council!.members[0]}, then 2 of 3 council approvals].`);
    });

    it('--approve-with is refused outside dev envs', () => {
      const staging = { ...sm, ...PROD_DELAYS, name: 'staging', allowSignerFullAccessKey: undefined };
      const p = buildDeployPlan(staging, deployed({ config: cfg, governance: { ...govOk, watchdogs: [] }, signerAccessKeys: [fc('ed25519:U', m.signer, UPDATER)] }), { ...opts, ownerTx: { member: m.council!.members[0], approveWith: m.council!.members[1] } });
      expect(p.blockers.join()).toContain('--approve-with is for dev envs on testnet only (D81)');
      const noMember = buildDeployPlan(staging, deployed({ config: cfg, governance: { ...govOk, watchdogs: [] }, signerAccessKeys: [fc('ed25519:U', m.signer, UPDATER)] }), opts);
      expect(noMember.blockers.join()).toContain('--member <council member> is required');
    });
  });

  describe('mainnet-style creation batch (printed only)', () => {
    it('Deploy + new(owner = DAO, delays, watchdogs, updater key) + DeleteKey, no AddKey', () => {
      const { problems, lines } = creationPlan(m, { wasm: { codeHash: 'H', bytes: 500_000 }, updaterPublicKey: 'ed25519:Upd', creationPublicKey: 'ed25519:Cre' });
      expect(problems).toEqual([]);
      const text = lines.join('\n');
      expect(text).toContain('printed only. This script never sends it');
      expect(text).toContain('cargo near build reproducible-wasm');
      expect(text).toContain('code_hash H (500000 bytes)');
      expect(text).toContain(`signed by the creation key ed25519:Cre`);
      expect(text).toContain(
        `new(${JSON.stringify({ owner: m.council!.dao, mpc: m.mpc, ckd_domain_id: m.ckdDomainId, change_delay_ms: m.changeDelayMs, issuer_key_delay_ms: 120_000, governance_delay_ms: 60_000, watchdogs: [WATCHDOG], updater_keys: ['ed25519:Upd'] })})`,
      );
      expect(text).toContain('c. DeleteKey(ed25519:Cre)');
      expect(text).not.toMatch(/\d\. AddKey|[a-d]\. AddKey/u);
      expect(text).toContain('No AddKey action');
    });

    it('needs a council, delays and a watchdog; placeholders without keys', () => {
      const { council: _c, ...noCouncil } = m;
      expect(creationPlan({ ...noCouncil, council: undefined }, { wasm: null, updaterPublicKey: null, creationPublicKey: null }).problems.join()).toContain('needs a council');
      expect(creationPlan({ ...m, watchdogs: [] }, { wasm: null, updaterPublicKey: null, creationPublicKey: null }).problems.join()).toContain('no watchdogs');
      const text = creationPlan(m, { wasm: null, updaterPublicKey: null, creationPublicKey: null }).lines.join('\n');
      expect(text).toContain('<pass --wasm <reproducible build> to print it>');
      expect(text).toContain('<updater public key');
    });
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
