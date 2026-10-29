import { defineConfig } from 'vitest/config';

// Unit tests only; the page itself is built by vite.config.ts (which needs a real manifest and the shell's variables).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
