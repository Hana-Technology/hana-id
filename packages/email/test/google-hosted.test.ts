// The Google-hosted rule (docs/email-login-spec.md "The four cases"; tests list: "Gmail, googlemail, hd equal, hd
// absent, hd different"). False negatives are the safe side: a code first (case A) or the 24 h delay (case B).
import { describe, expect, it } from 'vitest';
import { isGoogleHosted, normalizeEmail } from '../src/index.ts';

const n = (input: string) => {
  const r = normalizeEmail(input);
  if (!r.ok) throw new Error(r.reason);
  return r.email;
};
const hosted = (email: string, hd?: unknown, emailVerified: unknown = true) =>
  isGoogleHosted({ email: n(email), hd: hd as string | undefined, emailVerified: emailVerified as boolean });

describe('isGoogleHosted', () => {
  it('Gmail with no hd', () => {
    expect(hosted('a.b@gmail.com')).toBe(true);
    expect(hosted('ab@gmail.com', null)).toBe(true);
  });

  it('googlemail.com: through the Gmail canonical form', () => {
    expect(hosted('A.B+x@GoogleMail.com')).toBe(true);
  });

  it('Gmail with a present, different hd: not Google-hosted', () => {
    expect(hosted('ab@gmail.com', 'example.com')).toBe(false);
    expect(hosted('ab@gmail.com', '')).toBe(false);
  });

  it('Workspace: hd present and equal to the normalized domain', () => {
    expect(hosted('Alice@Example.COM', 'example.com')).toBe(true);
    expect(hosted('x@Bücher.example', 'xn--bcher-kva.example')).toBe(true);
  });

  it('hd absent on another domain: not Google-hosted (an outside address on a Google account)', () => {
    expect(hosted('alice@example.com')).toBe(false);
    expect(hosted('alice@example.com', null)).toBe(false);
    expect(hosted('alice@example.com', '')).toBe(false);
  });

  it('hd different: not Google-hosted, including parent, sub- and look-alike domains', () => {
    expect(hosted('alice@example.com', 'other.com')).toBe(false);
    expect(hosted('alice@mail.example.com', 'example.com')).toBe(false);
    expect(hosted('alice@example.com', 'mail.example.com')).toBe(false);
    expect(hosted('alice@example.com', 'example.co')).toBe(false);
    expect(hosted('alice@outlook.com', 'gmail.com')).toBe(false);
  });

  it('compares hd exactly, without normalizing it (D158)', () => {
    expect(hosted('alice@example.com', 'Example.com')).toBe(false);
    expect(hosted('alice@example.com', 'example.com.')).toBe(false);
    expect(hosted('alice@example.com', ' example.com')).toBe(false);
    expect(hosted('x@Bücher.example', 'bücher.example')).toBe(false);
    expect(hosted('alice@example.com', 42)).toBe(false);
  });

  it('needs email_verified to be exactly true', () => {
    for (const v of [false, undefined, null, 'true', 1]) {
      const emailVerified = v as boolean;
      expect(isGoogleHosted({ email: n('ab@gmail.com'), emailVerified })).toBe(false);
      expect(isGoogleHosted({ email: n('alice@example.com'), hd: 'example.com', emailVerified })).toBe(false);
    }
    expect(isGoogleHosted({ email: n('ab@gmail.com') } as unknown as Parameters<typeof isGoogleHosted>[0])).toBe(false);
  });

  it('refuses an address that is not normalized', () => {
    for (const email of ['Alice@example.com', 'a.b@gmail.com', 'ab@googlemail.com', 'nope']) {
      expect(() => isGoogleHosted({ email, hd: 'example.com', emailVerified: true })).toThrow(TypeError);
    }
  });
});
