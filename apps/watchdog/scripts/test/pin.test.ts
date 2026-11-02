// The pin command (L7): the RFC 7638 thumbprint of a public key, from a JWK, a JWKS or a PEM, the same value the
// Worker computes (`rsaThumbprint`), leading zeros stripped. Private keys are refused.
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { rsaThumbprint } from '@hana-id/jwks';
import { describe, expect, it } from 'vitest';
import { formatPins, pinsOfText } from '../pin.ts';

// RFC 7638 section 3.1.
const N =
  '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw';
const RFC = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs';

describe('pin', () => {
  it('prints the RFC example, from a JWK, a zero-padded JWK and a PEM of the same key', async () => {
    const jwk = { kty: 'RSA', n: N, e: 'AQAB' };
    expect(await pinsOfText(JSON.stringify(jwk))).toEqual([{ kid: null, thumbprint: RFC }]);
    const padded = Buffer.concat([Buffer.from([0]), Buffer.from(N, 'base64url')]).toString('base64url');
    expect(await pinsOfText(JSON.stringify({ ...jwk, n: padded, e: 'AAEAAQ' }))).toEqual([{ kid: null, thumbprint: RFC }]);
    const pem = createPublicKey({ key: jwk, format: 'jwk' }).export({ format: 'pem', type: 'spki' }).toString();
    expect(await pinsOfText(pem)).toEqual([{ kid: null, thumbprint: RFC }]);
    const pkcs1 = createPublicKey({ key: jwk, format: 'jwk' }).export({ format: 'pem', type: 'pkcs1' }).toString();
    expect(await pinsOfText(pkcs1)).toEqual([{ kid: null, thumbprint: RFC }]);
    // openssl's leading "Bag Attributes" (and any other text) around the block.
    expect(await pinsOfText(`Bag Attributes\n    localKeyID: 01 02 03\nsubject=CN = hana\n${pem}\ntrailing text\n`)).toEqual([{ kid: null, thumbprint: RFC }]);
  });

  it('matches the Worker for a fresh key, and says when a JWKS kid is not the thumbprint', async () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    const tp = (await rsaThumbprint(jwk))!;
    const lines = await pinsOfText(JSON.stringify({ keys: [{ ...jwk, kty: 'RSA', kid: tp }, { ...jwk, kty: 'RSA', kid: 'primary' }] }));
    expect(lines).toEqual([
      { kid: tp, thumbprint: tp },
      { kid: 'primary', thumbprint: tp },
    ]);
    expect(formatPins(lines)).toBe(`${tp}  (kid matches)\n${tp}  (kid "primary" does NOT match: the issuer must use the thumbprint as kid)`);
  });

  it('refuses private keys and anything that is not an RSA public key, printing no key material', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(pinsOfText(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())).rejects.toThrow(/private key/u);
    // A private key anywhere in the file is refused, even next to a public one.
    const pub = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString();
    await expect(pinsOfText(`Bag Attributes\n${pub}\n${privateKey.export({ format: 'pem', type: 'pkcs1' }).toString()}`)).rejects.toThrow(/private key/u);
    await expect(pinsOfText('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----')).rejects.toThrow(/No PUBLIC KEY block/u);
    await expect(pinsOfText(JSON.stringify(privateKey.export({ format: 'jwk' })))).rejects.toThrow(/private key/u);
    await expect(pinsOfText(JSON.stringify({ kty: 'EC', x: 'a', y: 'b' }))).rejects.toThrow(/RSA public JWK/u);
    await expect(pinsOfText('hello')).rejects.toThrow(/Not a JWK/u);
    await expect(pinsOfText(JSON.stringify({ kty: 'RSA', n: 'a*', e: 'AQAB' }))).rejects.toThrow(/base64url/u);
  });
});
