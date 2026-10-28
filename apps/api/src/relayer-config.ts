// Relayer key pools and their method allowlists. Kept free of Workers imports so scripts (Node) can check what they
// generate.

/**
 * Two pools of function-call keys on RELAYER_ACCOUNT (receiver SIGNER_ACCOUNT), each with its own Durable Objects:
 * - `session` (RELAYER_KEYS): logins. Only the session methods. Batch B moves this list through three states
 *   (docs/batch-b-spec.md, "Relayer allowlists"); this is state 1, from the contract upgrade that adds
 *   create_session_and_derive. State 2 (ship gate passes, smoke on /v1/login) drops create_session; state 3 (gate
 *   fails) drops create_session_and_derive. Each change is a deploy step that re-adds every session-pool key.
 * - `owner` (OWNER_RELAYER_KEYS, small allowance): /v1/owner-actions. Abuse of that endpoint can only drain this pool,
 *   never stop logins.
 * The allowlists match the access keys' `method_names` (scripts/deploy-contract.ts); the Durable Object refuses
 * anything else even if a key would allow it.
 */
export const POOL_METHODS = {
  session: ['create_session', 'create_session_and_derive', 'derive_key', 'revoke_session', 'prune_sessions'],
  owner: ['propose_change', 'cancel_change', 'remove_client', 'disable_shared_login', 'execute_change', 'register_scope', 'apply_pending_config'],
} as const;

export type Pool = keyof typeof POOL_METHODS;
export type RelayMethod = (typeof POOL_METHODS)[Pool][number];
export const POOLS: readonly Pool[] = ['session', 'owner'];

/** Secret holding each pool's keys. */
export const POOL_SECRET: Readonly<Record<Pool, 'RELAYER_KEYS' | 'OWNER_RELAYER_KEYS'>> = { session: 'RELAYER_KEYS', owner: 'OWNER_RELAYER_KEYS' };

/** Durable Object name of a pool's key (session keys keep their batch A names). */
export const relayerKeyName = (pool: Pool, index: number): string => (pool === 'session' ? `relayer-key-${index}` : `owner-relayer-key-${index}`);

export const isPool = (v: unknown): v is Pool => v === 'session' || v === 'owner';

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
