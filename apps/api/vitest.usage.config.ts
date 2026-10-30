// Node-side tests of the usage ledger's Postgres DDL (apps/api/migrations-usage) on PGlite, or on a real Postgres when
// USAGE_TEST_DATABASE_URL is set (test-usage/db.ts). Never Neon.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test-usage/**/*.test.ts'],
    environment: 'node',
    // PGlite starts a WASM Postgres per test file.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
