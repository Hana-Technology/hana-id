import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { emailIssuerRules } from './email-issuer.ts';
import { emailIssuerFor, manifestPath, manifestSchema, rsaJwkThumbprint, rsaModulusBits } from './index.ts';

const raw = () => JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Record<string, unknown>;

/** A fresh public JWKS entry (throwaway RSA key; the private half is discarded). */
function publicKey(bits = 2048) {
  const { publicKey: pub } = generateKeyPairSync('rsa', { modulusLength: bits, publicExponent: 65537 });
  const jwk = pub.export({ format: 'jwk' }) as { n: string; e: string };
  return { kty: 'RSA' as const, n: jwk.n, e: jwk.e, kid: rsaJwkThumbprint(jwk), use: 'sig' as const, alg: 'RS256' as const };
}
const primary = publicKey();
const standby = publicKey();

const emailIssuer = (over: Record<string, unknown> = {}) => {
  const m = raw();
  return {
    iss: emailIssuerFor(m.apiUrl as string),
    cloudflare: { workerName: 'hana-id-email-issuer-sandbox-dev', d1Name: 'hana-id-email-issuer-sandbox-dev' },
    signer: { kind: 'worker-secret', activeKid: primary.kid },
    publicKeys: [primary, standby],
    from: 'Hana <login@mail.example.com>',
    sender: 'sendgrid',
    ...over,
  };
};
const block = (over: Record<string, unknown> = {}, manifest: Record<string, unknown> = {}) => ({ ...raw(), ...manifest, emailIssuer: emailIssuer(over) });
const issues = (v: unknown): string[] => manifestSchema.safeParse(v).error?.issues.map((i) => i.message) ?? [];

describe('rsaJwkThumbprint', () => {
  it('matches RFC 7638 section 3.1 and ignores leading zero bytes', () => {
    const n =
      '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw';
    expect(rsaJwkThumbprint({ n, e: 'AQAB' })).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
    const padded = Buffer.concat([Buffer.from([0]), Buffer.from(n, 'base64url')]).toString('base64url');
    expect(rsaJwkThumbprint({ n: padded, e: 'AAEAAQ' })).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
    expect(() => rsaJwkThumbprint({ n: 'a+b', e: 'AQAB' })).toThrow();
  });

  it('rsaModulusBits counts bits without leading zeros', () => {
    expect(rsaModulusBits(primary.n)).toBe(2048);
    expect(rsaModulusBits(Buffer.concat([Buffer.from([0, 0]), Buffer.from(primary.n, 'base64url')]).toString('base64url'))).toBe(2048);
    expect(rsaModulusBits('AQ')).toBe(1);
    expect(rsaModulusBits('AA')).toBe(0);
    expect(rsaModulusBits('a+')).toBe(0);
  });
});

describe('manifestSchema: emailIssuer', () => {
  it('is optional, and a well-formed block parses', () => {
    expect(manifestSchema.safeParse(raw()).success).toBe(true);
    const parsed = manifestSchema.parse(block());
    expect(parsed.emailIssuer?.signer.kind).toBe('worker-secret');
    expect(parsed.emailIssuer?.publicKeys).toHaveLength(2);
  });

  it('iss is the API’s /v1/email', () => {
    expect(emailIssuerFor('https://api.example/')).toBe('https://api.example/v1/email');
    expect(issues(block({ iss: 'https://email.example' })).join()).toContain('/v1/email');
  });

  it('kid must be the thumbprint, unique; one modulus once', () => {
    expect(issues(block({ publicKeys: [{ ...primary, kid: standby.kid }] })).join()).toContain('thumbprint');
    expect(issues(block({ publicKeys: [primary, primary] })).join()).toContain('Duplicate key');
    const padded = { ...primary, n: Buffer.concat([Buffer.from([0]), Buffer.from(primary.n, 'base64url')]).toString('base64url') };
    expect(issues(block({ publicKeys: [primary, padded] })).join()).toContain('modulus is listed twice');
  });

  it('keys are 2048-4096-bit RSA with exponent 65537, public members only', () => {
    const small = publicKey(1024);
    expect(issues(block({ publicKeys: [small], signer: { kind: 'worker-secret', activeKid: small.kid } })).join()).toContain('2048-4096 bits');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 3 });
    const e3 = privateKey.export({ format: 'jwk' }) as { n: string; e: string; d: string };
    const pub3 = { kty: 'RSA', n: e3.n, e: e3.e, kid: rsaJwkThumbprint(e3), use: 'sig', alg: 'RS256' };
    expect(issues(block({ publicKeys: [pub3], signer: { kind: 'worker-secret', activeKid: pub3.kid } })).join()).toContain('65537');
    expect(issues(block({ publicKeys: [{ ...pub3, d: e3.d }], signer: { kind: 'worker-secret', activeKid: pub3.kid } })).join()).toContain('Unrecognized key');
  });

  it('the signer names a published key', () => {
    expect(issues(block({ signer: { kind: 'worker-secret', activeKid: publicKey().kid } })).join()).toContain('not in emailIssuer.publicKeys');
    const kms = (p: string, s: string) => ({
      kind: 'aws-kms',
      awsRegion: 'ap-east-1',
      keys: { primary: { kid: p, arn: 'arn:aws:kms:ap-east-1:123456789012:key/00000000-0000-4000-8000-000000000001' }, standby: { kid: s, arn: 'arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-4000-8000-000000000002' } },
    });
    expect(manifestSchema.safeParse(block({ signer: kms(primary.kid, standby.kid) })).success).toBe(true);
    expect(issues(block({ signer: kms(primary.kid, primary.kid) })).join()).toContain('different keys');
  });

  it('refuses a Worker-secret key outside testnet (mainnet uses AWS KMS)', () => {
    const problems: string[] = [];
    const ctx = { addIssue: (i: { message?: string }) => problems.push(i.message ?? '') } as unknown as z.RefinementCtx;
    const m = { ...raw(), network: 'mainnet' } as unknown as Parameters<typeof emailIssuerRules>[0];
    emailIssuerRules(m, emailIssuer() as never, ctx);
    expect(problems.join()).toContain('testnet only');
  });

  it('the outbox stub only in local* envs', () => {
    expect(issues(block({ sender: 'outbox' })).join()).toContain('local* envs only');
    const local = { name: 'local-dev', apiUrl: 'http://127.0.0.1:8787', rpc: 'http://127.0.0.1:3030' };
    const m = { ...raw(), ...local };
    delete (m as Record<string, unknown>).rpcFallback;
    delete (m as Record<string, unknown>).ckdNetworkKeySource;
    delete (m as Record<string, unknown>).vaultOrigin;
    delete (m as Record<string, unknown>).authOrigin;
    delete (m as Record<string, unknown>).identityToken;
    const r = manifestSchema.safeParse({ ...m, emailIssuer: { ...emailIssuer({ sender: 'outbox' }), iss: emailIssuerFor(local.apiUrl) } });
    expect(r.error?.issues.map((i) => i.message) ?? []).toEqual([]);
  });

  it('its own Worker and D1, a well-formed From, strict fields', () => {
    const m = raw() as { cloudflare: { workerName: string; d1Name: string } };
    expect(issues(block({ cloudflare: { workerName: m.cloudflare.workerName, d1Name: 'x-email' } })).join()).toContain("differ from the API's Worker");
    expect(issues(block({ cloudflare: { workerName: 'hana-id-watchdog-sandbox-dev', d1Name: 'x-email' } })).join()).toContain("differ from the watchdog's Worker");
    expect(issues(block({ cloudflare: { workerName: 'x-email', d1Name: m.cloudflare.d1Name } })).join()).toContain("differ from the API's D1");
    expect(issues(block({ from: 'Hana <Login@Mail.example.com>' })).join()).toContain('not lowercased');
    expect(issues(block({ from: 'Hana\r\nBcc: x@y.z <a@b.c>' })).join()).toContain('line break');
    expect(issues(block({ extra: 1 })).join()).toContain('Unrecognized key');
  });

  it('access and the webhook key are validated', () => {
    const access = { teamDomain: 'hana.cloudflareaccess.com', aud: 'a'.repeat(64), staffEmails: ['staff@example.com'] };
    expect(manifestSchema.safeParse(block({ access })).success).toBe(true);
    expect(issues(block({ access: { ...access, staffEmails: ['Staff@example.com'] } })).join()).toContain('lowercased');
    expect(issues(block({ access: { ...access, aud: 'UNSET' } })).join()).toContain('AUD tag');
    expect(issues(block({ sendgridWebhookPublicKey: 'not base64!' })).join()).toContain('SPKI');
  });
});
