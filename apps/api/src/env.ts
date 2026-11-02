import type { LoginRelay } from './login-relay.ts';
import type { RateLimiter } from './rate-limiter.ts';
import type { RelayerKey } from './relayer-key.ts';

/** Worker bindings. Vars come from the manifest (scripts/gen-wrangler.ts); secrets via `wrangler secret put`. */
export interface Env {
  /** NEAR JSON-RPC endpoint. */
  NEAR_RPC: string;
  /**
   * Manifest `rpcFallback`, when set: the vault reads from it when NEAR_RPC fails, so the vault page's CSP
   * `connect-src` lists it too. The API itself reads only NEAR_RPC.
   */
  NEAR_RPC_FALLBACK?: string;
  /** hana-signer contract account: the only receiver the relayer ever calls. */
  SIGNER_ACCOUNT: string;
  /** Account whose function-call keys (RELAYER_KEYS, OWNER_RELAYER_KEYS) pay gas. */
  RELAYER_ACCOUNT: string;
  ENV_NAME: string;
  /** MPC contract (manifest `mpc`): a failed receipt on it means the CKD failed after the session was committed. */
  MPC_ACCOUNT: string;
  /** Origin of the vault page (manifest `vaultOrigin`); unset in envs without Hana pages. */
  VAULT_ORIGIN?: string;
  /** Origin of the login, callback, approval and export pages (manifest `authOrigin`). */
  AUTH_ORIGIN?: string;
  /** "1": BLS pairing precheck of the app key on /v1/login and /v1/derive (Workers Paid plan only). Default off. */
  BLS_PRECHECK?: string;
  /** "1": /v1/sessions also refuses tokens with claims outside the allow-list. Default off until smoke moves. */
  REJECT_PII_ON_SESSIONS?: string;
  /** Optional Durable Object location hint for the shared objects (manifest cloudflare.durableObjectLocation). */
  DO_LOCATION_HINT?: string;
  /** Secret: session pool. JSON array of `ed25519:...` secret keys (create_session, create_session_and_derive, derive_key, revoke_session, prune_sessions). */
  RELAYER_KEYS: string;
  /** Secret: owner pool. JSON array of `ed25519:...` secret keys, small allowance, used by /v1/owner-actions only. */
  OWNER_RELAYER_KEYS?: string;
  /**
   * Secret: the keys-updater key, a function-call key on SIGNER_ACCOUNT that the contract installed with exactly
   * UPDATER_METHODS (set_issuer_key, propose_issuer_key_removal, execute_issuer_key_change; relayer-config.ts).
   */
  KEYS_UPDATER_KEY?: string;
  /** The API's own URL (manifest apiUrl), for the vault page's CSP connect-src. */
  API_URL?: string;
  /** Secret: vault share wrapping key, `<id>:<base64 of 32 bytes>` (vault/kek.ts). Without it the vault endpoints answer 503. */
  VAULT_KEK?: string;
  /** Secret, during a KEK rotation only: the previous VAULT_KEK, read to unwrap and re-wrap older shares. */
  VAULT_KEK_PREVIOUS?: string;
  /**
   * The partner identity token (docs/identity-token-spec.md; manifest `identityToken`, scripts/gen-wrangler.ts): the
   * `iss`, the JWKS (a JSON array of public P-256 JWKs) and the kid of the key that signs. Without them every
   * /v1/identity/* endpoint answers 503 identity_unavailable.
   */
  IDENTITY_ISS?: string;
  IDENTITY_PUBLIC_KEYS?: string;
  IDENTITY_ACTIVE_KID?: string;
  /**
   * Secrets (scripts/identity-key.ts), testnet and local* only: P-256 private JWKs. Whichever has the thumbprint
   * IDENTITY_ACTIVE_KID signs; the other is the standby, already in every partner's JWKS cache.
   */
  IDENTITY_SIGNING_KEY?: string;
  IDENTITY_SIGNING_KEY_STANDBY?: string;
  /** Secret: the `sub`/`sid` HMAC key, base64 of 32 bytes. Never rotated (a new key changes every user's `sub`). */
  IDENTITY_SUB_KEY?: string;
  /** Optional var: the global hourly mint ceiling (identity/limits.ts IDENTITY_GLOBAL_PER_HOUR by default). */
  IDENTITY_GLOBAL_HOURLY_MAX?: string;
  /** Optional per-method gas overrides in Tgas (see gas.ts), e.g. GAS_DERIVE_KEY_TGAS. */
  [gasOverride: `GAS_${string}_TGAS`]: string | undefined;
  DB: D1Database;
  RELAYER_KEY: DurableObjectNamespace<RelayerKey>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  LOGIN_RELAY: DurableObjectNamespace<LoginRelay>;
  /** Rate Limiting bindings (vault/limits.ts, D95): the vault's per-IP and per-share flood limits, counted per location. */
  VAULT_IP_LIMIT: RateLimit;
  VAULT_SHARE_LIMIT: RateLimit;
  /** POST /v1/identity/token's per-session-key flood limit (identity/limits.ts). */
  IDENTITY_SESSION_LIMIT: RateLimit;
  /** POST /v1/identity/token's per-account-root flood limit (identity/limits.ts, D176). */
  IDENTITY_ROOT_LIMIT: RateLimit;
}
