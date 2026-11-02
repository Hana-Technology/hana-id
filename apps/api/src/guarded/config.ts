// Batch C's vars (docs/batch-c-spec.md "Bindings"): the guarded-change delay, the network, and the Hana origins no app
// may list. Read by the guarded-change writers (AdminRpc and ConsoleRpc from batch C5); a missing or out-of-range delay
// refuses every guarded change with `internal` rather than guess a delay (spec "Topology and config" tests). Takes
// only the three vars (no Worker types), so the manifest-package check in scripts/test can import it.
const DAY_MS = 24 * 60 * 60 * 1000;
/** packages/env/src/dashboard.ts MIN/MAX/PRODUCTION_APP_CHANGE_DELAY_MS (the Worker doesn't import the manifest package; a test keeps them equal). */
export const MIN_APP_CHANGE_DELAY_MS = 60_000;
export const MAX_APP_CHANGE_DELAY_MS = 7 * DAY_MS;
export const PRODUCTION_APP_CHANGE_DELAY_MS = DAY_MS;
/** The NEAR network whose origin rules are production's (https only, no loopback, no wildcard). */
export const PRODUCTION_NETWORK = 'mainnet';

export interface ChangeConfig {
  delayMs: number;
  network: string;
  refusedOrigins: readonly string[];
}

export type ChangeConfigResult = { ok: true; config: ChangeConfig } | { ok: false; code: 'internal'; problem: string };

/**
 * The guarded-change configuration, or why there is none: APP_CHANGE_DELAY_MS an integer in [60 s, 7 d] (at least 24 h
 * on mainnet), NETWORK set, REFUSED_ORIGINS a JSON array of strings.
 */
export function changeConfig(env: { APP_CHANGE_DELAY_MS?: string; NETWORK?: string; REFUSED_ORIGINS?: string }): ChangeConfigResult {
  const fail = (problem: string): ChangeConfigResult => ({ ok: false, code: 'internal', problem });
  const raw = env.APP_CHANGE_DELAY_MS;
  if (raw === undefined || !/^\d{1,12}$/u.test(raw)) return fail('APP_CHANGE_DELAY_MS is missing or not an integer');
  const delayMs = Number(raw);
  if (delayMs < MIN_APP_CHANGE_DELAY_MS || delayMs > MAX_APP_CHANGE_DELAY_MS) return fail('APP_CHANGE_DELAY_MS is out of range');
  const network = env.NETWORK;
  if (!network) return fail('NETWORK is missing');
  if (network === PRODUCTION_NETWORK && delayMs < PRODUCTION_APP_CHANGE_DELAY_MS) return fail('APP_CHANGE_DELAY_MS is under 24 h on mainnet');
  let refused: unknown;
  try {
    refused = JSON.parse(env.REFUSED_ORIGINS ?? '');
  } catch {
    return fail('REFUSED_ORIGINS is missing or not JSON');
  }
  if (!Array.isArray(refused) || !refused.every((o) => typeof o === 'string' && o.length > 0)) return fail('REFUSED_ORIGINS is not an array of origins');
  return { ok: true, config: { delayMs, network, refusedOrigins: Object.freeze([...(refused as string[])]) } };
}
