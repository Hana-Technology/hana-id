// Guards over every file of the site, the art build's src/ui/ and src/ui.css included: the product as users read it
// (Journear Passport, never Hana), the design system's tokens only (no raw colour, no --hana- variable), nothing
// inline the page's CSP would block, and nothing of another chain (D798: the site is NEAR only).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '@hana-id/brand';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const brandFile = (p: string) => readFileSync(fileURLToPath(import.meta.resolve(`@hana-id/brand/${p}`)), 'utf8');

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir))) {
    const p = join(dir, name);
    if (statSync(join(root, p)).isDirectory()) out.push(...files(p, ext));
    else if (ext.test(name)) out.push(relative(root, join(root, p)));
  }
  return out;
}

/** The string literals of a TypeScript file, comments left out (the text a user can be shown). */
function strings(file: string): string[] {
  const code = read(file)
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/u.test(l))
    .join('\n');
  return [...code.matchAll(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"/gu)].map((m) => m[0]).filter((s) => !/^['"`](?:@hana-id\/|\.\.?\/|node:)/u.test(s));
}

const html = read('index.html');
const sources = [...files('src', /\.ts$/u), ...files('worker', /\.ts$/u)];
const styles = files('src', /\.css$/u);

describe('the page', () => {
  it('has no inline style or script for the CSP to block, one module entry and the brand’s favicon', () => {
    expect(html).not.toMatch(/\sstyle=|<style|\son[a-z]+=/iu);
    expect([...html.matchAll(/<script\b[^>]*>/gu)].map((m) => m[0])).toEqual(['<script type="module" src="/src/main.ts">']);
    expect(read('public/favicon.svg')).toBe(brandFile('logo/journear-mark.svg'));
    expect(html).toContain('<main id="passport">');
  });

  it('names the product as users read it: Journear Passport, never Hana', () => {
    expect(html.replace(/<[^>]+>/gu, ' ')).not.toMatch(/\bHana\b/u);
    expect(/<title>([^<]+)<\/title>/u.exec(html)![1]).toBe(`${BRAND.product} stamps`);
    for (const file of sources) for (const s of strings(file)) expect(/\bHana\b(?![A-Z])/u.test(s), `${file}: ${s}`).toBe(false);
  });

  it('shows nothing of another chain: no Stellar, EVM or Ethereum text in any string the site can show', () => {
    expect(sources.length).toBeGreaterThan(8);
    expect(html).not.toMatch(/stellar|\bevm\b|ethereum/iu);
    for (const file of sources) for (const s of strings(file)) expect(/stellar|\bevm\b|ethereum|sepolia|\bG[A-Z2-7]{55}\b|\b0x[0-9a-fA-F]{40}\b/iu.test(s), `${file}: ${s}`).toBe(false);
  });

  it('builds DOM with text nodes only: no innerHTML, outerHTML, insertAdjacentHTML or document.write', () => {
    for (const file of sources) expect(read(file), file).not.toMatch(/\.(?:inner|outer)HTML\s*=|insertAdjacentHTML|document\.write\(/u);
  });
});

describe('the stylesheets', () => {
  it('import only the brand, colour only from --jp-* tokens, no raw hex/rgb/hsl, no --hana- variable, no URL', () => {
    expect(styles).toContain('src/ui.css');
    for (const file of styles) {
      const css = read(file);
      for (const m of css.matchAll(/@import\s+['"]([^'"]+)['"]/gu)) expect(m[1], file).toMatch(/^@hana-id\/brand\/|^\.\//u);
      const rules = css.replace(/\/\*[\s\S]*?\*\//gu, '');
      expect(rules, file).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
      expect(rules, file).not.toMatch(/\b(?:rgba?|hsla?)\(/u);
      expect(rules, file).not.toContain('--hana-');
      expect(rules, file).not.toMatch(/url\(|https?:/u);
      for (const v of rules.matchAll(/var\((--[\w-]+)/gu)) expect(v[1], file).toMatch(/^--jp-/u);
    }
  });
});
