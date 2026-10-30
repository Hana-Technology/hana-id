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
  /** Active kids per watched provider (null: the issuer isn't configured). */
  issuer: IssuerView | null;
  /** Active keys with material, or null when the contract has no `get_issuer_keys` (older code) or no issuer. */
  issuerKeys: IssuerKey[] | null;
  config: ConfigView;
  governance: GovernanceView;
  /** The owner account (null when `get_config` names none). */
  owner: OwnerAccount | null;
}

export interface ChainReader {
  /** The RPC's `chain_id` (`testnet`). */
  chainId(): Promise<string>;
  snapshot(provider: string): Promise<ChainSnapshot>;
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
