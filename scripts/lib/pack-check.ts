// The checks `pnpm run pack:check` (scripts/pack-check.ts) runs on each SDK tarball before installing it: what may be
// in it, its packed package.json, and its source maps. docs/operations.md "Releasing the SDK packages".

/**
 * The published packages, in dependency order (each one's @hana-id deps come before it): directory, build outDir and
 * the source file holding its `VERSION` constant (kept equal to package.json by each package's index test).
 */
export const SDK_PACKAGES = [
  { name: '@hana-id/core', dir: 'packages/core', out: 'dist', versionFile: 'src/index.ts' },
  { name: '@hana-id/web', dir: 'packages/web', out: 'dist/lib', versionFile: 'src/version.ts' },
  { name: '@hana-id/react', dir: 'packages/react', out: 'dist', versionFile: 'src/index.ts' },
  { name: '@hana-id/sodax', dir: 'packages/sodax', out: 'dist', versionFile: 'src/index.ts' },
] as const;

export type SdkPackage = (typeof SDK_PACKAGES)[number];

/** Files that must never be in a tarball, with the reason (checked before the allowlist, for a clearer message). */
const FORBIDDEN: readonly [RegExp, string][] = [
  [/(^|\/)\.secrets(\/|$)/u, 'a .secrets file'],
  [/(^|\/)\.env(\.|$)|(^|\/)\.dev\.vars$/u, 'an env/dev-vars file'],
  [/(^|\/)envs\/[^/]+\.json$/u, 'a raw envs/*.json manifest'],
  [/(^|\/)(test|tests|__tests__|fixtures?)\//u, 'a test or fixture file'],
  [/\.(test|spec)\.[cm]?[jt]sx?(\.map)?$/u, 'a test file'],
  [/(^|\/)src\//u, 'a source file (maps inline their sources)'],
  [/(^|\/)dist\/pages\//u, 'a Hana page bundle (served by Hana, never packed)'],
  [/(^|\/)node_modules\//u, 'node_modules'],
];

/** Problems with a tarball's file list (paths relative to `package/`). */
export function fileListProblems(pkg: SdkPackage, files: readonly string[]): string[] {
  const problems: string[] = [];
  const allowed = new RegExp(`^${pkg.out.replaceAll('/', '\\/')}\\/.+\\.(js|d\\.ts|js\\.map)$`, 'u');
  for (const f of files) {
    const bad = FORBIDDEN.find(([re]) => re.test(f));
    if (bad) problems.push(`${pkg.name}: ${f} is ${bad[1]}`);
    else if (f !== 'package.json' && f !== 'README.md' && !allowed.test(f)) problems.push(`${pkg.name}: unexpected file ${f}`);
  }
  for (const required of ['package.json', 'README.md', `${pkg.out}/index.js`, `${pkg.out}/index.d.ts`]) {
    if (!files.includes(required)) problems.push(`${pkg.name}: ${required} is missing`);
  }
  return problems;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isRecord = (v: unknown): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every string target in an `exports` map. */
function exportTargets(exports: Json | undefined): string[] {
  if (typeof exports === 'string') return [exports];
  if (Array.isArray(exports)) return exports.flatMap(exportTargets);
  if (isRecord(exports)) return Object.values(exports).flatMap(exportTargets);
  return [];
}

/**
 * Problems with a packed package.json: workspace protocol left in, `exports` still at src/ or naming a file not in the
 * tarball, the version not the release version, an @hana-id dependency not `^<version>`, or a missing publish field.
 */
export function manifestProblems(pkg: SdkPackage, manifest: Record<string, Json>, files: readonly string[], version: string): string[] {
  const problems: string[] = [];
  const p = (m: string) => problems.push(`${pkg.name}: ${m}`);
  if (manifest.name !== pkg.name) p(`name is ${JSON.stringify(manifest.name)}`);
  if (manifest.version !== version) p(`version ${JSON.stringify(manifest.version)} is not the release version ${version}`);
  if (manifest.type !== 'module') p('type is not "module"');
  if (manifest.sideEffects !== false) p('sideEffects is not false');
  if (!isRecord(manifest.engines) || typeof manifest.engines.node !== 'string') p('engines.node is missing');
  if (JSON.stringify(manifest).includes('workspace:')) p('the workspace: protocol was not rewritten');
  const exports = manifest.exports;
  if (!isRecord(exports) || !isRecord(exports['.'])) p('exports["."] is not a conditions object');
  for (const [key, target] of isRecord(exports) ? Object.entries(exports) : []) {
    if (key === './package.json') continue;
    if (!isRecord(target) || typeof target.types !== 'string' || typeof target.import !== 'string') p(`exports["${key}"] lacks types/import`);
    else if (Object.keys(target)[0] !== 'types') p(`exports["${key}"]: "types" must come first`);
  }
  for (const t of exportTargets(exports)) {
    const path = t.replace(/^\.\//u, '');
    if (!files.includes(path)) p(`exports names ${t}, which is not in the tarball`);
  }
  for (const field of ['dependencies', 'peerDependencies'] as const) {
    const deps = manifest[field];
    for (const [dep, range] of isRecord(deps) ? Object.entries(deps) : []) {
      if (dep.startsWith('@hana-id/') && range !== `^${version}`) p(`${field}.${dep} is ${JSON.stringify(range)}, not ^${version}`);
    }
  }
  return problems;
}

/** Absolute filesystem paths, `file:` URLs and Windows drive paths: never valid in a published source map. */
const ABSOLUTE = /^(\/|file:|[A-Za-z]:[\\/]|\\\\)/u;

/** Problems with one source map: absolute or out-of-package sources, or sources not inlined. */
export function sourceMapProblems(pkgName: string, file: string, map: unknown): string[] {
  const problems: string[] = [];
  const p = (m: string) => problems.push(`${pkgName}: ${file} ${m}`);
  if (!isRecord(map)) return [`${pkgName}: ${file} is not a source map`];
  const sources = Array.isArray(map.sources) ? map.sources : [];
  if (sources.length === 0) p('names no sources');
  if (typeof map.sourceRoot === 'string' && map.sourceRoot !== '') p(`has sourceRoot ${JSON.stringify(map.sourceRoot)}`);
  for (const s of sources) {
    if (typeof s !== 'string' || ABSOLUTE.test(s)) p(`has an absolute source ${JSON.stringify(s)}`);
    else if (!/^(\.\.\/)+src\//u.test(s)) p(`has a source outside the package's src/: ${JSON.stringify(s)}`);
  }
  const contents = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
  if (contents.length !== sources.length || contents.some((c) => typeof c !== 'string')) p('does not inline its sources');
  return problems;
}

/**
 * Internal references a partner can't follow, in the comments of a shipped type declaration (partners read them as
 * editor tooltips): a decision number, a repo doc, a batch or build plan.
 */
const INTERNAL_REFERENCE = /\bD\d{2,3}\b|\bdocs\/[a-zA-Z]|[Bb]atch [A-C]\d{0,2}\b|batch-[a-c]|[Bb]uild plan|\b[a-z0-9-]+\.md\b|\bapps\/[a-z]|\bpackages\/[a-z]/u;

/** Problems in a `.d.ts`: a comment line that carries an internal reference (the lines themselves are named). */
export function typeCommentProblems(pkgName: string, file: string, text: string): string[] {
  if (!file.endsWith('.d.ts')) return [];
  return text
    .split('\n')
    .filter((line) => /^\s*(\*|\/\*\*|\/\/)/u.test(line) && INTERNAL_REFERENCE.test(line))
    .map((line) => `${pkgName}: ${file} has an internal reference in a comment: ${line.trim().slice(0, 100)}`);
}

/** Problems in a text file's contents: a local absolute path (the checkout, the home directory) baked in. */
export function localPathProblems(pkgName: string, file: string, text: string, localPaths: readonly string[]): string[] {
  return localPaths.filter((lp) => lp.length > 1 && text.includes(lp)).map((lp) => `${pkgName}: ${file} contains the local path ${lp}`);
}
