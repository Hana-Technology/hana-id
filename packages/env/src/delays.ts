// Floors for the two governance delays a manifest sets (`issuerKeyDelayMs`, `governanceDelayMs`), from
// docs/governance-spec.md "Delay length" and D80. The contract accepts any value from 0 (its bounds are only upper
// ones), so deploy-contract checks these before it deploys, migrates or sets a delay.
import { isDevEnv } from './origins.ts';

/** W: the watchdog's cron interval (apps/watchdog `*\/5 * * * *`, `RUN_INTERVAL_MS`; a test keeps them equal). */
export const WATCHDOG_INTERVAL_MS = 5 * 60_000;
/** T: time to land a transaction. */
export const TX_LANDING_MS = 60_000;
/**
 * The security bound D ≥ 3·(W + T) = 18 min: a forged key proposed with a stolen updater key gets three watchdog runs
 * (two may be missed) to be cancelled before anyone may execute it. Below it the updater key can propose and
 * execute (both in UPDATER_METHODS) before any run sees the proposal.
 */
export const MIN_ISSUER_KEY_DELAY_MS = 3 * (WATCHDOG_INTERVAL_MS + TX_LANDING_MS);
/** Outside dev envs: upgrades, owner transfers, withdrawals and a new watchdog's confirm power wait at least a day. */
export const MIN_GOVERNANCE_DELAY_MS = 24 * 60 * 60_000;
/** Mainnet: the 72 h of D80. */
export const MAINNET_GOVERNANCE_DELAY_MS = 72 * 60 * 60_000;

export interface DelayValues {
  issuerKeyDelayMs?: number | undefined;
  governanceDelayMs?: number | undefined;
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;
const hours = (ms: number) => `${Math.round(ms / 3_600_000)} h`;

/**
 * Blockers and warnings for the delays an env will run with (by default the manifest's; an unset value isn't
 * checked). Outside dev envs (`local*`, `sandbox*`): `issuerKeyDelayMs` below MIN_ISSUER_KEY_DELAY_MS and
 * `governanceDelayMs` below MIN_GOVERNANCE_DELAY_MS (mainnet: MAINNET_GOVERNANCE_DELAY_MS) are blockers. Dev envs may
 * go lower for fast drills (sandbox-dev: 2 min and 60 s, D80), with a warning that the issuer-key delay is below the
 * security bound.
 */
export function governanceDelayProblems(m: { name: string; network: string } & DelayValues, values: DelayValues = m): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const { issuerKeyDelayMs: d, governanceDelayMs: g } = values;
  const dev = isDevEnv(m.name);
  if (d !== undefined && d < MIN_ISSUER_KEY_DELAY_MS) {
    const what = `issuer_key_delay_ms ${d} ms is below the security bound 3·(W + T) = ${minutes(MIN_ISSUER_KEY_DELAY_MS)} (W = ${minutes(WATCHDOG_INTERVAL_MS)} watchdog runs, T = ${minutes(TX_LANDING_MS)} to land a transaction)`;
    if (dev) warnings.push(`${what}: a stolen updater key could propose and execute a forged key before the watchdog's first run. Accepted only in dev envs (D80; docs/governance-spec.md "Delay length").`);
    else blockers.push(`${what}: a stolen updater key could propose and execute a forged key before the watchdog's first run. Set issuerKeyDelayMs ≥ ${MIN_ISSUER_KEY_DELAY_MS} in envs/${m.name}.json (docs/governance-spec.md "Delay length").`);
  }
  const floor = m.network === 'mainnet' ? MAINNET_GOVERNANCE_DELAY_MS : MIN_GOVERNANCE_DELAY_MS;
  if (!dev && g !== undefined && g < floor) {
    blockers.push(
      `governance_delay_ms ${g} ms is below ${hours(floor)}${m.network === 'mainnet' ? ' (mainnet, D80)' : ' for a non-dev env'}: upgrades, owner transfers and withdrawals would ` +
        `give partners and users less than that to react. Set governanceDelayMs ≥ ${floor} in envs/${m.name}.json.`,
    );
  }
  return { blockers, warnings };
}
