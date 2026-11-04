import { join } from 'node:path';
import { loadEnv as loadManifest } from '@hana-id/env';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { DEFAULT_ENV, pageEnvFrom } from './src/config.ts';

// The environment is chosen at build time: VITE_HANA_ENV (shell or .env.local), default sandbox-dev. The manifest is
// validated by @hana-id/env and only its public fields reach the pages. Two pages: index.html (through the vault,
// @hana-id/web) and direct.html (the in-page split flow, with its Google redirect page direct-callback.html).
export default defineConfig(({ mode }) => {
  const vars = loadEnv(mode, import.meta.dirname, 'VITE_');
  const envName = vars.VITE_HANA_ENV || DEFAULT_ENV;
  const pageEnv = pageEnvFrom(loadManifest(envName), vars.VITE_HANA_API_URL);
  return {
    define: { __HANA_SMOKE_ENV__: JSON.stringify(pageEnv) },
    server: { port: 5173, strictPort: true, host: 'localhost' },
    preview: { port: 5173, strictPort: true, host: 'localhost' },
    build: {
      // Local test tooling: the partner client, @hana-id/core and stellar-base in one ~0.5 MB chunk is fine.
      chunkSizeWarningLimit: 1024,
      rollupOptions: {
        input: {
          index: join(import.meta.dirname, 'index.html'),
          direct: join(import.meta.dirname, 'direct.html'),
          'direct-callback': join(import.meta.dirname, 'direct-callback.html'),
        },
      },
    },
    test: {
      include: ['test/**/*.test.ts'],
      environment: 'node',
    },
  };
});
