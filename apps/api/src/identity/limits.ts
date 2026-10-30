// The identity token's limits (docs/identity-token-spec.md "API endpoints", "Threat model": mint flood). Kept free of
// Workers imports: scripts/gen-wrangler.ts writes the binding into every env's wrangler config.
//
// - per session key: the `IDENTITY_SESSION_LIMIT` Rate Limiting binding (per location, approximate, D95), after the
//   proof's signature verified, so only the session key's holder can use up its own window;
// - per IP and per app: the vault gate's (vault/limits.ts and VAULT_APP_MINUTE_FACTOR), shared with the vault endpoints;
// - a global hourly ceiling (RateLimiter object `identity:global`): a breaker that refuses every mint until the hour
//   ends, logged as a critical error (a mint flood or a bug; on mainnet each mint is a paid KMS signature).

/** Mints per minute per session key (a tab refreshes about once an hour; reloads and `maxAgeMs` add a few). */
export const IDENTITY_PER_SESSION_MINUTE = 10;
export const IDENTITY_LIMIT_PERIOD_S = 60;
/** Mints per hour across the env before the breaker trips. */
export const IDENTITY_GLOBAL_PER_HOUR = 100_000;
export const IDENTITY_GLOBAL_LIMITER = 'identity:global';

export const IDENTITY_RATE_LIMITS: readonly { name: 'IDENTITY_SESSION_LIMIT'; namespace_id: string; simple: { limit: number; period: 10 | 60 } }[] = [
  // Account-wide id reserved for this API (vault/limits.ts uses 95001 and 95002); every key starts with the env name.
  { name: 'IDENTITY_SESSION_LIMIT', namespace_id: '95003', simple: { limit: IDENTITY_PER_SESSION_MINUTE, period: IDENTITY_LIMIT_PERIOD_S } },
];

/** Key of the per-session window: env, app and the session public key in hex (public on chain, never a secret). */
export const identitySessionKey = (envName: string, appId: string, sessionPkHex: string): string => `${envName}:identity-session:${appId}:${sessionPkHex}`;

/** The RateLimiter object holding a session's proof markers (single use, IDENTITY_PROOF_MARKER_MS). */
export const identityProofLimiter = (sessionPkHex: string): string => `identity-proof:${sessionPkHex}`;
