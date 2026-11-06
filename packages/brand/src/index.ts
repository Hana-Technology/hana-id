// Hana's brand for Hana ID's own pages (D426): the shared tokens (tokens.css), the self-hosted fonts (fonts.css and
// fonts/), and the mark and wordmark (logo/). This module is what code needs of it: the font files' manifest (checked by
// test/brand.test.ts and by each app that ships a copy) and the logo's paths, for pages that draw the mark inline
// (an inline SVG needs no image request and takes its colours from the page's CSS).

/** A shipped font file: Hana's own Montserrat build, subset to Latin (fonts/OFL.txt). */
export interface FontFile {
  readonly file: string;
  readonly family: 'Montserrat' | 'Montserrat Alternates';
  readonly weight: 400 | 500 | 600 | 700;
  /** The font's own version string (name ID 5). */
  readonly version: string;
  /** Where it came from: a path in Hana-Technology/hana-extension, before subsetting. */
  readonly source: string;
  readonly sha256: string;
}

export const FONT_LICENCE_FILE = 'OFL.txt';

export const FONT_FILES: readonly FontFile[] = Object.freeze([
  { file: 'Montserrat-400.woff2', family: 'Montserrat', weight: 400, version: 'Version 8.000', source: 'src/static/fonts/Montserrat-Regular.ttf', sha256: '8ae4207c0cdbc12e9941c5bf5f6df8fe7f3278221e582af0c7192100d032381a' },
  { file: 'Montserrat-500.woff2', family: 'Montserrat', weight: 500, version: 'Version 8.000', source: 'src/static/fonts/Montserrat-Medium.ttf', sha256: '7d0695ec9a451f1cb389731c35dd02c4554487e784e15a9569f69cc9422e7724' },
  { file: 'Montserrat-600.woff2', family: 'Montserrat', weight: 600, version: 'Version 8.000', source: 'src/static/fonts/Montserrat-SemiBold.ttf', sha256: 'a28317ce91e8fd198047cc09d2b28ab6a64144eb9983faeee607bc723e6ea87a' },
  { file: 'Montserrat-700.woff2', family: 'Montserrat', weight: 700, version: 'Version 8.000', source: 'src/static/fonts/Montserrat-Bold.ttf', sha256: '8ae8630a5e84940feb42bdbe8c1ef6fd8a0ab5d96ea09c051c6c3ab1fae04d12' },
  { file: 'MontserratAlternates-700.woff2', family: 'Montserrat Alternates', weight: 700, version: 'Version 7.200', source: 'src/static/fonts/MontserratAlternates-Bold.ttf', sha256: '081a4d0cdd1a90c56f55f2e72b7565463edfc9144ebae8e94f1da0e6088f9251' },
]);

/** The Hana mark's 50 × 50 glyph (hana-extension src/common/assets/logos/hana.svg), drawn over a rounded square. */
export const MARK_VIEWBOX = '0 0 50 50';
export const MARK_PATHS: readonly string[] = Object.freeze([
  'M13.7175 19.5813C18.4911 19.5813 22.3614 15.7111 22.3614 10.9375H36.287V27.4606H28.1016V19.6781C25.1482 24.528 19.811 27.7667 13.7175 27.7667V19.5813Z',
  'M36.287 30.9035H13.7175V39.0889H36.287V30.9035Z',
]);
/** The mark's square: the corner radius in the 50-unit box. */
export const MARK_RADIUS = 12;
