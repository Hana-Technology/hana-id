// The thin Worker's tests run in Node: its fetch uses only Request, Response and its service binding, which the tests
// stand in for (the console's AuthHandler is tested in apps/console, end to end).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
