// The NEAR meta-transaction relay's configuration (D733, D736): the Worker var NEAR_RELAY, a JSON object gen-wrangler
// writes from the manifest's `near.relay`, and the secret NEAR_RELAY_KEYS (full-access keys on the relay account).
// Pure: the gen script and the sandbox tests read the same parser. Anything unreadable turns the relay off (fail
// closed): the routes then answer 503 relayer_unconfigured.
import { NEAR_ACCOUNT_RE, TGAS } from './delegate.ts';

/** Defaults when the manifest leaves a field out (testnet values; mainnet needs its own decision, mainnet-readiness). */
export const NEAR_RELAY_DEFAULTS = {
  /**
   * Gas all inner calls of one delegate may attach together (the relayer prepays it, holding about 10× it at the
   * pessimistic gas price until the refund). The guestbook's add_message burns about 1.45 Tgas.
   */
  maxGasTgas: 50,
  /** The NEAR the relay may spend in one UTC day, across the env (counted at the worst case, settled to what burnt). */
  dailyBudgetNear: 5,
  /** The NEAR one app may spend in one UTC day: below the env's, so one leaked key can't take the whole day (D736). */
  appDailyBudgetNear: 1,
  /** Relays per sender account per UTC day. */
  perSenderPerDay: 100,
  /** Relays per app per UTC day (below `relaysPerDay`). */
  perAppPerDay: 5000,
  /** Relays across the env per UTC day. */
  relaysPerDay: 20_000,
  /** Activations per app per UTC day (below `activationsPerDay`). */
  activationsPerAppPerDay: 200,
  /** Activations across the env per UTC day (each costs about 0.0071 NEAR; the budget bounds them too). */
  activationsPerDay: 1000,
  /** Below this balance (NEAR) the hourly check writes `near_relay_balance_low`. */
  lowBalanceNear: 2,
  /** The activation's Transfer, yocto: 0 creates an implicit account (zero-balance account, measured on near-sandbox). */
  activationYocto: '0',
  /**
   * Relay and activate only for a NEAR account the wallet directory holds for a user of the app's scope (D735). On by
   * default (fail closed); `false` (testnet only) leaves the limits alone to bound the spend.
   */
  requireKnownAccount: true,
} as const;

/** Hard bounds the parser enforces whatever the manifest says (the schema has the same ones). */
export const NEAR_RELAY_BOUNDS = {
  maxGasTgas: 300,
  dailyBudgetNear: 1000,
  perSenderPerDay: 10_000,
  perAppPerDay: 1_000_000,
  relaysPerDay: 10_000_000,
  activationsPerDay: 1_000_000,
  receivers: 16,
  lowBalanceNear: 1000,
  activationYocto: 10n ** 22n,
} as const;

/** Fixed limits (not in the manifest): see docs/api.md "NEAR relay". */
export const NEAR_RELAY_LIMITS = {
  /** Relays per Hana user (the directory's user, or a session proof's account root) per UTC day, across their NEAR accounts. */
  perUserPerDay: 200,
  /** Relays per app per minute. */
  perAppPerMinute: 120,
  /** Relays per IP subject per minute, across every app (the app gate's window). */
  perIpPerMinute: 30,
  /** Activations per Hana user per UTC day. */
  activationsPerUserPerDay: 5,
  /** Activations per IP subject per minute, across every app. */
  activationsPerIpPerMinute: 10,
  /** How far ahead of the current final block a delegate's `max_block_height` may be (≈ 10 min of testnet blocks). */
  maxBlocksAhead: 1000,
  /** A budget alert (`near_relay_budget_high`) once a day's spend reaches this share of the budget. */
  budgetAlertPct: 80,
} as const;

export interface NearRelayConfig {
  account: string;
  receivers: string[];
  maxGas: bigint;
  dailyBudgetYocto: bigint;
  appDailyBudgetYocto: bigint;
  perSenderPerDay: number;
  perAppPerDay: number;
  relaysPerDay: number;
  activationsPerAppPerDay: number;
  activationsPerDay: number;
  lowBalanceYocto: bigint;
  activationYocto: bigint;
  requireKnownAccount: boolean;
}

/** The manifest-side shape (what gen-wrangler serialises). */
export interface NearRelayManifest {
  account: string;
  receivers: string[];
  maxGasTgas?: number | undefined;
  dailyBudgetNear?: number | undefined;
  appDailyBudgetNear?: number | undefined;
  perSenderPerDay?: number | undefined;
  perAppPerDay?: number | undefined;
  relaysPerDay?: number | undefined;
  activationsPerAppPerDay?: number | undefined;
  activationsPerDay?: number | undefined;
  lowBalanceNear?: number | undefined;
  /** Decimal yocto, at most 0.01 NEAR (NEAR_RELAY_BOUNDS.activationYocto). */
  activationYocto?: string | undefined;
  requireKnownAccount?: boolean | undefined;
}

const OPTIONAL_FIELDS = ['maxGasTgas', 'dailyBudgetNear', 'appDailyBudgetNear', 'perSenderPerDay', 'perAppPerDay', 'relaysPerDay', 'activationsPerAppPerDay', 'activationsPerDay', 'lowBalanceNear', 'activationYocto', 'requireKnownAccount'] as const;

/** NEAR (a decimal number with at most 6 places) → yocto. */
export function nearToYocto(near: number): bigint {
  const micro = Math.round(near * 1_000_000);
  return BigInt(micro) * 10n ** 18n;
}

const intIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const numIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v > min && v <= max;

/**
 * Parses NEAR_RELAY. Null (relay off) for anything absent, malformed or out of bounds, and for a per-app cap or budget
 * not below the env's (D736: one app must never be able to use up the env's day).
 */
export function parseNearRelayConfig(raw: string | undefined): NearRelayConfig | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  const allowed = new Set<string>(['account', 'receivers', ...OPTIONAL_FIELDS]);
  if (Object.keys(m).some((k) => !allowed.has(k))) return null;
  if (typeof m.account !== 'string' || !NEAR_ACCOUNT_RE.test(m.account)) return null;
  const receivers = m.receivers;
  if (!Array.isArray(receivers) || receivers.length > NEAR_RELAY_BOUNDS.receivers || !receivers.every((r) => typeof r === 'string' && NEAR_ACCOUNT_RE.test(r))) return null;
  if (new Set(receivers).size !== receivers.length || receivers.includes(m.account)) return null;
  const d = NEAR_RELAY_DEFAULTS;
  const maxGasTgas = m.maxGasTgas ?? d.maxGasTgas;
  const dailyBudgetNear = m.dailyBudgetNear ?? d.dailyBudgetNear;
  const appDailyBudgetNear = m.appDailyBudgetNear ?? Math.min(d.appDailyBudgetNear, (dailyBudgetNear as number) / 5);
  const perSenderPerDay = m.perSenderPerDay ?? d.perSenderPerDay;
  const perAppPerDay = m.perAppPerDay ?? d.perAppPerDay;
  const relaysPerDay = m.relaysPerDay ?? d.relaysPerDay;
  const activationsPerAppPerDay = m.activationsPerAppPerDay ?? d.activationsPerAppPerDay;
  const activationsPerDay = m.activationsPerDay ?? d.activationsPerDay;
  const lowBalanceNear = m.lowBalanceNear ?? d.lowBalanceNear;
  const requireKnownAccount = m.requireKnownAccount ?? d.requireKnownAccount;
  if (!intIn(maxGasTgas, 1, NEAR_RELAY_BOUNDS.maxGasTgas)) return null;
  if (!numIn(dailyBudgetNear, 0, NEAR_RELAY_BOUNDS.dailyBudgetNear) || !numIn(appDailyBudgetNear, 0, NEAR_RELAY_BOUNDS.dailyBudgetNear)) return null;
  if (!intIn(perSenderPerDay, 1, NEAR_RELAY_BOUNDS.perSenderPerDay) || !intIn(perAppPerDay, 1, NEAR_RELAY_BOUNDS.perAppPerDay) || !intIn(relaysPerDay, 1, NEAR_RELAY_BOUNDS.relaysPerDay)) return null;
  if (!intIn(activationsPerAppPerDay, 1, NEAR_RELAY_BOUNDS.activationsPerDay) || !intIn(activationsPerDay, 1, NEAR_RELAY_BOUNDS.activationsPerDay)) return null;
  if (!numIn(lowBalanceNear, 0, NEAR_RELAY_BOUNDS.lowBalanceNear) || typeof requireKnownAccount !== 'boolean') return null;
  const appBudget = nearToYocto(appDailyBudgetNear);
  const budget = nearToYocto(dailyBudgetNear);
  // A per-app cap or budget at or above the env's would let one app (one leaked publishable key) use up the env's day.
  if (perAppPerDay >= relaysPerDay || activationsPerAppPerDay >= activationsPerDay || appBudget <= 0n || appBudget >= budget) return null;
  const activation = m.activationYocto ?? d.activationYocto;
  if (typeof activation !== 'string' || !/^(0|[1-9]\d{0,22})$/u.test(activation) || BigInt(activation) > NEAR_RELAY_BOUNDS.activationYocto) return null;
  return {
    account: m.account,
    receivers: receivers as string[],
    maxGas: BigInt(maxGasTgas) * TGAS,
    dailyBudgetYocto: budget,
    appDailyBudgetYocto: appBudget,
    perSenderPerDay,
    perAppPerDay,
    relaysPerDay,
    activationsPerAppPerDay,
    activationsPerDay,
    lowBalanceYocto: nearToYocto(lowBalanceNear),
    activationYocto: BigInt(activation),
    requireKnownAccount,
  };
}

/** The NEAR_RELAY var for a manifest's `near.relay` (gen-wrangler): the fields as given, defaults left to the parser. */
export function nearRelayVar(relay: NearRelayManifest): string {
  const out: Record<string, unknown> = { account: relay.account, receivers: [...relay.receivers] };
  for (const k of OPTIONAL_FIELDS) if (relay[k] !== undefined) out[k] = relay[k];
  return JSON.stringify(out);
}
