import { describe, expect, it } from 'vitest';
import { keyComponentBytes, sameRsaKey, usableJwks } from '../src/index.ts';

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
