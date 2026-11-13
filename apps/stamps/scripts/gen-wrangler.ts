// Writes apps/stamps/wrangler.jsonc (gitignored) for the stamps site of one env:
//
//   HANA_STAMPS_PUBLISHABLE_KEY=pk_test_… [HANA_STAMPS_ENV=<env>] pnpm --filter @hana-id/stamps gen
//
// The same variables as the build (vite.config.ts), so the page and its CSP describe the same vault and contract.
// Where it lives follows from the manifest, as the hosted demo's (apps/demo/scripts/gen-wrangler.ts): Worker
// `hana-id-stamps-<env>` on the workers.dev subdomain of the env's other Workers (the one in `apiUrl`), so
// `https://hana-id-stamps-<env>.<subdomain>.workers.dev`; or, with `HANA_STAMPS_ORIGIN=https://<host>` (an env on
// custom domains, D404), a Custom Domain on that host. Only for testnet dev envs (`sandbox*`, `local*` names), and only
// for an env whose manifest names its stamps contract (`near.demoStamps`).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Manifest, accountIdFields, customDomainPlacement, dnsNameProblem, isDevEnv, loadEnv } from '@hana-id/env';
import { COMPATIBILITY_DATE } from '../../api/scripts/gen-wrangler.ts';
import { workersDevHost } from '../../api/scripts/pages-wrangler.ts';
import { type StampsConfig, type StampsVars, stampsConfigFromVars, stampsEnvName } from '../src/config.ts';
import { pageCsp } from '../src/csp.ts';

const stampsDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG_FILE = 'wrangler.jsonc';

/** The Worker name of an env's stamps site. */
export const stampsWorkerName = (envName: string): string => `hana-id-stamps-${envName}`;

/** Worker name, origin and deployment target of the env's stamps site. Throws for an env it can't be deployed for. */
export function stampsPlacement(m: Manifest, customOrigin?: string): { name: string; origin: string; target: Record<string, unknown> } {
  if (m.network !== 'testnet' || !isDevEnv(m.name)) throw new Error(`The stamps site is for testnet sandbox*/local* envs only, not ${m.name}`);
  const name = stampsWorkerName(m.name);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(name)) throw new Error(`Worker name ${name} is not a valid workers.dev label`);
  let origin: string;
  let target: Record<string, unknown>;
  if (customOrigin !== undefined) {
    target = customDomainPlacement('HANA_STAMPS_ORIGIN', customOrigin);
    origin = new URL(customOrigin).origin;
    const problem = dnsNameProblem(new URL(origin).hostname);
    if (problem) throw new Error(`HANA_STAMPS_ORIGIN ${customOrigin} ${problem}`);
  } else {
    const api = workersDevHost(new URL(m.apiUrl).hostname);
    if (!api) throw new Error(`envs/${m.name}.json apiUrl ${m.apiUrl} is not on workers.dev: no account subdomain to put the site on (set HANA_STAMPS_ORIGIN to a Custom Domain, D404)`);
    origin = `https://${name}.${api.subdomain}.workers.dev`;
    target = { workers_dev: true, preview_urls: false };
  }
  const taken = [m.apiUrl, m.vaultOrigin, m.authOrigin, m.emailIssuer?.url, m.console?.origin, m.console?.authOrigin, m.files?.origin, m.admin?.origin];
  if (taken.some((o) => o !== undefined && new URL(o).origin === origin)) throw new Error(`${origin} is already one of the env's Journear origins`);
  return { name, origin, target };
}

/** The stamps Worker's wrangler config (worker/index.ts serves dist/ with the page CSP). */
export function stampsWranglerConfig(m: Manifest, config: StampsConfig, compatibilityDate: string = COMPATIBILITY_DATE, customOrigin?: string): Record<string, unknown> {
  if (config.environment !== m.name) throw new Error(`The stamps configuration is for ${config.environment}, not ${m.name}`);
  if (config.vaultOrigin !== m.vaultOrigin) throw new Error(`The stamps configuration's vault ${config.vaultOrigin} is not envs/${m.name}.json's`);
  const { name, origin, target } = stampsPlacement(m, customOrigin);
  return {
    $schema: 'node_modules/wrangler/config-schema.json',
    name,
    ...accountIdFields(m.cloudflare.accountId, 'cloudflare.accountId'),
    main: 'worker/index.ts',
    compatibility_date: compatibilityDate,
    ...target,
    vars: { STAMPS_ORIGIN: origin, CSP: pageCsp(config) },
    // The Worker runs first on every request: it alone decides which paths exist and sets every response's headers.
    assets: { directory: './dist', binding: 'ASSETS', run_worker_first: true, html_handling: 'none', not_found_handling: 'none' },
  };
}

/** Writes `<dir>/wrangler.jsonc` for the configuration `vars` select. Returns its path and the site's origin. */
export function writeStampsWranglerConfig(vars: StampsVars, opts: { dir?: string; loadManifest?: (name: string) => Manifest } = {}): { path: string; origin: string; config: StampsConfig } {
  const load = opts.loadManifest ?? loadEnv;
  const m = load(stampsEnvName(vars));
  const config = stampsConfigFromVars(vars, () => m);
  const custom = vars.HANA_STAMPS_ORIGIN?.trim();
  const wrangler = stampsWranglerConfig(m, config, COMPATIBILITY_DATE, custom ? custom : undefined);
  const path = join(opts.dir ?? stampsDir, CONFIG_FILE);
  const header = `// Generated by apps/stamps/scripts/gen-wrangler.ts from envs/${m.name}.json: edit the manifest or the script, not this file.\n`;
  writeFileSync(path, header + JSON.stringify(wrangler, null, 2) + '\n');
  return { path, origin: (wrangler.vars as { STAMPS_ORIGIN: string }).STAMPS_ORIGIN, config };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length > 2) {
    console.error('usage: HANA_STAMPS_PUBLISHABLE_KEY=pk_test_… [HANA_STAMPS_ENV=<env>] [HANA_STAMPS_ORIGIN=https://<custom domain>] gen-wrangler (no arguments)');
    process.exit(2);
  }
  const { path, origin, config } = writeStampsWranglerConfig(process.env);
  console.log(`wrote ${path} (env ${config.environment}, app ${config.publishableKey.slice(0, 12)}…, contract ${config.near.stamps}, ${origin})`);
}
