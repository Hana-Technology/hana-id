import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv as loadManifest } from '@hana-id/env';
import { tsImport } from 'tsx/esm/api';
import { type Plugin, defineConfig } from 'vite';

/**
 * The brand fonts' licences (SIL OFL 1.1, one per family: Archivo, IBM Plex Sans, IBM Plex Mono) next to the font
 * files Vite emits into assets/ (D426, D765), named as @hana-id/brand's FONT_LICENCE_FILES names them.
 */
const fontLicences = (files: readonly string[]): Plugin => ({
  name: 'hana-font-licences',
  apply: 'build',
  generateBundle() {
    for (const file of files) this.emitFile({ type: 'asset', fileName: `assets/${file}`, source: readFileSync(fileURLToPath(import.meta.resolve(`@hana-id/brand/fonts/${file}`))) });
  },
});

type ConfigModule = typeof import('./src/config.ts');
type CspModule = typeof import('./src/csp.ts');
type BrandModule = typeof import('@hana-id/brand');

// The configuration is chosen at build time from the shell (HANA_DEMO_ENV, HANA_DEMO_PUBLISHABLE_KEY; src/config.ts),
// validated, and baked into the bundle. scripts/gen-wrangler.ts reads the same variables for the Worker's CSP. No .env
// files are read, so the build and the Worker config can't see different values.
//
// src/config.ts validates with @hana-id/core, whose TypeScript Node can't load natively (Vite's config bundler leaves
// workspace packages external), so it is loaded through tsx.
export default defineConfig(async () => {
  const { demoConfigFromVars } = (await tsImport('./src/config.ts', import.meta.url)) as ConfigModule;
  const { pageCsp, securityHeaders } = (await tsImport('./src/csp.ts', import.meta.url)) as CspModule;
  const { FONT_LICENCE_FILES } = (await tsImport('@hana-id/brand', import.meta.url)) as BrandModule;
  const config = demoConfigFromVars(process.env, loadManifest);
  return {
    plugins: [fontLicences(FONT_LICENCE_FILES)],
    define: { __HANA_DEMO_CONFIG__: JSON.stringify(config) },
    // Local runs need http://localhost:5174 on the app's origins (README). The dev server injects inline styles, so
    // only `vite preview` (the built page) carries the page's CSP and headers.
    server: { port: 5174, strictPort: true, host: 'localhost' },
    preview: { port: 5174, strictPort: true, host: 'localhost', headers: securityHeaders(pageCsp(config)) },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      // No inline code anywhere (script-src/style-src 'self'): no preload polyfill, no data: URIs.
      modulePreload: { polyfill: false },
      assetsInlineLimit: 0,
      sourcemap: false,
      // The partner client and @hana-id/core in one chunk is fine for a demo.
      chunkSizeWarningLimit: 1024,
    },
  };
});
