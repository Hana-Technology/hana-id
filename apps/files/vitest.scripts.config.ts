// Node-side tests for apps/files/scripts and the config and source checks (the Worker tests run in workerd via
// vitest.config.ts).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/test/**/*.test.ts'],
    environment: 'node',
  },
});
