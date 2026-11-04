import { describe, expect, it } from 'vitest';
import { keyComponentBytes, rsaThumbprint, sameRsaKey, usableJwks } from '../src/index.ts';

const key = (over: Record<string, unknown> = {}) => ({ kid: 'k1', kty: 'RSA', alg: 'RS256', use: 'sig', n: 'qrs', e: 'AQAB', ...over });

describe('usableJwks', () => {
  it('keeps RS256 RSA signing keys only', () => {
    const body = {
      keys: [
        key(),
        key({ kid: 'no-alg', alg: undefined, use: undefined }),
        key({ kid: 'ec', kty: 'EC' }),
        key({ kid: 'ps', alg: 'PS256' }),
        key({ kid: 'enc', use: 'enc' }),
        key({ kid: '' }),
        key({ kid: 'x'.repeat(129) }),
        key({ kid: 'bad-n', n: 'a+b/' }),
        key({ kid: 'no-e', e: undefined }),
        null,
        'str',
      ],
    };
    expect(usableJwks(body).map((k) => k.kid)).toEqual(['k1', 'no-alg']);
  });

  it('returns [] for a body without a keys array', () => {
    expect(usableJwks(null)).toEqual([]);
    expect(usableJwks({})).toEqual([]);
    expect(usableJwks({ keys: 'x' })).toEqual([]);
  });
});

describe('keyComponentBytes / sameRsaKey', () => {
  it('decodes base64url and plain base64 and strips leading zeros', () => {
    expect([...(keyComponentBytes('AQAB') ?? [])]).toEqual([1, 0, 1]);
    // 0x00 0x01 0x00 0x01 → leading zero stripped
    expect([...(keyComponentBytes('AAEAAQ') ?? [])]).toEqual([1, 0, 1]);
    expect([...(keyComponentBytes('AAEAAQ==') ?? [])]).toEqual([1, 0, 1]);
    expect([...(keyComponentBytes('-_8') ?? [])]).toEqual([0xfb, 0xff]);
    expect([...(keyComponentBytes('+/8') ?? [])]).toEqual([0xfb, 0xff]);
  });

  it('rejects text that is not base64', () => {
    expect(keyComponentBytes('a*b')).toBeNull();
    expect(keyComponentBytes('abcde')).toBeNull();
  });

  it('compares modulus and exponent as numbers', () => {
    expect(sameRsaKey({ n: 'AAEAAQ', e: 'AQAB' }, { n: 'AQAB', e: 'AAEAAQ' })).toBe(true);
    expect(sameRsaKey({ n: 'AQAB', e: 'AQAB' }, { n: 'AQAC', e: 'AQAB' })).toBe(false);
    expect(sameRsaKey({ n: 'AQAB', e: 'AQAB' }, { n: 'AQAB', e: 'Aw' })).toBe(false);
    expect(sameRsaKey({ n: 'a*', e: 'AQAB' }, { n: 'a*', e: 'AQAB' })).toBe(false);
  });
});

describe('rsaThumbprint (RFC 7638)', () => {
  // RFC 7638 section 3.1.
  const n =
    '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw';
  const RFC_THUMBPRINT = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs';

  it('matches the RFC example', async () => {
    expect(await rsaThumbprint({ n, e: 'AQAB' })).toBe(RFC_THUMBPRINT);
  });

  it('canonicalizes: a leading zero byte, plain base64 and padding give the same thumbprint', async () => {
    const padded = Buffer.concat([Buffer.from([0]), Buffer.from(n, 'base64url')]).toString('base64');
    expect(await rsaThumbprint({ n: padded, e: 'AAEAAQ==' })).toBe(RFC_THUMBPRINT);
  });

  it('is null for undecodable or empty components, and differs for another exponent', async () => {
    expect(await rsaThumbprint({ n: 'a*', e: 'AQAB' })).toBeNull();
    expect(await rsaThumbprint({ n: '', e: 'AQAB' })).toBeNull();
    expect(await rsaThumbprint({ n: 'AA', e: 'AQAB' })).toBeNull();
    expect(await rsaThumbprint({ n, e: 'Aw' })).not.toBe(RFC_THUMBPRINT);
  });
});
