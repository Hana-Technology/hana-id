// Google's server-side endpoints for the stack's own Workers (build plan batch 8b): the email issuer's google-match
// (apps/email-issuer src/google.ts) reads Google's JWKS, `tokeninfo` and `userinfo` and revokes the access token, and
// apps/api reads the JWKS too. Both Workers run in this Node process, so `install()` answers those URLs here, in the
// stack process only (every other fetch goes out unchanged).
//
// One RSA key per stack signs every ID token: the tests' Google stub (src/google-stub.ts, in the test process, one per
// browser context) fetches it from the API's control endpoint `GET /__e2e/google-key` (no CORS, refused with an
// Origin, so no page can read it), so the issuer's JWKS cache (an hour) always knows the kid.
//
// Access tokens are the stub's own self-describing test values (`ya29.e2e.<b64url JSON>`: the client, the account's
// sub, its email, email_verified and hd): `tokeninfo` and `userinfo` read them back. Never a real Google token.
import { base64UrlDecode, base64UrlEncode, fromUtf8, utf8 } from '@hana-id/core';

export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const ACCESS_TOKEN_PREFIX = 'ya29.e2e.';

/** What a stub access token says (the account Google would answer for). */
export interface AccessGrant {
  aud: string;
  sub: string;
  email: string | null;
  emailVerified: boolean;
  hd: string | null;
  expMs: number;
}

export const accessTokenFor = (g: AccessGrant): string => `${ACCESS_TOKEN_PREFIX}${base64UrlEncode(utf8(JSON.stringify(g)))}`;

export function readAccessToken(token: string): AccessGrant | null {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return null;
  try {
    const g = JSON.parse(fromUtf8(base64UrlDecode(token.slice(ACCESS_TOKEN_PREFIX.length)))) as AccessGrant;
    return typeof g.aud === 'string' && typeof g.sub === 'string' && typeof g.expMs === 'number' ? g : null;
  } catch {
    return null;
  }
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class GoogleBackend {
  readonly kid = `e2e-stack-${base64UrlEncode(crypto.getRandomValues(new Uint8Array(6)))}`;
  readonly revoked = new Set<string>();
  private constructor(private readonly pair: CryptoKeyPair) {}

  static async create(): Promise<GoogleBackend> {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    return new GoogleBackend(pair);
  }

  /** The private JWK with its kid (the tests' stub signs with it). */
  async privateJwk(): Promise<JsonWebKey & { kid: string }> {
    return { ...(await crypto.subtle.exportKey('jwk', this.pair.privateKey)), kid: this.kid };
  }

  async jwks(): Promise<{ keys: Record<string, string>[] }> {
    const jwk = await crypto.subtle.exportKey('jwk', this.pair.publicKey);
    return { keys: [{ kty: 'RSA', alg: 'RS256', use: 'sig', kid: this.kid, n: jwk.n as string, e: jwk.e as string }] };
  }

  /** Google's answer for `url`, or null when it isn't one of Google's endpoints. */
  async answer(url: string, init: RequestInit | undefined): Promise<Response | null> {
    const bare = url.split('?')[0];
    if (bare === GOOGLE_CERTS_URL) return json(200, await this.jwks());
    if (bare === GOOGLE_TOKENINFO_URL) {
      const token = new URLSearchParams(typeof init?.body === 'string' ? init.body : '').get('access_token') ?? new URL(url).searchParams.get('access_token') ?? '';
      const g = readAccessToken(token);
      if (!g || this.revoked.has(token) || g.expMs <= Date.now()) return json(400, { error: 'invalid_token' });
      return json(200, { aud: g.aud, azp: g.aud, sub: g.sub, scope: 'https://www.googleapis.com/auth/userinfo.email openid', expires_in: String(Math.floor((g.expMs - Date.now()) / 1000)) });
    }
    if (bare === GOOGLE_USERINFO_URL) {
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const g = readAccessToken(token);
      if (!g || this.revoked.has(token)) return json(401, { error: 'invalid_token' });
      return json(200, { sub: g.sub, ...(g.email ? { email: g.email, email_verified: g.emailVerified } : {}), ...(g.hd ? { hd: g.hd } : {}) });
    }
    if (bare === GOOGLE_REVOKE_URL) {
      const token = new URLSearchParams(typeof init?.body === 'string' ? init.body : '').get('token') ?? '';
      this.revoked.add(token);
      return json(200, {});
    }
    return null;
  }

  /** Answers Google's endpoints in this process (the Workers' `fetch`); everything else goes out as before. */
  install(): void {
    const real = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://www.googleapis.com/') || url.startsWith('https://oauth2.googleapis.com/') || url.startsWith('https://openidconnect.googleapis.com/')) {
        let body = init;
        if (typeof input !== 'string' && !(input instanceof URL)) {
          body = { method: input.method, headers: input.headers, body: init?.body ?? (input.method === 'GET' ? undefined : await input.text()) };
        }
        const r = await this.answer(url, body);
        if (r) return r;
        return json(404, { error: 'not_found' });
      }
      return real(input, init);
    }) as typeof fetch;
  }
}
