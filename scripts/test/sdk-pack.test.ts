import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SDK_PACKAGES, fileListProblems, localPathProblems, manifestProblems, sourceMapProblems, typeCommentProblems } from '../lib/pack-check.ts';
import { buildPackage, outDirOf, rewriteDtsSpecifiers } from '../lib/sdk-build.ts';
import { checkVersion, setSdkVersion, withPackageVersion, withVersionConstant } from '../lib/sdk-version.ts';

const [core, web] = SDK_PACKAGES;

describe('rewriteDtsSpecifiers', () => {
  it('rewrites relative .ts/.tsx specifiers in from, export-from, import() and side-effect imports', () => {
    const text = [
      "export * from './a.ts';",
      'export { b } from "../b/index.ts";',
      "import type { C } from './c.tsx';",
      "export type D = import('./d.ts').D;",
      "import './e.mts';",
      "export * from './f.cts';",
    ].join('\n');
    expect(rewriteDtsSpecifiers(text)).toBe(
      [
        "export * from './a.js';",
        'export { b } from "../b/index.js";',
        "import type { C } from './c.js';",
        "export type D = import('./d.js').D;",
        "import './e.mjs';",
        "export * from './f.cjs';",
      ].join('\n'),
    );
  });

  it('leaves package specifiers, .js specifiers, .d.ts references and non-import text alone', () => {
    const text = [
      "import { x } from '@hana-id/core';",
      "import { y } from 'some-pkg/file.ts';",
      "export * from './already.js';",
      "export * from './types.d.ts';",
      "/** Reads './config.ts' at build time. */",
      "export declare const name = './x.ts';",
    ].join('\n');
    expect(rewriteDtsSpecifiers(text)).toBe(text);
  });
});

describe('buildPackage', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A tiny package under scripts/ (so `typescript` resolves from scripts' own install). */
  function fixture(tsconfig: object): string {
    const dir = mkdtempSync(join(import.meta.dirname, '..', '.tmp-sdk-build-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }));
    writeFileSync(join(dir, 'src', 'a.ts'), "export const a = 1;\n");
    writeFileSync(join(dir, 'src', 'index.ts'), "export * from './a.ts';\nexport type A = typeof import('./a.ts').a;\n");
    writeFileSync(join(dir, 'tsconfig.build.json'), JSON.stringify(tsconfig));
    return dir;
  }
  const options = {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
    allowImportingTsExtensions: true,
    rewriteRelativeImportExtensions: true,
    declaration: true,
    sourceMap: true,
    inlineSources: true,
    rootDir: 'src',
    types: [],
  };

  it('cleans the outDir, emits JS, declarations and inlined maps, and fixes the declarations', () => {
    const dir = fixture({ compilerOptions: { ...options, outDir: 'dist' }, include: ['src'] });
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'stale.js'), '');
    expect(buildPackage(dir)).toEqual(['dist/a.d.ts', 'dist/a.js', 'dist/a.js.map', 'dist/index.d.ts', 'dist/index.js', 'dist/index.js.map']);
    expect(() => readFileSync(join(dir, 'dist', 'stale.js'))).toThrow();
    expect(readFileSync(join(dir, 'dist', 'index.js'), 'utf8')).toContain('"./a.js"');
    const dts = readFileSync(join(dir, 'dist', 'index.d.ts'), 'utf8');
    expect(dts).toContain("from './a.js'");
    expect(dts).toContain("import('./a.js')");
    const map = JSON.parse(readFileSync(join(dir, 'dist', 'a.js.map'), 'utf8')) as { sources: string[]; sourcesContent: string[] };
    expect(map.sources).toEqual(['../src/a.ts']);
    expect(map.sourcesContent).toEqual(['export const a = 1;\n']);
  });

  it('fails on a type error, and refuses an outDir that is the package itself or outside it', () => {
    const bad = fixture({ compilerOptions: { ...options, outDir: 'dist', noEmitOnError: true }, include: ['src'] });
    writeFileSync(join(bad, 'src', 'a.ts'), 'export const a: number = "x";\n');
    expect(() => buildPackage(bad)).toThrow(/TS2322/u);
    expect(() => outDirOf(fixture({ compilerOptions: { ...options, outDir: '.' }, files: ['src/index.ts'] }))).toThrow(/is not inside/u);
    expect(() => outDirOf(fixture({ compilerOptions: { ...options, outDir: '../elsewhere' }, files: ['src/index.ts'] }))).toThrow(/is not inside/u);
  });
});

describe('fileListProblems', () => {
  const ok = ['README.md', 'package.json', 'dist/index.js', 'dist/index.d.ts', 'dist/index.js.map', 'dist/decode/index.js'];

  it('accepts dist JavaScript, declarations and maps plus package.json and README.md', () => {
    expect(fileListProblems(core, ok)).toEqual([]);
    expect(fileListProblems(web, ['README.md', 'package.json', 'dist/lib/index.js', 'dist/lib/index.d.ts'])).toEqual([]);
  });

  it('names forbidden files with the reason, and anything else outside the allowlist', () => {
    const files = [
      ...ok,
      '.secrets/relayer.json',
      '.env',
      '.dev.vars',
      'envs/sandbox-dev.json',
      'dist/test/x.js',
      'dist/x.test.js',
      'fixtures/a.json',
      'src/index.ts',
      'dist/pages/sandbox-dev/vault/index.html',
      'tsconfig.json',
      'dist/extra.css',
    ];
    expect(fileListProblems(core, files)).toEqual([
      '@hana-id/core: .secrets/relayer.json is a .secrets file',
      '@hana-id/core: .env is an env/dev-vars file',
      '@hana-id/core: .dev.vars is an env/dev-vars file',
      '@hana-id/core: envs/sandbox-dev.json is a raw envs/*.json manifest',
      '@hana-id/core: dist/test/x.js is a test or fixture file',
      '@hana-id/core: dist/x.test.js is a test file',
      '@hana-id/core: fixtures/a.json is a test or fixture file',
      '@hana-id/core: src/index.ts is a source file (maps inline their sources)',
      '@hana-id/core: dist/pages/sandbox-dev/vault/index.html is a Hana page bundle (served by Hana, never packed)',
      '@hana-id/core: unexpected file tsconfig.json',
      '@hana-id/core: unexpected file dist/extra.css',
    ]);
    // web's build is dist/lib: a file directly in dist/ is unexpected.
    expect(fileListProblems(web, ['README.md', 'package.json', 'dist/lib/index.js', 'dist/lib/index.d.ts', 'dist/index.js'])).toEqual(['@hana-id/web: unexpected file dist/index.js']);
  });

  it('requires package.json, README.md and the root entry', () => {
    expect(fileListProblems(core, ['dist/other.js'])).toEqual([
      '@hana-id/core: package.json is missing',
      '@hana-id/core: README.md is missing',
      '@hana-id/core: dist/index.js is missing',
      '@hana-id/core: dist/index.d.ts is missing',
    ]);
  });
});

describe('manifestProblems', () => {
  const files = ['package.json', 'README.md', 'dist/lib/index.js', 'dist/lib/index.d.ts'];
  const good = {
    name: '@hana-id/web',
    version: '0.1.0',
    type: 'module',
    sideEffects: false,
    engines: { node: '>=22' },
    exports: { '.': { types: './dist/lib/index.d.ts', import: './dist/lib/index.js' }, './package.json': './package.json' },
    dependencies: { '@hana-id/core': '^0.1.0' },
  };

  it('accepts a packed manifest', () => {
    expect(manifestProblems(web, good, files, '0.1.0')).toEqual([]);
  });

  it('names each problem', () => {
    const bad = {
      ...good,
      version: '0.0.0',
      type: 'commonjs',
      sideEffects: true,
      engines: {},
      exports: { '.': { import: './src/index.ts', types: './src/index.ts' }, './x': './dist/lib/x.js' },
      dependencies: { '@hana-id/core': 'workspace:^' },
    };
    expect(manifestProblems(web, bad, files, '0.1.0')).toEqual([
      '@hana-id/web: version "0.0.0" is not the release version 0.1.0',
      '@hana-id/web: type is not "module"',
      '@hana-id/web: sideEffects is not false',
      '@hana-id/web: engines.node is missing',
      '@hana-id/web: the workspace: protocol was not rewritten',
      '@hana-id/web: exports["."]: "types" must come first',
      '@hana-id/web: exports["./x"] lacks types/import',
      '@hana-id/web: exports names ./src/index.ts, which is not in the tarball',
      '@hana-id/web: exports names ./src/index.ts, which is not in the tarball',
      '@hana-id/web: exports names ./dist/lib/x.js, which is not in the tarball',
      '@hana-id/web: dependencies.@hana-id/core is "workspace:^", not ^0.1.0',
    ]);
    expect(manifestProblems(web, { ...good, name: '@hana-id/other', dependencies: { '@hana-id/core': '0.1.0' } }, files, '0.1.0')).toEqual([
      '@hana-id/web: name is "@hana-id/other"',
      '@hana-id/web: dependencies.@hana-id/core is "0.1.0", not ^0.1.0',
    ]);
  });
});

describe('sourceMapProblems', () => {
  const good = { version: 3, sources: ['../src/index.ts'], sourcesContent: ['export {};'], sourceRoot: '', mappings: '' };

  it('accepts relative, inlined sources under src/', () => {
    expect(sourceMapProblems('@hana-id/core', 'dist/index.js.map', good)).toEqual([]);
    expect(sourceMapProblems('@hana-id/web', 'dist/lib/client/a.js.map', { ...good, sources: ['../../../src/client/a.ts'] })).toEqual([]);
  });

  it('refuses absolute paths, file: URLs, a sourceRoot, sources outside src/ and missing contents', () => {
    const m = (over: object) => sourceMapProblems('@hana-id/core', 'dist/a.js.map', { ...good, ...over });
    expect(m({ sources: ['/Users/me/hana-id/packages/core/src/a.ts'] })).toEqual(['@hana-id/core: dist/a.js.map has an absolute source "/Users/me/hana-id/packages/core/src/a.ts"']);
    expect(m({ sources: ['file:///home/runner/a.ts'] })).toEqual(['@hana-id/core: dist/a.js.map has an absolute source "file:///home/runner/a.ts"']);
    expect(m({ sources: ['C:\\work\\a.ts'] })).toEqual(['@hana-id/core: dist/a.js.map has an absolute source "C:\\\\work\\\\a.ts"']);
    expect(m({ sourceRoot: '/Users/me' })).toEqual(['@hana-id/core: dist/a.js.map has sourceRoot "/Users/me"']);
    expect(m({ sources: ['../../envs/sandbox-dev.json'] })).toEqual([`@hana-id/core: dist/a.js.map has a source outside the package's src/: "../../envs/sandbox-dev.json"`]);
    expect(m({ sourcesContent: [] })).toEqual(['@hana-id/core: dist/a.js.map does not inline its sources']);
    expect(m({ sources: [], sourcesContent: [] })).toEqual(['@hana-id/core: dist/a.js.map names no sources']);
    expect(sourceMapProblems('@hana-id/core', 'dist/a.js.map', 'x')).toEqual(['@hana-id/core: dist/a.js.map is not a source map']);
  });
});

describe('localPathProblems', () => {
  it('finds the checkout or home directory baked into a file', () => {
    const paths = ['/Users/me/hana-id', '/Users/me'];
    expect(localPathProblems('@hana-id/core', 'dist/a.js', 'const p = "/Users/me/hana-id/envs";', paths)).toEqual([
      '@hana-id/core: dist/a.js contains the local path /Users/me/hana-id',
      '@hana-id/core: dist/a.js contains the local path /Users/me',
    ]);
    expect(localPathProblems('@hana-id/core', 'dist/a.js', 'export const a = 1;', paths)).toEqual([]);
    expect(localPathProblems('@hana-id/core', 'dist/a.js', 'a/b', ['/'])).toEqual([]);
  });
});

describe('typeCommentProblems', () => {
  const dts = (body: string) => typeCommentProblems('@hana-id/web', 'dist/a.d.ts', body);

  it('finds a decision number, a repo doc, a batch or a build plan in a declaration comment', () => {
    expect(dts('/** The cap (D428). */\nexport declare const a: 1;')).toEqual(['@hana-id/web: dist/a.d.ts has an internal reference in a comment: /** The cap (D428). */']);
    expect(dts('/**\n * See docs/integration.md "Support".\n */')).toHaveLength(1);
    expect(dts('    /** Batch C15: the Support ID. */')).toHaveLength(1);
    expect(dts(' * build plan batch 8b')).toHaveLength(1);
    expect(dts(' * as apps/api does it')).toHaveLength(1);
  });

  it('leaves code, ordinary words and other files alone', () => {
    expect(dts('export declare const D428: number;')).toEqual([]);
    expect(dts('/** A Deposit of 100 units, with HD wallets. */')).toEqual([]);
    expect(typeCommentProblems('@hana-id/web', 'dist/a.js', '/** D428 */')).toEqual([]);
  });
});

describe('SDK_PACKAGES', () => {
  it('lists the four packages in dependency order, with the outDir each tsconfig.build.json sets', () => {
    const root = join(import.meta.dirname, '..', '..');
    expect(SDK_PACKAGES.map((p) => p.name)).toEqual(['@hana-id/core', '@hana-id/web', '@hana-id/react', '@hana-id/sodax']);
    for (const p of SDK_PACKAGES) {
      const pkg = JSON.parse(readFileSync(join(root, p.dir, 'package.json'), 'utf8')) as { name: string; files: string[] };
      expect(pkg.name).toBe(p.name);
      expect(pkg.files).toEqual([p.out, 'README.md']);
      expect(outDirOf(join(root, p.dir))).toBe(join(root, p.dir, p.out));
    }
  });

  it('keeps one version across the four packages', () => {
    const root = join(import.meta.dirname, '..', '..');
    const versions = SDK_PACKAGES.map((p) => (JSON.parse(readFileSync(join(root, p.dir, 'package.json'), 'utf8')) as { version: string }).version);
    expect(new Set(versions).size).toBe(1);
  });
});

describe('sdk-version', () => {
  it('accepts x.y.z and x.y.z-pre only', () => {
    for (const v of ['0.1.0', '1.0.0', '0.2.0-rc.1']) expect(() => checkVersion(v)).not.toThrow();
    for (const v of ['v0.1.0', '0.1', '01.0.0', '0.1.0+build', '', 'latest']) expect(() => checkVersion(v)).toThrow(/is not a version/u);
  });

  it('sets the top-level package.json version only, keeping the rest of the file', () => {
    const text = '{\n  "name": "@hana-id/web",\n  "version": "0.1.0",\n  "devDependencies": {\n    "x": "1.0.0"\n  }\n}\n';
    expect(withPackageVersion(text, '0.2.0')).toBe(text.replace('"version": "0.1.0"', '"version": "0.2.0"'));
    expect(() => withPackageVersion('{\n  "name": "x"\n}\n', '0.2.0')).toThrow(/no top-level "version"/u);
  });

  it('sets the VERSION constant', () => {
    expect(withVersionConstant("/** v */\nexport const VERSION = '0.1.0';\nexport const X = 1;\n", '0.2.0')).toBe("/** v */\nexport const VERSION = '0.2.0';\nexport const X = 1;\n");
    expect(() => withVersionConstant('export const X = 1;\n', '0.2.0')).toThrow(/no `export const VERSION/u);
  });

  it('writes every package.json and VERSION file of the four packages, and nothing when already set', () => {
    const real = join(import.meta.dirname, '..', '..');
    const root = mkdtempSync(join(import.meta.dirname, '..', '.tmp-sdk-version-'));
    try {
      for (const p of SDK_PACKAGES) {
        mkdirSync(join(root, p.dir, 'src'), { recursive: true });
        for (const f of ['package.json', p.versionFile]) writeFileSync(join(root, p.dir, f), readFileSync(join(real, p.dir, f)));
      }
      const current = (JSON.parse(readFileSync(join(real, 'packages/core/package.json'), 'utf8')) as { version: string }).version;
      expect(setSdkVersion(root, current)).toEqual([]);
      expect(setSdkVersion(root, '9.8.7')).toEqual(SDK_PACKAGES.flatMap((p) => [join(p.dir, 'package.json'), join(p.dir, p.versionFile)]));
      for (const p of SDK_PACKAGES) {
        expect((JSON.parse(readFileSync(join(root, p.dir, 'package.json'), 'utf8')) as { version: string }).version).toBe('9.8.7');
        expect(readFileSync(join(root, p.dir, p.versionFile), 'utf8')).toContain("export const VERSION = '9.8.7';");
      }
      expect(() => setSdkVersion(root, 'v1')).toThrow(/is not a version/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

