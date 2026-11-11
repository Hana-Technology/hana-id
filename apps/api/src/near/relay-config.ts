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
  /** Relays per sender account per UTC day. */
  perSenderPerDay: 100,
  /** Relays per app per UTC day. */
  perAppPerDay: 5000,
  /** Below this balance (NEAR) the hourly check writes `near_relay_balance_low`. */
  lowBalanceNear: 2,
  /** The activation's Transfer, yocto: 0 creates an implicit account (zero-balance account, measured on near-sandbox). */
  activationYocto: '0',
} as const;

/** Hard bounds the parser enforces whatever the manifest says (the schema has the same ones). */
export const NEAR_RELAY_BOUNDS = { maxGasTgas: 300, dailyBudgetNear: 1000, perSenderPerDay: 10_000, perAppPerDay: 1_000_000, receivers: 16, lowBalanceNear: 1000, activationYocto: 10n ** 22n } as const;

/** Fixed limits (not in the manifest): see docs/api.md "NEAR relay". */
export const NEAR_RELAY_LIMITS = {
  /** Relays per Hana user (account root in the scope) per UTC day, across every NEAR account they relay for. */
  perUserPerDay: 200,
  /** Relays per app per minute. */
  perAppPerMinute: 120,
  /** Relays per IP subject per minute (exact, the limiter object), besides the vault's per-location window. */
  perIpPerMinute: 30,
  /** Activations per Hana user per UTC day. */
  activationsPerUserPerDay: 5,
  /** Activations per app per UTC day. */
  activationsPerAppPerDay: 1000,
  /** Activations per IP subject per minute. */
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
  perSenderPerDay: number;
  perAppPerDay: number;
  lowBalanceYocto: bigint;
  activationYocto: bigint;
}

/** The manifest-side shape (what gen-wrangler serialises). */
export interface NearRelayManifest {
  account: string;
  receivers: string[];
  maxGasTgas?: number | undefined;
  dailyBudgetNear?: number | undefined;
  perSenderPerDay?: number | undefined;
  perAppPerDay?: number | undefined;
  lowBalanceNear?: number | undefined;
  /** Decimal yocto, at most 0.01 NEAR (NEAR_RELAY_BOUNDS.activationYocto). */
  activationYocto?: string | undefined;
}

/** NEAR (a decimal number with at most 6 places) → yocto. */
export function nearToYocto(near: number): bigint {
  const micro = Math.round(near * 1_000_000);
  return BigInt(micro) * 10n ** 18n;
}

const intIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const numIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v > min && v <= max;

/** Parses NEAR_RELAY. Null (relay off) for anything absent, malformed or out of bounds. */
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
  const allowed = new Set(['account', 'receivers', 'maxGasTgas', 'dailyBudgetNear', 'perSenderPerDay', 'perAppPerDay', 'lowBalanceNear', 'activationYocto']);
  if (Object.keys(m).some((k) => !allowed.has(k))) return null;
  if (typeof m.account !== 'string' || !NEAR_ACCOUNT_RE.test(m.account)) return null;
  const receivers = m.receivers;
  if (!Array.isArray(receivers) || receivers.length > NEAR_RELAY_BOUNDS.receivers || !receivers.every((r) => typeof r === 'string' && NEAR_ACCOUNT_RE.test(r))) return null;
  if (new Set(receivers).size !== receivers.length || receivers.includes(m.account)) return null;
  const maxGasTgas = m.maxGasTgas ?? NEAR_RELAY_DEFAULTS.maxGasTgas;
  const dailyBudgetNear = m.dailyBudgetNear ?? NEAR_RELAY_DEFAULTS.dailyBudgetNear;
  const perSenderPerDay = m.perSenderPerDay ?? NEAR_RELAY_DEFAULTS.perSenderPerDay;
  const perAppPerDay = m.perAppPerDay ?? NEAR_RELAY_DEFAULTS.perAppPerDay;
  const lowBalanceNear = m.lowBalanceNear ?? NEAR_RELAY_DEFAULTS.lowBalanceNear;
  if (!intIn(maxGasTgas, 1, NEAR_RELAY_BOUNDS.maxGasTgas)) return null;
  if (!numIn(dailyBudgetNear, 0, NEAR_RELAY_BOUNDS.dailyBudgetNear)) return null;
  if (!intIn(perSenderPerDay, 1, NEAR_RELAY_BOUNDS.perSenderPerDay) || !intIn(perAppPerDay, 1, NEAR_RELAY_BOUNDS.perAppPerDay)) return null;
  if (!numIn(lowBalanceNear, 0, NEAR_RELAY_BOUNDS.lowBalanceNear)) return null;
  const activation = m.activationYocto ?? NEAR_RELAY_DEFAULTS.activationYocto;
  if (typeof activation !== 'string' || !/^(0|[1-9]\d{0,22})$/u.test(activation) || BigInt(activation) > NEAR_RELAY_BOUNDS.activationYocto) return null;
  return {
    account: m.account,
    receivers: receivers as string[],
    maxGas: BigInt(maxGasTgas) * TGAS,
    dailyBudgetYocto: nearToYocto(dailyBudgetNear),
    perSenderPerDay,
    perAppPerDay,
    lowBalanceYocto: nearToYocto(lowBalanceNear),
    activationYocto: BigInt(activation),
  };
}

/** The NEAR_RELAY var for a manifest's `near.relay` (gen-wrangler): the fields as given, defaults left to the parser. */
export function nearRelayVar(relay: NearRelayManifest): string {
  const out: Record<string, unknown> = { account: relay.account, receivers: [...relay.receivers] };
  for (const k of ['maxGasTgas', 'dailyBudgetNear', 'perSenderPerDay', 'perAppPerDay', 'lowBalanceNear', 'activationYocto'] as const) if (relay[k] !== undefined) out[k] = relay[k];
  return JSON.stringify(out);
}
