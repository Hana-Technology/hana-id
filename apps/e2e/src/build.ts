// Builds everything the suite serves into apps/e2e/.build (gitignored):
//
//   pages/local-e2e/vault, pages/local-e2e/auth   the vault bundle and the auth pages, built for the e2e env by
//                                                 @hana-id/web's own per-env build scripts (the deployed pipeline)
//   partner/app.js, partner/index.html            the partner test app (partner/app.ts): createHana from @hana-id/web,
//                                                 with the e2e env as its only known environment
//   demo/                                         the hosted demo (apps/demo): its page and src/main.ts, configured
//                                                 for the e2e env (DEMO_PK, the mocked EVM chain)
//
//   pnpm --filter @hana-id/e2e build
//
// src/server/main.ts (Playwright's webServer) runs it before serving, unless --no-build.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Plugin, build } from 'esbuild';
import { buildAuthPages } from '../../../packages/web/scripts/build-auth-pages.ts';
import { buildVault } from '../../../packages/web/scripts/build-vault.ts';
import { DEFAULT_STELLAR, type DemoConfig, validateDemoConfig } from '../../demo/src/config.ts';
import { BUILD_DIR, DEMO_PK, E2E_ENV, ENV_NAME, EVM_CHAIN_ID, EVM_RPC, VAULT_ORIGIN, portBase } from './stack.ts';

const e2eRoot = fileURLToPath(new URL('../', import.meta.url));
export const PAGES_DIR = fileURLToPath(new URL('pages/', BUILD_DIR));
export const PARTNER_DIR = fileURLToPath(new URL('partner/', BUILD_DIR));
export const DEMO_DIR = fileURLToPath(new URL('demo/', BUILD_DIR));
const demoRoot = fileURLToPath(new URL('../../demo/', import.meta.url));

/** The demo's configuration on the stack: the e2e env, its app key and the mocked EVM chain (no explorer). */
export const DEMO_CONFIG: DemoConfig = validateDemoConfig({
  environment: ENV_NAME,
  publishableKey: DEMO_PK,
  vaultOrigin: VAULT_ORIGIN,
  evm: { id: EVM_CHAIN_ID, name: 'Local test chain', rpcUrl: EVM_RPC, explorer: null },
  stellar: DEFAULT_STELLAR,
});

/**
 * createHana resolves `environment` through @hana-id/web's generated envs.generated.ts. The partner bundle gets a
 * module with the e2e env alone instead, so the test app goes through createHana exactly as a partner does.
 */
const e2eEnvs: Plugin = {
  name: 'hana-e2e-envs',
  setup(b) {
    b.onResolve({ filter: /\/envs\.generated(\.ts)?$/ }, () => ({ path: 'envs.generated', namespace: 'hana-e2e' }));
    b.onLoad({ filter: /.*/, namespace: 'hana-e2e' }, () => ({
      contents: `export const HANA_ENVS = Object.freeze({ ${JSON.stringify(ENV_NAME)}: Object.freeze(${JSON.stringify(E2E_ENV)}) });`,
      loader: 'js',
    }));
  },
};

export async function buildPartner(): Promise<void> {
  rmSync(PARTNER_DIR, { recursive: true, force: true });
  mkdirSync(PARTNER_DIR, { recursive: true });
  await build({
    absWorkingDir: e2eRoot,
    entryPoints: ['partner/app.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    sourcemap: false,
    outfile: `${PARTNER_DIR}app.js`,
    // Stellar Wallets Kit 1.9's dependencies expect Node's `global`. src/stack.ts reads the port base from the
    // environment: the bundle gets this run's value inlined.
    define: { global: 'globalThis', 'process.env.HANA_E2E_PORT_BASE': JSON.stringify(String(portBase())) },
    plugins: [e2eEnvs],
    logLevel: 'warning',
  });
  copyFileSync(`${e2eRoot}partner/index.html`, `${PARTNER_DIR}index.html`);
}

/** Vite's entry tag in apps/demo/index.html, which the e2e build swaps for its esbuild output. */
const DEMO_ENTRY = '<script type="module" src="/src/main.ts"></script>';

/**
 * The demo, bundled by esbuild like the partner app (Vite builds the deployed one from the same index.html and
 * src/main.ts), with the e2e env as createHana's only environment and DEMO_CONFIG baked in.
 */
export async function buildDemo(): Promise<void> {
  rmSync(DEMO_DIR, { recursive: true, force: true });
  mkdirSync(DEMO_DIR, { recursive: true });
  await build({
    absWorkingDir: demoRoot,
    entryPoints: ['src/main.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    sourcemap: false,
    // src/main.ts imports its stylesheet: esbuild writes it next to app.js as app.css.
    outfile: `${DEMO_DIR}app.js`,
    define: { __HANA_DEMO_CONFIG__: JSON.stringify(DEMO_CONFIG) },
    plugins: [e2eEnvs],
    logLevel: 'warning',
  });
  const html = readFileSync(`${demoRoot}index.html`, 'utf8');
  if (html.split(DEMO_ENTRY).length !== 2) throw new Error(`apps/demo/index.html must contain ${DEMO_ENTRY} exactly once`);
  writeFileSync(`${DEMO_DIR}index.html`, html.replace(DEMO_ENTRY, '<script type="module" src="/app.js"></script>\n    <link rel="stylesheet" href="/app.css" />'));
  copyFileSync(`${demoRoot}public/favicon.svg`, `${DEMO_DIR}favicon.svg`);
}

export async function buildAll(): Promise<void> {
  await buildVault(E2E_ENV, PAGES_DIR);
  await buildAuthPages(E2E_ENV, PAGES_DIR);
  await buildPartner();
  await buildDemo();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildAll();
  console.log(`built ${fileURLToPath(BUILD_DIR)}`);
}
