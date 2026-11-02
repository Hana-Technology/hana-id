// The Cloudflare Access application token (the `Cf-Access-Jwt-Assertion` header) the admin Worker checks on every
// /api/* request (docs/batch-c-spec.md "Hana admin console", D88): RS256 against the team's certs
// (`https://<teamDomain>/cdn-cgi/access/certs`, cached like Google's JWKS but never served stale), a `kid` in that set,
// `iss = https://<teamDomain>`, `aud` the application's AUD tag, unexpired and not before `nbf`, `type = 'app'`, a
// non-empty `sub` (service tokens have none) and a non-empty `email`. The staff allowlist is the caller's (the
// lowercased `email` in the manifest's `admin.staffEmails`). The fetcher is injected; nothing here logs.
import { type Fetcher, JwksCache } from './jwks-cache.ts';
import { decodeSegment, verifyRs256 } from './jws.ts';

/** The request header Cloudflare Access sets on requests it lets through. */
export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
/** Longer is refused unread (Access tokens are about 1 KB). */
export const MAX_ACCESS_JWT_BYTES = 8192;
/** Clock skew tolerated on `exp` and `nbf` by default: Access mints the token on another machine at the same moment. */
export const ACCESS_SKEW_MS = 60_000;

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

export const accessCertsUrl = (teamDomain: string): string => `https://${teamDomain}/cdn-cgi/access/certs`;

export interface AccessVerifierConfig {
  /** `<team>.cloudflareaccess.com` (manifest `admin.accessTeamDomain`). */
  teamDomain: string;
  /** The Access application's AUD tag (manifest `admin.accessAud`). */
  aud: string;
  /** Fetches the team's certs (the Worker passes `fetch`; tests a stub). */
  fetch: Fetcher;
  /** Default ACCESS_SKEW_MS. */
  skewMs?: number;
}

export type AccessFailure =
  | 'missing'
  | 'malformed'
  | 'wrong_type'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'expired'
  | 'not_yet_valid'
  | 'no_subject'
  | 'no_email'
  | 'unknown_key'
  | 'bad_signature';

export interface AccessIdentity {
  sub: string;
  /** As the token carries it; the staff check compares it lowercased. Personal data: never log it. */
  email: string;
  kid: string;
  exp: number;
  iat?: number;
}

export type AccessResult = { ok: true; identity: AccessIdentity } | { ok: false; code: AccessFailure };

const no = (code: AccessFailure): AccessResult => ({ ok: false, code });

export class AccessJwtVerifier {
  private readonly certs: JwksCache;
  private readonly iss: string;
  private readonly aud: string;
  private readonly skewMs: number;

  constructor(cfg: AccessVerifierConfig) {
    if (!HOSTNAME.test(cfg.teamDomain)) throw new Error('Access team domain must be a lowercase host name');
    if (typeof cfg.aud !== 'string' || cfg.aud.length === 0) throw new Error('Access AUD tag is required');
    this.certs = new JwksCache(accessCertsUrl(cfg.teamDomain), { fetch: cfg.fetch, staleGraceMs: 0 });
    this.iss = `https://${cfg.teamDomain}`;
    this.aud = cfg.aud;
    this.skewMs = cfg.skewMs ?? ACCESS_SKEW_MS;
  }

  /**
   * Checks an Access JWT (the header's value; null or empty when the header is missing). Every claim is checked
   * before the certs are read, so a malformed or misdirected token costs no fetch. Throws JwksUnavailableError only
   * when the team's certs can't be fetched (fail closed).
   */
  async verify(jwt: string | null | undefined, now: number = Date.now()): Promise<AccessResult> {
    if (!jwt) return no('missing');
    if (jwt.length > MAX_ACCESS_JWT_BYTES) return no('malformed');
    const parts = jwt.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return no('malformed');
    const header = decodeSegment(parts[0], true);
    const claims = decodeSegment(parts[1], true);
    if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length === 0) return no('malformed');
    const { iss, aud, exp, nbf, iat, sub, email, type } = claims;
    if (type !== 'app') return no('wrong_type');
    if (iss !== this.iss) return no('wrong_issuer');
    if (!(aud === this.aud || (Array.isArray(aud) && aud.includes(this.aud)))) return no('wrong_audience');
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return no('malformed');
    if (exp * 1000 + this.skewMs <= now) return no('expired');
    if (nbf !== undefined && (typeof nbf !== 'number' || !Number.isFinite(nbf))) return no('malformed');
    if (typeof nbf === 'number' && nbf * 1000 - this.skewMs > now) return no('not_yet_valid');
    if (iat !== undefined && (typeof iat !== 'number' || !Number.isFinite(iat))) return no('malformed');
    if (typeof sub !== 'string' || sub.length === 0) return no('no_subject');
    if (typeof email !== 'string' || email.length === 0) return no('no_email');

    const jwk = await this.certs.key(header.kid, now);
    if (!jwk) return no('unknown_key');
    if (!(await verifyRs256(jwk, `${parts[0]}.${parts[1]}`, parts[2]))) return no('bad_signature');
    return { ok: true, identity: { sub, email, kid: header.kid, exp, ...(typeof iat === 'number' && { iat }) } };
  }
}
