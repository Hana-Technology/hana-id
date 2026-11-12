// Copies Journear Passport's brand (packages/brand, D426 as amended by D765) into the staff SPA, which has no build step
// (D420):
//
//   corepack pnpm --filter @hana-id/admin sync-brand
//
// - public/fonts/: the brand's WOFF2 files and their OFL licences, byte for byte (nothing else);
// - public/app.css: the block between BRAND_START and BRAND_END becomes the brand's fonts.css, tokens.css and
//   components.css, verbatim except one declaration: the `select.jp-input` chevron, a `data:` SVG image, is left out
//   (BRAND_CSS_DROPPED), so the stylesheet loads nothing but the fonts; public/app.css draws that chevron with gradients;
// - public/index.html: the block between LOCKUP_START and LOCKUP_END becomes the white Journear lockup
//   (logo/journear-lockup-white.svg, for the ink nav in both themes: the teal card, the orange bracket and white type,
//   all outlined, D789), inline so no image is requested.
// scripts/test/gen-wrangler.test.ts fails when any of them has drifted from packages/brand, so run this after changing it.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FONT_FILES, FONT_LICENCE_FILES } from '@hana-id/brand';

export const BRAND_START = '/* ==== @hana-id/brand: fonts.css, tokens.css and components.css, copied by `pnpm --filter @hana-id/admin sync-brand`; never edit here ==== */';
export const BRAND_END = '/* ==== end of @hana-id/brand ==== */';
export const LOCKUP_START = '<!-- @hana-id/brand: logo/journear-lockup-white.svg, copied by `pnpm --filter @hana-id/admin sync-brand`; never edit here -->';
export const LOCKUP_END = '<!-- end of @hana-id/brand -->';

const brandDir = new URL('../../../packages/brand/', import.meta.url);
const publicDir = new URL('../public/', import.meta.url);

/** components.css's one image: the select's chevron (a `data:` URI), left out of the copy and drawn in app.css instead. */
export const BRAND_CSS_DROPPED = /background-image:url\("data:image\/svg\+xml,[^"]*"\);/gu;

/** components.css as copied: the brand's file without its `data:` chevron (exactly one, inside `select.jp-input`). */
export function brandComponents(): string {
  const css = readFileSync(new URL('components.css', brandDir), 'utf8').trimEnd();
  const found = [...css.matchAll(BRAND_CSS_DROPPED)];
  if (found.length !== 1 || !/select\.jp-input\{[^}]*$/u.test(css.slice(0, found[0]!.index))) {
    throw new Error('packages/brand/components.css: expected exactly one data: image, the select.jp-input chevron; update BRAND_CSS_DROPPED');
  }
  return css.replace(BRAND_CSS_DROPPED, '');
}

/** The block app.css must hold: the brand's fonts.css, tokens.css and components.css (its chevron left out). */
export function brandBlock(): string {
  const fonts = readFileSync(new URL('fonts.css', brandDir), 'utf8').trimEnd();
  const tokens = readFileSync(new URL('tokens.css', brandDir), 'utf8').trimEnd();
  return `${BRAND_START}\n${fonts}\n\n${tokens}\n\n${brandComponents()}\n${BRAND_END}`;
}

/**
 * The block index.html must hold: the white lockup's SVG as it is, with the class the nav sizes it by and without its
 * `xmlns` (an SVG inline in HTML needs none, and the page then names no URL at all).
 */
export function lockupBlock(): string {
  const svg = readFileSync(new URL('logo/journear-lockup-white.svg', brandDir), 'utf8').trim();
  const open = '<svg xmlns="http://www.w3.org/2000/svg" ';
  if (!svg.startsWith(open)) throw new Error('packages/brand/logo/journear-lockup-white.svg: not an <svg> element with its xmlns first');
  return `${LOCKUP_START}\n<svg class="lockup" ${svg.slice(open.length)}\n${LOCKUP_END}`;
}

/** The files public/fonts must hold, exactly. */
export const BRAND_FONT_FILES: readonly string[] = [...FONT_FILES.map((f) => f.file), ...FONT_LICENCE_FILES].sort();

function replaceBlock(path: URL, start: string, end: string, block: string): void {
  const text = readFileSync(path, 'utf8');
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a < 0 || b < a) throw new Error(`${path.pathname} has no brand block (${start} … ${end})`);
  writeFileSync(path, text.slice(0, a) + block + text.slice(b + end.length));
}

export function syncBrand(): void {
  const fontsDir = new URL('fonts/', publicDir);
  rmSync(fontsDir, { recursive: true, force: true });
  mkdirSync(fontsDir);
  for (const f of BRAND_FONT_FILES) copyFileSync(new URL(`fonts/${f}`, brandDir), new URL(f, fontsDir));
  replaceBlock(new URL('app.css', publicDir), BRAND_START, BRAND_END, brandBlock());
  replaceBlock(new URL('index.html', publicDir), LOCKUP_START, LOCKUP_END, lockupBlock());
  console.log(`public/fonts: ${readdirSync(fontsDir).join(', ')}; public/app.css and public/index.html: brand blocks updated`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) syncBrand();
