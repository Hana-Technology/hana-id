// Email identity v1 is FROZEN at the address freeze (docs/email-login-spec.md "Address impact", "Email
// normalization"). These tests are the CI guard, as for derivation v1 (packages/core/test/derivation.test.ts): the
// golden vectors in vectors/email-v1.json (scripts/gen-vectors.mjs, an independent implementation on Node's own
// UTS #46 and node:crypto) must match the code, and the vectors file, the EMAIL_V1 constants and the pinned IDNA
// library must match the guard constants below. A failure here means an ADDRESS-CHANGING EDIT: every email user's
// `sub`, so their path and wallet addresses, would change. Before the address freeze such an edit must be called out
// to the user; after it, never.
//
// The Gmail canonical form (spec Q7) rests on Google's own documentation, checked 2026-11-02:
// - Dots: "Dots don't matter in Gmail addresses" (https://support.google.com/mail/answer/7436150): "Emails sent to any
//   dotted version of your address will only go to you."
// - +suffix: Google Workspace Learning Center, "Tips to optimize your Gmail inbox"
//   (https://support.google.com/a/users/answer/9308648): "Just add a plus sign (+) and any word before the @ sign in
//   your current address. Messages sent to your current address or any variation with the plus sign, all arrive in
//   your current inbox." Gmail usernames themselves can't contain "+" ("Create a username",
//   https://support.google.com/mail/answer/9211434: letters, numbers and periods only).
// - Deleted Gmail usernames are never reissued (what makes the Google-hosted rule safe, D119): "Your Gmail address
//   can't be used by anyone in the future" (https://support.google.com/mail/answer/61177); a new address can't be
//   "the same as a username that someone used in the past and then deleted" (https://support.google.com/mail/answer/56256).
// - googlemail.com: no current Google help page states it; it is the same Gmail namespace (Gmail's former name in
//   Germany and the UK). Mapping it to gmail.com is the spec's rule; see docs/decisions.md D159.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { EMAIL_V1, emailSub, importSubKey, isNormalizedEmail, normalizeEmail } from '../src/index.ts';
import { UNICODE_AGE_SOURCE } from '../src/unicode-age.ts';
import { PKG, V, VECTORS_TEXT, readText, sha256Hex, testKey } from './helpers.ts';

/** sha256 of vectors/email-v1.json, byte for byte. */
const VECTORS_SHA256 = '7a58a737ee01eddbfb7cbccd8460a469c824551b07885b9eccad68de1d3efe61';
/** sha256 of JSON.stringify(EMAIL_V1). */
const CONSTANTS_SHA256 = 'b6baca6ba60dfb9c0f10ec68be30795c7db17c9cec61ad03c131deab042a33b0';
/** sha256 of src/unicode-age.ts (code points refused as newer than Unicode 15.0, from DerivedAge-18.0.0.txt). */
const UNICODE_AGE_SHA256 = '0344aa1c296659c7ff4734c845aa4f47e710c539a47a1f6a86daafafc208ae15';

const require = createRequire(`${PKG}/package.json`);

describe('email v1 freeze guard', () => {
  it('the frozen vectors file is unchanged (address-changing edit otherwise)', () => {
    expect(sha256Hex(VECTORS_TEXT), 'address-changing edit: vectors/email-v1.json changed').toBe(VECTORS_SHA256);
  });

  it('the EMAIL_V1 constants are unchanged (address-changing edit otherwise)', () => {
    expect(sha256Hex(JSON.stringify(EMAIL_V1)), 'address-changing edit: EMAIL_V1 changed').toBe(CONSTANTS_SHA256);
    expect(Object.isFrozen(EMAIL_V1) && Object.isFrozen(EMAIL_V1.idna) && Object.isFrozen(EMAIL_V1.idna.options)).toBe(true);
    expect(Object.isFrozen(EMAIL_V1.gmailDomains)).toBe(true);
  });

  it('the Unicode age table is unchanged (it decides which addresses are accepted)', () => {
    expect(sha256Hex(readText('src/unicode-age.ts')), 'address-changing edit: src/unicode-age.ts changed').toBe(UNICODE_AGE_SHA256);
    expect(UNICODE_AGE_SOURCE.cutoff).toBe(EMAIL_V1.unicodeCutoff);
    expect(UNICODE_AGE_SOURCE.file).toBe(`DerivedAge-${EMAIL_V1.idna.unicode}.txt`);
  });

  it('the vectors file names the same constants as the code', () => {
    expect(V.version).toBe(1);
    expect(V.provider).toBe(EMAIL_V1.provider);
    expect(V.subPrefix).toBe(EMAIL_V1.subPrefix);
    expect(V.subLabel).toBe(EMAIL_V1.subLabel);
    expect({ library: V.idna.library, version: V.idna.version, unicode: V.idna.unicode }).toEqual({
      library: EMAIL_V1.idna.library,
      version: EMAIL_V1.idna.version,
      unicode: EMAIL_V1.idna.unicode,
    });
  });

  it('the installed UTS #46 implementation is the pinned one (a tr46 or punycode upgrade can move addresses)', () => {
    const pkg = JSON.parse(readText('package.json')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies.tr46, 'tr46 must be pinned exactly').toBe(EMAIL_V1.idna.version);
    const tr46Pkg = require('tr46/package.json') as { version: string };
    expect(tr46Pkg.version).toBe(EMAIL_V1.idna.version);
    const fromTr46 = createRequire(require.resolve('tr46'));
    expect((fromTr46('punycode/package.json') as { version: string }).version).toBe('2.3.1');
  });

  it('has vectors of every kind the spec names', () => {
    const labels = V.normalize.map((v) => v.label).join('\n');
    for (const kind of ['IDN', 'Gmail', 'googlemail', 'uppercase', 'whitespace', 'non-transitional']) expect(labels).toContain(kind);
    expect(V.reject.length).toBeGreaterThanOrEqual(40);
    expect(V.sub.length).toBe(new Set(V.normalize.map((v) => v.out)).size);
  });
});

describe.each(V.normalize)('normalize: $label', (v) => {
  it('gives the frozen output, idempotently', () => {
    const r = normalizeEmail(v.in);
    expect(r.ok && r.email).toBe(v.out);
    expect(isNormalizedEmail(v.out)).toBe(true);
    const again = normalizeEmail(v.out);
    expect(again.ok && again.email).toBe(v.out);
  });
});

describe.each(V.reject)('reject: $label', (v) => {
  it('is not an acceptable address', () => {
    expect(normalizeEmail(v.in).ok).toBe(false);
  });
});

describe('sub vectors', () => {
  it.each(V.sub)('$email → $sub (raw key and imported key)', async ({ email, sub }) => {
    expect(await emailSub(testKey(), email)).toBe(sub);
    expect(await emailSub(await importSubKey(testKey()), email)).toBe(sub);
  });

  it('every input of one person gives one sub (Gmail dots, empty +tag, googlemail, case, whitespace)', async () => {
    const key = await importSubKey(testKey());
    const subOf = async (input: string) => {
      const r = normalizeEmail(input);
      if (!r.ok) throw new Error(r.reason);
      return emailSub(key, r.email);
    };
    const gmail = ['abc@gmail.com', 'A.B.C@Gmail.com', 'abc+@gmail.com', 'a.b.c@googlemail.com', 'ABC@GOOGLEMAIL.COM.', '  A.B.C@gmail.com\n'];
    expect(new Set(await Promise.all(gmail.map(subOf))).size).toBe(1);
    // Each Gmail +tag is its own identity (D159); the same tag in any spelling of the username is one.
    const tags = ['abc@gmail.com', 'abc+1@gmail.com', 'abc+2@gmail.com', 'abc+x+y@gmail.com'];
    expect(new Set(await Promise.all(tags.map(subOf))).size).toBe(tags.length);
    expect(new Set(await Promise.all(['abc+1@gmail.com', 'A.B.C+1@GoogleMail.com'].map(subOf))).size).toBe(1);
    const plain = ['alice@example.com', 'Alice@Example.COM', ' \t\r\n\falice@example.com \t\r\n\f', 'alice@example.com.', 'alice@example.com。'];
    expect(new Set(await Promise.all(plain.map(subOf))).size).toBe(1);
    const idn = ['x@Bücher.example', 'x@xn--bcher-kva.example', 'x@XN--BCHER-KVA.EXAMPLE'];
    expect(new Set(await Promise.all(idn.map(subOf))).size).toBe(1);
    // Distinct mailboxes stay distinct.
    expect(await subOf('x@faß.de')).not.toBe(await subOf('x@fass.de'));
    expect(await subOf('alice+news@example.com')).not.toBe(await subOf('alice@example.com'));
    expect(await subOf('a.l.i.c.e@example.com')).not.toBe(await subOf('alice@example.com'));
  });
});
