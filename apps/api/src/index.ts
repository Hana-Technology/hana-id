// Hana ID API: relays hana-signer calls for registered apps (Cloudflare Worker + Durable Objects + D1).
import type { Env } from './env.ts';
import { type AppEndpoint, APP_CONFIG_ENDPOINT, APP_ENDPOINTS, appPreflight, handleAppConfig, handleAppEndpoint, handleHealth, handleOwnerAction, openPreflight } from './handlers.ts';
import { GOVERNANCE_ENDPOINT, handleGovernance } from './governance-status.ts';
import { json } from './http.ts';
import { detectDrift } from './changes/drift.ts';
import { WALLET_RECORD_ENDPOINT, handleWalletRecord } from './directory/record.ts';
import { MAINNET_DEMO_EVENTS_ENDPOINT, handleMainnetDemoEvent } from './mainnet-demo.ts';
import { guardedChangesMaintenance } from './guarded/cron.ts';
import { HOME_APPS_ENDPOINT, handleHomeApps } from './home/apps.ts';
import { HOME_CONFIG_ENDPOINT, handleHomeConfig } from './home/config.ts';
import { HOME_DEVICES_ENDPOINT, handleHomeDevices } from './home/devices.ts';
import { handleHomeRevoke, isHomeRevokeEndpoint } from './home/revoke.ts';
import { HOME_LOGIN_ENDPOINT, handleHomeLogin } from './home/login.ts';
import { homePreflight } from './home/identity.ts';
import { syncIssuerKeys } from './issuer-keys.ts';
import { identityMaintenance } from './identity/maintenance.ts';
import { IDENTITY_PUBLIC_ENDPOINTS, handleIdentityPublic } from './identity/public.ts';
import { IDENTITY_TOKEN_ENDPOINT, handleIdentityToken } from './identity/token.ts';
import { EMAIL_CONSENT_ENDPOINTS, authPreflight, handleEmailConsent, isEmailConsentEndpoint } from './identity/email.ts';
import { log } from './log.ts';
import { checkOwnerPoolAllowance } from './owner-pool.ts';
import { LOGIN_ENDPOINT, handleLogin } from './login.ts';
import { LOGIN_RELAY_PREFIX, handleLoginRelay, loggedEndpoint } from './login-relay.ts';
import { LINK_ENDPOINTS, type LinkEndpoint, handleLinkEndpoint } from './links.ts';
import { syncEmailUsage } from './usage/email-sync.ts';
import { syncIdentityUsage } from './usage/identity-sync.ts';
import { ensureUsagePartitions } from './usage/partitions.ts';
import { vaultMaintenance } from './vault/cron.ts';
import { handleVaultConsent, isConsentEndpoint } from './vault/consents.ts';
import { handleVaultEndpoint, isVaultEndpoint, vaultPreflight } from './vault/endpoints.ts';
import { SHARE_STATUS_ENDPOINT, handleShareStatus } from './vault/share-status.ts';
import { BASE_CSP, handleVaultPage, isVaultPageRequest } from './vault/page.ts';

export { LoginRelay } from './login-relay.ts';
// Batch C's RPC entrypoints (no route: bound by the console and the admin Worker only, docs/batch-c-spec.md "RPC"),
// and the email issuer's read-only app lookups (no route: bound by the issuer only, D434).
export { AdminRpc } from './rpc/admin.ts';
export { ConsoleRpc } from './rpc/console.ts';
export { IssuerRpc } from './rpc/issuer.ts';
export { RateLimiter } from './rate-limiter.ts';
export { RelayerKey } from './relayer-key.ts';
export type { Env } from './env.ts';

const ID_RE = /^[A-Za-z0-9-]{1,64}$/u;

/**
 * The cron fires every 15 min (one quarter-hourly trigger from gen-wrangler.ts: the free plan allows 5 per
 * account). Every run syncs Google's JWKS with hana-signer (proposals and matured executions, issuer-keys.ts; the
 * governance spec's P = 15 min). The run in the first quarter of each UTC hour also does vault maintenance, prunes
 * the identity token's counts past their retention, records guarded changes' activations and expiries
 * (guarded/cron.ts), runs drift detection (changes/drift.ts), keeps the usage ledger's monthly partitions 12
 * months ahead (usage/partitions.ts), copies the recent identity token counts to it (usage/identity-sync.ts) and
 * checks the owner pool's allowance (owner-pool.ts, never fails the run). A Worker
 * still on the old `0 * * * *` trigger only ever gets hourly runs.
 */
export function isHourlyRun(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCMinutes() < 15;
}

/** The router's own JSON errors (404, 405, 500), with `x-request-id` like every handled response. */
function routeError(status: number, code: string, error: string, requestId: string, extra: Record<string, string> = {}): Response {
  return json(status, { error, code, requestId }, { 'x-request-id': requestId, ...extra });
}

function newRequestId(request: Request): string {
  const ray = request.headers.get('cf-ray');
  return ray && ID_RE.test(ray) ? ray : crypto.randomUUID();
}

/**
 * A Hana page origin (`VAULT_ORIGIN`, `AUTH_ORIGIN`) in the request URL. Those origins serve only their pages
 * (docs/batch-b-spec.md "Origins and pages"), so here they get `/vault` (vault origin) and nothing else: never the
 * API, which would otherwise be same-origin with the vault's storage.
 */
function onHanaPageOrigin(url: URL, env: Env): boolean {
  return (!!env.VAULT_ORIGIN && url.origin === env.VAULT_ORIGIN) || (!!env.AUTH_ORIGIN && url.origin === env.AUTH_ORIGIN);
}

/** 404 on a Hana page origin, with the page Workers' headers: nothing to run, frame or sniff. */
function pageOriginNotFound(head: boolean, requestId: string): Response {
  return new Response(head ? null : 'Not found\n', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-security-policy': [...BASE_CSP, "frame-ancestors 'none'"].join('; '),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-request-id': requestId,
    },
  });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const requestId = newRequestId(request);
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (isVaultPageRequest(request, env)) {
        if (request.method === 'GET' || request.method === 'HEAD') return await handleVaultPage(request, env, requestId);
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'GET, HEAD' });
      }
      if (onHanaPageOrigin(url, env)) return pageOriginNotFound(request.method === 'HEAD', requestId);
      if (pathname === '/v1/health') {
        if (request.method === 'GET' || request.method === 'HEAD') return handleHealth(env, requestId);
        if (request.method === 'OPTIONS') return openPreflight();
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'GET' });
      }
      if (pathname === GOVERNANCE_ENDPOINT) {
        if (request.method === 'GET' || request.method === 'HEAD') return await handleGovernance(request, env, requestId);
        if (request.method === 'OPTIONS') return openPreflight();
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'GET' });
      }
      if (pathname === APP_CONFIG_ENDPOINT) {
        if (request.method === 'OPTIONS') return await appPreflight(request, env);
        if (request.method === 'GET') return await handleAppConfig(request, env, requestId, ctx);
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'GET, OPTIONS' });
      }
      if (APP_ENDPOINTS.includes(pathname)) {
        if (request.method === 'OPTIONS') return await appPreflight(request, env);
        if (request.method === 'POST') return await handleAppEndpoint(request, env, pathname as AppEndpoint, requestId, ctx);
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'POST, OPTIONS' });
      }
      if (pathname === LOGIN_ENDPOINT) {
        if (request.method === 'OPTIONS') return await appPreflight(request, env);
        if (request.method === 'POST') return await handleLogin(request, env, requestId, ctx);
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'POST, OPTIONS' });
      }
      if (LINK_ENDPOINTS.includes(pathname)) {
        if (request.method === 'OPTIONS') return await appPreflight(request, env);
        if (request.method === 'POST') return await handleLinkEndpoint(request, env, pathname as LinkEndpoint, requestId, ctx);
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'POST, OPTIONS' });
      }
      if (pathname.startsWith(LOGIN_RELAY_PREFIX)) return await handleLoginRelay(request, env, requestId);
      if (isVaultEndpoint(pathname)) {
        if (request.method === 'OPTIONS') return vaultPreflight(request, env);
        if (request.method === 'POST') return await handleVaultEndpoint(request, env, pathname, requestId, ctx);
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'POST, OPTIONS' });
      }
      if (pathname === SHARE_STATUS_ENDPOINT) {
        // Vault only, like /v1/vault/* (D690: the share's status, for an open tab signed out from Hana Home).
        if (request.method === 'OPTIONS') return vaultPreflight(request, env);
        if (request.method === 'POST') return await handleShareStatus(request, env, requestId);
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'POST, OPTIONS' });
      }
      if (isConsentEndpoint(pathname)) {
        // Vault only, like /v1/vault/* (Hana Home H4: the server's record of auto-approve consents).
        if (request.method === 'OPTIONS') return vaultPreflight(request, env);
        if (request.method === 'POST') return await handleVaultConsent(request, env, pathname, requestId);
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'POST, OPTIONS' });
      }
      if (pathname === IDENTITY_TOKEN_ENDPOINT) {
        // Vault only, like /v1/vault/* (same preflight: Origin must be VAULT_ORIGIN).
        if (request.method === 'OPTIONS') return vaultPreflight(request, env);
        if (request.method === 'POST') return await handleIdentityToken(request, env, requestId, ctx);
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'POST, OPTIONS' });
      }
      if (isEmailConsentEndpoint(pathname)) {
        // D411: the vault's consent calls (vault only, like the mint) and the auth popup's preview (AUTH_ORIGIN only).
        if (request.method === 'OPTIONS') return pathname === EMAIL_CONSENT_ENDPOINTS.preview ? authPreflight(request, env) : vaultPreflight(request, env);
        if (request.method === 'POST') return await handleEmailConsent(request, env, pathname, requestId);
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'POST, OPTIONS' });
      }
      if (pathname === WALLET_RECORD_ENDPOINT) {
        // Vault only, like /v1/vault/* (the wallet directory, D310).
        if (request.method === 'OPTIONS') return vaultPreflight(request, env);
        if (request.method === 'POST') return await handleWalletRecord(request, env, requestId);
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'POST, OPTIONS' });
      }
      if (pathname === MAINNET_DEMO_EVENTS_ENDPOINT) {
        // Vault only (D428): one mainnet demo signature, reported after it is made.
        if (request.method === 'OPTIONS') return vaultPreflight(request, env);
        if (request.method === 'POST') return await handleMainnetDemoEvent(request, env, requestId);
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'POST, OPTIONS' });
      }
      if (pathname === HOME_CONFIG_ENDPOINT) {
        // Hana Home (docs/hana-home-spec.md): `AUTH_ORIGIN` only. No identity yet: the page calls it before a sign-in.
        if (request.method === 'OPTIONS') return homePreflight(request, env);
        if (request.method === 'GET') return await handleHomeConfig(request, env, requestId);
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'GET, OPTIONS' });
      }
      if (pathname === HOME_APPS_ENDPOINT) {
        // Hana Home's app list (H2): a Home identity sees its own rows only. No key is derived here.
        if (request.method === 'OPTIONS') return homePreflight(request, env);
        if (request.method === 'GET') return await handleHomeApps(request, env, requestId);
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'GET, OPTIONS' });
      }
      if (pathname === HOME_DEVICES_ENDPOINT) {
        // Hana Home's devices (H9): a Home identity's own live shares, consents and email sharing. D1 only.
        if (request.method === 'OPTIONS') return homePreflight(request, env);
        if (request.method === 'GET') return await handleHomeDevices(request, env, requestId);
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'GET, OPTIONS' });
      }
      if (isHomeRevokeEndpoint(pathname)) {
        // Hana Home's stops (H9): a consent, a device, email sharing; only the identity's own rows (404 otherwise).
        if (request.method === 'OPTIONS') return homePreflight(request, env);
        if (request.method === 'POST') return await handleHomeRevoke(request, env, pathname, requestId);
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'POST, OPTIONS' });
      }
      if (pathname === HOME_LOGIN_ENDPOINT) {
        // Hana Home's derive (H3): a Home identity, no app gate, relayed through the Home pool.
        if (request.method === 'OPTIONS') return homePreflight(request, env);
        if (request.method === 'POST') return await handleHomeLogin(request, env, requestId, ctx);
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'POST, OPTIONS' });
      }
      if (IDENTITY_PUBLIC_ENDPOINTS.includes(pathname)) {
        if (request.method === 'GET' || request.method === 'HEAD') return handleIdentityPublic(request, env, pathname, requestId);
        if (request.method === 'OPTIONS') return openPreflight();
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'GET, HEAD, OPTIONS' });
      }
      if (pathname === '/v1/owner-actions') {
        if (request.method === 'OPTIONS') return openPreflight();
        if (request.method === 'POST') return await handleOwnerAction(request, env, requestId, ctx);
        return routeError(405, 'method_not_allowed', 'Method not allowed', requestId, { allow: 'POST, OPTIONS' });
      }
      return routeError(404, 'not_found', 'Not found', requestId);
    } catch {
      log({ event: 'request', requestId, endpoint: loggedEndpoint(pathname), outcome: 'error', status: 500, code: 'internal' }, 'error');
      return routeError(500, 'internal', 'Internal error', requestId);
    }
  },

  async scheduled(controller, env, _ctx): Promise<void> {
    // Independent jobs: one failing must not skip the other. The sync records the JWKS observation from its fetch.
    const jobs: Promise<unknown>[] = [syncIssuerKeys(env)];
    if (isHourlyRun(controller.scheduledTime)) {
      jobs.push(vaultMaintenance(env), identityMaintenance(env), guardedChangesMaintenance(env), detectDrift(env));
      // Usage fails open: these log their own failures and never fail the run (the next hour tries again). Partitions
      // first, so the copy and the hour's events have their months. Pushed last: the destructuring below is positional.
      jobs.push(ensureUsagePartitions(env).then(() => Promise.all([syncIdentityUsage(env), syncEmailUsage(env)])));
      // Logs its own failures too; also positional-last.
      jobs.push(checkOwnerPoolAllowance(env));
    }
    const [issuerKeys, vault, identity, guarded, drift] = await Promise.allSettled(jobs);
    if (vault?.status === 'rejected') log({ event: 'vault_maintenance', outcome: 'error', code: 'internal' }, 'error');
    if (identity?.status === 'rejected') log({ event: 'identity_maintenance', outcome: 'error', code: 'internal' }, 'error');
    if (guarded?.status === 'rejected') log({ event: 'guarded_change_cron', outcome: 'error', code: 'internal' }, 'error');
    if (drift?.status === 'rejected') log({ event: 'drift_detection', outcome: 'error', code: 'internal' }, 'error');
    if (issuerKeys?.status === 'rejected') throw issuerKeys.reason;
    if (vault?.status === 'rejected') throw vault.reason;
    if (identity?.status === 'rejected') throw identity.reason;
    if (guarded?.status === 'rejected') throw guarded.reason;
    if (drift?.status === 'rejected') throw drift.reason;
  },
} satisfies ExportedHandler<Env>;
