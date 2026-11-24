// The demo wears Journear Passport's design system (packages/brand, D765): its stylesheet is the brand's tokens,
// fonts and components plus layout written with tokens only; the lockup drawn in the top bar is the brand file's
// geometry; the favicon is the brand's mark; nothing inline that the page's CSP would block; and the names users read
// are the new ones.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND, LOCKUP, MARK_BRACKET, MARK_CARD } from '@hana-id/brand';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const brandFile = (p: string) => readFileSync(fileURLToPath(import.meta.resolve(`@hana-id/brand/${p}`)), 'utf8');
const html = read('index.html');
const css = read('src/style.css');

describe('the stylesheet', () => {
  it('imports the brand’s tokens, fonts and components, and nothing else', () => {
    expect([...css.matchAll(/@import\s+'([^']+)'/gu)].map((m) => m[1])).toEqual(['@hana-id/brand/tokens.css', '@hana-id/brand/fonts.css', '@hana-id/brand/components.css']);
    expect(css).not.toMatch(/url\(|https?:/u);
  });

  it('colours only from --jp-* tokens: no hex, rgb or hsl of its own, no old --hana- variable', () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//gu, '');
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(rules).not.toMatch(/\b(?:rgba?|hsla?)\(/u);
    expect(rules).not.toContain('--hana-');
    for (const v of rules.matchAll(/var\((--[\w-]+)/gu)) expect(v[1]).toMatch(/^--jp-/u);
  });
});

describe('reduced motion (D905, the spinners as amended by D906)', () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/u.exec(rules)?.[1] ?? '';
  const inBlock = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((m) => ({ selectors: m[1]!.trim().split(/,\s*/u), body: m[2]!.trim() }));
  /** The brand's declaration for its spinners under reduced motion (components.css). */
  const pulse = /\.jp-btn \.spin,\.jp-provider \.spin,\.jp-iconfield \.spin\{animation:([^!}]+)!important\}/u.exec(brandFile('components.css'))?.[1];

  it('the demo’s spinner pulses with the brand’s declaration, above the brand’s rule for everything inside a .jp-* element', () => {
    expect(pulse).toBe('jp-spin-pulse 2s ease-in-out infinite');
    // The spinner as it turns without reduced motion: its two places.
    expect(rules).toContain('.progress::before, .stage::before { content: \'\'; flex: none; width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--jp-primary); border-right-color: transparent; animation: jp-spin 0.7s linear infinite; }');
    // `body` adds a type to the brand's `[class*=" jp-"] *::before` (0,1,1), so the pulse wins whatever the order.
    expect(inBlock).toContainEqual({ selectors: ['body .progress::before', 'body .stage::before'], body: `animation: ${pulse} !important;` });
  });

  it('nothing else moves: the results’ fade stops, and only the spinner names an animation', () => {
    // `body` puts it above `.result`'s own animation, which comes later in the file.
    expect(inBlock).toContainEqual({ selectors: ['body .result'], body: 'animation: none;' });
    expect(inBlock).toHaveLength(2);
    // Every animation that repeats for ever in the demo's own rules is that spinner.
    const outside = rules.replace(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/u, '');
    const forever = [...outside.matchAll(/([^{}@]+)\{([^{}]*)\}/gu)].filter((m) => /infinite/u.test(m[2]!)).map((m) => m[1]!.trim());
    expect(forever).toEqual(['.progress::before, .stage::before']);
  });
});

describe('the page', () => {
  it('draws the Journear lockup with the brand’s geometry (D789), outlined, and the favicon is the brand’s mark', () => {
    const lockup = /<svg class="lockup"[\s\S]*?<\/svg>/u.exec(html)![0];
    expect(lockup).toContain(`viewBox="${LOCKUP.viewBox}"`);
    expect(lockup).toContain(`<g transform="${LOCKUP.mark}">`);
    expect(lockup).toContain(`<path class="card" d="${MARK_CARD}"/>`);
    expect(lockup).toContain(`<path class="bracket" d="${MARK_BRACKET}"/>`);
    expect(lockup).toContain(`<path class="word" transform="${LOCKUP.word.transform}" d="${LOCKUP.word.d}"/>`);
    expect(lockup).toContain(`<path class="sub" transform="${LOCKUP.sub.transform}" d="${LOCKUP.sub.d}"/>`);
    // Outlined: no live text, so it never falls back to another face.
    expect(lockup).not.toMatch(/<text\b/u);
    expect(read('public/favicon.svg')).toBe(brandFile('logo/journear-mark.svg'));
  });

  it('has no inline style or script for the CSP to block (style-src and script-src are self)', () => {
    expect(html).not.toMatch(/\sstyle=|<style|\son[a-z]+=/iu);
    expect([...html.matchAll(/<script\b[^>]*>/gu)].map((m) => m[0])).toEqual(['<script type="module" src="/src/main.ts">']);
  });

  it('names the product as users now read it: Journear Passport, never Hana (package names aside)', () => {
    const text = html.replace(/<[^>]+>/gu, ' ').replace(/@hana-id\/web/gu, '');
    expect(text).not.toMatch(/\bHana\b/u);
    expect(text).toContain(BRAND.product);
    expect(/<title>([^<]+)<\/title>/u.exec(html)![1]).toBe(`${BRAND.product} demo (test networks)`);
  });

  it('the strings the page shows say Journear, Journear Passport or Passport Home, not Hana', () => {
    // The signed test texts were renamed too (D766): only identifiers and package names may still say hana.
    for (const file of ['src/errors.ts', 'src/page.ts', 'src/near-card.ts', 'src/gas-free-card.ts', 'src/requests.ts', 'src/near.ts']) {
      const code = read(file)
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/u.test(l))
        .join('\n');
      const strings = [...code.matchAll(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gu)].map((m) => m[0]);
      for (const s of strings) expect(/\bHana\b(?![A-Z])/u.test(s), `${file}: ${s}`).toBe(false);
    }
  });
});
