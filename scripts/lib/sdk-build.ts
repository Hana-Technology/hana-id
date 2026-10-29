// The published build of one SDK package (@hana-id/core, web, react, sodax): `tsc -p tsconfig.build.json` into its
// outDir (ESM, .d.ts, source maps with the sources inlined), then relative `.ts`/`.tsx` specifiers in the emitted .d.ts
// files rewritten to `.js`. tsc rewrites them in the JavaScript (`rewriteRelativeImportExtensions`) but leaves the
// declarations as written, which older TypeScript versions and some tools don't resolve. docs/operations.md
// "Releasing the SDK packages".
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';

const JS_EXT: Readonly<Record<string, string>> = { ts: 'js', tsx: 'js', mts: 'mjs', cts: 'cjs' };

/** Relative `./x.ts` / `../x.tsx` module specifiers in a declaration file, as their emitted `.js` names. */
export function rewriteDtsSpecifiers(text: string): string {
  return text.replace(
    /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.\.?\/[^'"\n]*?)\.(ts|tsx|mts|cts)\2/gu,
    (match: string, lead: string, quote: string, path: string, ext: string) => {
      // `./x.d.ts` names a declaration file, not a source: leave it.
      if (path.endsWith('.d')) return match;
      return `${lead}${quote}${path}.${JS_EXT[ext]}${quote}`;
    },
  );
}

/** Runs `tsc` from `pkgDir`'s own typescript install. Throws with tsc's output on failure. */
function tsc(pkgDir: string, args: readonly string[]): string {
  const bin = createRequire(join(pkgDir, 'package.json')).resolve('typescript/bin/tsc');
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: pkgDir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tsc ${args.join(' ')} failed in ${pkgDir}:\n${r.stdout}${r.stderr}`);
  return r.stdout;
}

/** The build's outDir (absolute), refused unless it is a strict subdirectory of the package. */
export function outDirOf(pkgDir: string, config = 'tsconfig.build.json'): string {
  const shown = JSON.parse(tsc(pkgDir, ['--showConfig', '-p', config])) as { compilerOptions?: { outDir?: string } };
  const outDir = shown.compilerOptions?.outDir;
  if (!outDir) throw new Error(`${config} in ${pkgDir} sets no outDir`);
  const abs = resolve(pkgDir, outDir);
  const rel = relative(pkgDir, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`outDir ${abs} is not inside ${pkgDir}`);
  return abs;
}

/** Cleans the outDir, compiles, and fixes the declarations. Returns the emitted files, relative to the package. */
export function buildPackage(pkgDir: string, config = 'tsconfig.build.json'): string[] {
  const outDir = outDirOf(pkgDir, config);
  rmSync(outDir, { recursive: true, force: true });
  const emitted = tsc(pkgDir, ['-p', config, '--listEmittedFiles'])
    .split('\n')
    .filter((l) => l.startsWith('TSFILE: '))
    .map((l) => l.slice('TSFILE: '.length).trim());
  for (const file of emitted.filter((f) => f.endsWith('.d.ts'))) {
    const text = readFileSync(file, 'utf8');
    const fixed = rewriteDtsSpecifiers(text);
    if (fixed !== text) writeFileSync(file, fixed);
  }
  return emitted.map((f) => relative(pkgDir, f)).sort();
}
