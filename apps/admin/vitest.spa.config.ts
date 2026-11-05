// The staff SPA's DOM tests (test-spa): public/app.js run as the browser runs it, in a happy-dom window per test, with the admin Worker's
// API mocked at `fetch` (the routes themselves are tested in workerd: vitest.config.ts).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test-spa/**/*.test.ts'],
    environment: 'node',
  },
});
