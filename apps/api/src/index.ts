// Hana ID API: relays hana-signer calls for registered apps (Cloudflare Worker + Durable Objects + D1).
import type { Env } from './env.ts';
import { type AppEndpoint, APP_CONFIG_ENDPOINT, APP_ENDPOINTS, appPreflight, handleAppConfig, handleAppEndpoint, handleHealth, handleOwnerAction, openPreflight } from './handlers.ts';
import { json } from './http.ts';
import { syncIssuerKeys } from './issuer-keys.ts';
import { log } from './log.ts';
import { LOGIN_ENDPOINT, handleLogin } from './login.ts';
import { LOGIN_RELAY_PREFIX, handleLoginRelay } from './login-relay.ts';

export { LoginRelay } from './login-relay.ts';
export { RateLimiter } from './rate-limiter.ts';
export { RelayerKey } from './relayer-key.ts';
export type { Env } from './env.ts';

const ID_RE = /^[A-Za-z0-9-]{1,64}$/u;

function newRequestId(request: Request): string {
  const ray = request.headers.get('cf-ray');
  return ray && ID_RE.test(ray) ? ray : crypto.randomUUID();
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const requestId = newRequestId(request);
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/v1/health') {
        if (request.method === 'GET' || request.method === 'HEAD') return handleHealth(env, requestId);
        if (request.method === 'OPTIONS') return openPreflight();
        return json(405, { error: 'Method not allowed', code: 'method_not_allowed', requestId }, { allow: 'GET' });
      }
      if (pathname === APP_CONFIG_ENDPOINT) {
        if (request.method === 'OPTIONS') return await appPreflight(request, env);
        if (request.method === 'GET') return await handleAppConfig(request, env, requestId);
        return json(405, { error: 'Method not allowed', code: 'method_not_allowed', requestId }, { allow: 'GET, OPTIONS' });
      }
      if (APP_ENDPOINTS.includes(pathname)) {
        if (request.method === 'OPTIONS') return await appPreflight(request, env);
        if (request.method === 'POST') return await handleAppEndpoint(request, env, pathname as AppEndpoint, requestId, ctx);
        return json(405, { error: 'Method not allowed', code: 'method_not_allowed', requestId }, { allow: 'POST, OPTIONS' });
      }
      if (pathname === LOGIN_ENDPOINT) {
        if (request.method === 'OPTIONS') return await appPreflight(request, env);
        if (request.method === 'POST') return await handleLogin(request, env, requestId, ctx);
        return json(405, { error: 'Method not allowed', code: 'method_not_allowed', requestId }, { allow: 'POST, OPTIONS' });
      }
      if (pathname.startsWith(LOGIN_RELAY_PREFIX)) return await handleLoginRelay(request, env, requestId);
      if (pathname === '/v1/owner-actions') {
        if (request.method === 'OPTIONS') return openPreflight();
        if (request.method === 'POST') return await handleOwnerAction(request, env, requestId);
        return json(405, { error: 'Method not allowed', code: 'method_not_allowed', requestId }, { allow: 'POST, OPTIONS' });
      }
      return json(404, { error: 'Not found', code: 'not_found', requestId });
    } catch {
      log({ event: 'request', requestId, endpoint: pathname, outcome: 'error', status: 500, code: 'internal' }, 'error');
      return json(500, { error: 'Internal error', code: 'internal', requestId });
    }
  },

  async scheduled(_controller, env, _ctx): Promise<void> {
    await syncIssuerKeys(env);
  },
} satisfies ExportedHandler<Env>;
