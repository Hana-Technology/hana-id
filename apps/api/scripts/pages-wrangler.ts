// The wrangler configs of the two thin page Workers (src/pages/host.ts), written next to wrangler.jsonc by
// gen-wrangler.ts: apps/api/wrangler.vault.jsonc and apps/api/wrangler.auth.jsonc (docs/batch-b-spec.md "Order of work"
// step 0, "Data, secrets, code").
//
// Where each Worker lives follows from its manifest origin:
// - `https://<worker>.<subdomain>.workers.dev` (dev envs only): the Worker is named after the hostname's first label
//   and served on workers.dev. The subdomain must be the API's when apiUrl is on workers.dev too, since the vault
//   Worker's service binding only reaches a Worker on the same account.
// - any other https hostname: a Custom Domain route (`custom_domain: true`), Worker `<API worker>-vault`/`-auth`.
// - loopback (local* envs): no deployment target; `wrangler dev` listens on the origin's host and port.
// Every config turns preview URLs off, so the pages exist on their origin only.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Manifest, emailIssuerUrl, isDevEnv, isLoopbackHost } from '@hana-id/env';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export type PageOrigin = 'vault' | 'auth';
export const PAGE_ORIGINS: readonly PageOrigin[] = ['vault', 'auth'];

/** Config file per page origin, in apps/api (deploy with `wrangler deploy -c <file>`). */
export const PAGES_CONFIG_FILES: Readonly<Record<PageOrigin, string>> = { vault: 'wrangler.vault.jsonc', auth: 'wrangler.auth.jsonc' };

/** The built pages of one origin, relative to apps/api (the @hana-id/web build writes packages/web/dist/pages/<env>/<origin>). */
export function pagesAssetsDir(envName: string, origin: PageOrigin): string {
  return `../../packages/web/dist/pages/${envName}/${origin}`;
}

const WORKERS_DEV_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.workers\.dev$/u;

/** `{worker, subdomain}` of a `<worker>.<subdomain>.workers.dev` hostname, or null. */
export function workersDevHost(hostname: string): { worker: string; subdomain: string } | null {
  const m = WORKERS_DEV_RE.exec(hostname);
  return m ? { worker: m[1]!, subdomain: m[2]! } : null;
}

type Placement = Record<string, unknown> & { name: string };

/** Name and deployment target of one page Worker. Throws for an origin it can't be deployed on. */
export function pagesPlacement(m: Manifest, origin: PageOrigin): Placement {
  const value = origin === 'vault' ? m.vaultOrigin : m.authOrigin;
  if (!m.vaultOrigin || !m.authOrigin || !value) throw new Error(`envs/${m.name}.json needs vaultOrigin and authOrigin`);
  const field = `${origin}Origin`;
  const url = new URL(value);
  if (isLoopbackHost(url.hostname)) {
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return {
      name: `${m.cloudflare.workerName}-${origin}`,
      workers_dev: false,
      preview_urls: false,
      dev: { ip: url.hostname.replace(/^\[(.*)\]$/u, '$1'), port, local_protocol: url.protocol === 'https:' ? 'https' : 'http' },
    };
  }
  const dev = workersDevHost(url.hostname);
  if (dev) {
    // docs/batch-b-spec.md "Origins and pages": no workers.dev in production.
    if (!isDevEnv(m.name)) throw new Error(`${field} ${value}: workers.dev hostnames are for local*/sandbox* envs only; use a Hana-owned domain`);
    const api = workersDevHost(new URL(m.apiUrl).hostname);
    if (api && api.subdomain !== dev.subdomain) {
      throw new Error(`${field} ${value} is on workers.dev subdomain ${dev.subdomain} but apiUrl is on ${api.subdomain}: the service binding needs both Workers on one account`);
    }
    if (dev.worker === m.cloudflare.workerName) throw new Error(`${field} ${value} names the API Worker itself (${dev.worker})`);
    return { name: dev.worker, workers_dev: true, preview_urls: false };
  }
  // Custom Domains take a bare hostname.
  if (url.port) throw new Error(`${field} ${value}: a Custom Domain can't have a port`);
  return { name: `${m.cloudflare.workerName}-${origin}`, workers_dev: false, preview_urls: false, routes: [{ pattern: url.hostname, custom_domain: true }] };
}

/** wrangler config of one page Worker (see src/pages/host.ts for what it serves). */
export function pagesWranglerConfig(m: Manifest, origin: PageOrigin, compatibilityDate: string): Record<string, unknown> {
  const placement = pagesPlacement(m, origin);
  const other = pagesPlacement(m, origin === 'vault' ? 'auth' : 'vault');
  if (other.name === placement.name) throw new Error(`vaultOrigin and authOrigin give the same Worker name ${placement.name}`);
  return {
    $schema: 'node_modules/wrangler/config-schema.json',
    ...placement,
    main: `src/pages/${origin}-worker.ts`,
    compatibility_date: compatibilityDate,
    observability: { enabled: true },
    vars:
      origin === 'vault'
        ? { VAULT_ORIGIN: m.vaultOrigin }
        : {
            AUTH_ORIGIN: m.authOrigin,
            API_URL: m.apiUrl,
            NEAR_RPC: m.rpc,
            ...(m.rpcFallback ? { NEAR_RPC_FALLBACK: m.rpcFallback } : {}),
            // Email login (D230): /login/email's connect-src names the issuer's own origin.
            ...(m.emailIssuer ? { EMAIL_ISSUER_URL: emailIssuerUrl(m) } : {}),
          },
    // The Worker runs first on every request: it alone decides which paths exist and sets the pages' headers.
    assets: { directory: pagesAssetsDir(m.name, origin), binding: 'ASSETS', run_worker_first: true, html_handling: 'none', not_found_handling: 'none' },
    // The vault page is rendered by the API Worker (D1 config inlined), reached through this binding.
    ...(origin === 'vault' ? { services: [{ binding: 'API', service: m.cloudflare.workerName }] } : {}),
  };
}

/** Writes both page Workers' configs into `dir` (default apps/api). Returns their paths. */
export function writePagesWranglerConfigs(m: Manifest, compatibilityDate: string, dir: string = apiDir): string[] {
  // Build both before writing either, so a refused env leaves no half-updated pair.
  const configs = PAGE_ORIGINS.map((origin) => [origin, pagesWranglerConfig(m, origin, compatibilityDate)] as const);
  return configs.map(([origin, config]) => {
    const path = join(dir, PAGES_CONFIG_FILES[origin]);
    const header = `// Generated by apps/api/scripts/gen-wrangler.ts from envs/${m.name}.json: edit the manifest, not this file.\n`;
    writeFileSync(path, header + JSON.stringify(config, null, 2) + '\n');
    return path;
  });
}
