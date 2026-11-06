// The partner SPA's build (docs/batch-c-spec.md "Repo layout": React 18.3.1, Vite, React Router, client-only): web/ →
// dist/, which the console Worker serves as its assets (`run_worker_first`, so every asset gets the console's CSP,
// whose `font-src 'self'` lets the SPA load its own fonts and nothing else).
// The CSP is `script-src 'self'; style-src 'self'`: the build must emit no inline script or style, so the modulepreload
// polyfill (an inline-capable helper) is off and every asset is a file (scripts/test/spa-build.test.ts builds and checks).
// index.html gets this checkout's build id as `<meta name="hana-build">` (scripts/build-stamp.ts, D406).
// Hana's fonts (packages/brand, D426) come in through the stylesheet's @import and are emitted as /assets/*.woff2; their
// licence (SIL OFL 1.1) is emitted beside them as /assets/OFL.txt.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Plugin, defineConfig } from 'vite';
import { buildStamp } from './scripts/build-stamp.ts';

/** Emits the fonts' licence next to them (build only). */
function fontLicence(): Plugin {
  return {
    name: 'hana-font-licence',
    apply: 'build',
    generateBundle() {
      const source = readFileSync(fileURLToPath(new URL('../../packages/brand/fonts/OFL.txt', import.meta.url)), 'utf8');
      this.emitFile({ type: 'asset', fileName: 'assets/OFL.txt', source });
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [buildStamp(), fontLicence()],
  publicDir: false,
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    // Never a data: URL for a script, style or font (the CSP allows data: for images only).
    assetsInlineLimit: 0,
    sourcemap: false,
    target: 'es2022',
  },
});
