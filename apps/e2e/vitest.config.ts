import { defineConfig } from 'vitest/config';

// Unit tests of the e2e stack itself (test/): the mocks must behave as the real services do for the suite to mean
// anything. The Playwright specs are in tests/ and run with `pnpm e2e`.
export default defineConfig({
  resolve: {
    // apps/api's Durable Object classes, run in Node (src/server/workers.ts does the same for tsx).
    alias: { 'cloudflare:workers': new URL('./src/server/cloudflare-workers.ts', import.meta.url).pathname },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // apps/api's structured JSON request logs are noise in test output (set LOG=1 to see them).
    onConsoleLog: (log: string) => (process.env.LOG || !log.startsWith('{"level"') ? undefined : false),
  },
});
