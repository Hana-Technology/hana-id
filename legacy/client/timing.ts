// How long each slow step usually takes, so the UI can show a countdown. Starts from measured testnet defaults and
// then averages this browser's recent runs (kept in localStorage: a convenience only).

export type StepKind = 'session' | 'ckd' | 'prepare' | 'sign' | 'verify' | 'stellar' | 'arbitrum' | 'sonic' | 'sodax' | 'fill';

/** Measured on NEAR testnet, Oct 2026. */
const DEFAULT_MS: Record<StepKind, number> = {
  session: 5_000,
  sign: 7_000,
  /** NEAR MPC Confidential Key Derivation (measured median 6.2 s, Oct 2026). */
  ckd: 6_500,
  stellar: 5_000,
  arbitrum: 2_000,
  sonic: 2_000,
  /** Sodax building the swap transaction (quote, deadline, Soroban simulation). */
  prepare: 5_500,
  /** Sodax submitting the signed swap to Stellar and relaying it to its hub. */
  sodax: 15_000,
  /** Sodax's solver filling the swap intent on its hub. */
  fill: 20_000,
  /** Local signature check. */
  verify: 300,
};

const KEY = 'embed.timings';
const KEEP = 5;

function read(): Partial<Record<StepKind, number[]>> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<StepKind, number[]>>;
  } catch {
    return {};
  }
}

/** Average of the last few runs, or the default. */
export function estimateMs(kind: StepKind): number {
  const runs = read()[kind];
  if (!runs?.length) return DEFAULT_MS[kind];
  return Math.round(runs.reduce((a, b) => a + b, 0) / runs.length);
}

export function recordMs(kind: StepKind, ms: number): void {
  try {
    const all = read();
    all[kind] = [...(all[kind] ?? []), ms].slice(-KEEP);
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable: estimates stay at the defaults.
  }
}
