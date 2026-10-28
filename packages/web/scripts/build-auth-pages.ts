// Builds the auth-origin pages (/login, /login/callback, /approve, /export) of every env whose manifest sets
// vaultOrigin and authOrigin, into packages/web/dist/pages/<env> (docs/batch-b-spec.md "Packages"):
//
//   pnpm --filter @hana-id/web build:auth [env…]
//
// Each env gets its own bundles with that env's envs.generated.ts entry inlined as constants (`signer`, `relayer`,
// `ckdNetworkKey`, origins), so nothing is read at runtime. Output, per env:
//   login.html, login/callback.html, approve.html, export.html   static HTML: a <meta> CSP, one stylesheet, one module
//   auth/*.js, auth/*.css                                       content-hashed bundles (no inline script or style)
//   auth-pages.json                                             each page's path, file and response headers, for the Worker
// The vault page's assets are built separately and share the directory; this script only replaces its own files.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { HanaEnv } from '../src/hana-env.ts';
import { AUTH_PAGES, type AuthPage, authPageHeaders, authPageMetaCsp } from '../src/auth/pages.ts';
import { ckdKeyProblem } from './ckd-key.ts';
import { hanaEnv, loadManifests } from './gen-envs.ts';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PAGES_DIST = join(webRoot, 'dist', 'pages');
/** Where the bundles go inside an env's directory (and the URL path they are served under). */
export const ASSET_DIR = 'auth';
export const MANIFEST_FILE = 'auth-pages.json';

const ENTRIES: Record<AuthPage['name'], string> = {
  login: 'src/auth/entries/login.ts',
  callback: 'src/auth/entries/callback.ts',
  approve: 'src/auth/entries/approve.ts',
  export: 'src/auth/entries/export.ts',
};

const escapeAttr = (s: string) => s.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

/** One page's HTML: no inline script or style, nothing from another origin. */
export function pageHtml(env: HanaEnv, page: AuthPage, script: string, stylesheet: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(authPageMetaCsp(env, page.name))}">`,
    '<meta name="referrer" content="no-referrer">',
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
  dir: string;
  /** Page name → its script and stylesheet URL paths. */
  pages: Record<AuthPage['name'], { file: string; script: string; stylesheet: string }>;
}

/** Builds one env's pages into `<outRoot>/<env.name>`. */
export async function buildAuthPages(env: HanaEnv, outRoot: string = PAGES_DIST): Promise<BuiltEnv> {
  const problem = ckdKeyProblem(env);
  if (problem) throw new Error(`Can't build the Hana pages: ${problem}`);
  const dir = join(outRoot, env.name);
  rmSync(join(dir, ASSET_DIR), { recursive: true, force: true });
  for (const p of AUTH_PAGES) rmSync(join(dir, p.file), { force: true });
  rmSync(join(dir, MANIFEST_FILE), { force: true });
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
    assetNames: 'assets/[name]-[hash]',
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
    writeFileSync(join(dir, page.file), pageHtml(env, page, script, stylesheet));
    pages[page.name] = { file: page.file, script, stylesheet };
  }
  const manifest = {
    env: env.name,
    origin: env.authOrigin,
    pages: AUTH_PAGES.map((p) => ({ name: p.name, path: p.path, file: p.file, headers: authPageHeaders(env, p.name) })),
  };
  writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return { env: env.name, dir, pages };
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
  for (const env of envs) {
    const built = await buildAuthPages(env);
    console.log(`built ${relative(process.cwd(), built.dir)} (${Object.keys(built.pages).join(', ')})`);
  }
  if (envs.length === 0) console.log('no env sets vaultOrigin and authOrigin: nothing to build');
}
