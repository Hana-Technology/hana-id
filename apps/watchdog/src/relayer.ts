// Relayer funds (read-only): the relayer account's spendable balance and the remaining allowance of each of its
// function-call keys on the signer, by pool (docs/operations.md "Relayer keys (either pool)"). The API relays every
// login (session pool, `RELAYER_KEYS`), owner action (owner pool, `OWNER_RELAYER_KEYS`) and Home derive (Home pool,
// `HOME_RELAYER_KEYS`) from these keys: a key whose
// allowance is used up, or an account whose balance can't pay the gas, makes those relays fail (`502 near_rejected`).
// The watchdog only alerts; it never tops anything up (it holds no key on the relayer account).
// No Worker types here: scripts/gen-wrangler.ts imports the defaults.

export const YOCTO_PER_NEAR = 10n ** 24n;
/** NEAR's storage price: 10^19 yoctoNEAR per byte (the part of `amount` that storage locks and gas can't use). */
export const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;

export type RelayerPool = 'session' | 'owner' | 'home';
export const RELAYER_POOLS: readonly RelayerPool[] = ['session', 'owner', 'home'];

/**
 * Which pool a function-call key for the signer belongs to, by its method list (the API's `POOL_METHODS`,
 * apps/api/src/relayer-config.ts). By marker methods rather than the exact list, so the session pool's planned
 * allowlist changes (batch B states 2 and 3 drop `create_session` or `create_session_and_derive`) keep it classified:
 * `derive_key` is in every session-pool state, `propose_change` in the owner pool, and a Home key has exactly
 * `create_session_and_derive`. A test checks every pool's list.
 */
export function poolOf(methods: readonly string[]): RelayerPool | null {
  const session = methods.includes('derive_key');
  const owner = methods.includes('propose_change');
  if (session && owner) return null; // a key that mixes both (not one the deploy script makes)
  if (session) return 'session';
  if (owner) return 'owner';
  return methods.length === 1 && methods[0] === 'create_session_and_derive' ? 'home' : null;
}

export interface Threshold {
  /** Warning below this (yoctoNEAR). */
  warn: bigint;
  /** Critical below this (yoctoNEAR); always below `warn`. */
  critical: bigint;
}

export interface RelayerThresholds {
  /** The relayer account's available balance (`amount` minus storage). */
  balance: Threshold;
  /** Each session-pool key's remaining allowance (default allowance 2 NEAR). */
  session: Threshold;
  /** Each owner-pool key's remaining allowance (default allowance 0.5 NEAR). */
  owner: Threshold;
  /** Each Home-pool key's remaining allowance (default allowance 2 NEAR). */
  home: Threshold;
}

/** The manifest's `watchdog.relayerFunds` shape (NEAR, not yocto): what `gen` writes into `RELAYER_FUNDS`. */
export interface RelayerFundsSetting {
  balance?: { warn: number; critical: number };
  sessionAllowance?: { warn: number; critical: number };
  ownerAllowance?: { warn: number; critical: number };
  homeAllowance?: { warn: number; critical: number };
}

/**
 * Defaults, in NEAR. Balance: 5 / 1 (at ~0.004 NEAR of gas per login on testnet, 1 NEAR is ~250 logins). Session key:
 * 0.5 / 0.1 of its 2 NEAR allowance (3 × 2 NEAR covered ~1,500 logins). Owner key: 0.1 / 0.02 of its 0.5 NEAR. Home key: 0.5 / 0.1
 * of its 2 NEAR (about 200 derives at 100 Tgas prepaid each, D98 item 11).
 */
export const DEFAULT_RELAYER_FUNDS = {
  balance: { warn: 5, critical: 1 },
  sessionAllowance: { warn: 0.5, critical: 0.1 },
  ownerAllowance: { warn: 0.1, critical: 0.02 },
  homeAllowance: { warn: 0.5, critical: 0.1 },
} as const satisfies Required<RelayerFundsSetting>;

/** Largest threshold accepted (NEAR): a guard against a typo in yocto. */
export const MAX_THRESHOLD_NEAR = 100_000;

/** NEAR (a finite number ≥ 0, at most 6 decimals kept) → yoctoNEAR. */
export function nearToYocto(near: number): bigint {
  if (!Number.isFinite(near) || near < 0 || near > MAX_THRESHOLD_NEAR) throw new Error(`Not a NEAR amount: ${near}`);
  return BigInt(Math.round(near * 1e6)) * 10n ** 18n;
}

/** yoctoNEAR → "1.2345 NEAR" (4 decimals, rounded down; "<0.0001 NEAR" for dust). */
export function formatNear(yocto: bigint): string {
  if (yocto > 0n && yocto < 10n ** 20n) return '<0.0001 NEAR';
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = ((yocto % YOCTO_PER_NEAR) / 10n ** 20n).toString().padStart(4, '0').replace(/0+$/u, '');
  return `${whole}${frac ? `.${frac}` : ''} NEAR`;
}

/** True for a pair the watchdog accepts: numbers within range and critical strictly below warn. */
export function validThresholdPair(p: unknown): p is { warn: number; critical: number } {
  if (!p || typeof p !== 'object') return false;
  const { warn, critical } = p as { warn?: unknown; critical?: unknown };
  const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_THRESHOLD_NEAR;
  return ok(warn) && ok(critical) && (critical as number) < (warn as number);
}

const pair = (p: { warn: number; critical: number }): Threshold => ({ warn: nearToYocto(p.warn), critical: nearToYocto(p.critical) });

/**
 * The thresholds from `RELAYER_FUNDS` (JSON of the manifest's `watchdog.relayerFunds`), each pair defaulted when
 * absent; an unreadable value or an invalid pair falls back to its default and is reported in `problems` (the run
 * shows it in the `config` check). Never throws.
 */
export function relayerThresholds(json: string | undefined): { thresholds: RelayerThresholds; problems: string[] } {
  const problems: string[] = [];
  let setting: RelayerFundsSetting = {};
  if (json !== undefined && json.trim() !== '') {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) setting = parsed as RelayerFundsSetting;
      else problems.push('RELAYER_FUNDS is not a JSON object: using the default thresholds');
    } catch {
      problems.push('RELAYER_FUNDS is not JSON: using the default thresholds');
    }
  }
  const pick = (key: keyof RelayerFundsSetting): Threshold => {
    const v = setting[key];
    if (v === undefined) return pair(DEFAULT_RELAYER_FUNDS[key]);
    if (validThresholdPair(v)) return pair(v);
    problems.push(`RELAYER_FUNDS.${key} is invalid (warn and critical in NEAR, critical < warn): using the default`);
    return pair(DEFAULT_RELAYER_FUNDS[key]);
  };
  return { thresholds: { balance: pick('balance'), session: pick('sessionAllowance'), owner: pick('ownerAllowance'), home: pick('homeAllowance') }, problems };
}

/** `view_access_key_list` entry, as the RPC returns it. */
export interface AccessKeyEntry {
  public_key: string;
  access_key: { nonce?: number | string; permission: 'FullAccess' | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } } };
}

export interface RelayerKey {
  public_key: string;
  pool: RelayerPool;
  /** Remaining allowance in yoctoNEAR (decimal string), or null: unlimited (the key spends the account's balance). */
  allowance: string | null;
}

/** One reading of the relayer account (what `GET /status` serves as `relayer_funds`). */
export interface RelayerFunds {
  account: string;
  exists: boolean;
  /** yoctoNEAR, decimal strings. */
  amount: string;
  locked: string;
  storage_usage: number;
  /** `amount` minus `storage_usage` × the storage price: what can pay gas. */
  available: string;
  /** Pool keys (function-call keys for the signer with a pool's methods). */
  keys: RelayerKey[];
  /** Function-call keys for the signer that belong to no pool, and keys with an unreadable allowance: listed, not judged. */
  other_keys: string[];
}

const DIGITS = /^\d{1,40}$/u;

/** Builds a reading from `view_account` (null: the account doesn't exist) and `view_access_key_list`. */
export function relayerFundsFrom(
  account: string,
  signer: string,
  view: { amount?: unknown; locked?: unknown; storage_usage?: unknown } | null,
  keys: readonly AccessKeyEntry[],
): RelayerFunds {
  const amount = view && typeof view.amount === 'string' && DIGITS.test(view.amount) ? BigInt(view.amount) : 0n;
  const locked = view && typeof view.locked === 'string' && DIGITS.test(view.locked) ? view.locked : '0';
  const storage = view && typeof view.storage_usage === 'number' && Number.isInteger(view.storage_usage) && view.storage_usage >= 0 ? view.storage_usage : 0;
  const locks = BigInt(storage) * STORAGE_YOCTO_PER_BYTE;
  const available = amount > locks ? amount - locks : 0n;
  const pool: RelayerKey[] = [];
  const other: string[] = [];
  for (const k of keys) {
    const p = k.access_key?.permission;
    if (typeof k.public_key !== 'string' || !p || p === 'FullAccess' || typeof p !== 'object' || !p.FunctionCall) continue;
    const fc = p.FunctionCall;
    if (fc.receiver_id !== signer) continue;
    const which = Array.isArray(fc.method_names) ? poolOf(fc.method_names) : null;
    const allowance = fc.allowance === null || fc.allowance === undefined ? null : typeof fc.allowance === 'string' && DIGITS.test(fc.allowance) ? fc.allowance : undefined;
    if (!which || allowance === undefined) other.push(k.public_key);
    else pool.push({ public_key: k.public_key, pool: which, allowance });
  }
  return { account, exists: view !== null, amount: amount.toString(), locked, storage_usage: storage, available: available.toString(), keys: pool, other_keys: other };
}

export type Level = 'ok' | 'warn' | 'critical';

/** Where a value sits against its threshold. */
export function level(value: bigint, t: Threshold): Level {
  return value < t.critical ? 'critical' : value < t.warn ? 'warn' : 'ok';
}
