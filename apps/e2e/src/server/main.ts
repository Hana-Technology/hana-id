// Starts the local stack (Playwright's webServer, playwright.config.ts): builds the bundles, then serves, with the
// default port base 4410 (HANA_E2E_PORT_BASE, src/ports.ts; each port is base + the offset shown; a linked worktree's
// default base is its own, src/checkout-port.ts)
//
//   http://localhost:4410                  the partner test app
//   http://site-b.localhost:4411           the partner test app on a second partner site
//   http://localhost:4412                  the hosted demo (apps/demo's Worker handler over its e2e build)
//   http://localhost:4413                  the stamps site (apps/stamps' Worker handler over its e2e build)
//   http://127.0.0.1:4420                  vaultOrigin (apps/api's vault host and vault page)
//   http://127.0.0.1:4430                  authOrigin (apps/api's auth host)
//   http://127.0.0.1:4440                  the Hana API: apps/api's Worker, /v1/login and /v1/derive mocked (and the
//                                          tests' /__e2e control endpoints)
//   http://127.0.0.1:4442                  the email issuer (apps/email-issuer's Worker, the outbox stub; /__e2e/outbox)
//   http://127.0.0.1:4443                  the staff admin portal, hand-test lane (apps/admin's Worker and SPA behind the
//                                          stack's Access stand-in, its own API copy and relayer: admin-lane.ts); sign in
//                                          at /__e2e/access/sign-in?as=staff
//   http://127.0.0.1:4444, :4445, :4446    the same, one lane per browser project (chromium, firefox, webkit)
//   http://127.0.0.1:4447, :4448, :4449    the partner console in those lanes (apps/console's Worker and SPA over the
//                                          lane's API, D899: lane-console.ts); sign in at /__e2e/console/sign-in
//   http://127.0.0.1:4452, :4453, :4454    the console's auth origin in those lanes (the fresh sign-in)
//   http://127.0.0.1:4450                  the mocked NEAR RPC
//   http://127.0.0.1:4451                  the same chain, as the env's rpcFallback (D263)
//   http://127.0.0.1:4460                  the mocked EVM chain RPC
//   http://127.0.0.1:4421, :4431, :4441    live mode's vault, auth and API hosts (LIVE_ENV, src/stack.ts): the same
//                                          apps/api code on the same D1 and chain, serving the https origins the
//                                          tests route to them
//
//   [HANA_E2E_PORT_BASE=4510] pnpm --filter @hana-id/e2e serve [--no-build]
//
// Google is not served here: the tests route accounts.google.com and www.googleapis.com to an OIDC stub inside the
// browser context (src/google-stub.ts), so the bundles keep their hard-coded Google endpoints.
import '../port-env.ts'; // first: this checkout's port base, before stack.ts reads it
import { buildAll } from '../build.ts';
import { stackFingerprint } from '../fingerprint.ts';
import { ADMIN_LANES, CONSOLE_LANES, EMAIL_ISS, LIVE_API_URL, LIVE_AUTH_ORIGIN, LIVE_ENV_NAME, LIVE_NEAR_RPC, LIVE_VAULT_ORIGIN, PORTS } from '../stack.ts';
import { MockApi } from './api.ts';
import { GoogleBackend } from './google-backend.ts';
import { newAccessKeys } from './access.ts';
import { AdminLanes } from './admin-lane.ts';
import { LocalIssuer, newIssuerKey } from './issuer.ts';
import { loadApiModules } from './api-modules.ts';
import { Chain } from './chain.ts';
import { D1Shim } from './d1.ts';
import { demoHost } from './demo.ts';
import { stampsHost } from './stamps.ts';
import { authHost, type PagesEnv, vaultHost } from './hosts.ts';
import { serve, servedAt } from './http.ts';
import { MockEvm, partnerHost } from './partner.ts';
import { e2eRelayer } from '../relayer-key.ts';

export async function startStack(fingerprint: string): Promise<void> {
  const modules = await loadApiModules();
  const d1 = new D1Shim();
  const chain = new Chain();
  // Email login (batch 8a): the issuer's throwaway key, active on the mocked chain and known to the API.
  const issuerKey = newIssuerKey();
  chain.emailKey = { kid: issuerKey.publicJwk.kid, n: issuerKey.publicJwk.n, e: issuerKey.publicJwk.e };
  // Google's server-side endpoints for the Workers in this process (google-match's tokeninfo, userinfo, JWKS, revoke).
  const google = await GoogleBackend.create();
  google.install();
  chain.googleKid = google.kid;
  const evm = new MockEvm(e2eRelayer().address);
  const api = new MockApi(d1, chain, modules, { fingerprint, email: { iss: EMAIL_ISS, publicKeys: [issuerKey.publicJwk] }, googleKey: () => google.privateJwk(), evm });
  // The stack's Cloudflare Access stand-in (access.ts): one team key, for the issuer's staff routes and the admin lanes.
  const access = newAccessKeys();
  const issuer = await LocalIssuer.start(d1, issuerKey, access);
  const loopback = ['127.0.0.1'];

  // Browsers resolve localhost and *.localhost to 127.0.0.1 or ::1; listen on both where the machine has IPv6 loopback.
  const partnerHosts = ['127.0.0.1', ...(await hasIpv6Loopback() ? ['::1'] : [])];
  await serve(PORTS.partner, partnerHosts, partnerHost());
  await serve(PORTS.siteB, partnerHosts, partnerHost());
  await serve(PORTS.demo, partnerHosts, demoHost());
  await serve(PORTS.stamps, partnerHosts, stampsHost());
  await serve(PORTS.vault, loopback, vaultHost(modules, d1));
  await serve(PORTS.auth, loopback, authHost(modules));
  await serve(PORTS.api, loopback, (req) => api.handle(req));
  await serve(PORTS.issuer, loopback, issuer.handler());
  // The staff admin portal's lanes: each starts on its first request (admin-lane.ts).
  const lanes = new AdminLanes({ access, issuer: issuer.directoryRpc });
  const lanePorts = { demo: PORTS.admin, chromium: PORTS.adminChromium, firefox: PORTS.adminFirefox, webkit: PORTS.adminWebkit } as const;
  for (const [name, origin] of Object.entries(ADMIN_LANES)) await serve(lanePorts[name as keyof typeof lanePorts], loopback, lanes.handler(name, origin));
  // The partner console in the browser lanes (D899): the same lane thread answers its two origins.
  const consolePorts = { chromium: [PORTS.consoleChromium, PORTS.consoleAuthChromium], firefox: [PORTS.consoleFirefox, PORTS.consoleAuthFirefox], webkit: [PORTS.consoleWebkit, PORTS.consoleAuthWebkit] } as const;
  for (const name of Object.keys(CONSOLE_LANES) as (keyof typeof CONSOLE_LANES)[]) for (const port of consolePorts[name]) await serve(port, loopback, lanes.handler(name, ADMIN_LANES[name]));
  // Live mode (LIVE_ENV): a second Worker and pair of page hosts for the https origins, on the same D1 and chain.
  const live: PagesEnv = { envName: LIVE_ENV_NAME, vaultOrigin: LIVE_VAULT_ORIGIN, authOrigin: LIVE_AUTH_ORIGIN, apiUrl: LIVE_API_URL, nearRpc: LIVE_NEAR_RPC };
  const liveApi = new MockApi(d1, chain, modules, { serves: live });
  await serve(PORTS.liveVault, loopback, servedAt(LIVE_VAULT_ORIGIN, vaultHost(modules, d1, live)));
  await serve(PORTS.liveAuth, loopback, servedAt(LIVE_AUTH_ORIGIN, authHost(modules, live)));
  await serve(PORTS.liveApi, loopback, servedAt(LIVE_API_URL, (req) => liveApi.handle(req)));
  await serve(PORTS.near, loopback, chain.handler());
  // The env's rpcFallback: another endpoint on the same chain (a member's path is confirmed on both, D263).
  await serve(PORTS.nearFallback, loopback, chain.handler());
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
