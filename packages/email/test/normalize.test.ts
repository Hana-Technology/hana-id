import { toASCII } from 'tr46';
import { describe, expect, it } from 'vitest';
import { isNormalizedEmail, normalizeDomain, normalizeEmail, type InvalidEmailReason } from '../src/index.ts';

const a = (n: number, c = 'a') => c.repeat(n);
const reason = (input: string) => {
  const r = normalizeEmail(input);
  return r.ok ? `accepted: ${r.email}` : r.reason;
};

describe('normalizeEmail: why an input is refused', () => {
  const cases: [string, InvalidEmailReason][] = [
    ['', 'at_sign'],
    ['alice', 'at_sign'],
    ['a@b@example.com', 'at_sign'],
    ['@example.com', 'local_empty'],
    ['+tag@gmail.com', 'local_empty'],
    ['+.+@googlemail.com', 'local_empty'],
    [`${a(65)}@example.com`, 'local_too_long'],
    [`${a(64)}@${a(63, 'b')}.${a(63, 'c')}.${a(58, 'd')}.com`, 'too_long'],
    ['alicé@example.com', 'local_not_ascii'],
    [' alice@example.com', 'local_not_ascii'],
    ['"a b"@example.com', 'local_syntax'],
    ['.alice@example.com', 'local_syntax'],
    ['alice.@example.com', 'local_syntax'],
    ['al..ice@example.com', 'local_syntax'],
    ['a\tb@example.com', 'local_syntax'],
    ['alice@ex_ample.com', 'domain_idna'],
    ['alice@ab--cd.com', 'domain_idna'],
    ['alice@-example.com', 'domain_idna'],
    ['alice@xn--a.com', 'domain_idna'],
    ['alice@a‍b.com', 'domain_idna'],
    ['alice@aא.com', 'domain_idna'],
    ['alice@[1.2.3.4]', 'domain_idna'],
    ['alice@exam ple.com', 'domain_idna'],
    ['alice@', 'domain_syntax'],
    ['alice@example..com', 'domain_syntax'],
    ['alice@example.com..', 'domain_syntax'],
    ['alice@1.2.3.4', 'domain_syntax'],
    ['alice@example.123', 'domain_syntax'],
    [`alice@${a(64, 'b')}.com`, 'domain_syntax'],
    ['alice@localhost', 'domain_no_dot'],
    ['alice@localhost.', 'domain_no_dot'],
    ['alice@ex\uD800ample.com', 'malformed'],
    ['\uDC00alice@example.com', 'malformed'],
  ];
  it.each(cases)('%j → %s', (input, why) => {
    expect(reason(input)).toBe(why);
  });

  it('refuses a non-string without throwing', () => {
    for (const v of [undefined, null, 42, {}, ['a@b.com']]) {
      expect(normalizeEmail(v as unknown as string)).toEqual({ ok: false, reason: 'not_string' });
      expect(isNormalizedEmail(v as unknown as string)).toBe(false);
    }
  });

  it('measures the 254-byte limit after trimming, in UTF-8 bytes', () => {
    const exactly = `${a(64)}@${a(63, 'b')}.${a(63, 'c')}.${a(57, 'd')}.com`;
    expect(exactly.length).toBe(254);
    expect(reason(`   ${exactly}\n`)).toBe(`accepted: ${exactly}`);
    // Non-ASCII domain characters count as their UTF-8 bytes on the input: 2 bytes each for ü.
    const fat = `a@${a(126, 'ü')}.com`;
    expect(new TextEncoder().encode(fat).length).toBeGreaterThan(254);
    expect(reason(fat)).toBe('too_long');
  });

  it('applies the limit again after punycode grows the domain (D156)', () => {
    const idn = `例え.${a(63, 'b')}.${a(63, 'c')}.${a(63, 'd')}.${a(45, 'e')}.com`;
    const input = `a@${idn}`;
    expect(new TextEncoder().encode(input).length).toBeLessThanOrEqual(254);
    const d = normalizeDomain(idn);
    expect(d.ok && d.domain.length).toBe(253);
    expect(reason(input)).toBe('too_long');
  });

  it('trims only ASCII whitespace at the edges', () => {
    expect(reason('\t\n\f\r alice@example.com \r\n')).toBe('accepted: alice@example.com');
    expect(reason('\u000Balice@example.com')).toBe('local_syntax'); // vertical tab is not WHATWG ASCII whitespace
    expect(reason('alice@example.com ')).toBe('domain_idna');
    expect(reason('　alice@example.com')).toBe('local_not_ascii');
  });

  it('lowercases ASCII only, never by locale', () => {
    expect(reason('İSTANBUL@example.com')).toBe('local_not_ascii');
    expect(reason('ISTANBUL@EXAMPLE.COM')).toBe('accepted: istanbul@example.com');
  });

  it('keeps every provider rule but Gmail out (spec step 5)', () => {
    expect(reason('A.B+c@outlook.com')).toBe('accepted: a.b+c@outlook.com');
    expect(reason('A.B+c@yahoo.com')).toBe('accepted: a.b+c@yahoo.com');
    expect(reason('A.B+c@gmail.com.au')).toBe('accepted: a.b+c@gmail.com.au');
    expect(reason('A.B+c@google.com')).toBe('accepted: a.b+c@google.com');
  });
});

describe('normalizeDomain', () => {
  it('is UTS #46 non-transitional (deviation characters kept, not mapped)', () => {
    expect(normalizeDomain('faß.de')).toEqual({ ok: true, domain: 'xn--fa-hia.de' });
    expect(toASCII('faß.de', { transitionalProcessing: true })).toBe('fass.de');
    expect(normalizeDomain('ς.gr')).toEqual({ ok: true, domain: 'xn--3xa.gr' });
    expect(normalizeDomain('a‌b.com').ok).toBe(false); // ZWNJ outside its ContextJ: refused, not dropped
  });

  it('strips exactly one trailing dot, after mapping', () => {
    expect(normalizeDomain('example.com.')).toEqual({ ok: true, domain: 'example.com' });
    expect(normalizeDomain('example.com．')).toEqual({ ok: true, domain: 'example.com' });
    expect(normalizeDomain('example.com..').ok).toBe(false);
    expect(normalizeDomain('.').ok).toBe(false);
  });

  it('holds the DNS limits: 63-byte labels, 253-byte names', () => {
    const d253 = `${a(63)}.${a(63, 'b')}.${a(63, 'c')}.${a(57, 'd')}.com`;
    expect(normalizeDomain(d253)).toEqual({ ok: true, domain: d253 });
    expect(normalizeDomain(`${d253}.`)).toEqual({ ok: true, domain: d253 });
    expect(normalizeDomain(`x${d253}`).ok).toBe(false);
    expect(normalizeDomain(`${a(63)}.com`).ok).toBe(true);
    expect(normalizeDomain(`${a(64)}.com`).ok).toBe(false);
  });

  it('agrees with the platform URL host parser on valid IDNs (its UTS #46 is non-transitional too)', () => {
    for (const d of ['Bücher.example', 'faß.de', 'ς.gr', '例え.テスト', 'مثال.إختبار', 'ＥＸＡＭＰＬＥ.com', 'exa­mple.com']) {
      const r = normalizeDomain(d);
      expect(r.ok && r.domain).toBe(new URL(`http://${d}/`).hostname);
    }
  });
});
