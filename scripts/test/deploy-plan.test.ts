import { describe, expect, it } from 'vitest';
import { loadEnv } from '@hana-id/env';
import { reportsCreateProof } from '../lib/deploy-run.ts';
import { OWNER_RELAYER_METHODS, SESSION_RELAYER_METHODS, sharedClientsOf } from '../lib/contract.ts';
import { type GovernanceView, UPDATER_METHODS } from '../lib/contract.ts';
import { buildDeployPlan, checkFunctionKey, creationPlan, type DeployObserved, type DeployOptions, type DeployStep, describeStep, CLOCK_MARGIN_MS, ownerCallOf, QUARANTINE_MARGIN_MS, SINK_WAIT_MAX_MS, signerFullAccessAllowed, sinkWaitMs } from '../lib/deploy-plan.ts';
import { type AccessKeyListEntry, EMPTY_CODE_HASH, nearToYocto } from '../lib/near.ts';
import { DEFAULT_OWNER_ALLOWANCE_NEAR } from '../lib/deploy-run.ts';
import { OWNER_POOL_ALLOWANCE_YOCTO, POOL_METHODS as API_POOL_METHODS } from '../../apps/api/src/relayer-config.ts';
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
const SESSION = ['create_session', 'create_session_and_derive', 'derive_key', 'revoke_session', 'link_identity', 'cancel_link', 'unlink_identity'];
const OWNER = ['propose_change', 'cancel_change', 'remove_client', 'disable_shared_login', 'execute_change'];
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
  const credOf = (publicKey: string) => ({ ...cred, publicKey });
  return {
    chainId: 'testnet',
    nowMs: NOW,
    accounts: { signer: acct, relayer: acct, owner: acct },
    credentials: { signer: credOf('ed25519:S'), relayer: credOf('ed25519:R'), owner: cred },
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

    it('email login batch 6: session keys with the batch B list (no link methods) are a blocker: delete, then re-run to re-add them', () => {
      const batchB = SESSION.filter((x) => !['link_identity', 'cancel_link', 'unlink_identity'].includes(x));
      const p = buildDeployPlan(m, deployed({ relayerAccessKeys: [fc('ed25519:s1', m.signer, batchB), fc('ed25519:s2', m.signer, batchB)], poolKeysInFile: { session: ['ed25519:s1', 'ed25519:s2'], owner: [] } }), opts);
      const text = p.blockers.join('\n');
      expect(text).toContain('with the wrong permission for the session pool');
      expect(text).toContain(`has methods ${batchB.join(', ')}; expected ${SESSION.join(', ')}`);
      expect(text).toContain(`near account delete-keys ${m.relayer} public-keys ed25519:s1`);
      // Deleted, they are re-added from the file with the new list.
      const after = buildDeployPlan(m, deployed({ relayerAccessKeys: [], poolKeysInFile: { session: ['ed25519:s1', 'ed25519:s2'], owner: [] } }), opts);
      expect(pool(after.steps, 'session')).toMatchObject({ reuse: ['ed25519:s1', 'ed25519:s2'], methods: SESSION });
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

    it('blocks on a contract without shared clients, also with --upgrade (no code migrates it)', () => {
      const { shared_clients: _s, pending_shared_clients: _p, ...old } = configV1;
      const p = buildDeployPlan(m, deployedV1({ config: old }), opts);
      expect(p.blockers.join()).toContain('predates batch A.2');
      expect(p.steps.find((s) => s.kind === 'set-shared-clients')).toMatchObject({ added: [['google', SHARED]] });
      const up = buildDeployPlan(m, deployedV1({ config: old }), { ...opts, upgrade: true, skipBuild: true });
      expect(up.blockers.join()).toContain('No code migrates it: deploy to a fresh signer account');
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

  describe('v1 contracts (pre-governance)', () => {
    it('a v1 contract is refused, with or without --upgrade: contract v3 has no migrate_v1 (D154)', () => {
      for (const o of [opts, { ...opts, upgrade: true }, { ...opts, upgrade: true, skipBuild: true }]) {
        const p = buildDeployPlan(m, deployedV1(), o);
        expect(p.blockers.join()).toContain("runs the v1 (pre-governance) contract, which this code can't migrate: contract v3 has no migrate_v1 (D154)");
        expect(p.steps.some((s) => s.kind === 'build' || s.kind === 'deploy' || s.kind === 'propose-upgrade' || s.kind === 'execute-upgrade')).toBe(false);
      }
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

    it('refuses to propose or execute while the env’s API lacks the create_session proof (capabilities.createProof, D137)', () => {
      for (const o of [deployed({ apiCreateProof: false }), pending('H', NOW - CLOCK_MARGIN_MS)]) {
        const p = buildDeployPlan(m, { ...o, apiCreateProof: false }, { ...up, skipBuild: true });
        expect(p.blockers.join()).toContain('capabilities.createProof');
        expect(p.steps.some((x) => x.kind === 'propose-upgrade' || x.kind === 'execute-upgrade')).toBe(false);
      }
      expect(buildDeployPlan(m, deployed({ apiCreateProof: true }), up).blockers.join()).not.toContain('createProof');
      // What deploy-contract reads from GET /v1/health.
      expect(reportsCreateProof({ ok: true, capabilities: { createProof: true } })).toBe(true);
      for (const h of [null, { ok: true }, { capabilities: { createProof: 'yes' } }, 'x']) expect(reportsCreateProof(h)).toBe(false);
    });

    it('never plans a raw DeployContract: build, then propose the built hash', () => {
      const p = buildDeployPlan(m, deployed(), up);
      expect(p.steps).toEqual([{ kind: 'build' }, { kind: 'propose-upgrade', codeHash: null, replaces: null, current: 'abc' }]);
      expect(describeStep(m, p.steps[1]!)).toContain(`propose_upgrade({"code_hash":"<hash of the built wasm>"}) [signed by ${m.owner}]`);
      expect(p.steps.some((s) => s.kind === 'deploy')).toBe(false);
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

  describe('full-access keys nobody knows of (OPER-7, D456)', () => {
    const staging = { ...m, ...PROD_DELAYS, name: 'staging', allowSignerFullAccessKey: undefined };
    const extra = (o: Partial<DeployObserved> = {}) => deployed({ relayerAccessKeys: [...deployed().relayerAccessKeys, full('ed25519:X')], ...o });

    it('warns on an extra relayer key in a dev env, with the command to delete it', () => {
      const p = buildDeployPlan(m, extra(), opts);
      expect(p.blockers).toEqual([]);
      const w = p.warnings.join('\n');
      expect(w).toContain(`${m.relayer} (relayer) has full-access key(s) besides the one in ~/.near-credentials (ed25519:R): ed25519:X`);
      expect(w).toContain(`near account delete-keys ${m.relayer} public-keys ed25519:X`);
    });

    it('blocks on one outside dev envs', () => {
      const p = buildDeployPlan(staging, extra({ signerAccessKeys: [fc('ed25519:U', m.signer, UPDATER)] }), opts);
      expect(p.blockers.join('\n')).toContain('(relayer) has full-access key(s) besides');
    });

    it('checks an owner account’s keys when it read them, and says so when there is no local key to compare', () => {
      const owner = buildDeployPlan(staging, deployed({ signerAccessKeys: [fc('ed25519:U', m.signer, UPDATER)], ownerAccessKeys: [full('ed25519:K'), full('ed25519:Y')] }), opts);
      expect(owner.blockers.join('\n')).toContain(`${m.owner} (owner) has full-access key(s) besides the one in ~/.near-credentials (ed25519:K): ed25519:Y`);
      const noCred = buildDeployPlan(m, deployed({ credentials: { ...fresh().credentials, relayer: { found: false, fullAccessOnChain: false } } }), opts);
      expect(noCred.warnings.join('\n')).toContain(`${m.relayer} (relayer) has full-access key(s) ed25519:R and there is no local key to compare them with`);
    });

    it('checks the signer’s own only in a dev env that may keep one: elsewhere every full-access key already blocks', () => {
      const dev = buildDeployPlan(m, deployed({ signerAccessKeys: [full('ed25519:S'), full('ed25519:Z'), fc('ed25519:U', m.signer, UPDATER)] }), opts);
      expect(dev.warnings.join('\n')).toContain(`${m.signer} (signer) has full-access key(s) besides the one in ~/.near-credentials (ed25519:S): ed25519:Z`);
    });

    it('stops on a full-access key on the council DAO outside dev envs', () => {
      const dao = (keys: string[]) => ({ councilDao: { ...fresh().councilDao!, fullAccessKeys: keys } });
      expect(buildDeployPlan(m, deployed(dao(['ed25519:D'])), opts).warnings.join('\n')).toContain('has full-access key(s) ed25519:D');
      expect(buildDeployPlan(staging, deployed({ ...dao(['ed25519:D']), signerAccessKeys: [fc('ed25519:U', m.signer, UPDATER)] }), opts).blockers.join('\n')).toContain('has full-access key(s) ed25519:D');
      expect(buildDeployPlan(m, deployed(dao([])), opts).warnings.join('\n')).not.toContain('has full-access key');
    });

    it('accepts exactly the known keys', () => {
      expect(buildDeployPlan(m, deployed({ ownerAccessKeys: [full('ed25519:K')] }), opts).warnings.join('\n')).not.toContain('full-access key(s)');
    });
  });

  describe('new code outside dev envs comes only from a reproducible build (OPER-7, D86, D456)', () => {
    const staging = { ...m, ...PROD_DELAYS, name: 'staging', allowSignerFullAccessKey: undefined };
    const noFull = { signerAccessKeys: [fc('ed25519:U', m.signer, UPDATER)] };
    const refused = 'takes only a reproducible build';

    it('refuses an upgrade that would build here, or take whatever is in target/', () => {
      expect(buildDeployPlan(staging, deployed(noFull), { ...opts, upgrade: true, skipBuild: false }).blockers.join('\n')).toContain(refused);
      const lastBuild = buildDeployPlan(staging, deployed({ ...noFull, wasmCodeHash: 'new', wasmBytes: 1000 }), { ...opts, upgrade: true, skipBuild: true });
      expect(lastBuild.steps.map((s) => s.kind)).toContain('propose-upgrade');
      expect(lastBuild.blockers.join('\n')).toContain(refused);
    });

    it('takes a build named with --wasm, and executes a proposed hash without one', () => {
      const named = buildDeployPlan(staging, deployed({ ...noFull, wasmCodeHash: 'new', wasmBytes: 1000 }), { ...opts, upgrade: true, skipBuild: true, wasmGiven: true });
      expect(named.blockers.join('\n')).not.toContain(refused);
      const gov = { ...govOk, pending_upgrade: { code_hash: 'new', proposed_at_ms: 0, executable_at_ms: NOW - CLOCK_MARGIN_MS - 1 } };
      const execute = buildDeployPlan(staging, deployed({ ...noFull, governance: gov, wasmCodeHash: 'new', wasmBytes: 1000 }), { ...opts, upgrade: true, skipBuild: true });
      expect(execute.steps.map((s) => s.kind)).toContain('execute-upgrade');
      expect(execute.blockers.join('\n')).not.toContain(refused);
    });

    it('a dev env still builds here', () => {
      expect(buildDeployPlan(m, deployed(), { ...opts, upgrade: true, skipBuild: false }).blockers.join('\n')).not.toContain(refused);
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

  it('the owner pool’s default allowance is the base of the API’s owner_allowance_low check', () => {
    expect(nearToYocto(DEFAULT_OWNER_ALLOWANCE_NEAR)).toBe(OWNER_POOL_ALLOWANCE_YOCTO);
  });

  // The console sink scope (docs/batch-c-spec.md "Address impact", D238).
  const CONSOLE_AUD: [string, string] = ['google', 'console.apps.googleusercontent.com'];
  const HANA: [string, string] = ['google', 'hana.apps.googleusercontent.com'];
  const withAud = { ...m, consoleAudiences: [CONSOLE_AUD] };
  const at = (scope: string | null) => ({ consoleAudienceScopes: { 'google/console.apps.googleusercontent.com': scope } });

  it('fresh env: the sink is registered before "global", which gets only googleClientIds', () => {
    const p = buildDeployPlan(withAud, fresh(), opts);
    const kinds = p.steps.map((s) => s.kind);
    expect(kinds.indexOf('register-console-sink')).toBeGreaterThan(-1);
    expect(kinds.indexOf('register-console-sink')).toBeLessThan(kinds.indexOf('register-global'));
    expect(p.steps).toContainEqual({ kind: 'register-console-sink', owners: [{ Near: { account_id: m.owner } }], clients: [CONSOLE_AUD], quarantineMs: 0 });
    expect(p.steps).toContainEqual({ kind: 'register-global', owners: [{ Near: { account_id: m.owner } }], clients: [HANA], allowShared: false });
    const sink = p.steps.find((s) => s.kind === 'register-console-sink')!;
    expect(ownerCallOf(sink)).toEqual({ method: 'admin_register_scope', args: { owners: [{ Near: { account_id: m.owner } }], clients: [CONSOLE_AUD], scope_id: null, allow_shared: false } });
    expect(p.blockers).toEqual([]);
  });

  it('register-global stops counting console audiences toward its 10 clients', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `own-${i}.apps.googleusercontent.com`);
    const p = buildDeployPlan({ ...withAud, googleClientIds: ten }, fresh(), opts);
    expect(p.blockers.join()).not.toContain('allows 10');
    expect(buildDeployPlan({ ...withAud, googleClientIds: [...ten, 'eleven.apps.googleusercontent.com'] }, fresh(), opts).blockers.join()).toContain('allows 10');
  });

  it('existing env with a console audience in "global": remove_client (by the owner, auth Near), then the sink after the quarantine', () => {
    const globalScope = { id: 'global', owners: [{ Near: { account_id: m.owner } }], clients: [HANA, CONSOLE_AUD], allow_shared: false };
    const p = buildDeployPlan(withAud, deployed({ globalScope, ...at('global') }), opts);
    const sinkSteps = p.steps.filter((s) => s.kind === 'remove-console-client' || s.kind === 'register-console-sink');
    expect(sinkSteps).toEqual([
      { kind: 'remove-console-client', provider: 'google', aud: CONSOLE_AUD[1], via: { kind: 'owner' } },
      { kind: 'register-console-sink', owners: [{ Near: { account_id: m.owner } }], clients: [CONSOLE_AUD], quarantineMs: configOk.change_delay_ms },
    ]);
    expect(ownerCallOf(sinkSteps[0]!)).toEqual({ method: 'remove_client', args: { scope_id: 'global', auth: 'Near', provider: 'google', aud: CONSOLE_AUD[1] } });
    expect(p.steps.map((s) => s.kind)).not.toContain('register-global');
    expect(p.blockers).toEqual([]);
    expect(describeStep(withAud, sinkSteps[0]!)).toContain('Remove console audience');
    // A quarantine longer than one run waits (a mainnet-like change_delay_ms): no removal at all, a blocker. The
    // audiences are never left in no scope with nobody running the registration.
    const slow = buildDeployPlan(withAud, deployed({ config: { ...configOk, change_delay_ms: 86_400_000 }, globalScope, ...at('global') }), opts);
    expect(slow.blockers.join()).toContain('Refusing to remove the console audiences');
    expect(slow.steps.map((s) => s.kind)).not.toContain('remove-console-client');
    // The boundary is the wait the run makes (quarantine + margin), not the quarantine alone: 10 min minus the margin
    // is planned, and the runner then waits exactly 10 min; one millisecond more is refused before any removal.
    const edge = SINK_WAIT_MAX_MS - QUARANTINE_MARGIN_MS;
    expect(sinkWaitMs(edge)).toBe(SINK_WAIT_MAX_MS);
    const ok = buildDeployPlan(withAud, deployed({ config: { ...configOk, change_delay_ms: edge }, globalScope, ...at('global') }), opts);
    expect(ok.blockers.join()).not.toContain('Refusing to remove');
    expect(ok.steps.map((s) => s.kind)).toContain('remove-console-client');
    const over = buildDeployPlan(withAud, deployed({ config: { ...configOk, change_delay_ms: edge + 1 }, globalScope, ...at('global') }), opts);
    expect(over.blockers.join()).toContain('Refusing to remove');
    expect(over.steps.map((s) => s.kind)).not.toContain('remove-console-client');
    // Formerly the boundary: a 10 min quarantine would make the run wait past it, so it is refused now.
    expect(buildDeployPlan(withAud, deployed({ config: { ...configOk, change_delay_ms: SINK_WAIT_MAX_MS }, globalScope, ...at('global') }), opts).blockers.join()).toContain('Refusing to remove');
  });

  it('a council-owned env removes from "global" only with --approve-with (no council vote between the removal and the sink)', () => {
    const dao = m.council!.dao;
    const daoOwned = { ...withAud, owner: dao, ownerKind: 'sputnik' as const };
    const globalScope = { id: 'global', owners: [{ Near: { account_id: dao } }], clients: [HANA, CONSOLE_AUD], allow_shared: false };
    const obs = deployed({ config: { ...configOk, owner: dao }, globalScope, ...at('global') });
    const noVotes = buildDeployPlan(daoOwned, obs, opts);
    expect(noVotes.blockers.join()).toContain('council');
    expect(noVotes.steps.map((s) => s.kind)).not.toContain('remove-console-client');
    // The same with "global" owned by the pre-transfer account: its removal is direct, but the sink's registration
    // still waits for votes.
    const oldGlobal = { ...globalScope, owners: [{ Near: { account_id: 'old-owner.testnet' } }] };
    expect(buildDeployPlan(daoOwned, deployed({ config: { ...configOk, owner: dao }, globalScope: oldGlobal, ...at('global'), globalOwnerKeys: { 'old-owner.testnet': true } }), opts).blockers.join()).toContain('council');
    const voted = buildDeployPlan(daoOwned, obs, { ...opts, ownerTx: { approveWith: m.council!.members[1] } });
    expect(voted.blockers.join()).not.toContain('Refusing to remove');
    expect(voted.steps.map((s) => s.kind)).toContain('remove-console-client');
  });

  it('"global" owned by the owner of the time (before a transfer): that account signs remove_client, else a blocker', () => {
    const globalScope = { id: 'global', owners: [{ Near: { account_id: 'old-owner.testnet' } }], clients: [HANA, CONSOLE_AUD], allow_shared: false };
    const withKey = buildDeployPlan(withAud, deployed({ globalScope, ...at('global'), globalOwnerKeys: { 'old-owner.testnet': true } }), opts);
    const remove = withKey.steps.find((s) => s.kind === 'remove-console-client')!;
    expect(remove).toMatchObject({ via: { kind: 'account', account: 'old-owner.testnet' } });
    expect(ownerCallOf(remove)).toBeNull();
    expect(describeStep(withAud, remove)).toContain('[signed by old-owner.testnet');
    expect(withKey.blockers).toEqual([]);
    const noKey = buildDeployPlan(withAud, deployed({ globalScope, ...at('global'), globalOwnerKeys: { 'old-owner.testnet': false } }), opts);
    expect(noKey.blockers.join()).toContain('must come from an Owner::Near');
    expect(noKey.steps.map((s) => s.kind)).not.toContain('remove-console-client');
  });

  it('refuses to leave "global" without a client', () => {
    const globalScope = { id: 'global', owners: [{ Near: { account_id: m.owner } }], clients: [CONSOLE_AUD], allow_shared: false };
    expect(buildDeployPlan(withAud, deployed({ globalScope, ...at('global') }), opts).blockers.join()).toContain('without a client');
  });

  it('a console audience removed earlier (unregistered) is registered in a sink with no wait; one already in a sink is done', () => {
    const unregistered = buildDeployPlan(withAud, deployed(at(null)), opts);
    expect(unregistered.steps).toContainEqual({ kind: 'register-console-sink', owners: [{ Near: { account_id: m.owner } }], clients: [CONSOLE_AUD], quarantineMs: 0 });
    const sink = { id: 's7', owners: [{ Near: { account_id: m.owner } }], clients: [CONSOLE_AUD], allow_shared: false };
    const done = buildDeployPlan(withAud, deployed({ ...at('s7'), consoleSinkScopes: { s7: sink } }), opts);
    expect(done.steps.filter((s) => s.kind === 'register-console-sink' || s.kind === 'remove-console-client')).toEqual([]);
    expect(done.done.join()).toContain('Console sink scope "s7" holds');
    // Owned by the council DAO: a known Hana owner.
    expect(buildDeployPlan(withAud, deployed({ ...at('s7'), consoleSinkScopes: { s7: { ...sink, owners: [{ Near: { account_id: m.council!.dao } }] } } }), opts).blockers).toEqual([]);
    // Registered by the owner before a transfer: a sink only once that account is named as a known Hana owner.
    const oldSink = { s7: { ...sink, owners: [{ Near: { account_id: 'old-owner.testnet' } }] } };
    expect(buildDeployPlan(withAud, deployed({ ...at('s7'), consoleSinkScopes: oldSink }), opts).blockers.join()).toContain('--known-owner');
    const known = buildDeployPlan(withAud, deployed({ ...at('s7'), consoleSinkScopes: oldSink }), { ...opts, knownOwners: ['old-owner.testnet'] });
    expect(known.blockers).toEqual([]);
    expect(known.done.join()).toContain('Console sink scope "s7" holds');
    // Any other NEAR account among the owners, even beside Hana's, is not a sink.
    const mixed = { s7: { ...sink, owners: [{ Near: { account_id: m.owner } }, { Near: { account_id: 'mallory.testnet' } }] } };
    expect(buildDeployPlan(withAud, deployed({ ...at('s7'), consoleSinkScopes: mixed }), opts).blockers.join()).toContain('not a Hana console sink');
    expect(buildDeployPlan(withAud, deployed({ ...at('s7'), consoleSinkScopes: { s7: { ...sink, owners: [{ Near: { account_id: 'mallory.testnet' } }] } } }), opts).blockers.join()).toContain('not a Hana console sink');
  });

  it('a console audience claimed by another scope (an OIDC owner, other clients or shared login) is a blocker', () => {
    const claimed = [
      { id: 's5', owners: [{ Oidc: { provider: 'google', sub: '1' } }], clients: [CONSOLE_AUD], allow_shared: false },
      { id: 's5', owners: [{ Near: { account_id: 'mallory.testnet' } }], clients: [CONSOLE_AUD, ['google', 'partner.apps.googleusercontent.com']], allow_shared: false },
      { id: 's5', owners: [{ Near: { account_id: m.owner } }], clients: [CONSOLE_AUD], allow_shared: true },
    ];
    for (const view of claimed) {
      const p = buildDeployPlan(withAud, deployed({ ...at('s5'), consoleSinkScopes: { s5: view } }), opts);
      expect(p.blockers.join(), JSON.stringify(view)).toContain('not a Hana console sink');
    }
    // A console audience that is also one of Hana's own clients can't be kept out of "global".
    expect(buildDeployPlan({ ...m, consoleAudiences: [HANA] }, fresh(), opts).blockers.join()).toContain('both a console audience and one of googleClientIds');
  });

  it('a console client retired from consoleAudiences but still in the sink: a blocker naming console:remove-audience; done once removed (D416)', () => {
    const OLD: [string, string] = ['google', 'old-console.apps.googleusercontent.com'];
    const sink = (clients: [string, string][]) => ({ s3: { id: 's3', owners: [{ Near: { account_id: m.owner } }], clients, allow_shared: false } });
    const scopes = (keys: [string, string][]) => Object.fromEntries(keys.map((c) => [`${c[0]}/${c[1]}`, 's3']));
    // Both in the manifest and the sink: done.
    const both = { ...withAud, consoleAudiences: [CONSOLE_AUD, OLD] };
    const kept = buildDeployPlan(both, deployed({ consoleAudienceScopes: scopes([CONSOLE_AUD, OLD]), consoleSinkScopes: sink([CONSOLE_AUD, OLD]) }), opts);
    expect(kept.blockers).toEqual([]);
    expect(kept.done.join()).toContain('Console sink scope "s3" holds');
    // The old one dropped from the manifest while the sink still holds it: refused, with the way out.
    const stale = buildDeployPlan(withAud, deployed({ consoleAudienceScopes: scopes([CONSOLE_AUD]), consoleSinkScopes: sink([CONSOLE_AUD, OLD]) }), opts);
    expect(stale.blockers.join()).toContain(`still holds google/${OLD[1]}, no longer in consoleAudiences`);
    expect(stale.blockers.join()).toContain(`admin ${m.name} console:remove-audience <aud>`);
    // After console:remove-audience: the sink holds only the manifest's audience.
    const after = buildDeployPlan(withAud, deployed({ consoleAudienceScopes: scopes([CONSOLE_AUD]), consoleSinkScopes: sink([CONSOLE_AUD]) }), opts);
    expect(after.blockers).toEqual([]);
    expect(after.steps.filter((s) => s.kind === 'register-console-sink' || s.kind === 'remove-console-client')).toEqual([]);
    // A new audience beside the sink's (a superset in the manifest): registered in a new sink, the old sink done.
    const NEW2: [string, string] = ['google', 'console-2.apps.googleusercontent.com'];
    const more = buildDeployPlan({ ...withAud, consoleAudiences: [CONSOLE_AUD, NEW2] }, deployed({ consoleAudienceScopes: { ...scopes([CONSOLE_AUD]), [`${NEW2[0]}/${NEW2[1]}`]: null }, consoleSinkScopes: sink([CONSOLE_AUD]) }), opts);
    expect(more.blockers).toEqual([]);
    expect(more.steps).toContainEqual({ kind: 'register-console-sink', owners: [{ Near: { account_id: m.owner } }], clients: [NEW2], quarantineMs: 0 });
  });

  it('warns when the signer balance looks too low for the wasm', () => {
    const p = buildDeployPlan(m, fresh({ wasmBytes: 400_000, accounts: { ...fresh().accounts, signer: { exists: true, balanceYocto: 2n * NEAR, codeHash: EMPTY_CODE_HASH } } }), opts);
    expect(p.warnings.join()).toContain('locks');
  });
});
