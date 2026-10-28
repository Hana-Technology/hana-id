// Starts the local stack (Playwright's webServer, playwright.config.ts): builds the bundles, then serves, with the
// default port base 4410 (HANA_E2E_PORT_BASE, src/stack.ts; each port is base + the offset shown)
//
//   http://localhost:4410                  the partner test app
//   http://site-b.localhost:4411           the partner test app on a second partner site
//   http://127.0.0.1:4420                  vaultOrigin (apps/api's vault host and vault page)
//   http://127.0.0.1:4430                  authOrigin (apps/api's auth host)
//   http://127.0.0.1:4440                  the Hana API: apps/api's Worker, /v1/login and /v1/derive mocked (and the
//                                          tests' /__e2e control endpoints)
//   http://127.0.0.1:4450                  the mocked NEAR RPC
//   http://127.0.0.1:4460                  the mocked EVM chain RPC
//
//   [HANA_E2E_PORT_BASE=4510] pnpm --filter @hana-id/e2e serve [--no-build]
//
// Google is not served here: the tests route accounts.google.com and www.googleapis.com to an OIDC stub inside the
// browser context (src/google-stub.ts), so the bundles keep their hard-coded Google endpoints.
import { buildAll } from '../build.ts';
import { stackFingerprint } from '../fingerprint.ts';
import { PORTS } from '../stack.ts';
import { MockApi } from './api.ts';
import { loadApiModules } from './api-modules.ts';
import { Chain } from './chain.ts';
import { D1Shim } from './d1.ts';
import { authHost, vaultHost } from './hosts.ts';
import { serve } from './http.ts';
import { MockEvm, partnerHost } from './partner.ts';

export async function startStack(fingerprint: string): Promise<void> {
  const modules = await loadApiModules();
  const d1 = new D1Shim();
  const chain = new Chain();
  const api = new MockApi(d1, chain, modules, { fingerprint });
  const evm = new MockEvm();
  const loopback = ['127.0.0.1'];

  // Browsers resolve localhost and *.localhost to 127.0.0.1 or ::1; listen on both where the machine has IPv6 loopback.
  const partnerHosts = ['127.0.0.1', ...(await hasIpv6Loopback() ? ['::1'] : [])];
  await serve(PORTS.partner, partnerHosts, partnerHost());
  await serve(PORTS.siteB, partnerHosts, partnerHost());
  await serve(PORTS.vault, loopback, vaultHost(modules, d1));
  await serve(PORTS.auth, loopback, authHost(modules));
  await serve(PORTS.api, loopback, (req) => api.handle(req));
  await serve(PORTS.near, loopback, chain.handler());
  await serve(PORTS.evm, loopback, evm.handler());
}

async function hasIpv6Loopback(): Promise<boolean> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(0, '::1', () => s.close(() => resolve(true)));
  });
}

// apps/api's info-level request logs (one JSON line per request) would bury Playwright's output: LOG=1 shows them.
// Warnings and errors always show.
if (!process.env.LOG) {
  const info = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('{"level":"info"')) return;
    info(...args);
  };
}

// Of the code as it is before the build reads it: what /__e2e/health reports to tests/global-setup.ts.
const fingerprint = stackFingerprint();
if (!process.argv.includes('--no-build')) await buildAll();
await startStack(fingerprint);
console.log('[e2e] stack ready');
