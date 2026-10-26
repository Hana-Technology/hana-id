import type { RateLimiter } from './rate-limiter.ts';
import type { RelayerKey } from './relayer-key.ts';

/** Worker bindings. Vars come from the manifest (scripts/gen-wrangler.ts); secrets via `wrangler secret put`. */
export interface Env {
  /** NEAR JSON-RPC endpoint. */
  NEAR_RPC: string;
  /** hana-signer contract account: the only receiver the relayer ever calls. */
  SIGNER_ACCOUNT: string;
  /** Account whose function-call keys (RELAYER_KEYS) pay gas. */
  RELAYER_ACCOUNT: string;
  ENV_NAME: string;
  /** Secret: JSON array of `ed25519:...` secret keys, one per access key on RELAYER_ACCOUNT. */
  RELAYER_KEYS: string;
  /** Secret: function-call key on SIGNER_ACCOUNT limited to set_issuer_key / remove_issuer_key. */
  KEYS_UPDATER_KEY?: string;
  DB: D1Database;
  RELAYER_KEY: DurableObjectNamespace<RelayerKey>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
}
