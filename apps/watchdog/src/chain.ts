// What the watchdog reads from and sends to hana-signer (docs/contract-interface.md), behind two small interfaces so
// the run logic is tested against a stub chain. The real implementation is near.ts.
import type { RelayerFunds } from './relayer.ts';

export type { RelayerFunds } from './relayer.ts';

/** `get_key_changes()` entry. */
export interface KeyChange {
  id: number;
  provider: string;
  kid: string;
  op: 'Add' | 'Remove';
  /** JWK base64url, leading zeros stripped; null for a Remove. */
  n: string | null;
  e: string | null;
  /** The signer of a self-issued issuer's key addition (contract v3); absent for every other change. */
  signer?: string;
  by: string;
  proposed_at_ms: number;
  executable_at_ms: number;
}

/** `get_issuer(provider)`. */
export interface IssuerView {
  provider: string;
  iss_values: string[];
  kids: string[];
}

/** `get_issuer_keys(provider)` entry. */
export interface IssuerKey {
  kid: string;
  n: string;
  e: string;
}

export interface DelayChange {
  change_delay_ms: number;
  effective_at_ms: number;
}

export interface PendingClient {
  provider: string;
  aud: string;
  effective_at_ms: number;
}

/** `get_config()`: the fields the watchdog diffs (the rest is kept as returned). */
export interface ConfigView {
  owner: string;
  mpc: string;
  ckd_domain_id: number;
  console_audiences: [string, string][];
  pending_console_audiences: PendingClient[];
  sponsors: string[];
  shared_clients: [string, string][];
  pending_shared_clients: PendingClient[];
  change_delay_ms: number;
  pending_change_delay: DelayChange | null;
  public_registration: boolean;
  issuer_key_delay_ms: number;
  pending_issuer_key_delay: DelayChange | null;
  governance_delay_ms: number;
  pending_governance_delay: DelayChange | null;
  paused: boolean;
  /** When the owner last unpaused (0: never): a pause and unpause between two runs still shows here. */
  unpaused_at_ms: number;
  /** No scope change executes before this (each unpause re-arms the scope-change timelock). */
  changes_unlock_floor_ms: number;
  /** Sessions opened before this can't derive (the owner raises it after a forged key was active). */
  sessions_valid_from_ms: number;
  /**
   * Contract v3: links are refused until the owner accepts the wallets opened before v3 (D135). Absent on v2. Must
   * never be true outside a dev env (D139).
   */
  unrecorded_wallets?: boolean;
  /** Contract v4: Hana Home's exit clients in force (D468). Absent before v4. */
  exit_clients?: [string, string][];
  /** Contract v4: exit clients still waiting `governance_delay_ms` (D482). */
  pending_exit_clients?: PendingClient[];
  /** Contract v4: exit sessions opened this hour and the hour before (D487; alert only). */
  exit_window?: ExitWindow;
}

/** `get_config().exit_window` (contract v4, D487): exit sessions per fixed UTC hour. It never refuses. */
export interface ExitWindow {
  window_start_ms: number;
  current: number;
  previous: number;
}

/** `get_self_issued(provider)` (contract v3): the signer policy of a self-issued issuer. */
export interface SelfIssuedView {
  provider: string;
  /** Each signer with its active kids. */
  signers: { id: string; kids: string[] }[];
  /** Distinct signers a token needs. */
  required: number;
  /** While a policy change's overlap lasts: until when tokens valid under the previous policy still pass. */
  overlap_until_ms?: number | null;
}

/** Link alarm thresholds per window (D200): alarm levels only, the contract refuses nothing. */
export interface LinkThresholds {
  per_scope_per_hour: number;
  total_per_hour: number;
}

/** One fixed UTC-hour window of `get_link_stats()`. */
export interface LinkWindow {
  window_start_ms: number;
  /** New links (immediate or pending) in the window, all scopes. */
  total: number;
  total_threshold_reached: boolean;
  /** Scopes whose links reached the per-scope threshold in the window (recorded by the call that reached it). */
  flagged_scopes: string[];
  /** More scopes reached the threshold than the view lists. */
  flagged_scopes_truncated?: boolean;
}

/** `get_link_stats()` (contract with D200's link counter and alarm thresholds). */
export interface LinkStatsView {
  window_ms: number;
  thresholds: LinkThresholds;
  /** A raise waiting `governance_delay_ms` (lowering is immediate). */
  pending_thresholds: (LinkThresholds & { effective_at_ms: number }) | null;
  links_total: number;
  current: LinkWindow;
  previous: LinkWindow | null;
}

/** The email issuer as the chain shows it. A v2 contract reads as no email issuer (no `get_self_issued`). */
export interface EmailSnapshot {
  /** `get_issuer("email")` (null: no email issuer). */
  issuer: IssuerView | null;
  /** `get_issuer_keys("email")` (null: no issuer, or a contract without the view). */
  issuerKeys: IssuerKey[] | null;
  /** `get_self_issued("email")` (null: not self-issued, or a pre-v3 contract without the view). */
  selfIssued: SelfIssuedView | null;
  /** False on a pre-v3 contract (no `get_self_issued`). */
  hasSelfIssuedView: boolean;
}

export interface WatchdogEntry {
  account_id: string;
  confirm_from_ms: number;
}

/** `get_governance()`. */
export interface GovernanceView {
  state_version: number;
  watchdogs: WatchdogEntry[];
  keys_slow_until_ms: number;
  /** Updater keys whose AddKey succeeded: the only ones a watchdog may delete. */
  updater_keys: string[];
  /** Updater keys whose AddKey hasn't resolved yet (absent on older contracts). Not alerted on: transient. */
  pending_updater_keys?: string[];
  updater_methods: string[];
  pending_upgrade: { code_hash: string; proposed_at_ms: number; executable_at_ms: number } | null;
  pending_owner: { owner: string; acceptable_at_ms: number } | null;
  pending_withdrawal: { receiver: string; amount: string; executable_at_ms: number } | null;
}

/**
 * The contract owner's account (`get_config().owner`): its code and, for a Sputnik DAO council, its `get_policy`. A
 * council's roles, members and vote policies decide who can act as the owner (D81: 2 of 3 for every proposal kind),
 * and a `ChangePolicy`, `AddMember` or `RemoveMember` changes them without touching hana-signer, so the watchdog
 * diffs them too.
 */
export interface OwnerAccount {
  account_id: string;
  /** `view_account` code hash (`11111111111111111111111111111111`: no contract, a plain account). */
  code_hash: string;
  /** The DAO's `get_policy`, or null when the owner has no contract or the contract has no `get_policy`. */
  policy: unknown;
}

/** Everything one run reads from the chain. */
export interface ChainSnapshot {
  keyChanges: KeyChange[];
  /** Google's issuer: active kids (null: the issuer isn't configured). */
  issuer: IssuerView | null;
  /** Google's active keys with material, or null when the contract has no `get_issuer_keys` (older code) or no issuer. */
  issuerKeys: IssuerKey[] | null;
  /** The email issuer (self-issued, D121). */
  email: EmailSnapshot;
  /** `get_link_stats()` (D200), or null on a contract without the view (v2, or v3 before the link counter). */
  linkStats: LinkStatsView | null;
  /**
   * Why `linkStats` is null although the contract may have the view: `malformed` (an answer of another shape) or
   * `read_failed` (the view errored). Null when it was read, or the contract has no view. Never fails the snapshot.
   */
  linkStatsProblem: 'malformed' | 'read_failed' | null;
  config: ConfigView;
  governance: GovernanceView;
  /** The owner account (null when `get_config` names none). */
  owner: OwnerAccount | null;
}

export interface ChainReader {
  /** The RPC's `chain_id` (`testnet`). */
  chainId(): Promise<string>;
  /** Every view one run judges: the key queue, Google's and the email issuer's keys, config, governance, the owner. */
  snapshot(): Promise<ChainSnapshot>;
  /**
   * The relayer account's balance and its pool keys' allowances (`view_account`, `view_access_key_list`; read-only).
   * An account that doesn't exist reads as `exists: false` with no balance and no keys; other failures throw.
   */
  relayerFunds(account: string): Promise<RelayerFunds>;
}

/** The only methods the watchdog key may call (its access-key permission lists exactly these). */
export const WATCHDOG_METHODS = ['cancel_issuer_key_change', 'confirm_issuer_key_change', 'pause', 'delete_updater_key'] as const;
export type WatchdogMethod = (typeof WATCHDOG_METHODS)[number];

export type TxResult = { ok: true; txHash: string } | { ok: false; txHash: string | null; error: string };

export interface ChainWriter {
  /** Sends one function call from the watchdog account to the signer and waits for its outcome. Never throws. */
  call(method: WatchdogMethod, args: Record<string, unknown>): Promise<TxResult>;
}
