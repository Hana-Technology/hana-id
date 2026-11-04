// The partner SPA's build (docs/batch-c-spec.md "Repo layout": React 18.3.1, Vite, React Router, client-only): web/ →
// dist/, which the console Worker serves as its assets (`run_worker_first`, so every asset gets the console's CSP).
// The CSP is `script-src 'self'; style-src 'self'`: the build must emit no inline script or style, so the modulepreload
// polyfill (an inline-capable helper) is off and every asset is a file (scripts/test/spa-build.test.ts builds and checks).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
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
