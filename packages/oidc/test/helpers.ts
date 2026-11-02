// Test helpers: throwaway RSA keys that sign real RS256 tokens, and a fake JWKS endpoint. Web Crypto only, so the
// same tests run in Node and in workerd. No network: every fetch is answered here.
import { GOOGLE_JWKS_URL } from '@hana-id/jwks';
import { vi } from 'vitest';

export const b64url = (data: string | Uint8Array): string => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

export interface RsaSigner {
  jwk: { kid: string; n: string; e: string; kty: 'RSA'; alg: 'RS256'; use: 'sig' };
  /** A real RS256 token over `claims` (header `{alg: RS256, kid, typ: JWT, ...header}`). */
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

export async function rsaSigner(kid = `kid-${Math.random().toString(36).slice(2, 8)}`): Promise<RsaSigner> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return {
    jwk: { kid, n: pub.n!, e: pub.e!, kty: 'RSA', alg: 'RS256', use: 'sig' },
    async sign(claims, header = {}) {
      const input = `${b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...header }))}.${b64url(JSON.stringify(claims))}`;
      const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(input)));
      return `${input}.${b64url(sig)}`;
    },
  };
}

/** A JWKS endpoint: its body, status and Cache-Control can change between calls; it counts fetches. */
export class FakeJwks {
  body: unknown;
  status = 200;
  cacheControl: string | undefined;
  fetches = 0;
  /** When set, the fetch rejects (a network error). */
  networkError = false;

  constructor(keys: unknown[] = []) {
    this.body = { keys };
  }

  readonly fetch = (input: string, init?: RequestInit): Promise<Response> => {
    void init;
    this.fetches++;
    if (this.networkError) return Promise.reject(new TypeError('Network connection lost.'));
    return Promise.resolve(Response.json(this.body, { status: this.status, headers: this.cacheControl ? { 'cache-control': this.cacheControl } : {} }));
  };
}

/** Stubs the global fetch: Google's JWKS URL is answered by `jwks`; anything else fails the test. */
export function stubGoogle(jwks: FakeJwks): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === GOOGLE_JWKS_URL) return jwks.fetch(url, init);
    return Promise.reject(new Error(`Unexpected fetch to ${url}`));
  });
}
