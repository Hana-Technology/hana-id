// The identity JWKS rules shared by the watchdog and the outside probe (D210, D213, D214): RFC 7638 P-256
// thumbprints, judging by material, public members only, private members, every object entry judged, duplicate
// members, the discovery fields, and what makes an answer unreadable.
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  duplicateMembers,
  IDENTITY_BODY_LIMIT,
  judgeDiscovery,
  judgeIdentityJwks,
  p256Thumbprint,
  parseIdentityDocument,
  readIdentityResponse,
} from '../src/identity.ts';

const ISS = 'https://api.test/v1/identity';

async function key() {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const j = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const kid = (await p256Thumbprint({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y }))!;
  return { kty: 'EC', crv: 'P-256', x: j.x, y: j.y, kid, use: 'sig', alg: 'ES256' };
}

describe('p256Thumbprint', () => {
  it('is the RFC 7638 form @hana-id/env and @hana-id/core compute, and refuses anything else', async () => {
    const k = { kty: 'EC', crv: 'P-256', x: 'K-9yfj4EQcl4NpjqbvU8Jd6o1qP6QXvq1H9vOcU4daI', y: '3ycRO9-5NiONOnFznQC004TVM9-Q_LTTxFJUJ-ayJac' };
    expect(await p256Thumbprint(k)).toBe('17xAVaTfgwnOkdwq1uOmwHR31pPKB90xw5oGN5HcBgY'); // sandbox-dev's active key
    expect(await p256Thumbprint({ ...k, kid: 'ignored', use: 'sig', alg: 'ES256' })).toBe('17xAVaTfgwnOkdwq1uOmwHR31pPKB90xw5oGN5HcBgY');
    const rsa = { kty: 'RSA', n: 'qrs', e: 'AQAB' };
    for (const bad of [{ ...k, crv: 'P-384' }, { ...k, kty: 'RSA' }, { ...k, x: `${k.x}A` }, { ...k, x: k.x.replace(/I$/u, 'J') }, { ...k, y: 7 }, null, 'k', rsa]) expect(await p256Thumbprint(bad)).toBeNull();
  });
});

describe('judgeIdentityJwks', () => {
  it('judges each entry by its material, never by its kid', async () => {
    const [a, b, evil] = [await key(), await key(), await key()];
    const v = await judgeIdentityJwks({ keys: [a, { ...evil, kid: b.kid }, { ...a, kid: 'renamed' }] }, { pins: [a.kid, b.kid], problems: [] });
    expect(v.unpinned.map((k) => [k.index, k.kid, k.thumbprint, k.reason])).toEqual([[1, b.kid, evil.kid, 'not_pinned']]);
    expect(v.missing).toEqual([{ thumbprint: b.kid, reason: 'not_published' }]);
    const renamed = await judgeIdentityJwks({ keys: [{ ...a, kid: 'renamed' }] }, { pins: [a.kid], problems: [] });
    expect(renamed.missing).toEqual([{ thumbprint: a.kid, reason: 'kid_differs' }]);
    expect(renamed.unpinned).toEqual([]);
  });

  it('accepts public members only: any other member makes a pinned key unpinned (and its pin not clean); private ones are listed', async () => {
    const a = await key();
    const v = await judgeIdentityJwks({ keys: [{ ...a, d: 'x', x5u: 'https://evil.example' }] }, { pins: [a.kid], problems: [] });
    expect(v.unpinned.map((k) => [k.reason, k.extra, k.private])).toEqual([['extra_members', ['d', 'x5u'], ['d']]]);
    expect(v.privateKeys).toHaveLength(1);
    expect(v.missing).toEqual([{ thumbprint: a.kid, reason: 'not_clean' }]);
    expect(v.unpinned[0]!.ref).toMatch(/^entry:/u);
  });

  it('judges every object entry even when others are malformed; a body without a keys array judges nothing', async () => {
    const [a, evil] = [await key(), await key()];
    const v = await judgeIdentityJwks({ keys: [1, a, 'x', [evil], evil, null] }, { pins: [a.kid], problems: [] });
    expect(v.shapeOk).toBe(true);
    expect(v.shapeProblems).toEqual(['keys[0] is not an object', 'keys[2] is not an object', 'keys[3] is not an object', 'keys[5] is not an object']);
    expect(v.unpinned.map((k) => [k.index, k.kid])).toEqual([[4, evil.kid]]);
    for (const [body, problem] of [
      [null, 'the JWKS is not a JSON object'],
      [[], 'the JWKS is not a JSON object'],
      [{ keys: 'x' }, '`keys` is not an array'],
      [{}, '`keys` is not an array'],
    ] as const) {
      const r = await judgeIdentityJwks(body, { pins: [a.kid], problems: [] });
      expect(r.shapeOk).toBe(false);
      expect(r.shapeProblems).toEqual([problem]);
      expect(r.missing).toEqual([]);
    }
  });

  it('nothing pinned, or unreadable pins: every key is unpinned, with the reason', async () => {
    const a = await key();
    expect((await judgeIdentityJwks({ keys: [a] }, { pins: null, problems: [] })).unpinned[0]?.reason).toBe('not_pinned');
    expect((await judgeIdentityJwks({ keys: [a] }, { pins: null, problems: ['bad'] })).unpinned[0]?.reason).toBe('pins_unreadable');
  });
});

describe('duplicate members', () => {
  it('finds a member twice in any object, with its path, escapes decoded; none in a clean document', () => {
    expect(duplicateMembers('{"keys":[{"kty":"EC","x":"a"},{"x":"a","y":"b","x":"c"}]}')).toEqual(['keys[1].x']);
    expect(duplicateMembers('{"keys":[{"d":"a","\\u0064":"b"}],"keys":[]}')).toEqual(['keys[0].d', 'keys']);
    expect(duplicateMembers('{"a":{"b":{"c":1,"c":2}},"s":"\\"x\\":1,\\"x\\":2"}')).toEqual(['a.b.c']);
    expect(duplicateMembers(JSON.stringify({ keys: [{ x: 1 }, { x: 1 }], issuer: 'a' }))).toEqual([]);
    expect(parseIdentityDocument('{"a":1,"a":2}')).toEqual({ value: { a: 2 }, duplicates: ['a'] });
    expect(parseIdentityDocument('{"a":')).toBeNull();
  });
});

describe('readIdentityResponse', () => {
  it('a redirect, a body over the cap, not JSON and duplicate members are findings; a clean body parses', () => {
    expect(readIdentityResponse({ kind: 'redirect', status: 302, location: 'https://evil.example' }).findings).toEqual([{ reason: 'redirect', detail: 'HTTP 302 to https://evil.example' }]);
    expect(readIdentityResponse({ kind: 'too_large' }).findings).toEqual([{ reason: 'too_large', detail: `body over ${IDENTITY_BODY_LIMIT} bytes` }]);
    expect(readIdentityResponse({ kind: 'body', text: 'nope' })).toMatchObject({ parsed: false, findings: [{ reason: 'not_json' }] });
    expect(readIdentityResponse({ kind: 'body', text: '{"keys":[],"keys":[]}' })).toMatchObject({ parsed: true, findings: [{ reason: 'duplicate_members', detail: 'duplicate members: keys' }] });
    expect(readIdentityResponse({ kind: 'body', text: '{"keys":[]}' })).toEqual({ value: { keys: [] }, parsed: true, findings: [] });
  });
});

describe('judgeDiscovery', () => {
  it('needs the configured issuer and its JWKS URL exactly', () => {
    expect(judgeDiscovery({ issuer: ISS, jwks_uri: `${ISS}/jwks.json` }, ISS).problems).toEqual([]);
    expect(judgeDiscovery({ issuer: `${ISS}/`, jwks_uri: 'https://evil.example/jwks.json' }, ISS).problems.map((p) => p.field)).toEqual(['issuer', 'jwks_uri']);
    expect(judgeDiscovery({}, ISS).problems.map((p) => p.published)).toEqual([null, null]);
    expect(judgeDiscovery({ issuer: 7, jwks_uri: [] }, ISS).problems.map((p) => p.published)).toEqual([null, null]);
    expect(judgeDiscovery([], ISS).shapeOk).toBe(false);
  });
});
