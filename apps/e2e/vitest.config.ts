import { defineConfig } from 'vitest/config';

// Unit tests of the e2e stack itself (test/): the mocks must behave as the real services do for the suite to mean
// anything. The Playwright specs are in tests/ and run with `pnpm e2e`.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
