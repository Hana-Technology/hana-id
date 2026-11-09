// Relayer key pools and their method allowlists. Kept free of Workers imports so scripts (Node) can check what they
// generate.

/**
 * Three pools of function-call keys on RELAYER_ACCOUNT (receiver SIGNER_ACCOUNT), each with its own Durable Objects:
 * - `session` (RELAYER_KEYS): logins and the email-login link methods (/v1/link*, email login build plan batch 6).
 *   Batch B moves the session methods through three states (docs/batch-b-spec.md, "Relayer allowlists"); this is state
 *   1, from the contract upgrade that adds create_session_and_derive. State 2 (ship gate passes, smoke on /v1/login)
 *   drops create_session; state 3 (gate fails) drops create_session_and_derive. Each change is a deploy step that
 *   re-adds every session-pool key; batch 6's link methods were one (they exist from contract v3: before it, a key may
 *   name them and nothing can call them).
 * - `owner` (OWNER_RELAYER_KEYS, small allowance): /v1/owner-actions. Abuse of that endpoint can only drain this pool,
 *   never stop logins.
 * - `home` (HOME_RELAYER_KEYS, small allowance, one key by default): POST /v1/home/login only, so a Home flood can only
 *   drain this pool, never stop logins or owner actions. Its one method means a leaked key opens nothing else.
 * The allowlists match the access keys' `method_names` (scripts/deploy-contract.ts); the Durable Object refuses
 * anything else even if a key would allow it. Each list holds only what an endpoint relays (D456), so a leaked key can
 * spend its allowance on nothing else.
 */
export const POOL_METHODS = {
  session: ['create_session', 'create_session_and_derive', 'derive_key', 'revoke_session', 'link_identity', 'cancel_link', 'unlink_identity'],
  owner: ['propose_change', 'cancel_change', 'remove_client', 'disable_shared_login', 'execute_change'],
  home: ['create_session_and_derive'],
} as const;

/**
 * Open methods of hana-signer no endpoint relays (D456): anyone may call them from an account of their own, so a pool
 * key needs none of them. `prune_sessions` and `apply_pending_config` are maintenance; `register_scope` needs public
 * registration, which is off (Hana registers scopes with `admin_register_scope`). Listed so the allowlist tests prove it.
 */
export const NOT_RELAYED_METHODS = ['prune_sessions', 'apply_pending_config', 'register_scope'] as const;

/**
 * The keys-updater key (KEYS_UPDATER_KEY, a function-call key on SIGNER_ACCOUNT itself, installed by the contract's
 * `add_updater_key`): exactly the contract's `UPDATER_METHODS` (docs/contract-interface.md "Updater keys"). The cron
 * (issuer-keys.ts) refuses to sign anything else, even if a key would allow it. `remove_issuer_key` is owner-only
 * since the governance batch and is never here.
 */
export const UPDATER_METHODS = ['set_issuer_key', 'propose_issuer_key_removal', 'execute_issuer_key_change'] as const;
export type UpdaterMethod = (typeof UPDATER_METHODS)[number];

export function updaterAllows(method: string): method is UpdaterMethod {
  return (UPDATER_METHODS as readonly string[]).includes(method);
}

/**
 * Owner, watchdog and governance methods of hana-signer (docs/contract-interface.md "Governance"): no pool and not
 * the updater ever relays them. Listed so the allowlist tests prove it.
 */
export const GOVERNANCE_METHODS = [
  'remove_issuer_key',
  'confirm_issuer_key_change',
  'cancel_issuer_key_change',
  'set_issuer_key_delay_ms',
  'set_governance_delay_ms',
  'add_watchdog',
  'remove_watchdog',
  'pause',
  'unpause',
  'add_updater_key',
  'delete_updater_key',
  'on_updater_key_added',
  'propose_upgrade',
  'cancel_upgrade',
  'execute_upgrade',
  'migrate',
  'propose_owner',
  'cancel_owner_proposal',
  'accept_owner',
  'propose_withdrawal',
  'cancel_withdrawal',
  'execute_withdrawal',
  'set_issuer',
  'set_console_audiences',
  'set_shared_clients',
  'set_exit_clients',
  'set_sponsors',
  'set_change_delay_ms',
  'enable_public_registration',
  'admin_register_scope',
  'set_sessions_valid_from_ms',
  'mark_self_issued',
  'accept_unrecorded_wallets',
  'set_link_thresholds',
] as const;

export type Pool = keyof typeof POOL_METHODS;
export type RelayMethod = (typeof POOL_METHODS)[Pool][number];
export const POOLS: readonly Pool[] = ['session', 'owner', 'home'];

/**
 * Each owner-pool key's allowance when deploy-contract adds it (its `--owner-relayer-allowance` default, 0.5 NEAR;
 * scripts/test/deploy-plan.test.ts keeps the two equal): the base of the hourly `owner_allowance_low` check
 * (owner-pool.ts), unless the Worker var OWNER_POOL_ALLOWANCE_YOCTO says the keys were added with another one.
 */
export const OWNER_POOL_ALLOWANCE_YOCTO = 5n * 10n ** 23n;

/** Secret holding each pool's keys. */
export const POOL_SECRET: Readonly<Record<Pool, 'RELAYER_KEYS' | 'OWNER_RELAYER_KEYS' | 'HOME_RELAYER_KEYS'>> = { session: 'RELAYER_KEYS', owner: 'OWNER_RELAYER_KEYS', home: 'HOME_RELAYER_KEYS' };

/** Durable Object name of a pool's key (session keys keep their batch A names). */
export const relayerKeyName = (pool: Pool, index: number): string => (pool === 'session' ? `relayer-key-${index}` : `${pool}-relayer-key-${index}`);

/** The code of a copy of a request its relayer key object already relayed (RelayerKey `claims`, D455). */
export const ALREADY_RELAYED = 'already_relayed';

export const isPool = (v: unknown): v is Pool => v === 'session' || v === 'owner' || v === 'home';

export function poolAllows(pool: Pool, method: string): method is RelayMethod {
  return (POOL_METHODS[pool] as readonly string[]).includes(method);
}

const KEY_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/u;

/** Parses a pool secret: a JSON array of `ed25519:<base58>` secret keys. Empty/absent → []. */
export function parseRelayerKeys(raw: string | undefined, name = 'RELAYER_KEYS'): string[] {
  if (!raw) return [];
  let keys: unknown;
  try {
    keys = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON array of ed25519 secret keys`);
  }
  if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string' && KEY_RE.test(k))) throw new Error(`${name} must be a JSON array of ed25519 secret keys`);
  return keys as string[];
}
