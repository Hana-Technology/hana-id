import { loadEnv as loadManifest } from '@hana-id/env';
import { tsImport } from 'tsx/esm/api';
import { defineConfig } from 'vite';

type ConfigModule = typeof import('./src/config.ts');
type CspModule = typeof import('./src/csp.ts');

// The configuration is chosen at build time from the shell (HANA_DEMO_ENV, HANA_DEMO_PUBLISHABLE_KEY; src/config.ts),
// validated, and baked into the bundle. scripts/gen-wrangler.ts reads the same variables for the Worker's CSP. No .env
// files are read, so the build and the Worker config can't see different values.
//
// src/config.ts validates with @hana-id/core, whose TypeScript Node can't load natively (Vite's config bundler leaves
// workspace packages external), so it is loaded through tsx.
export default defineConfig(async () => {
  const { demoConfigFromVars } = (await tsImport('./src/config.ts', import.meta.url)) as ConfigModule;
  const { pageCsp, securityHeaders } = (await tsImport('./src/csp.ts', import.meta.url)) as CspModule;
  const config = demoConfigFromVars(process.env, loadManifest);
  return {
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
