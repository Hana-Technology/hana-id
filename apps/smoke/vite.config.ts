import { loadEnv as loadManifest } from '@hana-id/env';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { DEFAULT_ENV, pageEnvFrom } from './src/config.ts';

// The environment is chosen at build time: VITE_HANA_ENV (shell or .env.local), default sandbox-dev. The manifest is
// validated by @hana-id/env and only its public fields reach the page.
export default defineConfig(({ mode }) => {
  const vars = loadEnv(mode, import.meta.dirname, 'VITE_');
  const envName = vars.VITE_HANA_ENV || DEFAULT_ENV;
  const pageEnv = pageEnvFrom(loadManifest(envName), vars.VITE_HANA_API_URL);
  return {
    define: { __HANA_SMOKE_ENV__: JSON.stringify(pageEnv) },
    server: { port: 5173, strictPort: true, host: 'localhost' },
    preview: { port: 5173, strictPort: true, host: 'localhost' },
    test: {
      include: ['test/**/*.test.ts'],
      environment: 'node',
    },
  };
});
