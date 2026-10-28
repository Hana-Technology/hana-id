// The auto-approve consent digest: the exact preimage (an independent node:crypto build of it), and that every field
// it binds changes it.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { toHex } from '../src/bytes.ts';
import { CONSENT_DIGEST_DOMAIN, consentDigest } from '../src/consent.ts';

const BASE = { id: 'ab'.repeat(16), policyId: 'c'.repeat(64), parentOrigin: 'https://partner.example', expiresAtMs: 1_800_000_000_000 };

function independent(i: typeof BASE): string {
  const borsh = (s: string) => {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    return Buffer.concat([len, b]);
  };
  const ms = Buffer.alloc(8);
  ms.writeBigUInt64LE(BigInt(i.expiresAtMs));
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(CONSENT_DIGEST_DOMAIN), borsh(i.id), borsh(i.policyId), borsh(i.parentOrigin), ms]))
    .digest('hex');
}

describe('consentDigest', () => {
  it('is sha256 of the domain, borsh(id, policyId, parentOrigin) and u64le(expiresAtMs)', () => {
    expect(CONSENT_DIGEST_DOMAIN).toBe('hana-id/auto-approve-consent/v1');
    expect(toHex(consentDigest(BASE))).toBe(independent(BASE));
  });

  it.each([
    ['id', { id: 'cd'.repeat(16) }],
    ['policyId', { policyId: 'd'.repeat(64) }],
    ['parentOrigin', { parentOrigin: 'https://evil.example' }],
    ['expiresAtMs', { expiresAtMs: BASE.expiresAtMs + 1 }],
  ])('changes with %s', (_, change) => {
    expect(toHex(consentDigest({ ...BASE, ...change }))).not.toBe(toHex(consentDigest(BASE)));
  });

  it('refuses a malformed policyId or empty strings', () => {
    expect(() => consentDigest({ ...BASE, policyId: 'C'.repeat(64) })).toThrow(/policyId/);
    expect(() => consentDigest({ ...BASE, id: '' })).toThrow();
    expect(() => consentDigest({ ...BASE, parentOrigin: '' })).toThrow();
  });
});
