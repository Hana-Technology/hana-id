// Off-chain ID-token verification (RS256 with WebCrypto against the issuer's published JWKS, cached per its
// Cache-Control max-age, refetched on an unknown kid at most once a minute; while refetches fail, the expired set
// keeps serving the kids it holds for a bounded grace period). Used wherever the API must not relay a
// forged token: logins (/v1/sessions) and owner actions. The contract verifies again against the keys it holds on
// chain (synced hourly from the same JWKS by the cron). An optional observer records each fetch's kids and the kid of
// each verified token, for the key lead-time measurement (key-observations.ts).
import { base64UrlDecode } from './bytes.ts';
import { GOOGLE_JWKS_URL, type Jwk, usableJwks } from './issuer-keys.ts';
import { providerForIssuer } from './jwt.ts';
import { type KeyObserver, cacheMaxAgeS } from './key-observations.ts';
import { log } from './log.ts';

/** provider → JWKS URL. */
export const JWKS_URLS: Readonly<Record<string, string>> = { google: GOOGLE_JWKS_URL };

const DEFAULT_TTL_MS = 60 * 60_000;
const MIN_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 6 * 60 * 60_000;
/** An unknown kid refetches the JWKS at most this often (Google pre-publishes keys, so this is rare). */
const REFETCH_MIN_MS = 60_000;
/** After a failed fetch, no new attempt for this long (fail closed, or serve the stale set, in between). */
const RETRY_AFTER_FAILURE_MS = 10_000;
/**
 * How long past its max-age an entry still serves the kids it holds while refetches fail (Google publishes keys well
 * before using them and keeps them for days after; the contract checks the same token against its on-chain keys).
 */
const STALE_GRACE_MS = MAX_TTL_MS;

interface CachedJwks {
  keys: Map<string, Jwk>;
  until: number;
}

const cache = new Map<string, CachedJwks>();
/** provider → time of the last fetch attempt, successful or not (throttles refetches even while they fail). */
const lastAttempt = new Map<string, number>();
/** provider → time of the last failed fetch. */
const lastFailure = new Map<string, number>();

/** The issuer's JWKS could not be fetched or had no usable key. */
export class JwksUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwksUnavailableError';
  }
}

function maxAgeMs(res: Response): number {
  const m = /max-age=(\d+)/u.exec(res.headers.get('cache-control') ?? '');
  const ms = m?.[1] ? Number(m[1]) * 1000 : DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ms));
}

async function fetchJwks(provider: string, now: number, observer?: KeyObserver): Promise<CachedJwks> {
  const url = JWKS_URLS[provider];
  if (!url) throw new JwksUnavailableError(`No JWKS for provider ${provider}`);
  lastAttempt.set(provider, now);
  let keys: Jwk[];
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
    keys = usableJwks(await res.json());
    if (keys.length === 0) throw new Error('JWKS has no usable key');
  } catch (err) {
    lastFailure.set(provider, now);
    throw new JwksUnavailableError(err instanceof Error ? err.message : String(err));
  }
  lastFailure.delete(provider);
  const entry = { keys: new Map(keys.map((k) => [k.kid, k])), until: now + maxAgeMs(res) };
  cache.set(provider, entry);
  observer?.jwks(provider, [...entry.keys.keys()], cacheMaxAgeS(res.headers.get('cache-control')), now);
  return entry;
}

const usableStale = (entry: CachedJwks | undefined, now: number): entry is CachedJwks => !!entry && now < entry.until + STALE_GRACE_MS;

async function jwkFor(provider: string, kid: string, now: number, observer?: KeyObserver): Promise<Jwk | null> {
  let entry = cache.get(provider);
  if (!entry || entry.until <= now) {
    const failedAt = lastFailure.get(provider);
    const mayFetch = failedAt === undefined || now - failedAt >= RETRY_AFTER_FAILURE_MS;
    try {
      if (!mayFetch) throw new JwksUnavailableError('JWKS fetch failed recently');
      entry = await fetchJwks(provider, now, observer);
    } catch (err) {
      // Stale-while-error: keep serving the kids we already hold for a bounded grace period.
      if (!usableStale(entry, now)) throw err;
      if (mayFetch) log({ event: 'jwks_stale', code: 'issuer_keys_unavailable' }, 'warn');
    }
  }
  if (!entry) throw new JwksUnavailableError('JWKS unavailable');
  const hit = entry.keys.get(kid);
  if (hit) return hit;
  // Unknown kid: refetch at most once a minute, counting failed attempts (a forged kid can't make us hammer Google).
  if (now - (lastAttempt.get(provider) ?? -Infinity) < REFETCH_MIN_MS) return null;
  return (await fetchJwks(provider, now, observer)).keys.get(kid) ?? null;
}

export interface VerifiedToken {
  provider: string;
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  nonce: string | null;
}

export type VerifyResult = { ok: true; token: VerifiedToken } | { ok: false; code: 'invalid_token' | 'unsupported_issuer' | 'token_expired'; error: string };

const fail = (code: 'invalid_token' | 'unsupported_issuer' | 'token_expired', error: string): VerifyResult => ({ ok: false, code, error });

const decodeJson = (part: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export interface VerifyOptions {
  /** Clock skew tolerated on `exp`: a token is accepted until `exp + skewMs` (default 0). */
  skewMs?: number;
  /** Told about each JWKS fetch and each valid signature's kid (key lead-time measurement); never about the token. */
  observer?: KeyObserver;
}

/**
 * Verifies an ID token the way the contract does (docs/contract-interface.md, "Token verification"): RS256 only,
 * known issuer, known kid, valid signature, not expired, single-string aud. Throws JwksUnavailableError only when
 * the JWKS cannot be fetched (callers answer 503: fail closed). `aud` and `nonce` are the caller's to check.
 */
export async function verifyIdToken(jwt: string, now: number = Date.now(), opts: VerifyOptions = {}): Promise<VerifyResult> {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return fail('invalid_token', 'Malformed token');
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  if (!header || !claims) return fail('invalid_token', 'Malformed token');
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return fail('invalid_token', 'Unsupported token algorithm');
  const { iss, aud, sub, exp, nonce } = claims;
  if (typeof iss !== 'string' || typeof aud !== 'string' || typeof sub !== 'string' || typeof exp !== 'number') return fail('invalid_token', 'Malformed token claims');
  const provider = providerForIssuer(iss);
  if (!provider || !JWKS_URLS[provider]) return fail('unsupported_issuer', 'Unsupported token issuer');
  if (exp * 1000 + (opts.skewMs ?? 0) <= now) return fail('token_expired', 'The token has expired');

  const jwk = await jwkFor(provider, header.kid, now, opts.observer);
  if (!jwk) return fail('invalid_token', 'Unknown token signing key');
  let valid = false;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    valid = false;
  }
  if (!valid) return fail('invalid_token', 'Invalid token signature');
  opts.observer?.token(provider, header.kid, now);
  return { ok: true, token: { provider, iss, aud, sub, exp, nonce: typeof nonce === 'string' ? nonce : null } };
}

/** Tests only. */
export function clearJwksCache(): void {
  cache.clear();
  lastAttempt.clear();
  lastFailure.clear();
}
