// Builds the auth-origin pages (/login, /login/email, /login/callback, /approve, /export, /share-email) of every env whose manifest sets
// vaultOrigin and authOrigin, into packages/web/dist/pages/<env>/auth (docs/batch-b-spec.md "Packages"):
//
//   pnpm --filter @hana-id/web build:auth [env…]
//
// Each env gets its own bundles with that env's envs.generated.ts entry inlined as constants (`signer`, `relayer`,
// `ckdNetworkKey`, origins), so nothing is read at runtime. Output, per env, in `<env>/auth/`, which is the auth
// origin's whole static-assets root (apps/api wrangler.auth.jsonc; the vault origin's is `<env>/vault`, so neither
// origin can serve the other's files):
//   login.html, login/email.html, login/callback.html, approve.html, export.html   static HTML: a <meta> CSP, one stylesheet, one module,
//                                                               and the build id (`<meta name="hana-build">`, D384)
//   assets/*.js, assets/*.css                                   content-hashed bundles (no inline script or style),
//                                                               served at /assets/…
// The Worker (apps/api src/pages/host.ts) serves each page from `<path>.html` with that page's headers, which it builds
// itself. A rebuild replaces the whole `<env>/auth` root and nothing outside it.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMeta } from '@hana-id/env/build-id';
import { localBuild } from '@hana-id/env/local-build';
import { build } from 'esbuild';
import type { HanaEnv } from '../src/hana-env.ts';
import { AUTH_PAGES, type AuthPage, authPageMetaCsp } from '../src/auth/pages.ts';
import { ckdKeyProblem } from './ckd-key.ts';
import { hanaEnv, loadManifests } from './gen-envs.ts';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PAGES_DIST = join(webRoot, 'dist', 'pages');
/** The auth origin's root inside an env's directory (the vault's is `vault`). */
export const ORIGIN_DIR = 'auth';
/** Where the bundles go inside that root (and the URL path they are served under). */
export const ASSET_DIR = 'assets';

const ENTRIES: Record<AuthPage['name'], string> = {
  login: 'src/auth/entries/login.ts',
  email: 'src/auth/entries/email.ts',
  callback: 'src/auth/entries/callback.ts',
  approve: 'src/auth/entries/approve.ts',
  export: 'src/auth/entries/export.ts',
  share: 'src/auth/entries/share.ts',
};

const escapeAttr = (s: string) => s.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

/**
 * One page's HTML: no inline script or style, nothing from another origin. `buildId` is the build id (D384), which
 * `deploy-check` reads from `{authOrigin}/login`; the bundles stay content-hashed by their code alone.
 */
export function pageHtml(env: HanaEnv, page: AuthPage, script: string, stylesheet: string, buildId: string): string {
  return [
    '<!doctype html>',
    // No auto-translation (AUTH-4): a translator could reword a signing request, and would send an exported key to
    // its service.
    '<html lang="en" translate="no">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="google" content="notranslate">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(authPageMetaCsp(env, page.name))}">`,
    '<meta name="referrer" content="no-referrer">',
    buildMeta(buildId),
    `<title>${escapeAttr(page.title)}</title>`,
    `<link rel="stylesheet" href="${escapeAttr(stylesheet)}">`,
    `<script type="module" src="${escapeAttr(script)}"></script>`,
    '</head>',
    '<body><main id="app"><noscript>Hana needs JavaScript to continue.</noscript></main></body>',
    '</html>',
    '',
  ].join('\n');
}

export interface BuiltEnv {
  env: string;
  /** The auth origin's assets root, `<outRoot>/<env>/auth`. */
  dir: string;
  /** Page name → its script and stylesheet URL paths. */
  pages: Record<AuthPage['name'], { file: string; script: string; stylesheet: string }>;
  /** The build id in every page's `<meta name="hana-build">`. */
  buildId: string;
}

/** Builds one env's pages into `<outRoot>/<env.name>/auth`, stamped with `buildId` (default: this checkout's). */
export async function buildAuthPages(env: HanaEnv, outRoot: string = PAGES_DIST, buildId: string = localBuild().id): Promise<BuiltEnv> {
  // Before anything is deleted: an id that isn't one never reaches the HTML.
  buildMeta(buildId);
  const problem = ckdKeyProblem(env);
  if (problem) throw new Error(`Can't build the Hana pages: ${problem}`);
  // The name becomes a path that is deleted recursively: only the manifest names' charset (packages/env manifestPath).
  if (!/^[a-z0-9-]+$/u.test(env.name)) throw new Error(`Invalid environment name: ${env.name}`);
  const dir = join(outRoot, env.name, ORIGIN_DIR);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const result = await build({
    absWorkingDir: webRoot,
    entryPoints: { ...ENTRIES, auth: 'src/auth/auth.css' },
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    outdir: join(dir, ASSET_DIR),
    entryNames: '[name]-[hash]',
    chunkNames: 'chunks/[name]-[hash]',
    assetNames: 'files/[name]-[hash]',
    // Assets are never inlined as data: URIs into scripts or styles (img-src allows data:, nothing else does).
    loader: { '.css': 'css' },
    define: { __HANA_ENV__: JSON.stringify(env), global: 'globalThis' },
    metafile: true,
    write: true,
    logLevel: 'silent',
  });
  const url = (out: string) => `/${relative(dir, join(webRoot, out)).split('\\').join('/')}`;
  const byEntry = new Map<string, string>();
  for (const [out, meta] of Object.entries(result.metafile.outputs)) if (meta.entryPoint) byEntry.set(meta.entryPoint, url(out));
  const stylesheet = byEntry.get('src/auth/auth.css');
  if (!stylesheet) throw new Error('esbuild produced no stylesheet');

  const pages = {} as BuiltEnv['pages'];
  for (const page of AUTH_PAGES) {
    const script = byEntry.get(ENTRIES[page.name]);
    if (!script) throw new Error(`esbuild produced no bundle for ${page.name}`);
    mkdirSync(dirname(join(dir, page.file)), { recursive: true });
    writeFileSync(join(dir, page.file), pageHtml(env, page, script, stylesheet, buildId));
    pages[page.name] = { file: page.file, script, stylesheet };
  }
  return { env: env.name, dir, pages, buildId };
}

/** Every env with both Hana origins, or the named ones (an unknown name, or one without origins, fails). */
export function selectEnvs(names: readonly string[]): HanaEnv[] {
  const all = loadManifests()
    .map(hanaEnv)
    .filter((e): e is HanaEnv => e !== null);
  if (names.length === 0) return all;
  return names.map((n) => {
    const e = all.find((x) => x.name === n);
    if (!e) throw new Error(`envs/${n}.json does not exist or does not set vaultOrigin and authOrigin`);
    return e;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const envs = selectEnvs(process.argv.slice(2));
  const buildId = localBuild().id;
  for (const env of envs) {
    const built = await buildAuthPages(env, PAGES_DIST, buildId);
    console.log(`built ${relative(process.cwd(), built.dir)} (${Object.keys(built.pages).join(', ')}; build ${built.buildId})`);
  }
  if (envs.length === 0) console.log('no env sets vaultOrigin and authOrigin: nothing to build');
}
