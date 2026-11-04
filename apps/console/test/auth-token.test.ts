// The console's ID-token check by scope (src/auth-token.ts; D271, D274, D277, D290, D342): `openid` (step-ups and owner
// actions, batch C10) is held to exactly the API's claim allow-list (which holds `at_hash` since D342), so a token
// carrying `email` or `hd` is refused; `openid email` (sign-in only, never relayed) may add exactly `email`,
// `email_verified` and `hd`, and must carry a verified address. In both, an `at_hash` must match the access token.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGN_IN_EXTRA_CLAIMS, TOKEN_CLAIM_ALLOW_LIST, allowedClaims, atHash, claimNames, verifyConsoleToken } from '../src/auth-token.ts';
import { CLIENT_ID, MockGoogle } from './google.ts';

let google: MockGoogle;
beforeEach(async () => {
  google = new MockGoogle();
  await google.init();
});
afterEach(() => vi.restoreAllMocks());

const NONCE = 'N'.repeat(43);
const base = () => {
  const now = Math.floor(Date.now() / 1000);
  return { iss: 'https://accounts.google.com', azp: CLIENT_ID, aud: CLIENT_ID, sub: '1234567890', nonce: NONCE, iat: now, exp: now + 3600 };
};
const check = (scope: 'openid' | 'openid email', accessToken?: string) => ({ clientId: CLIENT_ID, nonce: NONCE, scope, now: Date.now(), ...(accessToken ? { accessToken } : {}) });

describe('scope openid (step-ups, owner actions)', () => {
  it("accepts exactly the allow-list's claims (Google's openid set: iss azp aud sub iat exp nonce, plus nbf jti auth_time at_hash)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const access = 'ya29.all';
    const jwt = await google.idToken({ ...base(), nbf: now - 1, jti: 'j', auth_time: now, at_hash: await atHash(access) });
    expect(claimNames(jwt)).toEqual([...TOKEN_CLAIM_ALLOW_LIST].sort());
    expect(await verifyConsoleToken(jwt, check('openid', access))).toEqual({ ok: true, identity: { provider: 'google', sub: '1234567890', email: null, hd: null } });
  });

  it('refuses a token carrying email, email_verified, hd or a profile claim (claim_not_allowed, the claim named)', async () => {
    for (const [claim, value] of [['email', 'a@b.example'], ['email_verified', true], ['hd', 'b.example'], ['name', 'A'], ['picture', 'https://x'], ['given_name', 'A']] as const) {
      const r = await verifyConsoleToken(await google.idToken({ ...base(), [claim]: value }), check('openid', 'ya29.x'));
      expect(r, claim).toEqual({ ok: false, code: 'claim_not_allowed', claim });
    }
  });

  it('accepts a code-flow token with a matching at_hash (D342), and refuses a mismatched one or one with no access token', async () => {
    const access = 'ya29.step-up';
    const jwt = await google.idToken({ ...base(), at_hash: await atHash(access) });
    expect(await verifyConsoleToken(jwt, check('openid', access))).toEqual({ ok: true, identity: { provider: 'google', sub: '1234567890', email: null, hd: null } });
    expect(await verifyConsoleToken(jwt, check('openid', 'ya29.other'))).toEqual({ ok: false, code: 'at_hash_mismatch' });
    expect(await verifyConsoleToken(jwt, check('openid'))).toEqual({ ok: false, code: 'at_hash_mismatch' });
  });

  it('the allow-list is the API’s, with at_hash (D342)', () => {
    expect(allowedClaims('openid')).toEqual(TOKEN_CLAIM_ALLOW_LIST);
    expect(TOKEN_CLAIM_ALLOW_LIST).toEqual(['iss', 'azp', 'aud', 'sub', 'iat', 'exp', 'nonce', 'nbf', 'jti', 'auth_time', 'at_hash']);
  });
});

describe('scope openid email (sign-in)', () => {
  it('may add exactly email, email_verified and hd', () => {
    expect(SIGN_IN_EXTRA_CLAIMS).toEqual(['email', 'email_verified', 'hd']);
    expect(allowedClaims('openid email')).toEqual([...TOKEN_CLAIM_ALLOW_LIST, ...SIGN_IN_EXTRA_CLAIMS]);
  });

  it('accepts a verified address (lowercased) with a matching at_hash, and hd', async () => {
    const access = 'ya29.access';
    const jwt = await google.idToken({ ...base(), email: 'Member@Partner.Example', email_verified: true, hd: 'partner.example', at_hash: await atHash(access) });
    expect(await verifyConsoleToken(jwt, check('openid email', access))).toEqual({ ok: true, identity: { provider: 'google', sub: '1234567890', email: 'member@partner.example', hd: 'partner.example' } });
  });

  it("refuses an at_hash that isn't the access token's, or one with no access token to check it against", async () => {
    const jwt = await google.idToken({ ...base(), email: 'm@p.example', email_verified: true, at_hash: await atHash('ya29.one') });
    expect(await verifyConsoleToken(jwt, check('openid email', 'ya29.two'))).toEqual({ ok: false, code: 'at_hash_mismatch' });
    expect(await verifyConsoleToken(jwt, check('openid email'))).toEqual({ ok: false, code: 'at_hash_mismatch' });
  });

  it('needs email and email_verified === true ("true" as a string is read as true, as Google documents it)', async () => {
    expect(await verifyConsoleToken(await google.idToken({ ...base() }), check('openid email'))).toEqual({ ok: false, code: 'email_missing' });
    expect(await verifyConsoleToken(await google.idToken({ ...base(), email: 'm@p.example' }), check('openid email'))).toEqual({ ok: false, code: 'email_unverified' });
    expect(await verifyConsoleToken(await google.idToken({ ...base(), email: 'm@p.example', email_verified: false }), check('openid email'))).toEqual({ ok: false, code: 'email_unverified' });
    expect(await verifyConsoleToken(await google.idToken({ ...base(), email: 'm@p.example', email_verified: 'true' }), check('openid email'))).toMatchObject({ ok: true });
  });

  it('refuses profile claims', async () => {
    const r = await verifyConsoleToken(await google.idToken({ ...base(), email: 'm@p.example', email_verified: true, name: 'M' }), check('openid email'));
    expect(r).toEqual({ ok: false, code: 'claim_not_allowed', claim: 'name' });
  });
});

describe('both scopes', () => {
  it('refuse a forged signature, another audience or azp, another nonce, a stale or future iat, an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const forged = (await google.idToken(base())).replace(/\.[^.]+$/u, '.AAAA');
    expect(await verifyConsoleToken(forged, check('openid'))).toMatchObject({ ok: false, code: 'invalid_token' });
    for (const [edit, code] of [
      [{ aud: 'x.apps' }, 'wrong_audience'],
      [{ azp: 'x.apps' }, 'wrong_audience'],
      [{ nonce: 'other' }, 'wrong_nonce'],
      [{ iat: now - 121 }, 'stale_iat'],
      [{ iat: now + 61 }, 'stale_iat'],
      [{ exp: now - 1 }, 'token_expired'],
      [{ iss: 'https://evil.example' }, 'unsupported_issuer'],
    ] as const) {
      expect(await verifyConsoleToken(await google.idToken({ ...base(), ...edit }), check('openid')), JSON.stringify(edit)).toMatchObject({ ok: false, code });
    }
  });

  it('fail closed when the JWKS is unavailable', async () => {
    google.jwks.status = 500;
    const { clearJwksCache } = await import('@hana-id/oidc');
    clearJwksCache();
    expect(await verifyConsoleToken(await google.idToken(base()), check('openid'))).toEqual({ ok: false, code: 'jwks_unavailable' });
  });
});
