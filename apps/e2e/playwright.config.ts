// Playwright suite (docs/batch-b-spec.md "Tests → Playwright"): Chromium, WebKit and Firefox against the local stack
// (src/server/main.ts), which builds the bundles for the e2e env and serves them on loopback origins.
//
//   pnpm --filter @hana-id/e2e e2e:install   # once: the three browsers (CI adds their system dependencies)
//   pnpm --filter @hana-id/e2e e2e [--project webkit] [tests/login.spec.ts]
// First: this checkout's port base (src/port-env.ts) before src/stack.ts reads it.
import './src/port-env.ts';
import { defineConfig, devices } from '@playwright/test';
import { API_URL } from './src/stack.ts';

const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: CI,
  // A retry keeps the failing attempt's trace, but a test that only passed on retry still fails the run: several cases
  // are timing-dependent security checks (the Approve guard, the double-click, the reused popup), where an intermittent
  // pass is a regression, not flakiness.
  retries: CI ? 1 : 0,
  failOnFlakyTests: CI,
  workers: CI ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        // Firefox's shipped default (Total Cookie Protection: storage partitioned by top-level site); Playwright's own
        // profile turns it off.
        launchOptions: { firefoxUserPrefs: { 'network.cookie.cookieBehavior': 5 } },
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  // The stack listening on the fixed ports must be this checkout's current code (src/fingerprint.ts).
  globalSetup: './tests/global-setup.ts',
  webServer: {
    command: 'node --import tsx src/server/main.ts',
    url: `${API_URL}/__e2e/health`,
    reuseExistingServer: !CI,
    timeout: 120_000,
    stdout: 'pipe',
  },
});
