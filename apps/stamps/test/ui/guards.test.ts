// The UI module's guards, as the repo's other pages have them (apps/demo/test/brand.test.ts): ui.css colours only from
// the brand's --jp-* tokens and loads nothing; the words users read say Journear, never the code name; motion is off
// under reduced motion. And the small text helpers.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COVER_COPY, STAMP_IDS, STAMP_LABELS, STAMP_PROOFS } from '../../src/ui/index.ts';
import { UI_TEXT } from '../../src/ui/labels.ts';
import { relativeTime, safeHref, safeText, shortAccount, stampDate, stampTime } from '../../src/ui/text.ts';

const root = join(import.meta.dirname, '..', '..');
const css = readFileSync(join(root, 'src/ui.css'), 'utf8');
const rules = css.replace(/\/\*[\s\S]*?\*\//gu, '');

describe('ui.css', () => {
  it('colours only from --jp-* tokens: no hex, rgb or hsl of its own, no --hana- variable, no custom property of its own', () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(rules).not.toMatch(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/u);
    expect(rules).not.toContain('--hana-');
    for (const v of rules.matchAll(/var\((--[\w-]+)/gu)) expect(v[1]).toMatch(/^--jp-/u);
    expect(rules).not.toMatch(/^\s*--[\w-]+\s*:/mu);
  });

  it('loads nothing: no import, url() or address', () => {
    expect(rules).not.toMatch(/@import|url\(|https?:/u);
  });

  it('stops every animation and transition under reduced motion', () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/u.exec(rules)?.[1] ?? '';
    expect(block).toMatch(/\.pp \*, \.pp \*::before, \.pp \*::after \{ animation: none !important; transition: none !important; \}/u);
  });

  it('follows a forced theme as well as the system’s', () => {
    expect(rules).toContain(":root[data-theme='dark'] .pp { color-scheme: dark; }");
    expect(rules).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme='light'\]\) \.pp \{ color-scheme: dark; \}/u);
  });
});

describe('the words', () => {
  it('every stamp has a title, a one-line blurb and a proof', () => {
    for (const id of STAMP_IDS) {
      expect(STAMP_LABELS[id].title.length).toBeGreaterThan(0);
      expect(STAMP_LABELS[id].blurb.length).toBeLessThanOrEqual(80);
      expect(STAMP_PROOFS[id].length).toBeGreaterThan(0);
    }
    expect(STAMP_LABELS.sponsored.blurb).toBe('Journear’s relay paid the fee. You hold no NEAR.');
  });

  it('say Journear or Journear Passport, never the code name', () => {
    const shown = JSON.stringify([STAMP_LABELS, STAMP_PROOFS, COVER_COPY, UI_TEXT, UI_TEXT.totals(1, 2), UI_TEXT.collectedOf(3)]);
    expect(shown).not.toMatch(/hana/iu);
    expect(COVER_COPY.title).toBe('Journear Passport');
    // Every string literal in the module's code (comments aside), as the demo's guard reads its own.
    for (const file of readdirSync(join(root, 'src/ui')).filter((f) => f.endsWith('.ts'))) {
      const code = readFileSync(join(root, 'src/ui', file), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/u.test(l))
        .join('\n');
      const strings = [...code.matchAll(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gu)].map((m) => m[0]).filter((s) => !s.startsWith("'@hana-id/"));
      for (const s of strings) expect(/\bHana\b(?![A-Z])/u.test(s), `${file}: ${s}`).toBe(false);
    }
  });
});

describe('text helpers', () => {
  it('dates in UTC, as a stamp reads them', () => {
    expect(stampDate(Date.UTC(2026, 10, 13, 23, 59))).toBe('13 NOV 2026');
    expect(stampDate(Date.UTC(2026, 0, 2))).toBe('02 JAN 2026');
    expect(stampTime(Date.UTC(2026, 10, 13, 7, 5))).toBe('07:05 UTC');
    expect(stampDate(Number.NaN)).toBe('');
    expect(stampDate(1e20)).toBe('');
  });

  it('relative times', () => {
    const now = Date.UTC(2026, 10, 13, 12);
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 9 * 60_000, now)).toBe('9 min ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(relativeTime(now - 26 * 3_600_000, now)).toBe('1 day ago');
    expect(relativeTime(now - 30 * 86_400_000, now)).toBe('14 Oct 2026');
  });

  it('short accounts', () => {
    expect(shortAccount('a'.repeat(64))).toBe('aaaaaa…aaaaaa');
    expect(shortAccount('alice.testnet')).toBe('alice.testnet');
    expect(shortAccount('a-very-long-named-account-for-the-demo.testnet')).toBe('a-very-long-…mo.testnet');
  });

  it('safeText replaces controls, bidi and invisible characters, and cuts long strings', () => {
    expect(safeText('a‮b​c\u0000d\ne')).toBe('a�b�c�d e');
    expect(safeText('x'.repeat(10), 4)).toBe('xxxx…');
    expect(safeText(42)).toBe('');
  });

  it('safeHref keeps http(s) only', () => {
    const base = 'https://stamps.example/';
    expect(safeHref('https://testnet.nearblocks.io/x', base)?.href).toBe('https://testnet.nearblocks.io/x');
    expect(safeHref('/p/alice.testnet', base)?.href).toBe('https://stamps.example/p/alice.testnet');
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:x', 'java\tscript:x', 'data:text/html,x', 'vbscript:x', 'mailto:a@b.c', 'ftp://x', 'https://u:p@x.example/', '', 42, null])
      expect(safeHref(bad, base), String(bad)).toBeNull();
  });
});
