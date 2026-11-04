// Node-side tests for apps/watchdog/scripts (the Worker tests run in workerd via vitest.config.ts).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/test/**/*.test.ts'],
    environment: 'node',
  },
});
