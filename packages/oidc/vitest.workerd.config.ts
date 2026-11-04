// The whole suite again inside workerd (the runtime of the API, console and admin Workers), through the same
// @cloudflare/vitest-plugin the API and the watchdog use. No bindings, no network: every fetch is stubbed.
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ miniflare: { compatibilityDate: '2026-10-01' } })],
  test: {
    include: ['test/**/*.test.ts', 'test-workerd/**/*.test.ts'],
  },
});
