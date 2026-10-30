import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// CONSOLE_DB's migrations on a local D1 (Miniflare), as the console Worker will run them. Until the Worker exists
// (batch C7) there is no main module: the tests only use the D1 binding.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(new URL('./migrations', import.meta.url).pathname);
  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: '2026-10-01',
          compatibilityFlags: ['nodejs_compat'],
          bindings: { TEST_MIGRATIONS: migrations },
          d1Databases: { CONSOLE_DB: 'hana-id-console-test' },
        },
      }),
    ],
    test: { include: ['test/**/*.test.ts'] },
  };
});
