// Starts the local stack (Playwright's webServer, playwright.config.ts): builds the bundles, then serves
//
//   http://localhost:4410, http://127.0.0.1:4411   the partner test app (two sites)
//   http://127.0.0.1:4420                          vaultOrigin (apps/api's vault host and vault page)
//   http://127.0.0.1:4430                          authOrigin (apps/api's auth host)
//   http://127.0.0.1:4440                          the mocked Hana API (and the tests' /__e2e control endpoints)
//   http://127.0.0.1:4450                          the mocked NEAR RPC
//   http://127.0.0.1:4460                          the mocked EVM chain RPC
//
//   pnpm --filter @hana-id/e2e serve [--no-build]
//
// Google is not served here: the tests route accounts.google.com and www.googleapis.com to an OIDC stub inside the
// browser context (tests/google-stub.ts), so the bundles keep their hard-coded Google endpoints.
import { buildAll } from '../build.ts';
import { PORTS } from '../stack.ts';
import { MockApi } from './api.ts';
import { loadApiModules } from './api-modules.ts';
import { Chain } from './chain.ts';
import { D1Shim } from './d1.ts';
import { authHost, vaultHost } from './hosts.ts';
import { serve } from './http.ts';
import { MockEvm, partnerHost } from './partner.ts';

export async function startStack(): Promise<void> {
  const modules = await loadApiModules();
  const d1 = new D1Shim();
  const chain = new Chain();
  const api = new MockApi(d1, chain, modules);
  const evm = new MockEvm();
  const loopback = ['127.0.0.1'];

  const nearRpc = async (request: Request): Promise<Response> => {
    const cors = { 'access-control-allow-origin': request.headers.get('origin') ?? '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const res = chain.rpc(await request.json().catch(() => null));
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  };

  // localhost may resolve to ::1 first; listen there too where the machine has IPv6 loopback.
  const partnerHosts = ['127.0.0.1', ...(await hasIpv6Loopback() ? ['::1'] : [])];
  await serve(PORTS.partner, partnerHosts, partnerHost());
  await serve(PORTS.siteB, loopback, partnerHost());
  await serve(PORTS.vault, loopback, vaultHost(modules, d1));
  await serve(PORTS.auth, loopback, authHost(modules));
  await serve(PORTS.api, loopback, (req, signal) => api.handle(req, signal));
  await serve(PORTS.near, loopback, nearRpc);
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

if (!process.argv.includes('--no-build')) await buildAll();
await startStack();
console.log('[e2e] stack ready');
