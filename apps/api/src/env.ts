import type { LoginRelay } from './login-relay.ts';
import type { RateLimiter } from './rate-limiter.ts';
import type { RelayerKey } from './relayer-key.ts';

/** Worker bindings. Vars come from the manifest (scripts/gen-wrangler.ts); secrets via `wrangler secret put`. */
export interface Env {
  /** NEAR JSON-RPC endpoint: the first the API asks (near/rpc.ts rpcEndpoints). */
  NEAR_RPC: string;
  /**
   * Manifest `rpcFallback`, when set: the vault reads from it when NEAR_RPC fails, so the vault page's CSP
   * `connect-src` lists it too. The API's own fallbacks are NEAR_RPC_FALLBACKS.
   */
  NEAR_RPC_FALLBACK?: string;
  /**
   * The API's own NEAR RPC fallbacks, in order after NEAR_RPC (D435): a JSON array of URLs, from the manifest's
   * `apiRpcFallbacks`, or `[rpcFallback]` when that is unset; written only when non-empty. A call moves to the next
   * one only when an endpoint gives no JSON-RPC answer (near/rpc.ts Rpc).
   */
  NEAR_RPC_FALLBACKS?: string;
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
  /** Optional Durable Object location hint for the shared objects (manifest cloudflare.durableObjectLocation). */
  DO_LOCATION_HINT?: string;
  /** Secret: session pool. JSON array of `ed25519:...` secret keys (create_session, create_session_and_derive, derive_key, revoke_session, prune_sessions). */
  RELAYER_KEYS: string;
  /**
   * Optional secret (D436): a CoinGecko API key (Pro, else Demo) for the sandbox mainnet demo's live prices. Sent only in
   * CoinGecko's own header, and only for an app with the demo on, in a dev testnet env. Without it the public API, then
   * the fixed table, are used.
   */
  COINGECKO_API_KEY?: string;
  /** Secret: owner pool. JSON array of `ed25519:...` secret keys, small allowance, used by /v1/owner-actions only. */
  OWNER_RELAYER_KEYS?: string;
  /**
   * Optional var: the allowance (decimal yoctoNEAR) the owner-pool keys were added with, when deploy-contract ran with
   * another `--owner-relayer-allowance` than its 0.5 NEAR default: the base of the hourly `owner_allowance_low` check.
   */
  OWNER_POOL_ALLOWANCE_YOCTO?: string;
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
  /**
   * Var: the signer kind (manifest `identityToken.signer.kind`, identity/signers.ts): `worker-secret` (the secrets
   * above) or `aws-kms` (D215). Absent (a config generated before build step 7) means `worker-secret`.
   */
  IDENTITY_SIGNER?: string;
  /** Var, `aws-kms` only: the active key's ARN (`identityToken.signer.keys.active.arn`); its region picks the endpoint. */
  IDENTITY_KMS_KEY_ARN?: string;
  /**
   * Secrets, `aws-kms` only (scripts/identity-key.ts kms-put-aws-key): the access key of the dedicated IAM user whose
   * only permission is kms:Sign on the active key (D215, D219). Never logged.
   */
  IDENTITY_AWS_ACCESS_KEY_ID?: string;
  IDENTITY_AWS_SECRET_ACCESS_KEY?: string;
  /** Secret: the `sub`/`sid` HMAC key, base64 of 32 bytes. Never rotated (a new key changes every user's `sub`). */
  IDENTITY_SUB_KEY?: string;
  /**
   * Email sharing with partners (D411, D438, D439; identity/email.ts; scripts/identity-key.ts `email-keys`). Secrets:
   * IDENTITY_SEAL_KEY (`<id>:<base64 of 32 bytes>`, shared with the email issuer, which seals the verified address for
   * the API), IDENTITY_SEAL_KEY_PREVIOUS during a rotation only (still opened), and EMAIL_CONSENT_KEY (base64 of 32
   * bytes, API only: the consent rows' address MAC). Without them the consent endpoints answer 503
   * email_sharing_unavailable and tokens carry no email. Never logged.
   */
  IDENTITY_SEAL_KEY?: string;
  IDENTITY_SEAL_KEY_PREVIOUS?: string;
  EMAIL_CONSENT_KEY?: string;
  /** Optional var: the global hourly mint ceiling (identity/limits.ts IDENTITY_GLOBAL_PER_HOUR by default). */
  IDENTITY_GLOBAL_HOURLY_MAX?: string;
  /**
   * Batch C (manifest `appChangeDelayMs`, `network`, the Hana origins; scripts/gen-wrangler.ts): the guarded-change
   * delay in ms, the NEAR network, and every Hana origin as a JSON array, which no app may list as its own. A missing or
   * out-of-range delay makes every guarded change refuse with `internal` (guarded/config.ts).
   */
  APP_CHANGE_DELAY_MS?: string;
  NETWORK?: string;
  REFUSED_ORIGINS?: string;
  /** The logo origin (manifest `files.origin`), from batch C11; unset without the dashboard blocks. */
  FILES_ORIGIN?: string;
  /**
   * Batch C4 (docs/batch-c-spec.md "Usage capture"): the usage ledger's writer, a Hyperdrive config (role
   * `usage_writer`, which may only call `usage.record_event`, `usage.record_identity_tokens`, `usage.record_email_counts` and `usage.ensure_partitions`) bound by
   * `gen --usage-hyperdrive-id`. Optional: without it capture is off and every endpoint answers as before.
   */
  USAGE_DB?: Hyperdrive;
  /**
   * Secret (`usage-setup <env> user-id-key`): the uid key, base64 of 32 bytes (docs/batch-c-spec.md "uid"). Without
   * it events carry no uid (MAU and new users go uncounted). Never logged, never rotated within a contract term.
   */
  USER_ID_KEY?: string;
  /**
   * Email login (manifest `emailIssuer`, scripts/gen-wrangler.ts): the email tokens' `iss` and the issuer's public keys
   * (a JSON array of public RSA JWKs, the JWKS the issuer serves, D196). Without them every email token is refused
   * (`unsupported_issuer`); Google logins are unaffected.
   */
  EMAIL_ISS?: string;
  EMAIL_PUBLIC_KEYS?: string;
  /**
   * The email issuer's URL (manifest `emailIssuer.url`, else `apiUrl`; D230): the vault page's CSP `connect-src` adds
   * its origin, since the vault calls the issuer's google-match (build plan batch 8b). Absent without an issuer.
   */
  EMAIL_ISSUER_URL?: string;
  /**
   * The build id (D384, build.ts): set only by the `deploy` script (`wrangler deploy --var HANA_BUILD:<id>`), never by
   * `gen`; reported by GET /v1/health as `build`. Absent: deployed without the script.
   */
  HANA_BUILD?: string;
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
