// Off-chain ID-token verification (RS256 against the issuer's published JWKS), used where the API must not relay
// a forged token: owner actions, whose proof is only in the args. The contract verifies again against the keys it
// holds on chain (synced hourly from the same JWKS by the cron).
import { base64UrlDecode } from './bytes.ts';
import { GOOGLE_JWKS_URL, type Jwk, usableJwks } from './issuer-keys.ts';
import { providerForIssuer } from './jwt.ts';

/** provider → JWKS URL. */
export const JWKS_URLS: Readonly<Record<string, string>> = { google: GOOGLE_JWKS_URL };

const DEFAULT_TTL_MS = 60 * 60_000;
const MIN_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 6 * 60 * 60_000;
/** An unknown kid refetches the JWKS at most this often (Google pre-publishes keys, so this is rare). */
const REFETCH_MIN_MS = 60_000;

interface CachedJwks {
  keys: Map<string, Jwk>;
  until: number;
  fetchedAt: number;
}

const cache = new Map<string, CachedJwks>();

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

async function fetchJwks(provider: string, now: number): Promise<CachedJwks> {
  const url = JWKS_URLS[provider];
  if (!url) throw new JwksUnavailableError(`No JWKS for provider ${provider}`);
  let keys: Jwk[];
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
    keys = usableJwks(await res.json());
  } catch (err) {
    throw new JwksUnavailableError(err instanceof Error ? err.message : String(err));
  }
  if (keys.length === 0) throw new JwksUnavailableError('JWKS has no usable key');
  const entry = { keys: new Map(keys.map((k) => [k.kid, k])), until: now + maxAgeMs(res), fetchedAt: now };
  cache.set(provider, entry);
  return entry;
}

async function jwkFor(provider: string, kid: string, now: number): Promise<Jwk | null> {
  let entry = cache.get(provider);
  if (!entry || entry.until <= now) entry = await fetchJwks(provider, now);
  const hit = entry.keys.get(kid);
  if (hit) return hit;
  if (now - entry.fetchedAt < REFETCH_MIN_MS) return null;
  return (await fetchJwks(provider, now)).keys.get(kid) ?? null;
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

/**
 * Verifies an ID token the way the contract does (docs/contract-interface.md, "Token verification"): RS256 only,
 * known issuer, known kid, valid signature, not expired, single-string aud. Throws JwksUnavailableError only when
 * the JWKS cannot be fetched (callers answer 503: fail closed).
 */
export async function verifyIdToken(jwt: string, now: number = Date.now()): Promise<VerifyResult> {
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
  if (exp * 1000 <= now) return fail('token_expired', 'The token has expired');

  const jwk = await jwkFor(provider, header.kid, now);
  if (!jwk) return fail('invalid_token', 'Unknown token signing key');
  let valid = false;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    valid = false;
  }
  if (!valid) return fail('invalid_token', 'Invalid token signature');
  return { ok: true, token: { provider, iss, aud, sub, exp, nonce: typeof nonce === 'string' ? nonce : null } };
}

/** Tests only. */
export function clearJwksCache(): void {
  cache.clear();
}
