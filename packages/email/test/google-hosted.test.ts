// The Google-hosted rule (docs/email-login-spec.md "The four cases"; tests list: "Gmail, googlemail, hd equal, hd
// absent, hd different"). False negatives are the safe side: a code first (case A) or the 24 h delay (case B).
import { describe, expect, it } from 'vitest';
import { isGoogleHosted, normalizeEmail } from '../src/index.ts';

const n = (input: string) => {
  const r = normalizeEmail(input);
  if (!r.ok) throw new Error(r.reason);
  return r.email;
};

describe('isGoogleHosted', () => {
  it('Gmail: always, with or without hd', () => {
    expect(isGoogleHosted({ email: n('a.b@gmail.com') })).toBe(true);
    expect(isGoogleHosted({ email: n('ab@gmail.com'), hd: 'example.com' })).toBe(true);
  });

  it('googlemail.com: through the Gmail canonical form', () => {
    expect(isGoogleHosted({ email: n('A.B+x@GoogleMail.com') })).toBe(true);
  });

  it('Workspace: hd present and equal to the normalized domain', () => {
    expect(isGoogleHosted({ email: n('Alice@Example.COM'), hd: 'example.com' })).toBe(true);
    expect(isGoogleHosted({ email: n('x@Bücher.example'), hd: 'xn--bcher-kva.example' })).toBe(true);
  });

  it('hd absent: not Google-hosted (an outside address on a Google account)', () => {
    expect(isGoogleHosted({ email: n('alice@example.com') })).toBe(false);
    expect(isGoogleHosted({ email: n('alice@example.com'), hd: undefined })).toBe(false);
    expect(isGoogleHosted({ email: n('alice@example.com'), hd: null })).toBe(false);
    expect(isGoogleHosted({ email: n('alice@example.com'), hd: '' })).toBe(false);
  });

  it('hd different: not Google-hosted, including parent, sub- and look-alike domains', () => {
    expect(isGoogleHosted({ email: n('alice@example.com'), hd: 'other.com' })).toBe(false);
    expect(isGoogleHosted({ email: n('alice@mail.example.com'), hd: 'example.com' })).toBe(false);
    expect(isGoogleHosted({ email: n('alice@example.com'), hd: 'mail.example.com' })).toBe(false);
    expect(isGoogleHosted({ email: n('alice@example.com'), hd: 'example.co' })).toBe(false);
    expect(isGoogleHosted({ email: n('alice@outlook.com'), hd: 'gmail.com' })).toBe(false);
  });

  it('compares hd exactly, without normalizing it (D158)', () => {
    expect(isGoogleHosted({ email: n('alice@example.com'), hd: 'Example.com' })).toBe(false);
    expect(isGoogleHosted({ email: n('alice@example.com'), hd: 'example.com.' })).toBe(false);
    expect(isGoogleHosted({ email: n('alice@example.com'), hd: ' example.com' })).toBe(false);
    expect(isGoogleHosted({ email: n('x@Bücher.example'), hd: 'bücher.example' })).toBe(false);
    expect(isGoogleHosted({ email: n('alice@example.com'), hd: 42 as unknown as string })).toBe(false);
  });

  it('refuses an address that is not normalized', () => {
    for (const email of ['Alice@example.com', 'a.b@gmail.com', 'ab@googlemail.com', 'nope']) {
      expect(() => isGoogleHosted({ email, hd: 'example.com' })).toThrow(TypeError);
    }
  });
});
