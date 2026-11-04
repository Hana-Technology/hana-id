// The console's per-IP flood limits on Cloudflare's rate-limiting binding (`ratelimits`, D93 Q20): `/api/auth/*` and
// the auth origin's routes (batch C9), and the emailed-link confirms (`POST /api/cancel`, `POST /api/owner-grants/
// cancel`), 10 per minute per IP (IPv6 by /64). Counted per Cloudflare location, from a cached count, so these are
// flood limits only; the API keeps its own exact per-IP and global limits on link cancels (D228, D229). Kept free of
// Workers imports: scripts/gen-wrangler.ts writes the binding into every env's config.

export const CONSOLE_PER_IP_MINUTE = 10;
/** The binding's period, in seconds (Cloudflare allows 10 or 60); also the `retry-after` of its refusals. */
export const CONSOLE_LIMIT_PERIOD_S = 60;

/**
 * The `ratelimits` entry. A `namespace_id` is account-wide, so this one is reserved for the console (the API's are
 * 95001–95004), and every key starts with the env name, so two envs on one account never share a count.
 */
export const CONSOLE_RATE_LIMITS: readonly { name: 'CONSOLE_IP_LIMIT'; namespace_id: string; simple: { limit: number; period: 10 | 60 } }[] = [
  { name: 'CONSOLE_IP_LIMIT', namespace_id: '95101', simple: { limit: CONSOLE_PER_IP_MINUTE, period: CONSOLE_LIMIT_PERIOD_S } },
];

/**
 * The routes that share a count: sign-in (C9) and the emailed links per IP, and logo uploads (batch C11) per org, since
 * each one is a paid Images transform (logo.ts).
 */
export type LimitedRoute = 'auth' | 'link' | 'logo';

/** Key of a route's window: env, route and subject (an IP's `ip.ts` `ipSubject`, or the org id for `logo`). */
export const consoleIpKey = (envName: string, route: LimitedRoute, ipSubject: string): string => `${envName}:console-${route}:${ipSubject}`;
