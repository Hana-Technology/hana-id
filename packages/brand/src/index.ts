// Journear Passport's brand for its own pages (D426 as amended by D765, the Journear redesign): the design system's
// tokens (tokens.css), its component set (components.css), the self-hosted fonts (fonts.css and fonts/), and the mark,
// wordmark and lockup (logo/). This module is what code needs of it: the product's names, the font files' manifest
// (checked by test/brand.test.ts and by each app that ships a copy), and the logo's geometry (src/logo.ts), for pages
// that draw the mark or the lockup inline (an inline SVG needs no image request and takes its colours from the page's
// CSS).

import { MARK_BRACKET, MARK_CARD, MARK_VIEWBOX } from './logo.ts';

/** The names users read (D765). Code identifiers (packages, env names, SDK symbols) keep "hana". */
export const BRAND = Object.freeze({
  /** The company or service, alone: "ask Journear", "Journear never asks you to…" (was "Hana"). */
  company: 'Journear',
  /** The product (was "Hana ID"). */
  product: 'Journear Passport',
  /** The users' cross-app wallet page (was "Hana Home"). */
  home: 'Passport Home',
  /** The brand's one appearance inside a host app: the popup's footer badge. */
  badge: 'Secured by Journear Passport',
});

/** A shipped font file: an OFL 1.1 face from Fontsource's npm build, Latin subset, its licence beside it in fonts/. */
export interface FontFile {
  readonly file: string;
  readonly family: 'Archivo' | 'IBM Plex Sans' | 'IBM Plex Mono';
  readonly weight: 400 | 500 | 600 | 700 | 900;
  /** The font's own version string (name ID 5). */
  readonly version: string;
  /** The licence file beside it, in fonts/. */
  readonly licence: string;
  /** Where it came from: the npm package and its file, before renaming. */
  readonly source: string;
  readonly sha256: string;
}

export const FONT_LICENCE_FILES: readonly string[] = Object.freeze(['OFL-Archivo.txt', 'OFL-IBMPlexSans.txt', 'OFL-IBMPlexMono.txt']);

/** Fontsource's `latin` subset, which every file covers; other characters are drawn by the fallback stack. */
export const FONT_UNICODE_RANGE =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

const fs = (pkg: string, file: string) => `@fontsource/${pkg}@5.3.0 files/${file}`;

export const FONT_FILES: readonly FontFile[] = Object.freeze([
  { file: 'archivo-500.woff2', family: 'Archivo', weight: 500, version: 'Version 2.001', licence: 'OFL-Archivo.txt', source: fs('archivo', 'archivo-latin-500-normal.woff2'), sha256: 'ab74eca5ad115fe4cfec82ba641e5d37e4d92c58dfb1bfc1e464e9039c9d17cf' },
  { file: 'archivo-700.woff2', family: 'Archivo', weight: 700, version: 'Version 2.001', licence: 'OFL-Archivo.txt', source: fs('archivo', 'archivo-latin-700-normal.woff2'), sha256: 'abada6cd4c92a9a706f6d7ed3189f322ff43dd78b9402c7d1137465b861d2a04' },
  { file: 'archivo-900.woff2', family: 'Archivo', weight: 900, version: 'Version 2.001', licence: 'OFL-Archivo.txt', source: fs('archivo', 'archivo-latin-900-normal.woff2'), sha256: 'e915040a27c5310623be7ae57b6e4c508e8800206dcc37abe99984510e74a66d' },
  { file: 'ibm-plex-sans-400.woff2', family: 'IBM Plex Sans', weight: 400, version: 'Version 3.201', licence: 'OFL-IBMPlexSans.txt', source: fs('ibm-plex-sans', 'ibm-plex-sans-latin-400-normal.woff2'), sha256: '3b646991d30055a93a4ecc499713d4347953a74a947ecab435ab72070cbdab0e' },
  { file: 'ibm-plex-sans-500.woff2', family: 'IBM Plex Sans', weight: 500, version: 'Version 3.201', licence: 'OFL-IBMPlexSans.txt', source: fs('ibm-plex-sans', 'ibm-plex-sans-latin-500-normal.woff2'), sha256: '0717336fb31fcdcde4b8deb3675bb4a0f7f6d484864afcd6751ac29975962203' },
  { file: 'ibm-plex-sans-600.woff2', family: 'IBM Plex Sans', weight: 600, version: 'Version 3.201', licence: 'OFL-IBMPlexSans.txt', source: fs('ibm-plex-sans', 'ibm-plex-sans-latin-600-normal.woff2'), sha256: '8960851d691c054ed38e259bdcf1a6190d157b4203ed5bb32c632a863fb8ec2f' },
  { file: 'ibm-plex-mono-400.woff2', family: 'IBM Plex Mono', weight: 400, version: 'Version 2.3', licence: 'OFL-IBMPlexMono.txt', source: fs('ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff2'), sha256: '08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7' },
  { file: 'ibm-plex-mono-500.woff2', family: 'IBM Plex Mono', weight: 500, version: 'Version 2.3', licence: 'OFL-IBMPlexMono.txt', source: fs('ibm-plex-mono', 'ibm-plex-mono-latin-500-normal.woff2'), sha256: '01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22' },
]);

export { LOCKUP, LOGO_COLOURS, LOGO_FILES, type LogoFile, logoFile, MARK_BRACKET, MARK_CARD, MARK_SQUARE_VIEWBOX, MARK_VIEWBOX, PASSPORT_PATH, WORDMARK_PATH } from './logo.ts';

/**
 * The Journear mark (logo/journear-mark.svg, D789) as one SVG string, for pages that build HTML as strings: the card
 * takes `--jp-teal-500` and the bracket `--jp-orange-500` in both schemes (the logo's own colours, as the dark lockup
 * keeps them), or both `currentColor` for the mono mark. Never otherwise recoloured, no gradient, no shadow; at least
 * 20 px tall (the design system's logo rules).
 */
export function markSvg(opts: { size?: number; label?: string; mono?: boolean } = {}): string {
  const size = Math.max(20, opts.size ?? 20);
  const card = opts.mono ? 'currentColor' : 'var(--jp-teal-500)';
  const bracket = opts.mono ? 'currentColor' : 'var(--jp-orange-500)';
  const a11y = opts.label ? `role="img" aria-label="${opts.label.replace(/[&<>"']/gu, '')}"` : 'aria-hidden="true" focusable="false"';
  const [, , w, h] = MARK_VIEWBOX.split(' ').map(Number) as [number, number, number, number];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_VIEWBOX}" width="${Math.round((size * w) / h)}" height="${size}" ${a11y}>` +
    `<path fill="${card}" d="${MARK_CARD}"/><path fill="${bracket}" d="${MARK_BRACKET}"/>` +
    `</svg>`
  );
}
