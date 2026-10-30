// hana-signer interface as the scripts use it (method names and JSON shapes per docs/batch-a-spec.md).
import type { NearRpc } from './near.ts';

/**
 * Methods the relayer's session-pool keys (the API's RELAYER_KEYS) may call on the signer (docs/batch-a2-shared-client.md).
 * Logins only: abuse of the owner endpoint can never use up these keys. Batch B allowlist state 1 (docs/batch-b-spec.md,
 * "Relayer allowlists"): the contract upgrade adds create_session_and_derive; a later state drops create_session or
 * create_session_and_derive, after the ship gate.
 */
export const SESSION_RELAYER_METHODS = ['create_session', 'create_session_and_derive', 'derive_key', 'revoke_session', 'prune_sessions'] as const;

/** Methods the relayer's owner-pool keys (the API's OWNER_RELAYER_KEYS, /v1/owner-actions) may call on the signer. */
export const OWNER_RELAYER_METHODS = [
  'propose_change',
  'cancel_change',
  'remove_client',
  'disable_shared_login',
  'execute_change',
  'register_scope',
  'apply_pending_config',
] as const;

/**
 * Methods of the keys-updater function-call key (the API's KEYS_UPDATER_KEY, on the signer account itself) on the
 * governance contract: the contract installs it with exactly these (`add_updater_key`, its `UPDATER_METHODS`), receiver
 * the signer, allowance 1 NEAR. contracts/integration-tests checks this list against the contract's.
 */
export const UPDATER_METHODS = ['set_issuer_key', 'propose_issuer_key_removal', 'execute_issuer_key_change'] as const;

/** The v1 (pre-governance) keys-updater key's methods, added by hand by deploy-contract; replaced at the migration. */
export const V1_UPDATER_METHODS = ['set_issuer_key', 'remove_issuer_key'] as const;

/** The allowance the contract gives every updater key (`MAX_UPDATER_ALLOWANCE`). */
export const UPDATER_ALLOWANCE_YOCTO = 10n ** 24n;

/**
 * Owner-only methods of the governance contract (`Only the owner can do this`), the only ones owner-tx proposes or
 * signs (docs/governance-spec.md "How owner actions work through it"). `accept_owner` is the proposed owner's.
 * A superset of the contract's owner-only calls (`owner_only_calls()` in contracts/hana-signer/src/tests.rs): a test
 * keeps it so, since the recovery playbooks (`@hana-id/playbooks`) send them all through `admin owner:call`.
 */
export const OWNER_METHODS = [
  'set_sponsors',
  'set_console_audiences',
  'set_shared_clients',
  'set_change_delay_ms',
  'set_issuer_key_delay_ms',
  'set_governance_delay_ms',
  'enable_public_registration',
  'set_issuer',
  'mark_self_issued',
  'accept_unrecorded_wallets',
  'admin_register_scope',
  'set_issuer_key',
  'propose_issuer_key_removal',
  'remove_issuer_key',
  'cancel_issuer_key_change',
  'add_watchdog',
  'remove_watchdog',
  'add_updater_key',
  'delete_updater_key',
  'pause',
  'unpause',
  'set_sessions_valid_from_ms',
  'propose_upgrade',
  'cancel_upgrade',
  'propose_owner',
  'cancel_owner_proposal',
  'accept_owner',
  'propose_withdrawal',
  'cancel_withdrawal',
] as const;
export type OwnerMethod = (typeof OWNER_METHODS)[number];

export interface WatchdogView {
  account_id: string;
  confirm_from_ms: number;
}

/** get_governance() (docs/contract-interface.md "Governance"). Absent on a v1 contract. */
export interface GovernanceView {
  state_version: number;
  watchdogs: WatchdogView[];
  keys_slow_until_ms: number;
  /** Updater keys whose AddKey succeeded. */
  updater_keys: string[];
  /** Updater keys whose AddKey hasn't resolved yet (absent on contracts before it was added). */
  pending_updater_keys?: string[];
  updater_methods?: string[];
  pending_upgrade: { code_hash: string; proposed_at_ms: number; executable_at_ms: number } | null;
  pending_owner: { owner: string; acceptable_at_ms: number } | null;
  pending_withdrawal: { receiver: string; amount: string; executable_at_ms: number } | null;
}

/** One entry of get_key_changes(). */
export interface KeyChangeView {
  id: number;
  provider: string;
  kid: string;
  op: 'Add' | 'Remove';
  n: string | null;
  e: string | null;
  by: string;
  proposed_at_ms: number;
  executable_at_ms: number;
}

export const GOOGLE_PROVIDER = 'google';
export const GOOGLE_ISS_VALUES = ['https://accounts.google.com', 'accounts.google.com'] as const;
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GLOBAL_SCOPE = 'global';

/** Owner JSON form (serde externally tagged). */
export type Owner = { Near: { account_id: string } } | { Oidc: { provider: string; sub: string } };

export interface ContractConfig {
  owner?: string;
  mpc?: string;
  ckd_domain_id?: number;
  console_audiences?: [string, string][];
  sponsors?: string[];
  change_delay_ms?: number;
  public_registration?: boolean;
  /** Effective shared login clients, [provider, aud] (batch A.2). Absent on a contract that predates them. */
  shared_clients?: [string, string][];
  /** pending_shared_clients: [{provider, aud, effective_at_ms}] not yet in force (read through sharedClientsOf). */
  [key: string]: unknown;
}

export interface PendingSharedClient {
  client: [string, string];
  unlockAtMs: number | null;
}

export interface SharedClientsView {
  effective: [string, string][];
  pending: PendingSharedClient[];
}

const isPair = (v: unknown): v is [string, string] => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string';

function pendingEntries(raw: unknown, unlock: number | null = null): PendingSharedClient[] {
  if (raw === null || raw === undefined) return [];
  if (isPair(raw)) return [{ client: raw, unlockAtMs: unlock }];
  if (Array.isArray(raw)) return raw.flatMap((e) => pendingEntries(e, unlock));
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const at = typeof o.effective_at_ms === 'number' ? o.effective_at_ms : typeof o.unlock_at_ms === 'number' ? o.unlock_at_ms : unlock;
    if (isPair(o.client)) return [{ client: o.client, unlockAtMs: at }];
    if (typeof o.provider === 'string' && typeof o.aud === 'string') return [{ client: [o.provider, o.aud], unlockAtMs: at }];
    if (Array.isArray(o.clients)) return pendingEntries(o.clients, at);
  }
  throw new Error(`Unexpected pending shared clients in get_config: ${JSON.stringify(raw)}`);
}

/**
 * Shared clients from get_config: the effective list and pending additions. hana-signer returns
 * `pending_shared_clients: [{provider, aud, effective_at_ms}]`; pairs, {client, unlock_at_ms} objects and
 * {clients, unlock_at_ms} are tolerated too. Returns null when the contract has no `shared_clients` (deployed before
 * batch A.2).
 */
export function sharedClientsOf(config: ContractConfig): SharedClientsView | null {
  if (!Array.isArray(config.shared_clients)) return null;
  const effective = config.shared_clients.filter(isPair);
  const pendingKey = Object.keys(config).find((k) => /pending.*shared|shared.*pending/u.test(k));
  return { effective, pending: pendingKey ? pendingEntries(config[pendingKey]) : [] };
}

export interface IssuerView {
  iss_values: string[];
  kids: string[];
}

/** Normalises `get_issuer` output: tolerates `{iss_values, kids}`, `{keys: {kid: …}}` or a plain kid array. */
export function normaliseIssuer(raw: unknown): IssuerView | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return { iss_values: [], kids: raw.filter((k): k is string => typeof k === 'string') };
  if (typeof raw !== 'object') throw new Error(`Unexpected get_issuer result: ${JSON.stringify(raw)}`);
  const o = raw as { iss_values?: unknown; kids?: unknown; keys?: unknown };
  const iss = Array.isArray(o.iss_values) ? o.iss_values.filter((v): v is string => typeof v === 'string') : [];
  let kids: string[] = [];
  if (Array.isArray(o.kids)) kids = o.kids.filter((k): k is string => typeof k === 'string');
  else if (Array.isArray(o.keys)) kids = o.keys.filter((k): k is string => typeof k === 'string');
  else if (o.keys && typeof o.keys === 'object') kids = Object.keys(o.keys);
  return { iss_values: iss, kids };
}

/** View helpers that return null when the contract isn't deployed/initialised or the item doesn't exist. */
export async function tryView<T>(rpc: Pick<NearRpc, 'view'>, account: string, method: string, args: unknown = {}): Promise<T | null> {
  try {
    return await rpc.view<T>(account, method, args);
  } catch (err) {
    const msg = (err as Error).message;
    if (/CodeDoesNotExist|MethodNotFound|MethodResolveError|not initialized|NotInitialized|does not exist|Smart contract panicked/u.test(msg)) return null;
    throw err;
  }
}

export const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
export const samePairs = (a: readonly (readonly [string, string])[], b: readonly (readonly [string, string])[]) =>
  sameSet(
    a.map((p) => JSON.stringify(p)),
    b.map((p) => JSON.stringify(p)),
  );
