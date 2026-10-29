import { describe, expect, it } from 'vitest';
import { type RunRecord, compareRun, parsePath, parseStoredRuns, pkPrefix, resultsJson } from '../src/runs.ts';

let n = 0;
function run(over: Partial<RunRecord>): RunRecord {
  n += 1;
  return {
    run: n,
    at: '2026-10-26T00:00:00.000Z',
    env: 'sandbox-dev',
    signer: 'hana-id-signer-dev1.testnet',
    pkPrefix: 'pk_test_AAAAAAAA…',
    scopeId: 's1',
    clientMode: 'own',
    clientId: 'a.apps.googleusercontent.com',
    keyIndex: 0,
    path: 's1#google#111#0',
    counter: 1,
    sessionKeyPrefix: `00000${n}`,
    appIdHex: 'aa',
    derivation: 1,
    stellar: 'GA',
    evm: '0xA',
    createSessionTx: null,
    deriveTx: null,
    createSessionGas: null,
    deriveGas: null,
    timings: { googleMs: 1, createSessionMs: 2, deriveMs: 3, decryptVerifyMs: 4, totalMs: 10 },
    ...over,
  };
}

describe('results log comparisons', () => {
  it('same path through own and shared client: addresses must match', () => {
    const own = run({});
    const shared = run({ clientMode: 'shared', clientId: 'shared.apps.googleusercontent.com' });
    expect(compareRun(shared, [own])).toEqual([{ other: own.run, verdict: 'ok', note: 'same path, own vs shared client (own → shared): same addresses' }]);
    const broken = run({ clientMode: 'shared', stellar: 'GB' });
    expect(compareRun(broken, [own])[0]).toMatchObject({ verdict: 'fail' });
  });

  it('isolation: same user in another scope must give other addresses', () => {
    const a = run({});
    const b = run({ scopeId: 's2', path: 's2#google#111#0', stellar: 'GB', evm: '0xB', appIdHex: 'bb', pkPrefix: 'pk_test_BBBB…' });
    expect(compareRun(b, [a])).toEqual([{ other: a.run, verdict: 'ok', note: 'same user, other scope (s1 vs s2): addresses differ' }]);
    const leak = run({ scopeId: 's2', path: 's2#google#111#0', evm: '0xB', appIdHex: 'bb' });
    expect(compareRun(leak, [a])[0]).toMatchObject({ verdict: 'fail' });
  });

  it('key index: same user and scope, another key_index must give other addresses', () => {
    const k0 = run({});
    const k1 = run({ keyIndex: 1, path: 's1#google#111#1', stellar: 'GC', evm: '0xC', appIdHex: 'cc' });
    expect(compareRun(k1, [k0])[0]).toEqual({ other: k0.run, verdict: 'ok', note: 'same user and scope, key_index 0 vs 1: addresses differ' });
  });

  it('flags own vs shared giving another sub', () => {
    const own = run({});
    const shared = run({ clientMode: 'shared', path: 's1#google#222#0', stellar: 'GD', evm: '0xD', appIdHex: 'dd' });
    expect(compareRun(shared, [own])[0]?.note).toMatch(/Google sub differs/);
  });

  it('ignores runs of another environment or signer', () => {
    const a = run({});
    expect(compareRun(run({ env: 'other' }), [a])).toEqual([]);
    expect(compareRun(run({ signer: 'x.testnet' }), [a])).toEqual([]);
  });

  it('parses paths', () => {
    expect(parsePath('s1#google#111#0')).toEqual({ scope: 's1', provider: 'google', sub: '111', keyIndex: '0' });
    expect(parsePath('s1#google#0')).toBeNull();
  });

  it('exports and reloads public data only', () => {
    const runs = [run({})];
    const json = JSON.parse(resultsJson(runs)) as { runs: RunRecord[]; derivation: string };
    expect(json.runs).toEqual(runs);
    expect(json.derivation).toMatch(/^v1 /u);
    expect(parseStoredRuns(JSON.stringify(runs))).toEqual(runs);
    // Runs logged under the PROVISIONAL derivation (no `derivation` field) are dropped: their addresses differ.
    const { derivation: _, ...legacy } = runs[0]!;
    expect(parseStoredRuns(JSON.stringify([legacy]))).toEqual([]);
    expect(parseStoredRuns('not json')).toEqual([]);
    expect(parseStoredRuns(JSON.stringify([{ x: 1 }]))).toEqual([]);
    expect(parseStoredRuns(null)).toEqual([]);
  });

  it('shortens the publishable key', () => {
    expect(pkPrefix('pk_test_1234567890abcdefghij')).toBe('pk_test_12345678…');
    expect(pkPrefix('pk_test_x')).toBe('pk_test_x');
  });
});
