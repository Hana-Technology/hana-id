// The one display-safety rule (src/display-safe.ts; sweep AUTH-5 merged with CORE-4, AUTH-2): messages, decoded strings,
// policy labels and names, and app names.
import { describe, expect, it } from 'vitest';
import {
  CHECK_MARKS,
  decodeMessage,
  displayPartnerName,
  isDisplaySafeLine,
  isDisplaySafeText,
  parseWindowMessage,
  utf8,
  validateAutoApprovePolicy,
} from './entries.ts';
import { policyJson } from './policy-fixtures.ts';

// Every code point the sweep listed as missed, plus the ones the old lists caught.
const INVISIBLE: [string, string][] = [
  ['U+00AD soft hyphen', '­'],
  ['U+034F combining grapheme joiner', '͏'],
  ['U+061C Arabic letter mark', '؜'],
  ['U+115F Hangul choseong filler', 'ᅟ'],
  ['U+1160 Hangul jungseong filler', 'ᅠ'],
  ['U+17B4 Khmer vowel inherent AQ', '឴'],
  ['U+17B5 Khmer vowel inherent AA', '឵'],
  ['U+180B Mongolian free variation selector', '᠋'],
  ['U+180E Mongolian vowel separator', '᠎'],
  ['U+200B zero-width space', '​'],
  ['U+200D zero-width joiner', '‍'],
  ['U+200E left-to-right mark', '‎'],
  ['U+2028 line separator', ' '],
  ['U+2029 paragraph separator', ' '],
  ['U+202E right-to-left override', '‮'],
  ['U+2066 left-to-right isolate', '⁦'],
  ['U+206A inhibit symmetric swapping', '⁪'],
  ['U+206F nominal digit shapes', '⁯'],
  ['U+3164 Hangul filler', 'ㅤ'],
  ['U+E000 private use', ''],
  ['U+FE00 variation selector 1', '︀'],
  ['U+FE0F variation selector 16', '️'],
  ['U+FEFF BOM', '﻿'],
  ['U+FFA0 halfwidth Hangul filler', 'ﾠ'],
  ['U+FFF9 interlinear annotation anchor', '￹'],
  ['U+FFFB interlinear annotation terminator', '￻'],
  ['U+1D173 musical symbol begin beam', '\u{1d173}'],
  ['U+1D17A musical symbol end phrase', '\u{1d17a}'],
  ['U+E0001 language tag', '\u{e0001}'],
  ['U+E0041 tag Latin capital A', '\u{e0041}'],
  ['U+E007F cancel tag', '\u{e007f}'],
  ['U+E0100 variation selector 17', '\u{e0100}'],
  ['U+E01EF variation selector 256', '\u{e01ef}'],
  ['U+0007 bell', '\u0007'],
  ['U+0085 next line', '\u0085'],
];

describe('isDisplaySafeText / isDisplaySafeLine', () => {
  it.each(INVISIBLE)('refuses %s in both', (_, c) => {
    expect(isDisplaySafeText(`a${c}b`)).toBe(false);
    expect(isDisplaySafeLine(`a${c}b`)).toBe(false);
  });

  it('allows tab, LF and CR in multi-line text only', () => {
    for (const c of ['\t', '\n', '\r']) {
      expect(isDisplaySafeText(`a${c}b`)).toBe(true);
      expect(isDisplaySafeLine(`a${c}b`)).toBe(false);
    }
  });

  it('allows ordinary text in any script, accents, CJK and emoji without selectors', () => {
    for (const t of ['Sign in to Example', 'café', 'Ünïcödé', '日本語のアプリ', 'مرحبا', 'Привет', '🚀 Launch', 'a b']) {
      expect(isDisplaySafeText(t)).toBe(true);
      expect(isDisplaySafeLine(t)).toBe(true);
    }
  });

  it('a message carrying any of them is shown as hex only', () => {
    for (const [, c] of INVISIBLE) expect(decodeMessage(utf8(`hello${c}`)).text).toBeNull();
  });
});

describe('where the rule applies', () => {
  it('policy labels and contract names', () => {
    for (const [, c] of INVISIBLE.slice(0, 8)) {
      const p = { ...policyJson(), label: `Swaps${c}` };
      const r = validateAutoApprovePolicy(p);
      expect(r.ok).toBe(false);
      expect(r.ok ? [] : r.problems).toContain('policy.label: contains control or invisible characters');
    }
  });

  it('app names in popup messages (AUTH-2)', () => {
    const msg = (appName: string) => ({ v: 1, t: 'hana:export-context', pk: 'pk_test_1111111111111111', appName, parentOrigin: 'https://partner.example', scopeId: 's1', signer: 'hana-signer.testnet', keyIndex: 0, chain: 'evm', address: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23' });
    expect(parseWindowMessage(msg('Partner App'), ['hana:export-context'])).not.toBeNull();
    for (const [, c] of INVISIBLE) expect(parseWindowMessage(msg(`Partner${c}App`), ['hana:export-context'])).toBeNull();
  });

  it('check marks partners may not show, look-alikes included', () => {
    for (const c of ['✓', '✔', '✅', '\u{10102}', '\u{1fbb1}', '\u{1f5f8}']) {
      expect(displayPartnerName(`${c} Sodax`)).toBe('Sodax');
      expect(`x${c}`.replace(CHECK_MARKS, '')).toBe('x');
    }
  });
});
