// The two Hana page origins, served by apps/api's own page hosts (src/pages/host.ts) over the bundles src/build.ts
// built, exactly as the deployed vault and auth Workers serve them: the vault page is rendered per request by
// apps/api's handleVaultPage from D1 (frame-ancestors, CSP, inlined config), the auth pages get their per-page headers,
// and every other path is a static asset of that origin only.
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { PAGES_DIR } from '../build.ts';
import { API_URL, AUTH_ORIGIN, ENV_NAME, NEAR_RPC, VAULT_ORIGIN } from '../stack.ts';
import type { ApiModules, Fetcher } from './api-modules.ts';
import type { D1Shim } from './d1.ts';
import type { Handler } from './http.ts';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** A Workers static-assets binding over one directory: 200 with the file, or 404. */
export function assetsFetcher(root: string): Fetcher {
  return {
    async fetch(request: Request): Promise<Response> {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const file = normalize(join(root, path));
      if (!file.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return new Response('Not found', { status: 404 });
      try {
        const body = await readFile(file);
        return new Response(body, { status: 200, headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    },
  };
}

export function vaultHost(api: ApiModules, d1: D1Shim): Handler {
  const apiEnv = { DB: d1, ENV_NAME, API_URL, NEAR_RPC, VAULT_ORIGIN };
  let n = 0;
  const env = {
    VAULT_ORIGIN,
    ASSETS: assetsFetcher(join(PAGES_DIR, ENV_NAME, 'vault')),
    API: { fetch: (request: Request) => api.handleVaultPage(request, apiEnv, `rq_vault_${(n += 1)}`) },
  };
  return (request) => api.handleVaultHost(request, env);
}

export function authHost(api: ApiModules): Handler {
  const env = { AUTH_ORIGIN, API_URL, NEAR_RPC, ASSETS: assetsFetcher(join(PAGES_DIR, ENV_NAME, 'auth')) };
  return (request) => api.handleAuthHost(request, env);
}
