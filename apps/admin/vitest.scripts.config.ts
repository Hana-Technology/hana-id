// Node-side tests for apps/admin/scripts, the config snapshots across Workers and the source checks (the Worker tests
// run in workerd via vitest.config.ts; the ops store's SQL on PGlite via vitest.ops.config.ts).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/test/**/*.test.ts'],
    environment: 'node',
    // gen refuses a shell CLOUDFLARE_ACCOUNT_ID naming another account than a manifest's (D404): tests never inherit one.
    env: { CLOUDFLARE_ACCOUNT_ID: '' },
  },
});
