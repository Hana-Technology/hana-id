// D927 (docs/partner-platform-spec.md A3 "The request"): the platform API's signed message, against the vectors of the
// independent generator (scripts/gen-platform-request-vectors.mjs: node:crypto and its own ECDSA in BigInt); the
// reference signer; the DER conversion and both S values; the header and path rules.
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs script without types (the independent implementation)
import { buildVectors } from '../scripts/gen-platform-request-vectors.mjs';
import {
  PLATFORM_CONTENT_TYPE_RE,
  PLATFORM_HEADER_RES,
  PLATFORM_PATH_RE,
  PLATFORM_QUERY_RE,
  b64url,
  bodySha256Hex,
  derToRawSignature,
  fromHex,
  isHighS,
  jwkThumbprint,
  otherSValue,
  platformRequestMessage,
  platformRevokeBody,
  signPlatformRequest,
  signatureBytes,
  utf8,
} from '../src/index.ts';
import vectors from './platform-request-vectors.json' with { type: 'json' };

const publicKey = () => crypto.subtle.importKey('jwk', vectors.key.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
const buf = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;
const verifies = async (message: string, raw: Uint8Array) => crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await publicKey(), buf(raw), buf(utf8(message)));

describe('the vectors', () => {
  it('are current with the generator', () => {
    expect(JSON.parse(JSON.stringify(buildVectors()))).toEqual(vectors);
  });

  it('the key: its thumbprint (RFC 7638)', async () => {
    expect(await jwkThumbprint(vectors.key.jwk.x, vectors.key.jwk.y)).toBe(vectors.key.thumbprint);
  });

  for (const c of vectors.cases) {
    it(`${c.name}: the message, the body hash and the signature (${c.expect})`, async () => {
      const h = c.headers as Record<string, string>;
      expect(await bodySha256Hex(utf8(c.body))).toBe(c.bodySha256);
      // Built for the env it was signed for, the message is the generator's byte for byte.
      const forItsEnv = platformRequestMessage({
        ...c.signedFor,
        method: c.method,
        path: c.path,
        keyId: h['Journear-Key-Id']!,
        timestamp: h['Journear-Timestamp']!,
        nonce: h['Journear-Nonce']!,
        idempotencyKey: h['Idempotency-Key'],
        bodySha256Hex: c.bodySha256,
      });
      expect(forItsEnv).toBe(c.message);
      const raw = fromHex(c.signatureRawHex);
      expect(await verifies(c.message, raw)).toBe(true);
      expect(isHighS(raw)).toBe(c.highS);
      expect(derToRawSignature(fromHex(c.signatureDerHex))).toEqual(raw);
      // As this env (the vectors' own) would build it: only the cases signed for it verify.
      const here = platformRequestMessage({ ...vectors.env, method: c.method, path: c.path, keyId: h['Journear-Key-Id']!, timestamp: h['Journear-Timestamp']!, nonce: h['Journear-Nonce']!, idempotencyKey: h['Idempotency-Key'], bodySha256Hex: c.bodySha256 });
      const header = signatureBytes(h['Journear-Signature']!);
      const accepted = header !== null && (await verifies(here, header));
      expect(accepted).toBe(c.expect === 'verifies');
    });
  }

  it('the high-S case verifies, and so does its low-S twin; the DER one fails the header rule', async () => {
    const high = vectors.cases.find((c) => c.name === 'high_s')!;
    const raw = fromHex(high.signatureRawHex);
    expect(isHighS(raw)).toBe(true);
    expect(await verifies(high.message, otherSValue(raw))).toBe(true);
    const derCase = vectors.cases.find((c) => c.name === 'der')!;
    expect(PLATFORM_HEADER_RES.signature.test(derCase.headers['Journear-Signature'])).toBe(false);
    expect(signatureBytes(derCase.headers['Journear-Signature'])).toBeNull();
  });
});

describe('the reference signer', () => {
  it('signs a message the API rebuilds, with fresh nonces', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    const a = await signPlatformRequest(kp.privateKey, { envName: 'e', signerAccount: 's', keyId: vectors.key.keyId, method: 'POST', path: '/v1/platform/credential/revoke', body: '{}', idempotencyKey: 'abcdefgh' });
    const b = await signPlatformRequest(kp.privateKey, { envName: 'e', signerAccount: 's', keyId: vectors.key.keyId, method: 'GET', path: '/v1/platform/credential' });
    expect(a.headers['Journear-Nonce']).not.toBe(b.headers['Journear-Nonce']);
    for (const s of [a, b]) {
      for (const [k, re] of [['Journear-Key-Id', PLATFORM_HEADER_RES.keyId], ['Journear-Timestamp', PLATFORM_HEADER_RES.timestamp], ['Journear-Nonce', PLATFORM_HEADER_RES.nonce], ['Journear-Signature', PLATFORM_HEADER_RES.signature]] as const) {
        expect(re.test(s.headers[k]!), k).toBe(true);
      }
      expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, buf(signatureBytes(s.headers['Journear-Signature']!)!), buf(utf8(s.message)))).toBe(true);
    }
    expect(a.message.split('\n')).toHaveLength(10);
    expect(a.message.endsWith('\n')).toBe(false);
    expect(a.headers['content-type']).toBe('application/json');
    await expect(signPlatformRequest(kp.privateKey, { envName: 'e', signerAccount: 's', keyId: vectors.key.keyId, method: 'GET', path: '/v1/platform/credential', body: 'x' })).rejects.toThrow();
  });

  it('refuses a part that would make the message ambiguous', () => {
    const base = { envName: 'e', signerAccount: 's', method: 'GET', path: '/v1/platform/x', keyId: 'k', timestamp: '1', nonce: 'n', bodySha256Hex: 'a'.repeat(64) };
    expect(() => platformRequestMessage({ ...base, path: '/v1/platform/x\nGET' })).toThrow();
    expect(() => platformRequestMessage({ ...base, envName: '' })).toThrow();
    expect(() => platformRequestMessage({ ...base, bodySha256Hex: 'A'.repeat(64) })).toThrow();
  });
});

describe('the DER conversion', () => {
  it('drops a leading zero, pads short integers, and refuses anything else', () => {
    const r = new Uint8Array(32).fill(0x81);
    const s = new Uint8Array(32);
    s[31] = 5;
    const der = Uint8Array.from([0x30, 0x26, 0x02, 0x21, 0x00, ...r, 0x02, 0x01, 0x05]);
    expect(derToRawSignature(der)).toEqual(Uint8Array.from([...r, ...s]));
    for (const bad of [
      Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01]), // short
      Uint8Array.from([0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]), // not a SEQUENCE
      Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x81, 0x02, 0x01, 0x01]), // negative
      Uint8Array.from([0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01]), // a needless leading zero
      Uint8Array.from([0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x00]), // trailing bytes
    ]) {
      expect(() => derToRawSignature(bad)).toThrow();
    }
  });
});

describe('the rules', () => {
  it('the path: only /v1/platform and plain segments', () => {
    for (const ok of ['/v1/platform/credential', '/v1/platform/credential/revoke', '/v1/platform/apps/app_1/keys/key_2/revoke']) expect(PLATFORM_PATH_RE.test(ok), ok).toBe(true);
    for (const bad of ['/v1/platform', '/v1/platform/', '/v1/platform//credential', '/v1/platform/./credential', '/v1/platform/../x', '/v1/platform/a%2Fb', '/v1/platform/credential/', '/v1/platform/%2E', '/v1/platformx/a', '/v1/platform/a.b', '/V1/platform/a']) {
      expect(PLATFORM_PATH_RE.test(bad), bad).toBe(false);
    }
  });

  it('the query: one to four plain pairs', () => {
    for (const ok of ['?scopeId=s1', '?scopeId=s1&cursor=app_x', '?a=1&b=2&c=3&d=4']) expect(PLATFORM_QUERY_RE.test(ok), ok).toBe(true);
    for (const bad of ['?', '?a', '?a=', '?A=1', '?a=1&', '?a=1&&b=2', '?a=1&b=2&c=3&d=4&e=5', '?a=%20', '?a=1;b=2', '?a=x.y']) expect(PLATFORM_QUERY_RE.test(bad), bad).toBe(false);
  });

  it('the headers: each in full', () => {
    expect(PLATFORM_HEADER_RES.timestamp.test('1800000000000')).toBe(true);
    for (const bad of ['180000000000', '18000000000000', '0800000000000', ' 1800000000000', '1800000000000.0']) expect(PLATFORM_HEADER_RES.timestamp.test(bad), bad).toBe(false);
    const nonce = b64url(new Uint8Array(16).fill(255));
    expect(PLATFORM_HEADER_RES.nonce.test(nonce)).toBe(true);
    // 22 characters whose last carries non-zero padding bits, 15 or 17 bytes, padding: refused.
    for (const bad of [`${nonce.slice(0, 21)}B`, b64url(new Uint8Array(15)), b64url(new Uint8Array(17)), `${nonce}==`]) expect(PLATFORM_HEADER_RES.nonce.test(bad), bad).toBe(false);
    expect(PLATFORM_HEADER_RES.signature.test(b64url(new Uint8Array(64).fill(1)))).toBe(true);
    for (const n of [63, 65, 70]) expect(PLATFORM_HEADER_RES.signature.test(b64url(new Uint8Array(n).fill(1))), String(n)).toBe(false);
    for (const ok of ['application/json', 'application/json; charset=utf-8', 'Application/JSON; charset=UTF-8']) expect(PLATFORM_CONTENT_TYPE_RE.test(ok), ok).toBe(true);
    for (const bad of ['text/plain', 'application/json;charset=utf-8', 'application/json; charset=latin1', 'application/jsonx']) expect(PLATFORM_CONTENT_TYPE_RE.test(bad), bad).toBe(false);
  });

  it('the self-revoke body: an optional one-line reason of at most 200 characters', () => {
    expect(platformRevokeBody.safeParse({}).success).toBe(true);
    expect(platformRevokeBody.safeParse({ reason: 'Rotating' }).success).toBe(true);
    for (const bad of [{ reason: 'x'.repeat(201) }, { reason: 'a\nb' }, { reason: 'a‮b' }, { other: 1 }, { reason: 1 }]) expect(platformRevokeBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});
