import { defineConfig } from 'vitest/config';

// Unit tests only. The UI module's tests (test/ui/) run in happy-dom, chosen per file.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
