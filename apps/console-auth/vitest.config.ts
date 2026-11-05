// The thin Worker's tests run in Node: its fetch uses only Request, Response and its service binding, which the tests
// stand in for (the console's AuthHandler is tested in apps/console, end to end).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // gen refuses a shell CLOUDFLARE_ACCOUNT_ID naming another account than a manifest's (D404): tests never inherit one.
    env: { CLOUDFLARE_ACCOUNT_ID: '' },
  },
});
