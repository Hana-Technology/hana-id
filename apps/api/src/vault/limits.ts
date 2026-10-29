// The vault endpoints' flood limits per IP and per share, on Cloudflare's Rate Limiting bindings (`ratelimits`, D95):
// counted in the Cloudflare location that runs the request, from a locally cached count, so a check makes no network
// hop. Counts are per location and approximate (eventually consistent), so these are flood limits only: the per-app
// vault quota, and every limit that needs an exact global count, stay on the RateLimiter Durable Object. Kept free of
// Workers imports: scripts/gen-wrangler.ts writes these bindings into every env's wrangler config.

/** Requests per minute per IP per app, all vault endpoints together. */
export const VAULT_PER_IP_MINUTE = 60;
/** Requests per minute per share (unlock, touch, revoke, revoke-all with a well-formed body). */
export const SHARE_PER_MINUTE = 10;
/** The bindings' period, in seconds (Cloudflare allows 10 or 60); also the `retry-after` of their refusals. */
export const VAULT_LIMIT_PERIOD_S = 60;

export type VaultLimitBinding = 'VAULT_IP_LIMIT' | 'VAULT_SHARE_LIMIT';

/**
 * The `ratelimits` entries. A `namespace_id` is account-wide: Workers whose bindings share one share its counters
 * per key, so these ids are reserved for this API, and every key starts with the env name (two envs on one account
 * never share a count). Changing an id or a key format resets the counters; nothing else depends on them.
 */
export const VAULT_RATE_LIMITS: readonly { name: VaultLimitBinding; namespace_id: string; simple: { limit: number; period: 10 | 60 } }[] = [
  { name: 'VAULT_IP_LIMIT', namespace_id: '95001', simple: { limit: VAULT_PER_IP_MINUTE, period: VAULT_LIMIT_PERIOD_S } },
  { name: 'VAULT_SHARE_LIMIT', namespace_id: '95002', simple: { limit: SHARE_PER_MINUTE, period: VAULT_LIMIT_PERIOD_S } },
];

/** Key of the per-IP window: env, app and IP subject (`ip.ts` `ipSubject`: the IPv4 address or the IPv6 /64). */
export const vaultIpKey = (envName: string, appId: string, ipSubject: string): string => `${envName}:vault-ip:${appId}:${ipSubject}`;

/** Key of the per-share window: env, app and the share id in hex (a share is only ever looked up within its app). */
export const vaultShareKey = (envName: string, appId: string, shareIdHex: string): string => `${envName}:vault-share:${appId}:${shareIdHex}`;
