// Writes apps/demo/wrangler.jsonc (gitignored) for the hosted demo of one env:
//
//   [HANA_DEMO_ENV=<env>] [HANA_DEMO_PUBLISHABLE_KEY=pk_test_…] pnpm --filter @hana-id/demo gen
//
// The same variables as the build (vite.config.ts), so the page and its CSP describe the same vault. Where it lives
// follows from the manifest: Worker `hana-id-demo-<env>` on the workers.dev subdomain of the env's other Workers (the
// one in `apiUrl`), so `https://hana-id-demo-<env>.<subdomain>.workers.dev`; or, with `HANA_DEMO_ORIGIN=https://<host>`
// (an env on custom domains, D404), a Custom Domain on that host. Only for testnet dev envs (`sandbox*`, `local*`
// names): the demo is internal test tooling, never on a production domain.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Manifest, accountIdFields, customDomainPlacement, dnsNameProblem, isDevEnv, loadEnv } from '@hana-id/env';
import { COMPATIBILITY_DATE } from '../../api/scripts/gen-wrangler.ts';
import { workersDevHost } from '../../api/scripts/pages-wrangler.ts';
import { type DemoConfig, type DemoVars, demoConfigFromVars, demoEnvName } from '../src/config.ts';
import { pageCsp } from '../src/csp.ts';

const demoDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG_FILE = 'wrangler.jsonc';

/** The Worker name of an env's demo. */
export const demoWorkerName = (envName: string): string => `hana-id-demo-${envName}`;

/**
 * Worker name, origin and deployment target of the env's demo. Throws for an env it can't be deployed for.
 * `customOrigin` (HANA_DEMO_ORIGIN): a bare https origin served as a Custom Domain on a zone of the env's account,
 * for an env whose API is not on workers.dev (D404).
 */
export function demoPlacement(m: Manifest, customOrigin?: string): { name: string; origin: string; target: Record<string, unknown> } {
  if (m.network !== 'testnet' || !isDevEnv(m.name)) throw new Error(`The hosted demo is for testnet sandbox*/local* envs only, not ${m.name}`);
  const name = demoWorkerName(m.name);
  // A workers.dev hostname label (and a Worker name): at most 63 characters, letters, digits and inner hyphens.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(name)) throw new Error(`Worker name ${name} is not a valid workers.dev label`);
  let origin: string;
  let target: Record<string, unknown>;
  if (customOrigin !== undefined) {
    target = customDomainPlacement('HANA_DEMO_ORIGIN', customOrigin);
    origin = new URL(customOrigin).origin;
    const problem = dnsNameProblem(new URL(origin).hostname);
    if (problem) throw new Error(`HANA_DEMO_ORIGIN ${customOrigin} ${problem}`);
  } else {
    const api = workersDevHost(new URL(m.apiUrl).hostname);
    if (!api) throw new Error(`envs/${m.name}.json apiUrl ${m.apiUrl} is not on workers.dev: no account subdomain to put the demo on (set HANA_DEMO_ORIGIN to a Custom Domain, D404)`);
    origin = `https://${name}.${api.subdomain}.workers.dev`;
    target = { workers_dev: true, preview_urls: false };
  }
  const hana = [m.apiUrl, m.vaultOrigin, m.authOrigin, m.emailIssuer?.url, m.console?.origin, m.console?.authOrigin, m.files?.origin, m.admin?.origin];
  if (hana.some((o) => o !== undefined && new URL(o).origin === origin)) throw new Error(`${origin} is already one of the env's Hana origins`);
  return { name, origin, target };
}

/** The demo Worker's wrangler config (worker/index.ts serves dist/ with the page CSP). */
export function demoWranglerConfig(m: Manifest, config: DemoConfig, compatibilityDate: string = COMPATIBILITY_DATE, customOrigin?: string): Record<string, unknown> {
  if (config.environment !== m.name) throw new Error(`The demo configuration is for ${config.environment}, not ${m.name}`);
  if (config.vaultOrigin !== m.vaultOrigin) throw new Error(`The demo configuration's vault ${config.vaultOrigin} is not envs/${m.name}.json's`);
  const { name, origin, target } = demoPlacement(m, customOrigin);
  return {
    $schema: 'node_modules/wrangler/config-schema.json',
    name,
    // The env's account, when the manifest names it (D404).
    ...accountIdFields(m.cloudflare.accountId, 'cloudflare.accountId'),
    main: 'worker/index.ts',
    compatibility_date: compatibilityDate,
    // Its workers.dev URL or its Custom Domain; preview URLs off: the page exists on its origin only.
    ...target,
    vars: { DEMO_ORIGIN: origin, CSP: pageCsp(config) },
    // The Worker runs first on every request: it alone decides which paths exist and sets every response's headers.
    assets: { directory: './dist', binding: 'ASSETS', run_worker_first: true, html_handling: 'none', not_found_handling: 'none' },
  };
}

/** Writes `<dir>/wrangler.jsonc` for the configuration `vars` select. Returns its path and the demo's origin. */
export function writeDemoWranglerConfig(
  vars: DemoVars,
  opts: { dir?: string; loadManifest?: (name: string) => Manifest } = {},
): { path: string; origin: string; config: DemoConfig } {
  const load = opts.loadManifest ?? loadEnv;
  const m = load(demoEnvName(vars));
  const config = demoConfigFromVars(vars, () => m);
  const custom = vars.HANA_DEMO_ORIGIN?.trim();
  const wrangler = demoWranglerConfig(m, config, COMPATIBILITY_DATE, custom ? custom : undefined);
  const path = join(opts.dir ?? demoDir, CONFIG_FILE);
  const header = `// Generated by apps/demo/scripts/gen-wrangler.ts from envs/${m.name}.json: edit the manifest or the script, not this file.\n`;
  writeFileSync(path, header + JSON.stringify(wrangler, null, 2) + '\n');
  return { path, origin: (wrangler.vars as { DEMO_ORIGIN: string }).DEMO_ORIGIN, config };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length > 2) {
    console.error('usage: [HANA_DEMO_ENV=<env>] [HANA_DEMO_PUBLISHABLE_KEY=pk_test_…] [HANA_DEMO_ORIGIN=https://<custom domain>] gen-wrangler (no arguments)');
    process.exit(2);
  }
  const { path, origin, config } = writeDemoWranglerConfig(process.env);
  console.log(`wrote ${path} (env ${config.environment}, app ${config.publishableKey.slice(0, 12)}…, ${origin})`);
}
