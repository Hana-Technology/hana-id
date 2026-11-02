// Off-chain ID-token verification (RS256 with Web Crypto against the issuer's published JWKS, cached per its
// Cache-Control max-age, refetched on an unknown kid at most once a minute; while refetches fail, the expired set
// keeps serving the kids it holds for a bounded grace period). The API uses it wherever it must not relay a forged
// token: logins (/v1/sessions, /v1/login) and owner actions; the contract verifies again against the keys it holds on
// chain (proposed from the same JWKS by the API's cron every 15 min, active only after the governance delay or a
// watchdog's confirmation, so a login also checks the token's kid is active on chain: apps/api handlers.ts
// chainGate). The console verifies its own sign-in tokens with it (batch C). An optional observer records each
// fetch's kids and the kid of each verified token, for the key lead-time measurement (apps/api key-observations.ts).
import { GOOGLE_JWKS_URL, GOOGLE_PROVIDER, type Jwk } from '@hana-id/jwks';
import { JwksCache, MAX_TTL_MS } from './jwks-cache.ts';
import { decodeSegment, verifyRs256 } from './jws.ts';

/** `iss` claim → issuer provider name in hana-signer (`set_issuer(provider, iss_values)`). */
export const ISSUER_PROVIDERS: Readonly<Record<string, string>> = {
  'https://accounts.google.com': GOOGLE_PROVIDER,
  'accounts.google.com': GOOGLE_PROVIDER,
};

export function providerForIssuer(iss: string): string | null {
  return Object.hasOwn(ISSUER_PROVIDERS, iss) ? (ISSUER_PROVIDERS[iss] ?? null) : null;
}

/** provider → JWKS URL. */
export const JWKS_URLS: Readonly<Record<string, string>> = { [GOOGLE_PROVIDER]: GOOGLE_JWKS_URL };

/**
 * How long past its max-age a provider's set still serves the kids it holds while refetches fail (Google publishes
 * keys well before using them and keeps them for days after; the contract checks the same token against its on-chain
 * keys).
 */
const STALE_GRACE_MS = MAX_TTL_MS;

/** provider → its JWKS in this isolate. */
const caches = new Map<string, JwksCache>();

function cacheFor(provider: string): JwksCache | null {
  const url = Object.hasOwn(JWKS_URLS, provider) ? JWKS_URLS[provider] : undefined;
  if (!url) return null;
  let cache = caches.get(provider);
  if (!cache) caches.set(provider, (cache = new JwksCache(url, { staleGraceMs: STALE_GRACE_MS })));
  return cache;
}

/** What token verification reports (`VerifyOptions.observer`). Both calls return at once. */
export interface KeyObserver {
  /** A successful JWKS fetch listing `kids`. */
  jwks(provider: string, kids: readonly string[], maxAgeS: number | null, now: number): void;
  /** A token with a valid signature by `kid`. */
  token(provider: string, kid: string, now: number): void;
}

export interface VerifiedToken {
  provider: string;
  /** The JWS header's key id (the API checks it is active on chain before relaying, handlers.ts chainGate). */
  kid: string;
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  nonce: string | null;
  // The claims below are present only when the token carries them, each with its type checked (a token carrying one
  // with the wrong type is refused). The API ignores them; `email` and `hd` are personal data (D25, D96): never log
  // or store them.
  email?: string;
  email_verified?: boolean;
  iat?: number;
  hd?: string;
  azp?: string;
  amr?: string[];
  auth_time?: number;
}

export type VerifyFailure = 'invalid_token' | 'unsupported_issuer' | 'token_expired' | 'bad_token';
export type VerifyResult = { ok: true; token: VerifiedToken } | { ok: false; code: VerifyFailure; error: string };

const fail = (code: VerifyFailure, error: string): VerifyResult => ({ ok: false, code, error });

/** The partner identity token's JWS `typ` (@hana-id/core IDENTITY_TOKEN_TYP; docs/identity-token-spec.md "Refusals elsewhere"). */
export const IDENTITY_TOKEN_TYP = 'hana-identity+jwt';

export interface VerifyOptions {
  /** Clock skew tolerated on `exp`: a token is accepted until `exp + skewMs` (default 0). */
  skewMs?: number;
  /** Told about each JWKS fetch and each valid signature's kid (key lead-time measurement); never about the token. */
  observer?: KeyObserver;
  /** Called when an expired JWKS is served because its refetch just failed (the API logs `jwks_stale`). */
  onStaleKeys?: () => void;
  /** The env's identity token issuer (IDENTITY_ISS): a token with this `iss` is refused as `bad_token`. */
  identityIssuer?: string | undefined;
}

type Optional = Pick<VerifiedToken, 'email' | 'email_verified' | 'iat' | 'hd' | 'azp' | 'amr' | 'auth_time'>;

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

const OPTIONAL_CLAIMS: { [K in keyof Optional]-?: (v: unknown) => boolean } = {
  email: isString,
  email_verified: isBoolean,
  iat: isNumber,
  hd: isString,
  azp: isString,
  amr: isStringArray,
  auth_time: isNumber,
};

/** The optional claims the token carries, or null when one has the wrong type. Absent claims stay absent. */
function optionalClaims(claims: Record<string, unknown>): Optional | null {
  const out: Record<string, unknown> = {};
  for (const [name, valid] of Object.entries(OPTIONAL_CLAIMS)) {
    if (!Object.hasOwn(claims, name)) continue;
    const v = claims[name];
    if (!valid(v)) return null;
    out[name] = Array.isArray(v) ? [...(v as string[])] : v;
  }
  return out as Optional;
}

/**
 * Verifies an ID token the way the contract does (docs/contract-interface.md, "Token verification"): RS256 only,
 * known issuer, known kid, valid signature, not expired, single-string aud; and the optional claims (`email`,
 * `email_verified`, `iat`, `hd`, `azp`, `amr`, `auth_time`) typed when present. Throws JwksUnavailableError only
 * when the JWKS cannot be fetched (callers answer 503: fail closed). `aud`, `nonce`, `iat` age and the email claims
 * are the caller's to check. Before anything else, a partner identity token (`typ` hana-identity+jwt, or `iss` the
 * env's identity issuer) is refused as `bad_token`: no Hana API accepts one (D120), whatever its signature.
 */
export async function verifyIdToken(jwt: string, now: number = Date.now(), opts: VerifyOptions = {}): Promise<VerifyResult> {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return fail('invalid_token', 'Malformed token');
  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  if (!header || !claims) return fail('invalid_token', 'Malformed token');
  if (header.typ === IDENTITY_TOKEN_TYP || (!!opts.identityIssuer && claims.iss === opts.identityIssuer)) return fail('bad_token', 'A Hana identity token is not accepted here');
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return fail('invalid_token', 'Unsupported token algorithm');
  const { iss, aud, sub, exp, nonce } = claims;
  if (typeof iss !== 'string' || typeof aud !== 'string' || typeof sub !== 'string' || typeof exp !== 'number') return fail('invalid_token', 'Malformed token claims');
  const optional = optionalClaims(claims);
  if (!optional) return fail('invalid_token', 'Malformed token claims');
  const provider = providerForIssuer(iss);
  const cache = provider ? cacheFor(provider) : null;
  if (!provider || !cache) return fail('unsupported_issuer', 'Unsupported token issuer');
  if (exp * 1000 + (opts.skewMs ?? 0) <= now) return fail('token_expired', 'The token has expired');

  const { observer, onStaleKeys } = opts;
  const jwk = await cache.key(header.kid, now, {
    ...(observer && { onFetch: (kids, maxAgeS, at) => observer.jwks(provider, kids, maxAgeS, at) }),
    ...(onStaleKeys && { onStale: onStaleKeys }),
  });
  if (!jwk) return fail('invalid_token', 'Unknown token signing key');
  if (!(await verifyRs256(jwk, `${parts[0]}.${parts[1]}`, parts[2]))) return fail('invalid_token', 'Invalid token signature');
  observer?.token(provider, header.kid, now);
  return { ok: true, token: { provider, kid: header.kid, iss, aud, sub, exp, nonce: typeof nonce === 'string' ? nonce : null, ...optional } };
}

/**
 * The issuer's published keys as this isolate holds them (fetched when the cache is cold or expired, with the same
 * failure backoff and stale grace as token checks), or null when they can't be had. For the API's GET
 * /v1/governance JWKS comparison only.
 */
export async function publishedKeys(provider: string, now: number = Date.now()): Promise<Jwk[] | null> {
  return (await cacheFor(provider)?.published(now)) ?? null;
}

/** Tests only: forgets every provider's cached JWKS and fetch history. */
export function clearJwksCache(): void {
  for (const cache of caches.values()) cache.clear();
}
