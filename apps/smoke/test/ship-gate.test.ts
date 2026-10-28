import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../src/runs.ts';
import { SHIP_GATE_RUNS, median, shipGate } from '../src/ship-gate.ts';
import type { VaultRunRecord } from '../src/vault-runs.ts';

const ENV = 'sandbox-dev';
const SIGNER = 'hana-id-signer-dev1.testnet';

const vault = (chain: number | undefined, over: Partial<VaultRunRecord> = {}): VaultRunRecord =>
  ({ env: ENV, signer: SIGNER, kind: 'login', timings: { stages: chain === undefined ? null : { chain }, totalMs: 1 }, ...over }) as VaultRunRecord;
const split = (createSessionMs: number | null, deriveMs: number, over: Partial<RunRecord> = {}): RunRecord =>
  ({ env: ENV, signer: SIGNER, counter: 1, timings: { googleMs: 1, createSessionMs, deriveMs, decryptVerifyMs: 1, totalMs: 1 }, ...over }) as RunRecord;
const times = <T>(k: number, f: (i: number) => T): T[] => Array.from({ length: k }, (_, i) => f(i));

describe('median', () => {
  it('odd, even and empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('ship gate', () => {
  it('is pending until both sides have 10 runs, counting only usable samples', () => {
    const v = [...times(9, () => vault(6000)), vault(undefined), vault(6000, { kind: 'unlock' }), vault(6000, { env: 'other' })];
    const s = [...times(10, () => split(4000, 4500)), split(null, 4000), split(4000, 4000, { counter: 2 }), split(4000, 4000, { signer: 'x' })];
    const g = shipGate(ENV, SIGNER, v, s);
    expect(g).toMatchObject({ verdict: 'pending', savedMs: null, combined: { runs: 9, medianMs: 6000 }, split: { runs: 10, medianMs: 8500 } });
    expect(g.note).toBe('Needs 1 more vault login(s) on sandbox-dev');
    expect(shipGate(ENV, SIGNER, [], []).note).toBe(`Needs ${SHIP_GATE_RUNS} more vault login(s) and ${SHIP_GATE_RUNS} more direct-page session(s) on sandbox-dev`);
  });

  it('passes when the combined median saves at least 1.5 s', () => {
    const g = shipGate(ENV, SIGNER, times(10, () => vault(7000)), times(10, () => split(4250, 4250)));
    expect(g).toMatchObject({ verdict: 'pass', savedMs: 1500 });
    expect(g.note).toMatch(/keep create_session_and_derive \(allowlist state 2\)/);
  });

  it('fails below 1.5 s', () => {
    const g = shipGate(ENV, SIGNER, times(10, () => vault(7001)), times(10, () => split(4250, 4250)));
    expect(g).toMatchObject({ verdict: 'fail', savedMs: 1499 });
    expect(g.note).toMatch(/remove create_session_and_derive \(allowlist state 3\)/);
  });

  it('uses the latest 10 samples of each side', () => {
    const v = [...times(5, () => vault(60_000)), ...times(10, () => vault(5000))];
    const g = shipGate(ENV, SIGNER, v, times(10, () => split(4000, 4000)));
    expect(g).toMatchObject({ combined: { runs: 15, medianMs: 5000 }, savedMs: 3000, verdict: 'pass' });
  });
});
