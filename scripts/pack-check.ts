// `pnpm run pack:check`: proves the four SDK packages install and work outside this monorepo, without publishing.
//
//   1. `pnpm pack` each of @hana-id/core, web, react and sodax into a temp dir (prepack runs its `build:lib`), so
//      `workspace:^` is rewritten and `publishConfig.exports` (dist/) replaces the workspace's src/ exports.
//   2. Checks every tarball (lib/pack-check.ts): only dist JavaScript, declarations and source maps plus package.json
//      and README.md; no tests, fixtures, sources, .secrets, env files, raw envs/*.json or page bundles; source maps
//      with relative, inlined sources; no local absolute path in any file; the packed package.json's exports, version
//      and @hana-id ranges.
//   3. Installs the tarballs with plain npm into a fresh project in the system temp dir (outside the workspace), with
//      the peer versions this repo tests (react, react-dom, @types/react*, @sodax/types).
//   4. Type-checks pack-smoke/types.ts and app.tsx there (NodeNext and Bundler resolution, skipLibCheck off), and
//      guide-near.ts: the partner guide's NEAR samples (docs/integration.md section 8, "NEAR", every `ts` block) in one
//      module, with the @near-js packages one of them uses; then runs pack-smoke/run.mjs in Node: every exported
//      subpath imports, createHana knows exactly the envs/*.json that set both Hana origins, HanaProvider
//      server-renders.
//
//   pnpm run pack:check [--keep]      (--keep leaves the temp dir for inspection)
//
// docs/operations.md "Releasing the SDK packages".
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '@hana-id/env';
import { SDK_PACKAGES, codeBlocks, fileListProblems, localPathProblems, manifestProblems, sampleModule, sourceMapProblems, typeCommentProblems } from './lib/pack-check.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const keep = process.argv.includes('--keep');

function run(cmd: string, args: readonly string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, npm_config_update_notifier: 'false' } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} (in ${cwd}) failed:\n${r.stdout}${r.stderr}${r.error ? String(r.error) : ''}`);
  return r.stdout;
}

/** pnpm as this script was started with (`pnpm run pack:check`), else the one on PATH. */
function pnpm(args: readonly string[], cwd: string): string {
  const exec = process.env.npm_execpath;
  return exec && /pnpm/u.test(exec) && /\.c?js$/u.test(exec) ? run(process.execPath, [exec, ...args], cwd) : run('pnpm', args, cwd);
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p, base) : [relative(base, p).split(sep).join('/')];
  });
}

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} kB`;

const version = readJson(join(repoRoot, 'packages/core/package.json')).version as string;
for (const pkg of SDK_PACKAGES) {
  const v = readJson(join(repoRoot, pkg.dir, 'package.json')).version;
  if (v !== version) throw new Error(`${pkg.name} is at ${String(v)}, @hana-id/core at ${version}: the four SDK packages share one version`);
}
// The envs @hana-id/web's gen-envs includes: every envs/<env>.json that sets both Hana origins.
const expectedEnvs = readdirSync(join(repoRoot, 'envs'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => loadEnv(f.slice(0, -'.json'.length)))
  .filter((m) => m.vaultOrigin !== undefined && m.authOrigin !== undefined)
  .map((m) => m.name)
  .sort();

/** The files tsc checks in the project. */
const CHECKED = ['types.ts', 'app.tsx', 'guide-near.ts'];
/** The registry packages the guide's NEAR samples import, besides Hana's. */
const GUIDE_NEAR_JS = ['@near-js/crypto', '@near-js/transactions', '@near-js/utils'] as const;

/**
 * docs/integration.md's NEAR samples as one module. The prelude declares what the guide's earlier sections set up:
 * the client (`hana`, section 3), a button and the page's result handlers.
 */
function guideNearModule(): string {
  const guide = readFileSync(join(repoRoot, 'docs/integration.md'), 'utf8');
  const prelude = [
    '// docs/integration.md section 8, "NEAR": its `ts` samples, in order (scripts/pack-check.ts writes this file).',
    "const hana = createHana({ publishableKey: 'pk_test_example', environment: 'sandbox-dev' });",
    'declare const button: HTMLButtonElement;',
    'declare function onSent(transactionHash: string): void;',
    'declare function onError(error: unknown): void;',
  ].join('\n');
  return sampleModule(codeBlocks(guide, '### NEAR', '### Raw signing'), prelude, { '@hana-id/web': ['createHana'] });
}

// Read first, so a guide whose samples can't be extracted fails before anything is packed.
const guideNear = guideNearModule();

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'hana-pack-check-')));
if (tmp === repoRoot || tmp.startsWith(repoRoot + sep)) throw new Error(`The temp dir ${tmp} is inside the workspace; set TMPDIR elsewhere`);
const packs = join(tmp, 'packs');
const project = join(tmp, 'project');
mkdirSync(packs);
mkdirSync(project);

try {
  // 1–2. Pack and check.
  const problems: string[] = [];
  const tarballs: Record<string, string> = {};
  const subpaths: Record<string, string[]> = {};
  const rows: string[] = [];
  const localPaths = [repoRoot, realpathSync(homedir())];
  for (const pkg of SDK_PACKAGES) {
    const short = pkg.name.slice('@hana-id/'.length);
    process.stdout.write(`packing ${pkg.name} … `);
    pnpm(['pack', '--pack-destination', packs], join(repoRoot, pkg.dir));
    const tarball = join(packs, `hana-id-${short}-${version}.tgz`);
    const extracted = join(tmp, 'extract', short);
    mkdirSync(extracted, { recursive: true });
    run('tar', ['-xzf', tarball, '-C', extracted], tmp);
    const root = join(extracted, 'package');
    const files = listFiles(root).sort();
    const manifest = readJson(join(root, 'package.json')) as Parameters<typeof manifestProblems>[1];
    problems.push(...fileListProblems(pkg, files), ...manifestProblems(pkg, manifest, files, version));
    let unpacked = 0;
    for (const f of files) {
      const text = readFileSync(join(root, f), 'utf8');
      unpacked += Buffer.byteLength(text);
      problems.push(...localPathProblems(pkg.name, f, text, localPaths));
      problems.push(...typeCommentProblems(pkg.name, f, text));
      if (f.endsWith('.map')) problems.push(...sourceMapProblems(pkg.name, f, JSON.parse(text)));
    }
    tarballs[pkg.name] = tarball;
    subpaths[pkg.name] = Object.keys(manifest.exports as Record<string, unknown>);
    const row = `${pkg.name.padEnd(16)} ${String(files.length).padStart(4)} files  ${kb(statSync(tarball).size).padStart(9)} packed  ${kb(unpacked).padStart(9)} unpacked`;
    rows.push(row);
    console.log(row.slice(pkg.name.length).trim());
  }
  if (problems.length > 0) throw new Error(`The tarballs failed the checks:\n  ${problems.join('\n  ')}`);

  // 3. A fresh project, plain npm, the tested peer versions.
  const reactDev = readJson(join(repoRoot, 'packages/react/package.json')).devDependencies as Record<string, string>;
  const sodaxDev = readJson(join(repoRoot, 'packages/sodax/package.json')).devDependencies as Record<string, string>;
  const coreDev = readJson(join(repoRoot, 'packages/core/package.json')).devDependencies as Record<string, string>;
  // The NEAR SDK the guide's transaction sample builds with, at the version Hana's own scripts use.
  const scriptsDeps = readJson(join(repoRoot, 'scripts/package.json')).dependencies as Record<string, string>;
  const pin = (deps: Record<string, string>, name: string): string => {
    const v = deps[name];
    if (!v || !/^\d+\.\d+\.\d+$/u.test(v)) throw new Error(`${name} must be an exact devDependency (is ${String(v)})`);
    return v;
  };
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify(
      {
        name: 'hana-pack-check',
        private: true,
        type: 'module',
        dependencies: {
          ...Object.fromEntries(Object.entries(tarballs).map(([name, t]) => [name, `file:${relative(project, t)}`])),
          '@sodax/types': pin(sodaxDev, '@sodax/types'),
          react: pin(reactDev, 'react'),
          'react-dom': pin(reactDev, 'react-dom'),
          ...Object.fromEntries(GUIDE_NEAR_JS.map((name) => [name, pin(scriptsDeps, name)])),
        },
        // @types/node: @stellar/stellar-base's declarations (behind @hana-id/core/signers/stellar and /decode)
        // reference Node's Buffer without depending on it.
        devDependencies: {
          '@types/node': pin(coreDev, '@types/node'),
          '@types/react': pin(reactDev, '@types/react'),
          '@types/react-dom': pin(reactDev, '@types/react-dom'),
        },
      },
      null,
      2,
    )}\n`,
  );
  for (const f of ['types.ts', 'app.tsx', 'run.mjs']) copyFileSync(join(here, 'pack-smoke', f), join(project, f));
  writeFileSync(join(project, 'guide-near.ts'), guideNear);
  const compilerOptions = {
    target: 'ES2022',
    lib: ['ES2023', 'DOM', 'DOM.Iterable'],
    jsx: 'react-jsx',
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: [],
  };
  writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { ...compilerOptions, module: 'NodeNext', moduleResolution: 'NodeNext' }, include: CHECKED }));
  writeFileSync(join(project, 'tsconfig.bundler.json'), JSON.stringify({ compilerOptions: { ...compilerOptions, module: 'ESNext', moduleResolution: 'Bundler' }, include: CHECKED }));
  // Registry packages at least 7 days old, as pnpm-workspace.yaml's minimumReleaseAge; no install scripts.
  const before = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  process.stdout.write('npm install … ');
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `--before=${before}`], project);
  const installed = readJson(join(project, 'node_modules/@hana-id/web/package.json'));
  if (installed.version !== version) throw new Error(`npm installed @hana-id/web ${String(installed.version)}, not the tarball's ${version}`);
  console.log('done');

  // 4. Type-check and run.
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  for (const config of ['tsconfig.json', 'tsconfig.bundler.json']) {
    process.stdout.write(`tsc -p ${config} … `);
    run(process.execPath, [tsc, '-p', config], project);
    console.log('ok');
  }
  process.stdout.write('node run.mjs … ');
  console.log(run(process.execPath, ['run.mjs', JSON.stringify(expectedEnvs), JSON.stringify(subpaths)], project).trim());

  console.log(`\npack check passed (version ${version}, envs ${expectedEnvs.join(', ')}):\n  ${rows.join('\n  ')}`);
  if (keep) console.log(`kept ${tmp}`);
} finally {
  if (!keep) rmSync(tmp, { recursive: true, force: true });
}
