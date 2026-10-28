import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../src/runs.ts';
import { SHIP_GATE_RUNS, median, shipGate } from '../src/ship-gate.ts';
import type { VaultRunRecord } from '../src/vault-runs.ts';

const ENV = 'sandbox-dev';
const SIGNER = 'hana-id-signer-dev1.testnet';
const API = 'https://hana-id-api-sandbox-dev.example.workers.dev';
const LOCAL_API = 'http://localhost:8787';

const vault = (chain: number | undefined, over: Partial<VaultRunRecord> = {}): VaultRunRecord =>
  ({ env: ENV, signer: SIGNER, apiUrl: API, kind: 'login', timings: { stages: chain === undefined ? null : { chain }, totalMs: 1 }, ...over }) as VaultRunRecord;
const split = (createSessionMs: number | null, deriveMs: number, over: Partial<RunRecord> = {}): RunRecord =>
  ({ env: ENV, signer: SIGNER, apiUrl: API, counter: 1, timings: { googleMs: 1, createSessionMs, deriveMs, decryptVerifyMs: 1, totalMs: 1 }, ...over }) as RunRecord;
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
    const g = shipGate(ENV, SIGNER, API, v, s);
    expect(g).toMatchObject({ verdict: 'pending', savedMs: null, combined: { runs: 9, medianMs: 6000, excluded: 0 }, split: { runs: 10, medianMs: 8500, excluded: 0 } });
    expect(g.note).toBe('Needs 1 more vault login(s) on sandbox-dev');
    expect(shipGate(ENV, SIGNER, API, [], []).note).toBe(`Needs ${SHIP_GATE_RUNS} more vault login(s) and ${SHIP_GATE_RUNS} more direct-page session(s) on sandbox-dev`);
  });

  it('passes when the combined median saves at least 1.5 s', () => {
    const g = shipGate(ENV, SIGNER, API, times(10, () => vault(7000)), times(10, () => split(4250, 4250)));
    expect(g).toMatchObject({ verdict: 'pass', savedMs: 1500 });
    expect(g.note).toMatch(/keep create_session_and_derive \(allowlist state 2\)$/);
  });

  it('fails below 1.5 s', () => {
    const g = shipGate(ENV, SIGNER, API, times(10, () => vault(7001)), times(10, () => split(4250, 4250)));
    expect(g).toMatchObject({ verdict: 'fail', savedMs: 1499 });
    expect(g.note).toMatch(/remove create_session_and_derive \(allowlist state 3\)$/);
  });

  it('uses the latest 10 samples of each side', () => {
    const v = [...times(5, () => vault(60_000)), ...times(10, () => vault(5000))];
    const g = shipGate(ENV, SIGNER, API, v, times(10, () => split(4000, 4000)));
    expect(g).toMatchObject({ combined: { runs: 15, medianMs: 5000 }, savedMs: 3000, verdict: 'pass' });
  });

  it('never compares two APIs: direct-page runs against an override (or with no recorded API) are left out and named', () => {
    // A local `wrangler dev` (VITE_HANA_API_URL) answers much faster: mixed in, these would turn a fail into a pass.
    const local = times(10, () => split(500, 500, { apiUrl: LOCAL_API }));
    const legacy = split(500, 500);
    delete (legacy as { apiUrl?: string }).apiUrl;
    const deployed = times(9, () => split(4250, 4250));
    const g = shipGate(ENV, SIGNER, API, times(10, () => vault(7001)), [...deployed, ...local, legacy]);
    expect(g).toMatchObject({ verdict: 'pending', split: { runs: 9, medianMs: 8500, excluded: 11 }, combined: { runs: 10, excluded: 0 } });
    expect(g.note).toBe(
      `Needs 1 more direct-page session(s) on sandbox-dev (left out: 11 direct-page run(s) against another API than ${API}, such as a VITE_HANA_API_URL override, or logged before runs recorded their API)`,
    );
    // With the tenth deployed session the verdict is the deployed API's alone, still with the note.
    const g2 = shipGate(ENV, SIGNER, API, times(10, () => vault(7001)), [...deployed, split(4250, 4250), ...local]);
    expect(g2).toMatchObject({ verdict: 'fail', savedMs: 1499, split: { excluded: 10 } });
    expect(g2.note).toMatch(/^Saves 1499 ms .*\(left out: 10 direct-page run\(s\) against another API/u);
  });

  it('leaves out vault runs recorded against another API too', () => {
    const g = shipGate(ENV, SIGNER, API, [...times(10, () => vault(7000)), vault(100, { apiUrl: LOCAL_API })], times(10, () => split(4250, 4250)));
    expect(g).toMatchObject({ verdict: 'pass', combined: { runs: 10, medianMs: 7000, excluded: 1 } });
    expect(g.note).toMatch(/left out: 1 vault run\(s\)/u);
  });
});
