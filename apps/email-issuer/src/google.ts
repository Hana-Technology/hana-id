// Google, for google-match (spec "How the popup gets Google's verified email"): the ID token (RS256 against Google's
// JWKS, iss, aud, exp; the nonce is the caller's to check), the access token's tokeninfo (its aud/azp must be the ID
// token's client and its sub the ID token's), userinfo (`email`, `email_verified`, `hd`), then the access token's
// revocation. Tokens travel in POST bodies and the Authorization header, never in a URL. Every answer is size-capped;
// nothing here logs a token, an address or a body.
import { base64UrlDecode } from './bytes.ts';
import { GOOGLE_JWKS_URL, type Jwk, usableJwks } from '@hana-id/jwks';
import { responseJson } from './http.ts';
import { verifyRs256 } from './signer.ts';

export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
export const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_TIMEOUT_MS = 8000;
export const GOOGLE_MAX_RESPONSE_BYTES = 64 * 1024;
const JWKS_TTL_MS = 60 * 60_000;
const JWKS_REFETCH_MIN_MS = 60_000;
/** Clock skew tolerated on the ID token's exp. */
const EXP_SKEW_MS = 60_000;

export class GoogleUnavailable extends Error {}

export interface GoogleIdToken {
  sub: string;
  aud: string;
  nonce: string | null;
}

export interface UserInfo {
  email: string;
  emailVerified: boolean;
  hd: string | null;
}

export type GoogleCheck<T> = { ok: true; value: T } | { ok: false; reason: string };

const decodeJson = (part: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(base64UrlDecode(part)));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export class Google {
  private jwks: { keys: Map<string, Jwk>; at: number } | null = null;
  private lastFetch = -Infinity;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async get(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
    } catch {
      throw new GoogleUnavailable('Google unreachable');
    }
    return { status: res.status, body: await responseJson(res, GOOGLE_MAX_RESPONSE_BYTES) };
  }

  private async key(kid: string): Promise<Jwk | null> {
    const now = this.now();
    if (this.jwks && now - this.jwks.at < JWKS_TTL_MS && this.jwks.keys.has(kid)) return this.jwks.keys.get(kid)!;
    if (this.jwks && now - this.lastFetch < JWKS_REFETCH_MIN_MS) return this.jwks.keys.get(kid) ?? null;
    this.lastFetch = now;
    const { status, body } = await this.get(GOOGLE_JWKS_URL, { headers: { accept: 'application/json' } });
    const keys = status === 200 ? usableJwks(body) : [];
    if (keys.length === 0) throw new GoogleUnavailable('Google JWKS unavailable');
    this.jwks = { keys: new Map(keys.map((k) => [k.kid, k])), at: now };
    return this.jwks.keys.get(kid) ?? null;
  }

  /** A genuine, unexpired Google ID token for one of `audiences`. */
  async verifyIdToken(jwt: string, audiences: readonly string[]): Promise<GoogleCheck<GoogleIdToken>> {
    const parts = typeof jwt === 'string' ? jwt.split('.') : [];
    if (parts.length !== 3 || jwt.length > 7168) return { ok: false, reason: 'malformed' };
    const header = decodeJson(parts[0]!);
    const claims = decodeJson(parts[1]!);
    if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string') return { ok: false, reason: 'malformed' };
    const { iss, aud, sub, exp, nonce } = claims;
    if (typeof iss !== 'string' || !GOOGLE_ISSUERS.includes(iss)) return { ok: false, reason: 'issuer' };
    if (typeof aud !== 'string' || !audiences.includes(aud)) return { ok: false, reason: 'audience' };
    if (typeof sub !== 'string' || sub.length === 0 || sub.length > 255 || sub.includes('#')) return { ok: false, reason: 'sub' };
    if (typeof exp !== 'number' || exp * 1000 + EXP_SKEW_MS <= this.now()) return { ok: false, reason: 'expired' };
    const jwk = await this.key(header.kid);
    if (!jwk) return { ok: false, reason: 'unknown_key' };
    let sig: Uint8Array;
    try {
      sig = base64UrlDecode(parts[2]!);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (!(await verifyRs256(jwk, new TextEncoder().encode(`${parts[0]}.${parts[1]}`), sig))) return { ok: false, reason: 'signature' };
    return { ok: true, value: { sub, aud, nonce: typeof nonce === 'string' ? nonce : null } };
  }

  /** tokeninfo for the access token: it must be for `aud` (aud and, when present, azp) and for `sub`, and unexpired. */
  async checkAccessToken(accessToken: string, aud: string, sub: string): Promise<GoogleCheck<null>> {
    const { status, body } = await this.get(GOOGLE_TOKENINFO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: accessToken }).toString(),
    });
    if (status >= 500) throw new GoogleUnavailable('tokeninfo unavailable');
    const o = (body ?? {}) as Record<string, unknown>;
    if (status !== 200) return { ok: false, reason: 'tokeninfo' };
    if (o.aud !== aud || (o.azp !== undefined && o.azp !== aud)) return { ok: false, reason: 'tokeninfo_aud' };
    if (o.sub !== sub) return { ok: false, reason: 'tokeninfo_sub' };
    const expiresIn = typeof o.expires_in === 'string' ? Number(o.expires_in) : o.expires_in;
    if (typeof expiresIn !== 'number' || !(expiresIn > 0)) return { ok: false, reason: 'tokeninfo_expired' };
    return { ok: true, value: null };
  }

  /** userinfo: the account's primary address, whether Google verified it, and its Workspace domain. */
  async userInfo(accessToken: string, sub: string): Promise<GoogleCheck<UserInfo>> {
    const { status, body } = await this.get(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
    if (status >= 500) throw new GoogleUnavailable('userinfo unavailable');
    const o = (body ?? {}) as Record<string, unknown>;
    if (status !== 200 || o.sub !== sub || typeof o.email !== 'string') return { ok: false, reason: 'userinfo' };
    const hd = typeof o.hd === 'string' ? o.hd : null;
    return { ok: true, value: { email: o.email, emailVerified: o.email_verified === true, hd } };
  }

  /** Revokes the access token (best effort: a failure is logged by the caller, never retried with the token kept). */
  async revoke(accessToken: string): Promise<boolean> {
    try {
      const { status } = await this.get(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: accessToken }).toString(),
      });
      return status === 200;
    } catch {
      return false;
    }
  }
}
