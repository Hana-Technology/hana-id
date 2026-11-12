// The NEAR meta-transaction tests against a real node (test-sandbox/, D731): Node, one file at a time, each starting
// its own near-sandbox. Run by `pnpm --filter @hana-id/api test:sandbox` and by `pnpm verify`'s sandbox lane after the
// contract lane has downloaded the binary; skipped when no binary is found unless HANA_SANDBOX_REQUIRED=1.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test-sandbox/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
