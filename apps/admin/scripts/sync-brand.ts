// Copies Hana's brand (packages/brand, D426) into the staff SPA, which has no build step (D420):
//
//   corepack pnpm --filter @hana-id/admin sync-brand
//
// - public/fonts/: the brand's WOFF2 files and their OFL licence, byte for byte (nothing else);
// - public/app.css: the block between BRAND_START and BRAND_END becomes the brand's fonts.css then tokens.css, verbatim.
// scripts/test/gen-wrangler.test.ts fails when either has drifted from packages/brand, so run this after changing it.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FONT_FILES, FONT_LICENCE_FILE } from '@hana-id/brand';

export const BRAND_START = '/* ==== @hana-id/brand: fonts.css and tokens.css, copied by `pnpm --filter @hana-id/admin sync-brand`; never edit here ==== */';
export const BRAND_END = '/* ==== end of @hana-id/brand ==== */';

const brandDir = new URL('../../../packages/brand/', import.meta.url);
const publicDir = new URL('../public/', import.meta.url);

/** The block app.css must hold: the brand's fonts.css and tokens.css as they are. */
export function brandBlock(): string {
  const fonts = readFileSync(new URL('fonts.css', brandDir), 'utf8').trimEnd();
  const tokens = readFileSync(new URL('tokens.css', brandDir), 'utf8').trimEnd();
  return `${BRAND_START}\n${fonts}\n\n${tokens}\n${BRAND_END}`;
}

/** The files public/fonts must hold, exactly. */
export const BRAND_FONT_FILES: readonly string[] = [...FONT_FILES.map((f) => f.file), FONT_LICENCE_FILE].sort();

export function syncBrand(): void {
  const fontsDir = new URL('fonts/', publicDir);
  rmSync(fontsDir, { recursive: true, force: true });
  mkdirSync(fontsDir);
  for (const f of BRAND_FONT_FILES) copyFileSync(new URL(`fonts/${f}`, brandDir), new URL(f, fontsDir));
  const cssPath = new URL('app.css', publicDir);
  const css = readFileSync(cssPath, 'utf8');
  const start = css.indexOf(BRAND_START);
  const end = css.indexOf(BRAND_END);
  if (start < 0 || end < start) throw new Error(`public/app.css has no brand block (${BRAND_START} … ${BRAND_END})`);
  writeFileSync(cssPath, css.slice(0, start) + brandBlock() + css.slice(end + BRAND_END.length));
  console.log(`public/fonts: ${readdirSync(fontsDir).join(', ')}; public/app.css: brand block updated`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) syncBrand();
