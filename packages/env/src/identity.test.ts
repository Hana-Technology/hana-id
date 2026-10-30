import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { identityIssuerFor, manifestPath, manifestSchema, p256Thumbprint } from './index.ts';

const raw = () => JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Record<string, unknown>;

/** A fresh public JWKS entry (throwaway key; the private half is discarded). */
function publicKey() {
  const { publicKey: pub } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pub.export({ format: 'jwk' }) as { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  return { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x, y: jwk.y, kid: p256Thumbprint(jwk), use: 'sig' as const, alg: 'ES256' as const };
}

const block = (over: Record<string, unknown> = {}) => {
  const m = raw();
  const active = publicKey();
  const standby = publicKey();
  return { ...m, identityToken: { iss: identityIssuerFor(m.apiUrl as string), signer: { kind: 'worker-secret', activeKid: active.kid }, publicKeys: [active, standby], ...over } };
};
const issues = (v: unknown): string[] => manifestSchema.safeParse(v).error?.issues.map((i) => i.message) ?? [];

describe('manifestSchema: identityToken', () => {
  it('is optional, and a well-formed block parses', () => {
    const { identityToken: _, ...base } = raw();
    expect(manifestSchema.safeParse(base).success).toBe(true);
    const parsed = manifestSchema.parse(block());
    expect(parsed.identityToken?.signer.kind).toBe('worker-secret');
    expect(parsed.identityToken?.publicKeys).toHaveLength(2);
  });

  it('iss is the API’s /v1/identity', () => {
    expect(identityIssuerFor('https://api.example/')).toBe('https://api.example/v1/identity');
    expect(issues(block({ iss: 'https://id.example' })).join()).toContain('/v1/identity');
  });

  it('kid must be the key’s RFC 7638 thumbprint and appear once', () => {
    const k = publicKey();
    const wrongKid = { ...k, kid: publicKey().kid };
    expect(issues(block({ signer: { kind: 'worker-secret', activeKid: wrongKid.kid }, publicKeys: [wrongKid] })).join()).toContain('thumbprint');
    expect(issues(block({ signer: { kind: 'worker-secret', activeKid: k.kid }, publicKeys: [k, k] })).join()).toContain('Duplicate');
  });

  it('refuses a private member or any other extra field in a public key', () => {
    const k = publicKey();
    expect(manifestSchema.safeParse(block({ signer: { kind: 'worker-secret', activeKid: k.kid }, publicKeys: [{ ...k, d: 'x'.repeat(43) }] })).success).toBe(false);
    expect(manifestSchema.safeParse(block({ signer: { kind: 'worker-secret', activeKid: k.kid }, publicKeys: [{ ...k, alg: 'RS256' }] })).success).toBe(false);
  });

  it('the signer’s keys must be in the list', () => {
    expect(issues(block({ signer: { kind: 'worker-secret', activeKid: publicKey().kid } })).join()).toContain('not in identityToken.publicKeys');
  });

  it('1 to 4 keys', () => {
    expect(manifestSchema.safeParse(block({ publicKeys: [] })).success).toBe(false);
    const keys = Array.from({ length: 5 }, publicKey);
    expect(manifestSchema.safeParse(block({ signer: { kind: 'worker-secret', activeKid: keys[0]!.kid }, publicKeys: keys })).success).toBe(false);
  });

  it('accepts the KMS signer shape (build step 7; gen refuses it until then)', () => {
    const [a, b] = [publicKey(), publicKey()];
    const kms = block({ signer: { kind: 'aws-kms', awsRegion: 'ap-east-1', keys: { active: a.kid, standby: b.kid } }, publicKeys: [a, b] });
    expect(manifestSchema.safeParse(kms).success).toBe(true);
  });
});
