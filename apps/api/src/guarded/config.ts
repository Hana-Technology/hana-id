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
/** packages/console-core PLATFORM_MIN_DELAY_MS (D914): what a platform key (and, from P4, a platform proposal) waits at least when nobody confirms it. */
export const PLATFORM_MIN_DELAY_MS = DAY_MS;

/**
 * A real-money setup (D914): four eyes on every platform key. Fails closed, as the manifest schema reads production
 * (`packages/env/src/schema.ts`: anything but testnet): every network but `testnet`, a missing one included.
 */
export const fourEyesNetwork = (network: string | undefined): boolean => network !== 'testnet';

/**
 * The platform minimum for this env (D914, D918): 24 h everywhere except a `local*` env on testnet, which keeps its own
 * short delay (0 here: the guarded-change delay then applies alone). Fails closed: any other name, a missing name, or
 * any other network (mainnet above all) gets the 24 h. The rest of the `local*` guard the spec proposes (the manifest
 * rule, the deploy wrapper's refusal) is piece P10's.
 */
/** A `local*` test env (its name `local…` and its network `testnet`): the one predicate for the platform's exceptions. */
export function isLocalTestEnv(env: { ENV_NAME?: string; NETWORK?: string }): boolean {
  return typeof env.ENV_NAME === 'string' && /^local/u.test(env.ENV_NAME) && env.NETWORK === 'testnet';
}

export function platformMinDelayMs(env: { ENV_NAME?: string; NETWORK?: string }): number {
  return isLocalTestEnv(env) ? 0 : PLATFORM_MIN_DELAY_MS;
}

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
