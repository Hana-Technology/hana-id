import { defineConfig } from 'vitest/config';

// Unit tests only; the page itself is built by vite.config.ts (which needs a real manifest and the shell's variables).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // gen refuses a shell CLOUDFLARE_ACCOUNT_ID naming another account than a manifest's (D404): tests never inherit one.
    env: { CLOUDFLARE_ACCOUNT_ID: '' },
  },
});
