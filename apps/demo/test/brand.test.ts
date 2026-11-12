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
    expect(/<title>([^<]+)<\/title>/u.exec(html)![1]).toBe(`${BRAND.product} testnet demo`);
  });

  it('the strings the page shows say Journear, Journear Passport or Passport Home, not Hana', () => {
    // The signed test texts were renamed too (D766): only identifiers and package names may still say hana.
    for (const file of ['src/errors.ts', 'src/page.ts', 'src/near-card.ts', 'src/requests.ts', 'src/near.ts']) {
      const code = read(file)
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/u.test(l))
        .join('\n');
      const strings = [...code.matchAll(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gu)].map((m) => m[0]);
      for (const s of strings) expect(/\bHana\b(?![A-Z])/u.test(s), `${file}: ${s}`).toBe(false);
    }
  });
});
