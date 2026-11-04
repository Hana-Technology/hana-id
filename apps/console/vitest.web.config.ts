// The partner SPA's component tests (web/test), in happy-dom with the console's API mocked at `fetch`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['web/test/**/*.test.tsx'],
    environment: 'happy-dom',
  },
});
