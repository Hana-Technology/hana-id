// RS256 ID-token check and the claim allow-list, with tokens signed by a throwaway WebCrypto RSA key.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { base64UrlEncode, utf8 } from '../src/bytes.ts';
import {
  GOOGLE_JWKS_URL,
  type Jwk,
  NAMED_PII_CLAIMS,
  TOKEN_CLAIM_ALLOW_LIST,
  decodeJwt,
  disallowedClaim,
  fetchGoogleJwks,
  usableJwks,
  verifyGoogleIdToken,
} from '../src/id-token.ts';
import { contractFixture } from './helpers.ts';

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const CLIENT = 'hana-shared.apps.googleusercontent.com';
const NONCE = 'n'.repeat(43);
const KID = 'kid-1';

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let jwk: Jwk;

async function rsaKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
}

beforeAll(async () => {
  const pair = await rsaKey();
  privateKey = pair.privateKey;
  otherKey = (await rsaKey()).privateKey;
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  jwk = { kid: KID, kty: 'RSA', alg: 'RS256', use: 'sig', n: pub.n!, e: pub.e! };
});

const goodClaims = (): Record<string, unknown> => ({
  iss: 'https://accounts.google.com',
  azp: CLIENT,
  aud: CLIENT,
  sub: '110248495921238986420',
  iat: NOW_S - 10,
  nbf: NOW_S - 310,
  exp: NOW_S + 3590,
  nonce: NONCE,
  jti: 'abc123',
});

async function jwt(claims: Record<string, unknown>, opts: { header?: Record<string, unknown>; key?: CryptoKey } = {}): Promise<string> {
  const head = base64UrlEncode(utf8(JSON.stringify(opts.header ?? { alg: 'RS256', kid: KID, typ: 'JWT' })));
  const body = base64UrlEncode(utf8(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', opts.key ?? privateKey, utf8(`${head}.${body}`)));
  return `${head}.${body}.${base64UrlEncode(sig)}`;
}

const verify = (token: string, over: Partial<Parameters<typeof verifyGoogleIdToken>[1]> = {}) =>
  verifyGoogleIdToken(token, { clientId: CLIENT, nonce: NONCE, nowMs: NOW_MS, jwks: [jwk], ...over });

describe('verifyGoogleIdToken', () => {
  it('accepts a valid openid-only token (the spike’s exact claim set)', async () => {
    const r = await verify(await jwt(goodClaims()));
    expect(r).toEqual({ ok: true, token: { iss: 'https://accounts.google.com', aud: CLIENT, sub: '110248495921238986420', nonce: NONCE, iat: NOW_S - 10, exp: NOW_S + 3590, authTime: null } });
  });

  it('accepts the bare issuer form and a kid lookup function', async () => {
    const lookup = vi.fn(async (kid: string) => (kid === KID ? jwk : null));
    const r = await verify(await jwt({ ...goodClaims(), iss: 'accounts.google.com' }), { jwks: lookup });
    expect(r.ok).toBe(true);
    expect(lookup).toHaveBeenCalledWith(KID);
  });

  it.each([
    ['a bad signature', async () => jwt(goodClaims(), { key: otherKey }), /signature/],
    ['an unknown kid', async () => jwt(goodClaims(), { header: { alg: 'RS256', kid: 'nope' } }), /signing key/],
    ['alg none', async () => jwt(goodClaims(), { header: { alg: 'none', kid: KID } }), /algorithm/],
    ['alg HS256', async () => jwt(goodClaims(), { header: { alg: 'HS256', kid: KID } }), /algorithm/],
    ['a wrong iss', async () => jwt({ ...goodClaims(), iss: 'https://evil.example' }), /issuer/],
    ['a wrong aud', async () => jwt({ ...goodClaims(), aud: 'other.apps.googleusercontent.com' }), /audience/],
    ['an aud array', async () => jwt({ ...goodClaims(), aud: [CLIENT] }), /audience/],
    ['a wrong nonce', async () => jwt({ ...goodClaims(), nonce: 'm'.repeat(43) }), /nonce/],
    ['no nonce', async () => jwt({ ...goodClaims(), nonce: undefined }), /nonce/],
    ['an expired token (beyond the 60 s skew)', async () => jwt({ ...goodClaims(), exp: NOW_S - 61 }), /expired/],
    ['an iat in the future (beyond 60 s)', async () => jwt({ ...goodClaims(), iat: NOW_S + 61 }), /future/],
    ['an nbf in the future (beyond 60 s)', async () => jwt({ ...goodClaims(), nbf: NOW_S + 61 }), /not valid yet/],
    ['a string exp', async () => jwt({ ...goodClaims(), exp: String(NOW_S + 100) }), /expired/],
    ['a sub with #', async () => jwt({ ...goodClaims(), sub: 'a#b' }), /sub/],
    ['an empty sub', async () => jwt({ ...goodClaims(), sub: '' }), /sub/],
    ['a 256-byte sub', async () => jwt({ ...goodClaims(), sub: 'x'.repeat(256) }), /sub/],
    ['a malformed token', async () => 'a.b', /Malformed/],
  ])('refuses %s', async (_, make, reason) => {
    const r = await verify(await make());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('token_invalid');
      expect(r.reason).toMatch(reason);
    }
  });

  it('accepts exp and iat at the edge of the 60 s skew', async () => {
    expect((await verify(await jwt({ ...goodClaims(), exp: NOW_S - 59 }))).ok).toBe(true);
    expect((await verify(await jwt({ ...goodClaims(), iat: NOW_S + 60 }))).ok).toBe(true);
    expect((await verify(await jwt({ ...goodClaims(), exp: NOW_S - 60 }))).ok).toBe(false);
  });

  it.each([...NAMED_PII_CLAIMS, 'unknown_claim'])('refuses claim %s with token_has_pii', async (claim) => {
    const r = await verify(await jwt({ ...goodClaims(), [claim]: claim === 'email_verified' ? true : 'x' }));
    expect(r).toMatchObject({ ok: false, code: 'token_has_pii', claim });
  });

  it.each(TOKEN_CLAIM_ALLOW_LIST)('allows claim %s', async (claim) => {
    const extra = claim === 'auth_time' ? { auth_time: NOW_S - 5 } : claim === 'at_hash' ? { at_hash: 'pKoRe4wHbXLoKz8BsUNdXg' } : {};
    const c = { ...goodClaims(), ...extra };
    expect(Object.keys(c)).toContain(claim);
    expect((await verify(await jwt(c))).ok).toBe(true);
  });

  it('the allow-list is the spec’s with at_hash (D342), and hd is refused', () => {
    expect([...TOKEN_CLAIM_ALLOW_LIST].sort()).toEqual(['at_hash', 'aud', 'auth_time', 'azp', 'exp', 'iat', 'iss', 'jti', 'nbf', 'nonce', 'sub']);
    expect(disallowedClaim({ iss: 'x', hd: 'example.com' })).toBe('hd');
    expect(disallowedClaim(goodClaims())).toBeNull();
  });

  it('auth_time freshness (export): required and at most maxAuthAgeMs old when asked', async () => {
    const fresh = await jwt({ ...goodClaims(), auth_time: NOW_S - 60 });
    const stale = await jwt({ ...goodClaims(), auth_time: NOW_S - 301 });
    expect((await verify(fresh, { maxAuthAgeMs: 300_000 })).ok).toBe(true);
    expect(await verify(stale, { maxAuthAgeMs: 300_000 })).toMatchObject({ ok: false, reason: /not fresh/ });
    expect(await verify(await jwt(goodClaims()), { maxAuthAgeMs: 300_000 })).toMatchObject({ ok: false, reason: /no auth_time/ });
    expect((await verify(stale)).ok).toBe(true); // not asked: auth_time is only checked for type
  });

  it('a JWKS lookup failure propagates (unavailable, not invalid)', async () => {
    await expect(verify(await jwt(goodClaims()), { jwks: async () => Promise.reject(new Error('offline')) })).rejects.toThrow('offline');
  });

  it('results never contain the token', async () => {
    const token = await jwt({ ...goodClaims(), email: 'a@b.c' });
    expect(JSON.stringify(await verify(token))).not.toContain(token.split('.')[2]);
  });
});

describe('JWKS', () => {
  it('keeps RS256 signing keys only', () => {
    const keys = usableJwks({
      keys: [
        { kid: 'a', kty: 'RSA', alg: 'RS256', use: 'sig', n: 'AQAB', e: 'AQAB' },
        { kid: 'b', kty: 'RSA', alg: 'RS512', n: 'AQAB', e: 'AQAB' },
        { kid: 'c', kty: 'EC', n: 'AQAB', e: 'AQAB' },
        { kid: '', kty: 'RSA', n: 'AQAB', e: 'AQAB' },
        { kid: 'd', kty: 'RSA', use: 'enc', n: 'AQAB', e: 'AQAB' },
        { kid: 'e', kty: 'RSA', n: 'A+B', e: 'AQAB' },
      ],
    });
    expect(keys.map((k) => k.kid)).toEqual(['a']);
    expect(usableJwks(null)).toEqual([]);
  });

  it('fetchGoogleJwks fetches Google’s certs and refuses an empty set', async () => {
    const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ keys: [jwk] }));
    expect(await fetchGoogleJwks(f)).toEqual([jwk]);
    expect(f.mock.calls[0]![0]).toBe(GOOGLE_JWKS_URL);
    await expect(fetchGoogleJwks(async () => Response.json({ keys: [] }))).rejects.toThrow(/no usable key/);
    await expect(fetchGoogleJwks(async () => new Response('x', { status: 500 }))).rejects.toThrow(/500/);
  });

  it('verifies the contract fixture tokens against the fixture key (gen-fixtures.mjs)', async () => {
    const fx = contractFixture();
    const token = fx.tokens.shared_s3!;
    const claims = decodeJwt(token)!.claims;
    const r = await verifyGoogleIdToken(token, { clientId: claims.aud as string, nonce: claims.nonce as string, nowMs: (claims.iat as number) * 1000, jwks: [{ kid: fx.kid, n: fx.n, e: fx.e }] });
    expect(r).toMatchObject({ ok: true, token: { sub: '1098765432' } });
  });
});
