// The Unicode-version cutoff (D156): any code point assigned after Unicode 15.0 is refused, so the runtime's own
// Unicode data (NFC inside tr46) never decides an address.
import { describe, expect, it } from 'vitest';
import { normalizeDomain, normalizeEmail } from '../src/index.ts';
import { ASSIGNED_AFTER_CUTOFF, UNICODE_AGE_SOURCE } from '../src/unicode-age.ts';
import { assignedAfterCutoff, hasLoneSurrogate, hasPostCutoffCodePoint } from '../src/unicode.ts';

const ranges = ASSIGNED_AFTER_CUTOFF.trim()
  .split(/\s+/)
  .map((r) => {
    const [lo, hi = lo] = r.split('..') as [string, string?];
    return [parseInt(lo, 16), parseInt(hi, 16)] as const;
  });

describe('the vendored age table', () => {
  it('is sorted, disjoint, non-adjacent and matches its header', () => {
    expect(ranges.length).toBe(UNICODE_AGE_SOURCE.ranges);
    let count = 0;
    ranges.forEach(([lo, hi], i) => {
      expect(lo).toBeLessThanOrEqual(hi);
      if (i > 0) expect(lo).toBeGreaterThan(ranges[i - 1]![1] + 1);
      count += hi - lo + 1;
    });
    expect(count).toBe(UNICODE_AGE_SOURCE.codePoints);
  });

  it('flags the characters of the review finding and the later versions, not 15.0 or older', () => {
    for (const cp of [0x1ad0, 0x1ae0, 0x1e6e3, 0x2ebf0, 0x2ffc, 0x0b53, 0x3d000]) expect(assignedAfterCutoff(cp)).toBe(true);
    for (const cp of [0x41, 0xdf, 0x3c2, 0x0316, 0x31350, 0x2b739, 0x1f4a9, 0x200c, 0x10ffff]) expect(assignedAfterCutoff(cp)).toBe(false);
  });

  it('every flagged code point makes normalizeDomain refuse, typed or as punycode', () => {
    for (const [lo, hi] of ranges) {
      for (let cp = lo; cp <= hi; cp++) {
        const label = `a${String.fromCodePoint(cp)}`;
        const r = normalizeDomain(`${label}.com`);
        expect(r.ok ? 'accepted' : r.reason).toBe('domain_unicode_version');
      }
    }
  });

  it('a newer character hidden in an xn-- label is refused before tr46 validates it', () => {
    expect(normalizeEmail('alice@xn--x-4cb533p.com')).toEqual({ ok: false, reason: 'domain_unicode_version' });
    expect(normalizeEmail('alice@xn--x-4cb633p.com')).toEqual({ ok: false, reason: 'domain_unicode_version' });
    expect(hasPostCutoffCodePoint('x\u{1E6E3}')).toBe(true);
  });
});

describe('hasLoneSurrogate', () => {
  it('finds unpaired surrogates without a lookbehind regex', () => {
    expect(hasLoneSurrogate('abc')).toBe(false);
    expect(hasLoneSurrogate('a\u{1F4A9}b')).toBe(false);
    expect(hasLoneSurrogate('\uD83D')).toBe(true);
    expect(hasLoneSurrogate('\uDCA9')).toBe(true);
    expect(hasLoneSurrogate('a\uD83Db')).toBe(true);
    expect(hasLoneSurrogate('\uDCA9\uD83D')).toBe(true);
    expect(hasLoneSurrogate('\uD83D💩')).toBe(true);
  });

  it('no regex in src uses lookbehind or Unicode property escapes (both engine-dependent)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('../src/', import.meta.url);
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const text = readFileSync(new URL(f, dir), 'utf8');
      expect(text, f).not.toMatch(/\(\?<[=!]/);
      expect(text, f).not.toMatch(/\\[pP]\{/);
    }
  });
});
