// AccessJwtVerifier: the Cloudflare Access application token the admin Worker checks on every /api/* request
// (docs/batch-c-spec.md "Hana admin console"; the "Admin and email" refusals: missing, wrong aud or iss, expired,
// unknown kid, empty sub). The certs endpoint is a stub passed in; nothing touches the network.
import { beforeEach, describe, expect, it } from 'vitest';
import { ACCESS_CERTS_MAX_TTL_MS, ACCESS_JWT_HEADER, AccessJwtVerifier, JwksUnavailableError, MAX_ACCESS_JWT_BYTES, MAX_BODY_BYTES, accessCertsUrl } from '../src/index.ts';
import { FakeJwks, type RsaSigner, b64url, rsaSigner } from './helpers.ts';

const TEAM = 'hana.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const T0 = 1_800_000_000_000;
const s = (ms: number): number => Math.floor(ms / 1000);

let access: RsaSigner;
let certs: FakeJwks;
let urls: string[];
let verifier: AccessJwtVerifier;

beforeEach(async () => {
  access ??= await rsaSigner('access-kid');
  certs = new FakeJwks([access.jwk]);
  urls = [];
  verifier = new AccessJwtVerifier({
    teamDomain: TEAM,
    aud: AUD,
    fetch: (url, init) => {
      urls.push(url);
      return certs.fetch(url, init);
    },
  });
});

/** Claims shaped like a real Access application token. */
const claims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  aud: [AUD],
  email: 'Staff@Example.com',
  exp: s(T0) + 3600,
  iat: s(T0),
  nbf: s(T0),
  iss: `https://${TEAM}`,
  type: 'app',
  identity_nonce: 'nonce',
  sub: '7335d417-61da-459d-899c-0a01c76a2b94',
  country: 'MY',
  ...over,
});
const token = (over: Record<string, unknown> = {}, signer: RsaSigner = access): Promise<string> => signer.sign(claims(over));

describe('AccessJwtVerifier', () => {
  it('accepts a genuine application token: sub, email as sent, kid, exp, iat', async () => {
    expect(await verifier.verify(await token(), T0)).toEqual({
      ok: true,
      identity: { sub: '7335d417-61da-459d-899c-0a01c76a2b94', email: 'Staff@Example.com', kid: 'access-kid', exp: s(T0) + 3600, iat: s(T0) },
    });
    expect(urls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
    expect(accessCertsUrl(TEAM)).toBe(urls[0]);
    expect(ACCESS_JWT_HEADER).toBe('cf-access-jwt-assertion');
    // A single-string aud is the same audience (RFC 7519); iat is optional.
    expect((await verifier.verify(await token({ aud: AUD, iat: undefined }), T0)).ok).toBe(true);
  });

  it('refuses a missing token', async () => {
    for (const missing of [null, undefined, '']) expect(await verifier.verify(missing, T0)).toEqual({ ok: false, code: 'missing' });
  });

  it('refuses a wrong aud', async () => {
    for (const aud of ['b'.repeat(64), [], ['b'.repeat(64)], [AUD.toUpperCase()], undefined, null, 1, { [AUD]: true }]) {
      expect(await verifier.verify(await token({ aud }), T0), JSON.stringify(aud)).toEqual({ ok: false, code: 'wrong_audience' });
    }
  });

  it('refuses a wrong iss', async () => {
    for (const iss of ['https://other.cloudflareaccess.com', `http://${TEAM}`, `https://${TEAM}/`, TEAM, `https://${TEAM.toUpperCase()}`, undefined, 1]) {
      expect(await verifier.verify(await token({ iss }), T0), String(iss)).toEqual({ ok: false, code: 'wrong_issuer' });
    }
  });

  it('refuses an expired token (60 s skew by default, configurable), and one not yet valid', async () => {
    expect((await verifier.verify(await token({ exp: s(T0) - 30 }), T0)).ok).toBe(true);
    expect(await verifier.verify(await token({ exp: s(T0) - 60 }), T0)).toEqual({ ok: false, code: 'expired' });
    expect(await verifier.verify(await token({ exp: s(T0) - 3600 }), T0)).toEqual({ ok: false, code: 'expired' });
    const strict = new AccessJwtVerifier({ teamDomain: TEAM, aud: AUD, fetch: certs.fetch, skewMs: 0 });
    expect(await strict.verify(await token({ exp: s(T0) }), T0)).toEqual({ ok: false, code: 'expired' });
    expect(await verifier.verify(await token({ nbf: s(T0) + 30 }), T0)).toMatchObject({ ok: true });
    expect(await verifier.verify(await token({ nbf: s(T0) + 120 }), T0)).toEqual({ ok: false, code: 'not_yet_valid' });
    for (const bad of [{ exp: undefined }, { exp: '9999999999' }, { nbf: 'now' }, { iat: '1' }]) {
      expect(await verifier.verify(await token(bad), T0), JSON.stringify(bad)).toEqual({ ok: false, code: 'malformed' });
    }
  });

  it('refuses an unknown kid after one refetch of the certs, at most once a minute', async () => {
    expect((await verifier.verify(await token(), T0)).ok).toBe(true);
    const stranger = await rsaSigner('stranger-kid');
    expect(await verifier.verify(await token({}, stranger), T0 + 61_000)).toEqual({ ok: false, code: 'unknown_key' });
    expect(await verifier.verify(await token({}, stranger), T0 + 62_000)).toEqual({ ok: false, code: 'unknown_key' });
    expect(certs.fetches).toBe(2);
    // Cloudflare rotates in a new key: found by the next refetch.
    const rotated = await rsaSigner('rotated-kid');
    certs.body = { keys: [access.jwk, rotated.jwk] };
    expect((await verifier.verify(await token({}, rotated), T0 + 130_000)).ok).toBe(true);
    expect(certs.fetches).toBe(3);
  });

  it('refuses an empty or missing sub (service tokens), and an empty or missing email', async () => {
    for (const sub of ['', undefined, 1, null]) expect(await verifier.verify(await token({ sub }), T0), String(sub)).toEqual({ ok: false, code: 'no_subject' });
    // A service token: empty sub, a common_name, no email.
    expect(await verifier.verify(await token({ sub: '', email: undefined, common_name: 'x.access' }), T0)).toEqual({ ok: false, code: 'no_subject' });
    for (const email of ['', undefined, null, ['a@example.com'], 1]) expect(await verifier.verify(await token({ email }), T0), String(email)).toEqual({ ok: false, code: 'no_email' });
  });

  it('refuses a token that is not an application token', async () => {
    for (const type of ['org', 'APP', '', undefined]) expect(await verifier.verify(await token({ type }), T0), String(type)).toEqual({ ok: false, code: 'wrong_type' });
  });

  it('refuses a bad signature, a swapped payload, a non-canonical signature and alg none', async () => {
    const impostor = await rsaSigner('access-kid');
    expect(await verifier.verify(await token({}, impostor), T0)).toEqual({ ok: false, code: 'bad_signature' });
    const [h, p, sig] = (await token()).split('.') as [string, string, string];
    const other = (await token({ email: 'mallory@example.com' })).split('.')[1];
    expect(await verifier.verify(`${h}.${other}.${sig}`, T0)).toEqual({ ok: false, code: 'bad_signature' });
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    expect(await verifier.verify(`${h}.${p}.${sig.slice(0, -1)}${alphabet[alphabet.indexOf(sig.at(-1)!) | 1]}`, T0)).toEqual({ ok: false, code: 'bad_signature' });
    const none = `${b64url(JSON.stringify({ alg: 'none', kid: 'access-kid' }))}.${p}.${b64url('x')}`;
    expect(await verifier.verify(none, T0)).toEqual({ ok: false, code: 'malformed' });
    expect((await verifier.verify(`${h}.${p}.${sig}`, T0)).ok).toBe(true);
  });

  it('refuses malformed tokens, invalid UTF-8 and oversized ones without reading the certs', async () => {
    const [h, p, sig] = (await token()).split('.') as [string, string, string];
    const badUtf8 = b64url(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
    const noKid = b64url(JSON.stringify({ alg: 'RS256' }));
    const emptyKid = b64url(JSON.stringify({ alg: 'RS256', kid: '' }));
    for (const bad of ['x', 'a.b', `${h}.${p}`, `${h}.${p}.${sig}.x`, `${h}..${sig}`, `${badUtf8}.${p}.${sig}`, `${h}.${badUtf8}.${sig}`, `${noKid}.${p}.${sig}`, `${emptyKid}.${p}.${sig}`, `${h}.${p}.${sig}`.padEnd(MAX_ACCESS_JWT_BYTES + 1, 'A')]) {
      expect(await verifier.verify(bad, T0), bad.slice(0, 40)).toEqual({ ok: false, code: 'malformed' });
    }
    expect(certs.fetches).toBe(0);
  });

  it('checks every claim before reading the certs: a misdirected token costs no fetch', async () => {
    for (const over of [{ aud: ['x'] }, { iss: 'https://x' }, { exp: s(T0) - 3600 }, { sub: '' }, { email: '' }, { type: 'org' }]) await verifier.verify(await token(over), T0);
    expect(certs.fetches).toBe(0);
  });

  it('fails closed when the certs cannot be fetched, and never serves an expired set', async () => {
    certs.status = 500;
    await expect(verifier.verify(await token(), T0)).rejects.toBeInstanceOf(JwksUnavailableError);
    certs.status = 200;
    certs.cacheControl = 'max-age=600';
    expect((await verifier.verify(await token(), T0 + 11_000)).ok).toBe(true);
    // Expired and the refetch fails: no stale grace for Access.
    certs.networkError = true;
    await expect(verifier.verify(await token(), T0 + 11_000 + 601_000)).rejects.toBeInstanceOf(JwksUnavailableError);
  });

  it('caches the certs for their max-age but at most 10 min, with no floor (max-age=0 and no-cache refetch)', async () => {
    const fetchesAfter = async (cacheControl: string | undefined, laterMs: number): Promise<number> => {
      certs = new FakeJwks([access.jwk]);
      certs.cacheControl = cacheControl;
      const v = new AccessJwtVerifier({ teamDomain: TEAM, aud: AUD, fetch: certs.fetch });
      expect((await v.verify(await token(), T0)).ok).toBe(true);
      expect((await v.verify(await token(), T0 + laterMs)).ok).toBe(true);
      return certs.fetches;
    };
    expect(ACCESS_CERTS_MAX_TTL_MS).toBe(600_000);
    expect(await fetchesAfter('max-age=86400', 599_000)).toBe(1);
    expect(await fetchesAfter('max-age=86400', 601_000)).toBe(2);
    expect(await fetchesAfter(undefined, 601_000)).toBe(2);
    expect(await fetchesAfter('max-age=30', 31_000)).toBe(2);
    expect(await fetchesAfter('max-age=0', 1)).toBe(2);
    expect(await fetchesAfter('no-cache', 1)).toBe(2);
    // Each fetch has the 8 s timeout's signal.
    expect(certs.inits.every((i) => i?.signal instanceof AbortSignal)).toBe(true);
  });

  it('refuses a certs body over 64 KiB (fail closed)', async () => {
    certs.body = JSON.stringify({ keys: [access.jwk], pad: 'x'.repeat(MAX_BODY_BYTES) });
    await expect(verifier.verify(await token(), T0)).rejects.toBeInstanceOf(JwksUnavailableError);
  });

  it('refuses a bad configuration at construction', () => {
    for (const teamDomain of ['', 'Hana.cloudflareaccess.com', 'hana.cloudflareaccess.com/x', 'https://hana.cloudflareaccess.com', 'hana', 'a b.com', 'evil.com#']) {
      expect(() => new AccessJwtVerifier({ teamDomain, aud: AUD, fetch: certs.fetch }), teamDomain).toThrow();
    }
    expect(() => new AccessJwtVerifier({ teamDomain: TEAM, aud: '', fetch: certs.fetch })).toThrow();
  });
});
