// The vault endpoints' flood limits per IP and per share, on Cloudflare's Rate Limiting bindings (`ratelimits`, D95):
// counted in the Cloudflare location that runs the request, from a locally cached count, so a check makes no network
// hop. Counts are per location and approximate (eventually consistent), so these are flood limits only: the per-app
// vault quota, and every limit that needs an exact global count, stay on the RateLimiter Durable Object. Kept free of
// Workers imports: scripts/gen-wrangler.ts writes these bindings into every env's wrangler config.

/** Requests per minute per IP per app, all vault endpoints together. */
export const VAULT_PER_IP_MINUTE = 60;
/** Requests per minute per share (unlock, touch, revoke, revoke-all with a well-formed body). */
export const SHARE_PER_MINUTE = 10;
/**
 * POST /v1/vault/share-status (D690): its own windows, apart from the share actions' and the per-IP vault window, so
 * a minute's status reads never use up an unlock's or a touch's budget. Per share: every tab of the app in one browser
 * profile holds the same share and reads about once a minute, plus a read before an approval. Per IP: a ceiling only,
 * high enough for a NAT with many users of one app.
 */
export const STATUS_PER_SHARE_MINUTE = 30;
export const STATUS_PER_IP_MINUTE = 600;
/** The bindings' period, in seconds (Cloudflare allows 10 or 60); also the `retry-after` of their refusals. */
export const VAULT_LIMIT_PERIOD_S = 60;

export type VaultLimitBinding = 'VAULT_IP_LIMIT' | 'VAULT_SHARE_LIMIT' | 'VAULT_STATUS_IP_LIMIT' | 'VAULT_STATUS_SHARE_LIMIT';

/**
 * The `ratelimits` entries. A `namespace_id` is account-wide: Workers whose bindings share one share its counters
 * per key, so these ids are reserved for this API, and every key starts with the env name (two envs on one account
 * never share a count). Changing an id or a key format resets the counters; nothing else depends on them.
 */
export const VAULT_RATE_LIMITS: readonly { name: VaultLimitBinding; namespace_id: string; simple: { limit: number; period: 10 | 60 } }[] = [
  { name: 'VAULT_IP_LIMIT', namespace_id: '95001', simple: { limit: VAULT_PER_IP_MINUTE, period: VAULT_LIMIT_PERIOD_S } },
  { name: 'VAULT_SHARE_LIMIT', namespace_id: '95002', simple: { limit: SHARE_PER_MINUTE, period: VAULT_LIMIT_PERIOD_S } },
  // 95003 and 95004 are the identity token's (identity/limits.ts).
  { name: 'VAULT_STATUS_IP_LIMIT', namespace_id: '95005', simple: { limit: STATUS_PER_IP_MINUTE, period: VAULT_LIMIT_PERIOD_S } },
  { name: 'VAULT_STATUS_SHARE_LIMIT', namespace_id: '95006', simple: { limit: STATUS_PER_SHARE_MINUTE, period: VAULT_LIMIT_PERIOD_S } },
];

/** Key of the per-IP window: env, app and IP subject (`ip.ts` `ipSubject`: the IPv4 address or the IPv6 /64). */
export const vaultIpKey = (envName: string, appId: string, ipSubject: string): string => `${envName}:vault-ip:${appId}:${ipSubject}`;

/** Key of the per-share window: env, app and the share id in hex (a share is only ever looked up within its app). */
export const vaultShareKey = (envName: string, appId: string, shareIdHex: string): string => `${envName}:vault-share:${appId}:${shareIdHex}`;

/** Keys of the share-status windows (D690): as the vault's, with their own prefixes. */
export const statusIpKey = (envName: string, appId: string, ipSubject: string): string => `${envName}:vault-status-ip:${appId}:${ipSubject}`;
export const statusShareKey = (envName: string, appId: string, shareIdHex: string): string => `${envName}:vault-status-share:${appId}:${shareIdHex}`;
