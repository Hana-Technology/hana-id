import { describe, expect, it } from 'vitest';
import { loadEnv } from '@hana-id/env';
import { buildDeployPlan, type DeployObserved, type DeployOptions, describeStep } from '../lib/deploy-plan.ts';
import { EMPTY_CODE_HASH } from '../lib/near.ts';

const base = loadEnv('sandbox-dev');
const m = { ...base, googleClientIds: ['hana.apps.googleusercontent.com'] };
const NEAR = 10n ** 24n;

function fresh(over: Partial<DeployObserved> = {}): DeployObserved {
  const acct = { exists: true, balanceYocto: 10n * NEAR, codeHash: EMPTY_CODE_HASH };
  const cred = { found: true, publicKey: 'ed25519:K', fullAccessOnChain: true };
  return {
    chainId: 'testnet',
    accounts: { signer: acct, relayer: acct, owner: acct },
    credentials: { signer: cred, relayer: cred, owner: cred },
    config: null,
    relayerKeysOnChain: [],
    relayerKeysElsewhere: {},
    relayerKeysInFile: [],
    signerFunctionKeysOnChain: [],
    updaterKeyInFile: null,
    googleIssuer: null,
    globalScope: null,
    wasmBytes: null,
    ...over,
  };
}

const opts: DeployOptions = { relayerKeyCount: 3, relayerAllowanceYocto: 2n * NEAR, updaterAllowanceYocto: NEAR, upgrade: false, skipBuild: false };

describe('buildDeployPlan', () => {
  it('plans a full fresh deploy in order', () => {
    const p = buildDeployPlan(m, fresh(), opts);
    expect(p.blockers).toEqual([]);
    expect(p.steps.map((s) => s.kind)).toEqual(['build', 'deploy', 'relayer-keys', 'updater-key', 'set-issuer', 'set-sponsors', 'register-global']);
    expect(p.steps[1]).toEqual({ kind: 'deploy', init: { owner: m.owner, mpc: m.mpc, ckd_domain_id: 2, change_delay_ms: m.changeDelayMs } });
    const relayer = p.steps[2];
    expect(relayer).toMatchObject({ kind: 'relayer-keys', generate: 3, reuse: [], allowanceYocto: 2n * NEAR });
    expect(relayer?.kind === 'relayer-keys' && relayer.methods).toEqual([
      'create_session', 'derive_key', 'revoke_session', 'prune_sessions', 'register_scope', 'propose_change', 'cancel_change', 'remove_client', 'execute_change',
    ]);
    expect(p.steps[3]).toMatchObject({ kind: 'updater-key', reuse: null, methods: ['set_issuer_key', 'remove_issuer_key'] });
    expect(p.steps[4]).toEqual({ kind: 'set-issuer', provider: 'google', iss_values: ['https://accounts.google.com', 'accounts.google.com'] });
    expect(p.steps[5]).toEqual({ kind: 'set-sponsors', sponsors: [m.relayer] });
    expect(p.steps[6]).toEqual({ kind: 'register-global', owners: [{ Near: { account_id: m.owner } }], clients: [['google', 'hana.apps.googleusercontent.com']] });
  });

  // Steps hold public keys only; that no secret reaches the output is checked end to end in deploy-run.test.ts.
  it('descriptions name accounts and arguments', () => {
    const p = buildDeployPlan(m, fresh(), opts);
    const text = p.steps.map((s) => describeStep(m, s)).join('\n');
    expect(text).toContain(m.signer);
    expect(text).toContain(`generate 3 new key(s) into .secrets/${m.name}/relayer-keys.json`);
    expect(text).toContain('"scope_id":"global"');
  });

  it('plans nothing when everything is in place', () => {
    const p = buildDeployPlan(
      m,
      fresh({
        accounts: { signer: { exists: true, balanceYocto: 10n * NEAR, codeHash: 'abc' }, relayer: fresh().accounts.relayer, owner: fresh().accounts.owner },
        config: { owner: m.owner, mpc: m.mpc, ckd_domain_id: 2, sponsors: [m.relayer], change_delay_ms: m.changeDelayMs, console_audiences: [] },
        relayerKeysOnChain: ['ed25519:1', 'ed25519:2', 'ed25519:3'],
        relayerKeysInFile: ['ed25519:1', 'ed25519:2', 'ed25519:3'],
        signerFunctionKeysOnChain: ['ed25519:U'],
        updaterKeyInFile: 'ed25519:U',
        googleIssuer: { iss_values: ['accounts.google.com', 'https://accounts.google.com'], kids: [] },
        globalScope: { id: 'global' },
      }),
      opts,
    );
    expect(p.blockers).toEqual([]);
    expect(p.steps).toEqual([]);
    expect(p.done.length).toBeGreaterThan(3);
  });

  it('resumes a partial deploy: re-adds saved keys, tops up to the count', () => {
    const p = buildDeployPlan(
      m,
      fresh({
        accounts: { signer: { exists: true, balanceYocto: 10n * NEAR, codeHash: 'abc' }, relayer: fresh().accounts.relayer, owner: fresh().accounts.owner },
        config: { owner: m.owner, sponsors: [] },
        relayerKeysOnChain: ['ed25519:1'],
        relayerKeysInFile: ['ed25519:1', 'ed25519:2'],
        updaterKeyInFile: 'ed25519:U',
      }),
      { ...opts, relayerKeyCount: 4 },
    );
    expect(p.steps.map((s) => s.kind)).toEqual(['relayer-keys', 'updater-key', 'set-issuer', 'set-sponsors', 'register-global']);
    expect(p.steps[0]).toMatchObject({ reuse: ['ed25519:2'], generate: 2 });
    expect(p.steps[1]).toMatchObject({ reuse: 'ed25519:U' });
  });

  it('blocks (instead of re-adding) file keys already on the relayer for another receiver or with full access', () => {
    const p = buildDeployPlan(
      m,
      fresh({
        accounts: { signer: { exists: true, balanceYocto: 10n * NEAR, codeHash: 'abc' }, relayer: fresh().accounts.relayer, owner: fresh().accounts.owner },
        config: { owner: m.owner, sponsors: [m.relayer] },
        relayerKeysOnChain: ['ed25519:1'],
        relayerKeysElsewhere: { 'ed25519:2': 'a function-call key for old-signer.testnet', 'ed25519:3': 'a full-access key', 'ed25519:9': 'a full-access key' },
        relayerKeysInFile: ['ed25519:1', 'ed25519:2', 'ed25519:3', 'ed25519:4'],
      }),
      opts,
    );
    const text = p.blockers.join('\n');
    expect(text).toContain('holds 2 key(s) that are already on');
    expect(text).toContain('ed25519:2: a function-call key for old-signer.testnet');
    expect(text).toContain('ed25519:3: a full-access key');
    expect(text).not.toContain('ed25519:9'); // not in the file: not ours to mention
    expect(text).toContain(`move .secrets/${m.name}/relayer-keys.json aside`);
    // Only the key that is genuinely absent would be re-added.
    expect(p.steps.find((s) => s.kind === 'relayer-keys')).toMatchObject({ reuse: ['ed25519:4'], generate: 0 });
  });

  it('--upgrade redeploys code without init', () => {
    const p = buildDeployPlan(m, fresh({ accounts: { ...fresh().accounts, signer: { exists: true, balanceYocto: 10n * NEAR, codeHash: 'abc' } }, config: { owner: m.owner } }), { ...opts, upgrade: true, skipBuild: true });
    expect(p.steps.slice(0, 1)).toEqual([{ kind: 'deploy', init: null }]);
  });

  it('blocks on missing accounts, missing keys, wrong chain, foreign code and owner mismatch', () => {
    const missing = buildDeployPlan(m, fresh({ accounts: { ...fresh().accounts, relayer: { exists: false, balanceYocto: 0n, codeHash: '' } } }), opts);
    expect(missing.blockers.join('\n')).toContain('create-account sponsor-by-faucet-service');
    const noKey = buildDeployPlan(m, fresh({ credentials: { ...fresh().credentials, owner: { found: false, fullAccessOnChain: false } } }), opts);
    expect(noKey.blockers.join('\n')).toContain('.near-credentials');
    const fnKey = buildDeployPlan(m, fresh({ credentials: { ...fresh().credentials, signer: { found: true, publicKey: 'ed25519:X', fullAccessOnChain: false } } }), opts);
    expect(fnKey.blockers.join('\n')).toContain('not a full-access key');
    expect(buildDeployPlan(m, fresh({ chainId: 'mainnet' }), opts).blockers.join()).toContain('not testnet');
    const foreign = buildDeployPlan(m, fresh({ accounts: { ...fresh().accounts, signer: { exists: true, balanceYocto: 10n * NEAR, codeHash: 'abc' } } }), opts);
    expect(foreign.blockers.join()).toContain('fresh signer account');
    const owner = buildDeployPlan(m, fresh({ config: { owner: 'someone.testnet' } }), opts);
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
