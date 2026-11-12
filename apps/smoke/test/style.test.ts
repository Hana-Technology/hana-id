// The smoke pages wear Journear Passport's tokens and fonts (packages/brand, D765): one stylesheet, linked by every
// page, with colours from the --jp-* tokens only, and the product named as users now read it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '@hana-id/brand';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const PAGES = ['index.html', 'direct.html', 'direct-callback.html', 'spike.html', 'spike-email.html', 'spike-callback.html'];

describe('the smoke pages’ style', () => {
  it('every page links src/smoke.css once and has no inline <style> of its own', () => {
    for (const page of PAGES) {
      const html = read(page);
      expect(html.split('<link rel="stylesheet" href="/src/smoke.css" />').length, page).toBe(2);
      expect(html, page).not.toMatch(/<style|\sstyle=/u);
    }
  });

  it('src/smoke.css is the brand’s tokens and fonts, then rules with --jp-* colours only', () => {
    const css = read('src/smoke.css');
    expect([...css.matchAll(/@import\s+'([^']+)'/gu)].map((m) => m[1])).toEqual(['@hana-id/brand/tokens.css', '@hana-id/brand/fonts.css']);
    const rules = css.replace(/\/\*[\s\S]*?\*\//gu, '');
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(|url\(|--hana-/iu);
    for (const v of rules.matchAll(/var\((--[\w-]+)/gu)) expect(v[1]).toMatch(/^--jp-/u);
  });

  it('names the product Journear Passport in the pages’ titles and text', () => {
    for (const page of ['index.html', 'direct.html', 'direct-callback.html']) expect(/<title>([^<]+)<\/title>/u.exec(read(page))![1], page).toMatch(new RegExp(`^${BRAND.product} smoke test`, 'u'));
    for (const page of PAGES) {
      const text = read(page)
        .replace(/<script[\s\S]*?<\/script>/gu, '')
        .replace(/<[^>]+>/gu, ' ')
        .replace(/@hana-id\/[\w-]+|hana-id\/chain-keys\/v1\/extract/gu, '');
      expect(text, page).not.toMatch(/\bHana\b/u);
    }
  });
});
