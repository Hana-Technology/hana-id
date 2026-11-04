// Node-side tests of the admin Worker's Postgres state (src/ops.ts: ops.state, ops.scope_snapshot, ops.scope_watch)
// against the usage ledger's real migrations (apps/api/migrations-usage) on PGlite, run as the usage_admin role, or on
// a real Postgres when USAGE_TEST_DATABASE_URL is set (apps/api/test-usage/db.ts). Never Neon.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test-ops/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
