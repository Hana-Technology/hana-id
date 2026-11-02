// verifyIdToken, publishedKeys and the Google JWKS cache, moved from apps/api (src/jwks.ts, src/jwt.ts) with the
// behaviours apps/api/test/verification.test.ts checks through POST /v1/sessions, here against the function itself;
// and the new optional claims.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_PROVIDER } from '@hana-id/jwks';
import { IDENTITY_TOKEN_TYP, JwksUnavailableError, type KeyObserver, cacheMaxAgeS, clearJwksCache, providerForIssuer, publishedKeys, verifyIdToken } from '../src/index.ts';
import { base64UrlDecode } from '../src/jws.ts';
import { FakeJwks, type RsaSigner, b64url, rsaSigner, stubGoogle } from './helpers.ts';

const ISS = 'https://accounts.google.com';
const AUD = 'client-1.apps.googleusercontent.com';
const T0 = 1_800_000_000_000;
const s = (ms: number): number => Math.floor(ms / 1000);

let google: RsaSigner;
let jwks: FakeJwks;

beforeEach(async () => {
  clearJwksCache();
  google ??= await rsaSigner('google-kid');
  jwks = new FakeJwks([google.jwk]);
  stubGoogle(jwks);
});
afterEach(() => vi.restoreAllMocks());

const claims = (over: Record<string, unknown> = {}, now = T0): Record<string, unknown> => ({ iss: ISS, aud: AUD, sub: '1234', exp: s(now) + 3600, nonce: 'n1', ...over });
const token = (over: Record<string, unknown> = {}, now = T0, signer: RsaSigner = google): Promise<string> => signer.sign(claims(over, now));

describe('verifyIdToken: signature and format', () => {
  it('accepts a genuine token and returns the checked claims', async () => {
    expect(await verifyIdToken(await token(), T0)).toEqual({
      ok: true,
      token: { provider: GOOGLE_PROVIDER, kid: 'google-kid', iss: ISS, aud: AUD, sub: '1234', exp: s(T0) + 3600, nonce: 'n1' },
    });
    // Both of Google's `iss` spellings.
    expect((await verifyIdToken(await token({ iss: 'accounts.google.com' }), T0)).ok).toBe(true);
    expect(providerForIssuer('accounts.google.com')).toBe(GOOGLE_PROVIDER);
    expect(providerForIssuer('__proto__')).toBeNull();
  });

  it('rejects a bad signature, an unsigned token, a swapped payload and alg none', async () => {
    const impostor = await rsaSigner(google.jwk.kid);
    expect(await verifyIdToken(await token({}, T0, impostor), T0)).toMatchObject({ ok: false, code: 'invalid_token', error: 'Invalid token signature' });
    const valid = await token();
    const [h, p, sig] = valid.split('.') as [string, string, string];
    expect(await verifyIdToken(`${h}.${p}.${b64url('nope')}`, T0)).toMatchObject({ ok: false, code: 'invalid_token' });
    // Payload swapped under a genuine signature.
    const other = (await token({ sub: 'mallory' })).split('.')[1];
    expect(await verifyIdToken(`${h}.${other}.${sig}`, T0)).toMatchObject({ ok: false, code: 'invalid_token' });
    // An unsigned token for a kid Google doesn't publish.
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }))}.${b64url(JSON.stringify(claims()))}.${b64url('signature-not-checked')}`;
    expect(await verifyIdToken(unsigned, T0)).toMatchObject({ ok: false, code: 'invalid_token' });
    const none = `${b64url(JSON.stringify({ alg: 'none', kid: google.jwk.kid }))}.${p}.${b64url('x')}`;
    expect(await verifyIdToken(none, T0)).toMatchObject({ ok: false, code: 'invalid_token', error: 'Unsupported token algorithm' });
    const noKid = `${b64url(JSON.stringify({ alg: 'RS256' }))}.${p}.${sig}`;
    expect(await verifyIdToken(noKid, T0)).toMatchObject({ ok: false, code: 'invalid_token', error: 'Unsupported token algorithm' });
  });

  it('rejects a signature with non-canonical base64url (the contract would panic on it)', async () => {
    const [h, p, sig] = (await token()).split('.') as [string, string, string];
    // A 256-byte RS256 signature is 342 chars: its last char carries 4 unused bits, which atob ignores.
    expect(sig.length % 4).toBe(2);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(sig.at(-1)!);
    for (const bits of [1, 2, 4, 8, 15]) {
      expect(await verifyIdToken(`${h}.${p}.${sig.slice(0, -1)}${alphabet[last | bits]}`, T0), String(bits)).toMatchObject({ ok: false, code: 'invalid_token' });
    }
    expect((await verifyIdToken(`${h}.${p}.${sig}`, T0)).ok).toBe(true);
  });

  it('rejects malformed tokens and claims before reading the JWKS', async () => {
    const [h, p, sig] = (await token()).split('.') as [string, string, string];
    for (const bad of ['', 'a.b', `${h}.${p}`, `${h}.${p}.${sig}.x`, `.${p}.${sig}`, `${h}..${sig}`, `${h}.${p}.`, `!!.${p}.${sig}`, `${b64url('[1]')}.${p}.${sig}`, `${h}.${b64url('"s"')}.${sig}`]) {
      expect(await verifyIdToken(bad, T0), bad).toMatchObject({ ok: false, code: 'invalid_token', error: 'Malformed token' });
    }
    for (const over of [{ iss: 1 }, { aud: [AUD] }, { aud: undefined }, { sub: 5 }, { sub: undefined }, { exp: '9999999999' }, { exp: undefined }]) {
      expect(await verifyIdToken(await token(over), T0), JSON.stringify(over)).toMatchObject({ ok: false, code: 'invalid_token', error: 'Malformed token claims' });
    }
    expect(jwks.fetches).toBe(0);
  });

  it('a nonce that is not a string is null (the caller refuses it), as before', async () => {
    expect(await verifyIdToken(await token({ nonce: 5 }), T0)).toMatchObject({ ok: true, token: { nonce: null } });
    expect(await verifyIdToken(await token({ nonce: undefined }), T0)).toMatchObject({ ok: true, token: { nonce: null } });
  });
});

describe('verifyIdToken: issuer, expiry and identity tokens', () => {
  it('rejects unknown issuers without reading the JWKS', async () => {
    for (const iss of ['https://evil.example', 'https://accounts.google.com/', 'constructor', '__proto__']) {
      expect(await verifyIdToken(await token({ iss }), T0), iss).toMatchObject({ ok: false, code: 'unsupported_issuer' });
    }
    expect(jwks.fetches).toBe(0);
  });

  it('rejects expired tokens, with the caller’s clock skew', async () => {
    const exp = s(T0) - 30;
    expect(await verifyIdToken(await token({ exp }), T0)).toMatchObject({ ok: false, code: 'token_expired' });
    expect((await verifyIdToken(await token({ exp }), T0, { skewMs: 60_000 })).ok).toBe(true);
    expect(await verifyIdToken(await token({ exp: s(T0) - 90 }), T0, { skewMs: 60_000 })).toMatchObject({ ok: false, code: 'token_expired' });
    // exp is exclusive: a token is accepted until exp + skew, not at it.
    expect(await verifyIdToken(await token({ exp: s(T0) }), T0)).toMatchObject({ ok: false, code: 'token_expired' });
  });

  it('refuses a partner identity token (typ, or iss the identity issuer) as bad_token before anything else', async () => {
    const identityIss = 'https://api.test/v1/identity';
    const typed = await google.sign(claims(), { typ: IDENTITY_TOKEN_TYP, alg: 'ES256' });
    expect(await verifyIdToken(typed, T0)).toMatchObject({ ok: false, code: 'bad_token' });
    const forged = await token({ iss: identityIss });
    expect(await verifyIdToken(forged, T0, { identityIssuer: identityIss })).toMatchObject({ ok: false, code: 'bad_token' });
    expect(await verifyIdToken(forged, T0)).toMatchObject({ ok: false, code: 'unsupported_issuer' });
    expect((await verifyIdToken(await token(), T0, { identityIssuer: identityIss })).ok).toBe(true);
    expect(IDENTITY_TOKEN_TYP).toBe('hana-identity+jwt');
  });
});

describe('verifyIdToken: new optional claims', () => {
  const ALL = { email: 'a@example.com', email_verified: true, iat: s(T0) - 10, hd: 'example.com', azp: AUD, amr: ['pwd', 'mfa'], auth_time: s(T0) - 20 };

  it('parses email, email_verified, iat, hd, azp, amr and auth_time when present', async () => {
    const r = await verifyIdToken(await token(ALL), T0);
    expect(r).toEqual({ ok: true, token: { provider: GOOGLE_PROVIDER, kid: 'google-kid', iss: ISS, aud: AUD, sub: '1234', exp: s(T0) + 3600, nonce: 'n1', ...ALL } });
    expect(await verifyIdToken(await token({ email_verified: false, amr: [] }), T0)).toMatchObject({ ok: true, token: { email_verified: false, amr: [] } });
  });

  it('leaves absent claims absent (no key, not undefined)', async () => {
    const r = await verifyIdToken(await token({ email: 'a@example.com' }), T0);
    expect(r.ok && Object.keys(r.token).sort()).toEqual(['aud', 'email', 'exp', 'iss', 'kid', 'nonce', 'provider', 'sub']);
  });

  it('refuses a token carrying one of them with the wrong type, before reading the JWKS', async () => {
    const wrong: Record<string, unknown[]> = {
      email: [1, true, null, ['a@example.com'], {}],
      email_verified: ['true', 1, null, 'false'],
      iat: ['1700000000', null, true, [1]],
      hd: [1, null, ['example.com']],
      azp: [1, null, [AUD]],
      amr: ['pwd', [1], ['pwd', null], null, {}],
      auth_time: ['1700000000', null, false],
    };
    for (const [name, values] of Object.entries(wrong)) {
      for (const v of values) {
        expect(await verifyIdToken(await token({ [name]: v }), T0), `${name}=${JSON.stringify(v)}`).toMatchObject({ ok: false, code: 'invalid_token', error: 'Malformed token claims' });
      }
    }
    // A number too large for a double parses as Infinity: refused too.
    const [h, , sig] = (await token()).split('.') as [string, string, string];
    const huge = b64url(JSON.stringify(claims()).replace(/\}$/u, ',"iat":1e400}'));
    expect(await verifyIdToken(`${h}.${huge}.${sig}`, T0)).toMatchObject({ ok: false, code: 'invalid_token', error: 'Malformed token claims' });
    expect(jwks.fetches).toBe(0);
  });

  it('returns a copy of amr, not the parsed array', async () => {
    const r1 = await verifyIdToken(await token({ amr: ['pwd'] }), T0);
    if (!r1.ok) throw new Error('expected ok');
    r1.token.amr!.push('x');
    const r2 = await verifyIdToken(await token({ amr: ['pwd'] }), T0);
    expect(r2.ok && r2.token.amr).toEqual(['pwd']);
  });
});

describe('Google JWKS cache', () => {
  it('refetches the JWKS once for an unknown kid (at most once a minute)', async () => {
    expect((await verifyIdToken(await token(), T0)).ok).toBe(true);
    expect(jwks.fetches).toBe(1);
    // Google rotates in a new key.
    const rotated = await rsaSigner('rotated-kid');
    jwks.body = { keys: [google.jwk, rotated.jwk] };
    // Just after a fetch: no refetch, the unknown kid is rejected.
    expect(await verifyIdToken(await token({}, T0, rotated), T0 + 30_000)).toMatchObject({ ok: false, code: 'invalid_token', error: 'Unknown token signing key' });
    expect(jwks.fetches).toBe(1);
    // Later: one refetch finds it.
    expect((await verifyIdToken(await token({}, T0, rotated), T0 + 61_000)).ok).toBe(true);
    expect(jwks.fetches).toBe(2);
    // A kid Google doesn't publish: one refetch at most, then rejected.
    const stranger = await rsaSigner('stranger-kid');
    expect(await verifyIdToken(await token({}, T0, stranger), T0 + 200_000)).toMatchObject({ ok: false, code: 'invalid_token' });
    expect(await verifyIdToken(await token({}, T0, stranger), T0 + 200_000)).toMatchObject({ ok: false, code: 'invalid_token' });
    expect(jwks.fetches).toBe(3);
  });

  it('caches the JWKS per its Cache-Control max-age, clamped to 5 min .. 6 h (1 h without one)', async () => {
    jwks.cacheControl = 'public, max-age=600, must-revalidate, no-transform';
    expect((await verifyIdToken(await token(), T0)).ok).toBe(true);
    expect((await verifyIdToken(await token({}, T0 + 540_000), T0 + 540_000)).ok).toBe(true);
    expect(jwks.fetches).toBe(1);
    expect((await verifyIdToken(await token({}, T0 + 660_000), T0 + 660_000)).ok).toBe(true);
    expect(jwks.fetches).toBe(2);

    const fetchesAt = async (cacheControl: string | undefined, laterMs: number): Promise<number> => {
      clearJwksCache();
      jwks.fetches = 0;
      jwks.cacheControl = cacheControl;
      await verifyIdToken(await token(), T0);
      await verifyIdToken(await token({}, T0 + laterMs), T0 + laterMs);
      return jwks.fetches;
    };
    expect(await fetchesAt('max-age=10', 299_000)).toBe(1);
    expect(await fetchesAt('max-age=10', 301_000)).toBe(2);
    expect(await fetchesAt('max-age=999999', 6 * 3_600_000 - 1_000)).toBe(1);
    expect(await fetchesAt('max-age=999999', 6 * 3_600_000 + 1_000)).toBe(2);
    expect(await fetchesAt(undefined, 3_599_000)).toBe(1);
    expect(await fetchesAt(undefined, 3_601_000)).toBe(2);
  });

  it('keeps serving cached keys while the JWKS refetch fails (bounded grace), throttling failed fetches', async () => {
    jwks.cacheControl = 'public, max-age=600';
    const onStaleKeys = vi.fn();
    const at = async (ms: number, signer: RsaSigner = google) => verifyIdToken(await token({}, T0 + ms, signer), T0 + ms, { onStaleKeys });
    expect((await at(0)).ok).toBe(true);
    expect(jwks.fetches).toBe(1);
    // The set expired and Google's endpoint fails: the cached kid still verifies (the contract has it on chain too).
    jwks.status = 500;
    expect((await at(700_000)).ok).toBe(true);
    expect(jwks.fetches).toBe(2);
    expect(onStaleKeys).toHaveBeenCalledTimes(1);
    // Forged tokens with unknown kids can't make every request fetch again: the failed attempt counts.
    const stranger = await rsaSigner('stranger-kid');
    for (let i = 0; i < 3; i++) expect(await at(700_000, stranger)).toMatchObject({ ok: false, code: 'invalid_token' });
    expect(jwks.fetches).toBe(2);
    // The stale set is retried at most every 10 s (no fetch, no stale report in between)...
    expect((await at(705_000)).ok).toBe(true);
    expect(jwks.fetches).toBe(2);
    expect(onStaleKeys).toHaveBeenCalledTimes(1);
    expect((await at(711_000)).ok).toBe(true);
    expect(jwks.fetches).toBe(3);
    expect(onStaleKeys).toHaveBeenCalledTimes(2);
    // ...and used for at most 6 h past its max-age: then fail closed.
    await expect(at(600_000 + 6 * 3_600_000 + 1_000)).rejects.toBeInstanceOf(JwksUnavailableError);
    // Once Google answers again, verification resumes.
    jwks.status = 200;
    expect((await at(600_000 + 6 * 3_600_000 + 12_000)).ok).toBe(true);
  });

  it('a cold isolate whose JWKS fetch fails retries at most every 10 s', async () => {
    jwks.status = 500;
    await expect(verifyIdToken(await token(), T0)).rejects.toBeInstanceOf(JwksUnavailableError);
    await expect(verifyIdToken(await token(), T0 + 5_000)).rejects.toThrow('JWKS fetch failed recently');
    expect(jwks.fetches).toBe(1);
    jwks.status = 200;
    expect((await verifyIdToken(await token(), T0 + 11_000)).ok).toBe(true);
    expect(jwks.fetches).toBe(2);
  });

  it('fails closed (JwksUnavailableError) on an HTTP error, a network error, a non-JSON body or no usable key', async () => {
    const cases: [string, (j: FakeJwks) => void][] = [
      ['http', (j) => (j.status = 503)],
      ['network', (j) => (j.networkError = true)],
      ['no keys', (j) => (j.body = { keys: [] })],
      ['no RS256 key', (j) => (j.body = { keys: [{ ...google.jwk, alg: 'PS256' }] })],
      ['not a JWKS', (j) => (j.body = 'nope')],
    ];
    for (const [name, breakIt] of cases) {
      clearJwksCache();
      jwks = new FakeJwks([google.jwk]);
      breakIt(jwks);
      stubGoogle(jwks);
      await expect(verifyIdToken(await token(), T0), name).rejects.toBeInstanceOf(JwksUnavailableError);
    }
  });

  it('an unknown kid whose refetch fails throws (fail closed), it does not answer invalid_token', async () => {
    expect((await verifyIdToken(await token(), T0)).ok).toBe(true);
    jwks.status = 500;
    const rotated = await rsaSigner('rotated-kid');
    await expect(verifyIdToken(await token({}, T0, rotated), T0 + 61_000)).rejects.toBeInstanceOf(JwksUnavailableError);
    // The known kid still verifies from the fresh set.
    expect((await verifyIdToken(await token(), T0 + 62_000)).ok).toBe(true);
  });

  it('tells the observer about each fetch and each valid signature, never about a failed one', async () => {
    jwks.cacheControl = 'public, max-age=1234';
    const observer: KeyObserver = { jwks: vi.fn(), token: vi.fn() };
    expect((await verifyIdToken(await token(), T0, { observer })).ok).toBe(true);
    expect(observer.jwks).toHaveBeenCalledWith(GOOGLE_PROVIDER, ['google-kid'], 1234, T0);
    expect(observer.token).toHaveBeenCalledWith(GOOGLE_PROVIDER, 'google-kid', T0);
    const impostor = await rsaSigner(google.jwk.kid);
    expect((await verifyIdToken(await token({}, T0, impostor), T0 + 1, { observer })).ok).toBe(false);
    expect(observer.token).toHaveBeenCalledTimes(1);
    expect(observer.jwks).toHaveBeenCalledTimes(1);
  });
});

describe('publishedKeys', () => {
  it('serves the cached set, refetches it once expired, keeps it stale within the grace, and null after', async () => {
    jwks.cacheControl = 'max-age=600';
    expect(await publishedKeys(GOOGLE_PROVIDER, T0)).toEqual([google.jwk]);
    expect(await publishedKeys(GOOGLE_PROVIDER, T0 + 1_000)).toEqual([google.jwk]);
    expect(jwks.fetches).toBe(1);
    // Shares the token check's cache.
    expect((await verifyIdToken(await token(), T0 + 2_000)).ok).toBe(true);
    expect(jwks.fetches).toBe(1);
    jwks.status = 500;
    expect(await publishedKeys(GOOGLE_PROVIDER, T0 + 700_000)).toEqual([google.jwk]);
    expect(await publishedKeys(GOOGLE_PROVIDER, T0 + 600_000 + 6 * 3_600_000 + 1_000)).toBeNull();
    expect(await publishedKeys('nobody', T0)).toBeNull();
    expect(await publishedKeys('__proto__', T0)).toBeNull();
  });
});

describe('helpers', () => {
  it('cacheMaxAgeS reads the max-age directive, capped for an INTEGER column', () => {
    expect(cacheMaxAgeS('public, max-age=19774, must-revalidate')).toBe(19774);
    expect(cacheMaxAgeS('MAX-AGE=5')).toBe(5);
    expect(cacheMaxAgeS('s-maxage=5')).toBeNull();
    expect(cacheMaxAgeS('x-max-age=5')).toBeNull();
    expect(cacheMaxAgeS(null)).toBeNull();
    expect(cacheMaxAgeS(`max-age=${'9'.repeat(30)}`)).toBe(2 ** 31 - 1);
  });

  it('base64UrlDecode round-trips and rejects non-canonical encodings atob would accept', () => {
    for (let n = 0; n < 40; n++) {
      const b = new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37 + n) % 256));
      expect([...base64UrlDecode(b64url(b))]).toEqual([...b]);
    }
    expect([...base64UrlDecode('QQ')]).toEqual([65]);
    expect([...base64UrlDecode('QUI')]).toEqual([65, 66]);
    for (const bad of ['QR', 'QX', 'QUJ', 'QUL', 'Q', 'QUJDR', 'QQ==', 'Q+Q', 'Q/Q']) expect(() => base64UrlDecode(bad), bad).toThrow();
  });
});
