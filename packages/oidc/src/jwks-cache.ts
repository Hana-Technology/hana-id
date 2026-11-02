// One issuer's JWKS, cached in the isolate: per its Cache-Control max-age (by default clamped to 5 min..6 h, 1 h
// without one; the bounds and no-cache handling are options), refetched on an unknown kid at most once a minute
// (failed attempts count, so a forged kid can't make us hammer the issuer), no new attempt within 10 s of a failure,
// and, when `staleGraceMs` allows it, the expired set keeps serving the kids it holds while refetches fail. Each
// fetch has a timeout and a body cap. RS256 keys only (`usableJwks`, @hana-id/jwks).
import { type Jwk, usableJwks } from '@hana-id/jwks';

const DEFAULT_TTL_MS = 60 * 60_000;
export const MIN_TTL_MS = 5 * 60_000;
export const MAX_TTL_MS = 6 * 60 * 60_000;
/** Default fetch timeout (connection, headers and body). */
export const FETCH_TIMEOUT_MS = 8_000;
/** Default cap on a JWKS response body (Google's is about 2 KB). */
export const MAX_BODY_BYTES = 64 * 1024;
/** An unknown kid refetches the JWKS at most this often (Google pre-publishes keys, so this is rare). */
export const REFETCH_MIN_MS = 60_000;
/** After a failed fetch, no new attempt for this long (fail closed, or serve the stale set, in between). */
export const RETRY_AFTER_FAILURE_MS = 10_000;
/** Largest max-age reported to an observer (the API stores it in an INTEGER column; a silly header must not become a float). */
const MAX_AGE_CAP_S = 2 ** 31 - 1;

/** The issuer's JWKS could not be fetched or had no usable key. Callers answer 503: fail closed. */
export class JwksUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwksUnavailableError';
  }
}

/** The `max-age` directive of a Cache-Control header in seconds (capped at 2^31 − 1), or null without one. */
export function cacheMaxAgeS(cacheControl: string | null): number | null {
  const m = /(?:^|[\s,])max-age=(\d+)/iu.exec(cacheControl ?? '');
  return m?.[1] ? Math.min(MAX_AGE_CAP_S, Number(m[1])) : null;
}

/** The response body as JSON, read up to `maxBytes` (a declared or actual larger body throws). */
async function readJsonCapped(res: Response, maxBytes: number): Promise<unknown> {
  if (Number(res.headers.get('content-length')) > maxBytes) throw new Error('JWKS response too large');
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('JWKS response too large');
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface JwksCacheOptions {
  /** Default: the global `fetch`, looked up at each call. */
  fetch?: Fetcher;
  /** How long past its max-age the set still serves the kids it holds while refetches fail (default 0: fail closed). */
  staleGraceMs?: number;
  /** Each fetch is aborted after this long, body included (default FETCH_TIMEOUT_MS). */
  timeoutMs?: number;
  /** A larger response body fails the fetch (default MAX_BODY_BYTES). */
  maxBodyBytes?: number;
  /** The max-age is clamped to [minTtlMs, maxTtlMs] (defaults MIN_TTL_MS, MAX_TTL_MS); 1 h, clamped, without one. */
  minTtlMs?: number;
  maxTtlMs?: number;
  /** `no-cache` or `no-store` means a TTL of 0, before the clamp (default false: ignored, as for Google). */
  respectNoCache?: boolean;
}

/** Per-call hooks: told about each successful fetch, and about a lookup served from an expired set. Never about a token. */
export interface JwksHooks {
  onFetch?(kids: readonly string[], maxAgeS: number | null, now: number): void;
  onStale?(): void;
}

interface Entry {
  keys: Map<string, Jwk>;
  until: number;
}

export class JwksCache {
  private entry: Entry | undefined;
  /** Time of the last fetch attempt, successful or not (throttles refetches even while they fail). */
  private lastAttempt = -Infinity;
  /** Time of the last failed fetch. */
  private lastFailure: number | undefined;
  private readonly fetcher: Fetcher;
  private readonly staleGraceMs: number;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly minTtlMs: number;
  private readonly maxTtlMs: number;
  private readonly respectNoCache: boolean;

  constructor(
    readonly url: string,
    opts: JwksCacheOptions = {},
  ) {
    this.fetcher = opts.fetch ?? ((input, init) => fetch(input, init));
    this.staleGraceMs = opts.staleGraceMs ?? 0;
    this.timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.maxBodyBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;
    this.minTtlMs = opts.minTtlMs ?? MIN_TTL_MS;
    this.maxTtlMs = opts.maxTtlMs ?? MAX_TTL_MS;
    this.respectNoCache = opts.respectNoCache ?? false;
  }

  /** How long a fetched set is fresh. */
  private ttlMs(cacheControl: string | null): number {
    const m = /max-age=(\d+)/u.exec(cacheControl ?? '');
    let ms = m?.[1] ? Number(m[1]) * 1000 : DEFAULT_TTL_MS;
    if (this.respectNoCache && /(?:^|[\s,])no-(?:cache|store)(?:$|[\s,=])/iu.test(cacheControl ?? '')) ms = 0;
    return Math.min(this.maxTtlMs, Math.max(this.minTtlMs, ms));
  }

  private async fetchKeys(now: number, hooks?: JwksHooks): Promise<Entry> {
    this.lastAttempt = now;
    let keys: Jwk[];
    let res: Response;
    try {
      res = await this.fetcher(this.url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
      keys = usableJwks(await readJsonCapped(res, this.maxBodyBytes));
      if (keys.length === 0) throw new Error('JWKS has no usable key');
    } catch (err) {
      this.lastFailure = now;
      throw new JwksUnavailableError(err instanceof Error ? err.message : String(err));
    }
    this.lastFailure = undefined;
    const entry = { keys: new Map(keys.map((k) => [k.kid, k])), until: now + this.ttlMs(res.headers.get('cache-control')) };
    this.entry = entry;
    hooks?.onFetch?.([...entry.keys.keys()], cacheMaxAgeS(res.headers.get('cache-control')), now);
    return entry;
  }

  private usableStale(entry: Entry | undefined, now: number): entry is Entry {
    return !!entry && now < entry.until + this.staleGraceMs;
  }

  private mayFetch(now: number): boolean {
    return this.lastFailure === undefined || now - this.lastFailure >= RETRY_AFTER_FAILURE_MS;
  }

  /**
   * The key for `kid`, or null when the issuer doesn't publish it. Throws JwksUnavailableError only when the JWKS
   * can't be had (no fresh or, within the grace, stale set; or the unknown-kid refetch failed).
   */
  async key(kid: string, now: number, hooks?: JwksHooks): Promise<Jwk | null> {
    let entry = this.entry;
    if (!entry || entry.until <= now) {
      const mayFetch = this.mayFetch(now);
      try {
        if (!mayFetch) throw new JwksUnavailableError('JWKS fetch failed recently');
        entry = await this.fetchKeys(now, hooks);
      } catch (err) {
        // Stale-while-error: keep serving the kids we already hold for a bounded grace period.
        if (!this.usableStale(entry, now)) throw err;
        if (mayFetch) hooks?.onStale?.();
      }
    }
    if (!entry) throw new JwksUnavailableError('JWKS unavailable');
    const hit = entry.keys.get(kid);
    if (hit) return hit;
    // Unknown kid: refetch at most once a minute, counting failed attempts.
    if (now - this.lastAttempt < REFETCH_MIN_MS) return null;
    return (await this.fetchKeys(now, hooks)).keys.get(kid) ?? null;
  }

  /**
   * Every published key as this isolate holds them (fetched when the cache is cold or expired, with the same failure
   * backoff and stale grace as `key`), or null when they can't be had.
   */
  async published(now: number): Promise<Jwk[] | null> {
    let entry = this.entry;
    if (!entry || entry.until <= now) {
      if (this.mayFetch(now)) {
        try {
          entry = await this.fetchKeys(now);
        } catch {
          // Served stale below, within the grace period.
        }
      }
    }
    return this.usableStale(entry, now) ? [...entry.keys.values()] : null;
  }

  clear(): void {
    this.entry = undefined;
    this.lastAttempt = -Infinity;
    this.lastFailure = undefined;
  }
}
