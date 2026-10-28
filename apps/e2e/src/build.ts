// Builds everything the suite serves into apps/e2e/.build (gitignored):
//
//   pages/local-e2e/vault, pages/local-e2e/auth   the vault bundle and the auth pages, built for the e2e env by
//                                                 @hana-id/web's own per-env build scripts (the deployed pipeline)
//   partner/app.js, partner/index.html            the partner test app (partner/app.ts): createHana from @hana-id/web,
//                                                 with the e2e env as its only known environment
//
//   pnpm --filter @hana-id/e2e build
//
// Playwright's global setup runs it before every run (tests/global-setup.ts).
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Plugin, build } from 'esbuild';
import { buildAuthPages } from '../../../packages/web/scripts/build-auth-pages.ts';
import { buildVault } from '../../../packages/web/scripts/build-vault.ts';
import { BUILD_DIR, E2E_ENV, ENV_NAME } from './stack.ts';

const e2eRoot = fileURLToPath(new URL('../', import.meta.url));
export const PAGES_DIR = fileURLToPath(new URL('pages/', BUILD_DIR));
export const PARTNER_DIR = fileURLToPath(new URL('partner/', BUILD_DIR));

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
    // Stellar Wallets Kit 1.9's dependencies expect Node's `global`.
    define: { global: 'globalThis' },
    plugins: [e2eEnvs],
    logLevel: 'warning',
  });
  copyFileSync(`${e2eRoot}partner/index.html`, `${PARTNER_DIR}index.html`);
}

export async function buildAll(): Promise<void> {
  await buildVault(E2E_ENV, PAGES_DIR);
  await buildAuthPages(E2E_ENV, PAGES_DIR);
  await buildPartner();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildAll();
  console.log(`built ${fileURLToPath(BUILD_DIR)}`);
}
