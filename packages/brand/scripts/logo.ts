// Writes the mark and lockup files in logo/ (journear-mark*.svg, journear-lockup*.svg) from src/logo.ts, the logo's one
// source of geometry and colours (D789). Run after a change there, then the mail logo (it is drawn from the lockup):
//
//   pnpm --filter @hana-id/brand logo
//   pnpm --filter @hana-id/brand mail-logo
//
// test/brand.test.ts fails while a file differs from what this would write. The wordmark files (the outline alone) are
// not written here: the test checks their outline is src/logo.ts's WORDMARK_PATH.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOGO_FILES, logoFile } from '../src/logo.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'logo');
for (const name of LOGO_FILES) {
  const svg = logoFile(name);
  writeFileSync(join(dir, name), svg);
  console.log(`logo/${name}: ${svg.length} bytes`);
}
