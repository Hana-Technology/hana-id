// The one-transaction login's ship gate (docs/batch-b-spec.md, Decisions "One transaction per login"): if the 10-run
// testnet median of create_session_and_derive saves less than 1.5 s over the split flow (create_session, then
// derive_key), the combined method is removed before the audit. Both sides are API round trips, measured on this page:
// - combined: the vault's `chain` stage (POST /v1/login, from a pk_test_ app's LoginResult.timings);
// - split: the direct page's create_session + derive_key round trips of a session's first derive.
// The gate is the user's call; this only computes the medians from the results logs.
import type { RunRecord } from './runs.ts';
import type { VaultRunRecord } from './vault-runs.ts';

export const SHIP_GATE_RUNS = 10;
export const SHIP_GATE_MIN_SAVING_MS = 1500;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export interface GateSide {
  /** Samples available (the median uses the latest SHIP_GATE_RUNS of them). */
  runs: number;
  medianMs: number | null;
}

export interface ShipGate {
  combined: GateSide;
  split: GateSide;
  /** split median − combined median, once both sides have SHIP_GATE_RUNS samples. */
  savedMs: number | null;
  verdict: 'pass' | 'fail' | 'pending';
  note: string;
}

const latest = (xs: readonly number[]): number[] => xs.slice(-SHIP_GATE_RUNS);

function side(samples: readonly number[]): GateSide {
  return { runs: samples.length, medianMs: median(latest(samples)) };
}

/** The ship gate for `env`/`signer` from the vault log (combined) and the direct log (split). */
export function shipGate(env: string, signer: string, vaultRuns: readonly VaultRunRecord[], directRuns: readonly RunRecord[]): ShipGate {
  const combinedSamples = vaultRuns
    .filter((r) => r.env === env && r.signer === signer && r.kind === 'login' && typeof r.timings.stages?.chain === 'number')
    .map((r) => r.timings.stages!.chain as number);
  const splitSamples = directRuns
    .filter((r) => r.env === env && r.signer === signer && r.counter === 1 && r.timings.createSessionMs !== null)
    .map((r) => (r.timings.createSessionMs as number) + r.timings.deriveMs);
  const combined = side(combinedSamples);
  const split = side(splitSamples);
  if (combined.runs < SHIP_GATE_RUNS || split.runs < SHIP_GATE_RUNS) {
    const need = [
      combined.runs < SHIP_GATE_RUNS ? `${SHIP_GATE_RUNS - combined.runs} more vault login(s)` : null,
      split.runs < SHIP_GATE_RUNS ? `${SHIP_GATE_RUNS - split.runs} more direct-page session(s)` : null,
    ].filter(Boolean);
    return { combined, split, savedMs: null, verdict: 'pending', note: `Needs ${need.join(' and ')} on ${env}` };
  }
  const savedMs = (split.medianMs as number) - (combined.medianMs as number);
  const pass = savedMs >= SHIP_GATE_MIN_SAVING_MS;
  return {
    combined,
    split,
    savedMs,
    verdict: pass ? 'pass' : 'fail',
    note: pass
      ? `Saves ${Math.round(savedMs)} ms (≥ ${SHIP_GATE_MIN_SAVING_MS} ms): keep create_session_and_derive (allowlist state 2)`
      : `Saves ${Math.round(savedMs)} ms (< ${SHIP_GATE_MIN_SAVING_MS} ms): remove create_session_and_derive (allowlist state 3)`,
  };
}
