// Builds the vault bundle of every env whose manifest sets vaultOrigin and authOrigin, into
// packages/web/dist/pages/<env>/vault (docs/batch-b-spec.md "Packages"):
//
//   pnpm --filter @hana-id/web build:vault [env…]
//
// Each env gets its own bundle with that env's envs.generated.ts entry inlined as constants (src/build-env.ts), so
// nothing is read at runtime. Output, per env, in `<env>/vault/`, which is the vault origin's whole static-assets root
// (apps/api wrangler.vault.jsonc; the auth origin's is `<env>/auth`, so neither origin can serve the other's files):
//   vault.js   one self-contained module, no chunks: the vault page (apps/api src/vault/page.ts, rendered per request
//              by the API Worker) loads it as `/vault.js` and nothing else. Its first line is the build id
//              (`/* hana-build <id> */`, @hana-id/env/build-id, D384), which `deploy-check` reads from the vault origin.
// A rebuild replaces the whole `<env>/vault` root and nothing outside it.
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vaultBanner } from '@hana-id/env/build-id';
import { localBuild } from '@hana-id/env/local-build';
import { build } from 'esbuild';
import type { HanaEnv } from '../src/hana-env.ts';
import { PAGES_DIST, selectEnvs } from './build-auth-pages.ts';
import { ckdKeyProblem } from './ckd-key.ts';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The vault origin's root inside an env's directory (the auth pages' is `auth`). */
export const VAULT_ORIGIN_DIR = 'vault';
/** The bundle's file name, which is its URL path on vaultOrigin (apps/api VAULT_SCRIPT_PATH, `/vault.js`). */
export const VAULT_SCRIPT = 'vault.js';

export interface BuiltVault {
  env: string;
  /** The vault origin's assets root, `<outRoot>/<env>/vault`. */
  dir: string;
  /** The bundle, `<dir>/vault.js`. */
  script: string;
  /** The build id in its first line. */
  buildId: string;
}

/** Builds one env's vault bundle into `<outRoot>/<env.name>/vault/vault.js`, stamped with `buildId` (default: this checkout's). */
export async function buildVault(env: HanaEnv, outRoot: string = PAGES_DIST, buildId: string = localBuild().id): Promise<BuiltVault> {
  // Before anything is deleted: an id that isn't one never reaches the bundle (it is written into a JS comment).
  const banner = vaultBanner(buildId);
  const problem = ckdKeyProblem(env);
  if (problem) throw new Error(`Can't build the vault: ${problem}`);
  // The name becomes a path that is deleted recursively: only the manifest names' charset (packages/env manifestPath).
  if (!/^[a-z0-9-]+$/u.test(env.name)) throw new Error(`Invalid environment name: ${env.name}`);
  const dir = join(outRoot, env.name, VAULT_ORIGIN_DIR);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const script = join(dir, VAULT_SCRIPT);
  const result = await build({
    absWorkingDir: webRoot,
    entryPoints: ['src/vault/entry.ts'],
    bundle: true,
    // One file: the page names only /vault.js, and a chunk would be one more same-origin URL to keep in step.
    splitting: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    banner: { js: banner },
    outfile: script,
    define: { __HANA_ENV__: JSON.stringify(env), global: 'globalThis' },
    metafile: true,
    write: true,
    logLevel: 'silent',
  });
  const outputs = Object.keys(result.metafile.outputs);
  if (outputs.length !== 1) throw new Error(`esbuild produced ${outputs.length} vault outputs, expected only ${VAULT_SCRIPT}`);
  return { env: env.name, dir, script, buildId };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const envs = selectEnvs(process.argv.slice(2));
  const buildId = localBuild().id;
  for (const env of envs) {
    const built = await buildVault(env, PAGES_DIST, buildId);
    console.log(`built ${relative(process.cwd(), built.script)} (build ${built.buildId})`);
  }
  if (envs.length === 0) console.log('no env sets vaultOrigin and authOrigin: nothing to build');
}
