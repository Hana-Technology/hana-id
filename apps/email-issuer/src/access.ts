// Cloudflare Access in front of every `admin/*` route (D88): the `Cf-Access-Jwt-Assertion` JWT is RS256 against the
// team's certs, `iss` the team domain, `aud` the application's AUD tag, unexpired, a non-empty `sub`, and an email on the
// issuer's own staff allowlist (a second check behind the Access policy). Any failure is a 403 that names nothing.
import { base64UrlDecode } from './bytes.ts';
import { type Jwk, usableJwks } from '@hana-id/jwks';
import { responseJson, globalFetch } from './http.ts';
import { verifyRs256 } from './signer.ts';

export const ACCESS_HEADER = 'cf-access-jwt-assertion';
const CERTS_TTL_MS = 10 * 60_000;
/** After a failed certs fetch or an unknown kid, no new fetch for this long (L6: a flood of bad JWTs costs no fetches). */
export const ACCESS_NEGATIVE_CACHE_MS = 30_000;
const SKEW_S = 60;

export interface AccessConfig {
  teamDomain: string;
  aud: string;
  staffEmails: string[];
}

export function accessConfig(env: { ACCESS_TEAM_DOMAIN?: string | undefined; ACCESS_AUD?: string | undefined; ACCESS_STAFF_EMAILS?: string | undefined }): AccessConfig | null {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ACCESS_STAFF_EMAILS) return null;
  let staff: unknown;
  try {
    staff = JSON.parse(env.ACCESS_STAFF_EMAILS);
  } catch {
    return null;
  }
  if (!Array.isArray(staff) || staff.length === 0 || !staff.every((s) => typeof s === 'string')) return null;
  return { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, staffEmails: staff as string[] };
}

const decode = (part: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(base64UrlDecode(part)));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export class AccessVerifier {
  private certs: { keys: Map<string, Jwk>; at: number } | null = null;
  private missUntil = 0;
  /** How many times the certs were fetched (tests). */
  fetches = 0;

  constructor(
    private readonly cfg: AccessConfig,
    private readonly fetcher: typeof fetch = globalFetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async key(kid: string): Promise<Jwk | null> {
    const now = this.now();
    const fresh = this.certs && now - this.certs.at < CERTS_TTL_MS;
    if (fresh && this.certs!.keys.has(kid)) return this.certs!.keys.get(kid)!;
    // Negative cache: a recent failed fetch, or a recent fetch that didn't know this kid.
    if (now < this.missUntil || (this.certs && now - this.certs.at < 60_000)) return this.certs?.keys.get(kid) ?? null;
    try {
      this.fetches++;
      const res = await this.fetcher(`https://${this.cfg.teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(8000) });
      const keys = res.ok ? usableJwks(await responseJson(res, 64 * 1024)) : [];
      if (keys.length > 0) this.certs = { keys: new Map(keys.map((k) => [k.kid, k])), at: now };
    } catch {
      // Below: a miss.
    }
    const hit = this.certs?.keys.get(kid) ?? null;
    if (!hit) this.missUntil = now + ACCESS_NEGATIVE_CACHE_MS;
    return hit;
  }

  /** The staff email of a valid Access JWT, or null. */
  async staff(request: Request): Promise<string | null> {
    const jwt = request.headers.get(ACCESS_HEADER);
    if (!jwt || jwt.length > 8192) return null;
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const header = decode(parts[0]!);
    const claims = decode(parts[1]!);
    if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    const now = Math.floor(this.now() / 1000);
    if (claims.iss !== `https://${this.cfg.teamDomain}`) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.cfg.aud)) return null;
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S <= now) return null;
    if (typeof claims.nbf === 'number' && claims.nbf - SKEW_S > now) return null;
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) return null;
    if (typeof claims.email !== 'string' || !this.cfg.staffEmails.includes(claims.email.toLowerCase())) return null;
    const jwk = await this.key(header.kid);
    if (!jwk) return null;
    let sig: Uint8Array;
    try {
      sig = base64UrlDecode(parts[2]!);
    } catch {
      return null;
    }
    if (!(await verifyRs256(jwk, new TextEncoder().encode(`${parts[0]}.${parts[1]}`), sig))) return null;
    return claims.email.toLowerCase();
  }
}
