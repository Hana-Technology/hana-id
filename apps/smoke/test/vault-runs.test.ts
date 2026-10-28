import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../src/runs.ts';
import { type VaultRunRecord, accountLabelProblem, allResultsJson, compareVaultRun, parseStoredVaultRuns } from '../src/vault-runs.ts';

const A = { stellar: 'GA', evm: '0xAa' };
const B = { stellar: 'GB', evm: '0xBb' };

let n = 0;
function run(over: Partial<VaultRunRecord>): VaultRunRecord {
  n += 1;
  return {
    run: n,
    at: '2026-10-28T00:00:00.000Z',
    env: 'sandbox-dev',
    signer: 'hana-id-signer-dev1.testnet',
    pkPrefix: 'pk_test_AAAAAAAA…',
    scopeId: 's1',
    clientMode: 'own',
    clientId: 'a.apps.googleusercontent.com',
    account: 'personal',
    kind: 'login',
    keyIndex: 0,
    derivation: 1,
    persistence: 'session',
    warning: null,
    ...A,
    expiresAtMs: 1,
    timings: { stages: { chain: 6000 }, totalMs: 9000 },
    ...over,
  };
}

function direct(over: Partial<RunRecord>): RunRecord {
  return {
    run: 7,
    at: '2026-10-28T00:00:00.000Z',
    env: 'sandbox-dev',
    signer: 'hana-id-signer-dev1.testnet',
    pkPrefix: 'pk_test_AAAAAAAA…',
    scopeId: 's1',
    clientMode: 'own',
    clientId: 'a.apps.googleusercontent.com',
    keyIndex: 0,
    path: 's1#google#111#0',
    counter: 1,
    sessionKeyPrefix: '00',
    appIdHex: 'aa',
    derivation: 1,
    ...A,
    createSessionTx: null,
    deriveTx: null,
    createSessionGas: null,
    deriveGas: null,
    timings: { googleMs: 1, createSessionMs: 4000, deriveMs: 4000, decryptVerifyMs: 4, totalMs: 9000 },
    ...over,
  };
}

describe('vault results log comparisons', () => {
  it('same account and scope: same addresses, including own vs shared client', () => {
    const first = run({});
    const shared = run({ clientMode: 'shared' });
    expect(compareVaultRun(shared, [first])).toEqual([{ other: `#${first.run}`, verdict: 'ok', note: 'same account and scope, own → shared client: same addresses' }]);
    expect(compareVaultRun(run({ ...B }), [first])[0]).toMatchObject({ verdict: 'fail', note: 'same account and scope, but DIFFERENT addresses' });
  });

  it('same account in another scope, or another account: addresses must differ', () => {
    const first = run({});
    expect(compareVaultRun(run({ scopeId: 's2', ...B }), [first])[0]).toMatchObject({ verdict: 'ok', note: 'same account, other scope (s1 vs s2): addresses differ' });
    expect(compareVaultRun(run({ scopeId: 's2', stellar: A.stellar, evm: B.evm }), [first])[0]).toMatchObject({ verdict: 'fail' });
    expect(compareVaultRun(run({ account: 'workspace', ...B }), [first])[0]).toMatchObject({ verdict: 'ok', note: 'other account (personal vs workspace): addresses differ' });
    // EVM addresses compare case-insensitively (EIP-55 vs lowercase).
    expect(compareVaultRun(run({ account: 'workspace', stellar: 'GC', evm: '0xaa' }), [first])[0]).toMatchObject({ verdict: 'fail' });
  });

  it('without a label only notes equal addresses in the same scope', () => {
    const first = run({ account: '' });
    expect(compareVaultRun(run({ account: '' }), [first])).toEqual([{ other: `#${first.run}`, verdict: 'info', note: 'same scope, same addresses (no account label to judge by)' }]);
    expect(compareVaultRun(run({ account: 'personal', ...B }), [first])).toEqual([]);
  });

  it('an unlock must restore the latest earlier run of the same app', () => {
    const first = run({});
    const other = run({ pkPrefix: 'pk_test_BBBBBBBB…', scopeId: 's2', ...B });
    const unlock = run({ kind: 'unlock', timings: { stages: null, totalMs: 200 } });
    expect(compareVaultRun(unlock, [first, other])).toEqual([{ other: `#${first.run}`, verdict: 'ok', note: `unlock restored #${first.run}'s addresses` }]);
    expect(compareVaultRun(run({ kind: 'unlock', ...B }), [first])[0]).toMatchObject({ verdict: 'fail' });
    expect(compareVaultRun(run({ kind: 'unlock' }), [])[0]).toMatchObject({ verdict: 'info' });
  });

  it('ignores other envs and signers', () => {
    const first = run({ env: 'local' });
    const second = run({ signer: 'other.testnet' });
    expect(compareVaultRun(run({ ...B }), [first, second])).toEqual([]);
  });

  it('notes agreement with the direct page (key_index 0, same scope) and judges nothing else', () => {
    const r = run({});
    expect(compareVaultRun(r, [], [direct({})])).toEqual([{ other: 'direct #7', verdict: 'ok', note: 'same addresses as the in-page derivation (s1#google#111#0)' }]);
    expect(compareVaultRun(r, [], [direct({ keyIndex: 1 }), direct({ scopeId: 's2' }), direct({ ...B })])).toEqual([]);
  });
});

describe('vault results log storage', () => {
  it('drops malformed entries', () => {
    const good = run({});
    expect(parseStoredVaultRuns(JSON.stringify([good, { run: 2 }, null, { ...good, derivation: 0 }, { ...good, kind: 'derive' }]))).toEqual([good]);
    expect(parseStoredVaultRuns('nope')).toEqual([]);
    expect(parseStoredVaultRuns(null)).toEqual([]);
    expect(parseStoredVaultRuns('{}')).toEqual([]);
  });

  it('exports both logs', () => {
    const v = run({});
    const d = direct({});
    expect(JSON.parse(allResultsJson([v], [d]))).toMatchObject({ kind: 'hana-id-smoke-results', version: 2, vaultRuns: [v], directRuns: [d] });
  });
});

describe('account label', () => {
  it('accepts short tags and refuses email addresses', () => {
    expect(accountLabelProblem('')).toBeNull();
    expect(accountLabelProblem('workspace 2')).toBeNull();
    expect(accountLabelProblem('someone@example.com')).toMatch(/not an email address/);
    expect(accountLabelProblem('x'.repeat(33))).not.toBeNull();
  });
});
