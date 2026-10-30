// The identity token's limits (docs/identity-token-spec.md "API endpoints", "Threat model": mint flood; D176). Kept
// free of Workers imports: scripts/gen-wrangler.ts writes the bindings into every env's wrangler config.
//
// Asked in this order, so that a request a narrower limit refuses never uses up a wider, shared one, and no tenant can
// exhaust what other tenants share:
// - per IP: the vault gate's binding (`VAULT_IP_LIMIT`), before anything is parsed;
// - per session key: the `IDENTITY_SESSION_LIMIT` binding, once the proof's signature verified (only the key's holder
//   can use up its own window);
// - per account root: the `IDENTITY_ROOT_LIMIT` binding, keyed by the HMAC `sub` bytes (one user's devices and tabs);
// - per app: its own windows on the app's RateLimiter object (`identity:minute`, `identity:hour`), never the vault
//   endpoints' `vault:minute`, so mints can't starve unlocks (sized by the plan, the hour capped);
// - per scope: `identity:hour` on the object `identity:scope:<scopeId>` (an app's web and mobile apps share it);
// - global: `identity:global`, a hard breaker far above any one app's ceiling, plus a soft alert well below it.
// The per-app, per-scope and global windows are sliding (RateLimiter.hitSliding) and counted only for a request that
// passed every other check; one refused by a later window is taken back from the earlier ones.

/** Mints per minute per session key (a tab refreshes about once an hour; reloads and `maxAgeMs` add a few). */
export const IDENTITY_PER_SESSION_MINUTE = 10;
/** Mints per minute per account root (every device and tab of one user in one scope). */
export const IDENTITY_PER_ROOT_MINUTE = 30;
export const IDENTITY_LIMIT_PERIOD_S = 60;

/** Per app per minute: this × the plan's `per_minute` (the vault endpoints' own factor, in a window of its own). */
export const IDENTITY_APP_MINUTE_FACTOR = 10;
/** Per app per hour: this × the plan's `per_day`, at most IDENTITY_APP_HOUR_MAX. */
export const IDENTITY_APP_HOUR_FACTOR = 1;
export const IDENTITY_APP_HOUR_MAX = 100_000;
/** Per scope per hour: this × the requesting app's hourly ceiling. */
export const IDENTITY_SCOPE_HOUR_FACTOR = 2;
/** Global per hour: the breaker. At least 10 × the largest per-app ceiling, so no single tenant can trip it. */
export const IDENTITY_GLOBAL_PER_HOUR = 1_000_000;
/** Global per hour: a critical alert (logged, no refusal), for the operator to look before the breaker. */
export const IDENTITY_GLOBAL_ALERT_PER_HOUR = 100_000;
export const IDENTITY_GLOBAL_LIMITER = 'identity:global';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

export type IdentityLimitBinding = 'IDENTITY_SESSION_LIMIT' | 'IDENTITY_ROOT_LIMIT';

export const IDENTITY_RATE_LIMITS: readonly { name: IdentityLimitBinding; namespace_id: string; simple: { limit: number; period: 10 | 60 } }[] = [
  // Account-wide ids reserved for this API (vault/limits.ts uses 95001 and 95002); every key starts with the env name.
  { name: 'IDENTITY_SESSION_LIMIT', namespace_id: '95003', simple: { limit: IDENTITY_PER_SESSION_MINUTE, period: IDENTITY_LIMIT_PERIOD_S } },
  { name: 'IDENTITY_ROOT_LIMIT', namespace_id: '95004', simple: { limit: IDENTITY_PER_ROOT_MINUTE, period: IDENTITY_LIMIT_PERIOD_S } },
];

/** The per-app hourly ceiling for a plan. */
export const identityAppHourMax = (plan: { per_day: number }): number => Math.max(1, Math.min(IDENTITY_APP_HOUR_MAX, IDENTITY_APP_HOUR_FACTOR * plan.per_day));

/** Key of the per-session window: env, app and the session public key in hex (public on chain, never a secret). */
export const identitySessionKey = (envName: string, appId: string, sessionPkHex: string): string => `${envName}:identity-session:${appId}:${sessionPkHex}`;

/** Key of the per-root window: env, scope and the root's HMAC `sub` bytes in hex (never the Google `sub`). */
export const identityRootKey = (envName: string, scopeId: string, subBytesHex: string): string => `${envName}:identity-root:${scopeId}:${subBytesHex}`;

/** The RateLimiter object holding a session's proof markers (single use, IDENTITY_PROOF_MARKER_MS; swept by an alarm). */
export const identityProofLimiter = (sessionPkHex: string): string => `identity-proof:${sessionPkHex}`;

export const identityScopeLimiter = (scopeId: string): string => `identity:scope:${scopeId}`;
