// The frozen vectors again, inside workerd (the Workers runtime the email issuer runs on), through the same
// @cloudflare/vitest-plugin the API and the watchdog use. No bindings, no network: the test only computes.
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ miniflare: { compatibilityDate: '2026-10-01' } })],
  test: {
    include: ['test-workerd/**/*.test.ts'],
  },
});
