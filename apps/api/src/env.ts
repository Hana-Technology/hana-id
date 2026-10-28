import type { RateLimiter } from './rate-limiter.ts';
import type { RelayerKey } from './relayer-key.ts';

/** Worker bindings. Vars come from the manifest (scripts/gen-wrangler.ts); secrets via `wrangler secret put`. */
export interface Env {
  /** NEAR JSON-RPC endpoint. */
  NEAR_RPC: string;
  /** hana-signer contract account: the only receiver the relayer ever calls. */
  SIGNER_ACCOUNT: string;
  /** Account whose function-call keys (RELAYER_KEYS, OWNER_RELAYER_KEYS) pay gas. */
  RELAYER_ACCOUNT: string;
  ENV_NAME: string;
  /** Optional Durable Object location hint for the shared objects (manifest cloudflare.durableObjectLocation). */
  DO_LOCATION_HINT?: string;
  /** Secret: session pool. JSON array of `ed25519:...` secret keys (create_session, derive_key, revoke_session, prune_sessions). */
  RELAYER_KEYS: string;
  /** Secret: owner pool. JSON array of `ed25519:...` secret keys, small allowance, used by /v1/owner-actions only. */
  OWNER_RELAYER_KEYS?: string;
  /** Secret: function-call key on SIGNER_ACCOUNT limited to set_issuer_key / remove_issuer_key. */
  KEYS_UPDATER_KEY?: string;
  /** Hana page origins (manifest vaultOrigin/authOrigin) and the API's own URL (manifest apiUrl, for the vault CSP). */
  VAULT_ORIGIN?: string;
  AUTH_ORIGIN?: string;
  API_URL?: string;
  /** Secret: vault share wrapping key, `<id>:<base64 of 32 bytes>` (vault/kek.ts). Without it the vault endpoints answer 503. */
  VAULT_KEK?: string;
  /** Secret, during a KEK rotation only: the previous VAULT_KEK, read to unwrap and re-wrap older shares. */
  VAULT_KEK_PREVIOUS?: string;
  /** Optional per-method gas overrides in Tgas (see gas.ts), e.g. GAS_DERIVE_KEY_TGAS. */
  [gasOverride: `GAS_${string}_TGAS`]: string | undefined;
  DB: D1Database;
  RELAYER_KEY: DurableObjectNamespace<RelayerKey>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
}
