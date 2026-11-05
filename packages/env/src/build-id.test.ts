import { describe, expect, it, vi } from 'vitest';
import { BUILD_ID_RE, assertBuildId, buildMeta, formatBuildId, parseBuildId, parseBuildMeta, parseVaultBanner, vaultBanner } from './build-id.ts';
import { type Git, localBuild, stampedDeploy, stampedDeployArgv } from './local-build.ts';

const SHA = '0485faa1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7';

describe('build id format', () => {
  it('is the first 12 hex characters of the commit, with -dirty for a tree with changes', () => {
    expect(formatBuildId(SHA, false)).toBe('0485faa1c2d3');
    expect(formatBuildId(SHA, true)).toBe('0485faa1c2d3-dirty');
    expect(formatBuildId('0485faa1c2d3', false)).toBe('0485faa1c2d3');
    for (const bad of ['', '0485faa', SHA.toUpperCase(), `${SHA} `, 'g485faa1c2d3']) expect(() => formatBuildId(bad, false), bad).toThrow();
  });

  it('parses only well-formed ids', () => {
    expect(parseBuildId('0485faa1c2d3')).toEqual({ id: '0485faa1c2d3', commit: '0485faa1c2d3', dirty: false });
    expect(parseBuildId('0485faa1c2d3-dirty')).toEqual({ id: '0485faa1c2d3-dirty', commit: '0485faa1c2d3', dirty: true });
    for (const bad of [undefined, null, 1, '', 'unknown', '0485faa1c2d', '0485faa1c2d3e', '0485faa1c2d3-DIRTY', '0485faa1c2d3-dirty ', SHA]) {
      expect(parseBuildId(bad), String(bad)).toBeNull();
    }
  });

  it('never lets anything but an id into a JS comment or an HTML attribute', () => {
    for (const bad of ['0485faa1c2d3 */ alert(1) /*', '0485faa1c2d3"><script>', '']) {
      expect(() => assertBuildId(bad)).toThrow();
      expect(() => vaultBanner(bad)).toThrow();
      expect(() => buildMeta(bad)).toThrow();
    }
    expect(BUILD_ID_RE.test(assertBuildId('0485faa1c2d3-dirty'))).toBe(true);
  });
});

describe('bundle stamps', () => {
  it('the vault banner round-trips, at the start of the bundle only', () => {
    const js = `${vaultBanner('0485faa1c2d3')}\nvar a=1;`;
    expect(parseVaultBanner(js)?.id).toBe('0485faa1c2d3');
    expect(parseVaultBanner(`var a=1;\n${vaultBanner('0485faa1c2d3')}`)).toBeNull();
    expect(parseVaultBanner('var a=1;')).toBeNull();
    expect(parseVaultBanner('/* hana-build nope */')).toBeNull();
  });

  it('the auth meta round-trips; a page with none, two or a malformed one has no id', () => {
    const meta = buildMeta('0485faa1c2d3-dirty');
    expect(meta).toBe('<meta name="hana-build" content="0485faa1c2d3-dirty">');
    expect(parseBuildMeta(`<head>${meta}</head>`)).toEqual({ id: '0485faa1c2d3-dirty', commit: '0485faa1c2d3', dirty: true });
    expect(parseBuildMeta('<head></head>')).toBeNull();
    expect(parseBuildMeta(`${meta}${buildMeta('111111111111')}`)).toBeNull();
    expect(parseBuildMeta('<meta name="hana-build" content="x">')).toBeNull();
  });
});

describe('localBuild', () => {
  const git = (head: string, status: string): Git => (args) => (args[0] === 'rev-parse' ? `${head}\n` : status);

  it('stamps HEAD, -dirty when git status lists anything (untracked files too)', () => {
    expect(localBuild(git(SHA, ''))).toEqual({ id: '0485faa1c2d3', commit: '0485faa1c2d3', dirty: false, head: SHA });
    expect(localBuild(git(SHA, ' M apps/api/src/index.ts\n')).id).toBe('0485faa1c2d3-dirty');
    expect(localBuild(git(SHA, '?? apps/api/src/new.ts\n')).dirty).toBe(true);
  });

  it('asks git for untracked files and HEAD itself', () => {
    const calls: string[][] = [];
    localBuild((args) => {
      calls.push([...args]);
      return args[0] === 'rev-parse' ? SHA : '';
    });
    expect(calls).toEqual([
      ['rev-parse', '--verify', 'HEAD'],
      ['status', '--porcelain=v1', '--untracked-files=normal'],
    ]);
  });

  it('fails outside a git checkout or on a strange answer, never returning a made-up id', () => {
    expect(() =>
      localBuild(() => {
        throw new Error('not a git repository');
      }),
    ).toThrow(/git checkout/u);
    expect(() => localBuild(git('HEAD', ''))).toThrow(/commit hash/u);
  });

  it('reads this checkout', () => {
    const b = localBuild();
    expect(b.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(b.id.startsWith(b.head.slice(0, 12))).toBe(true);
  });
});

describe('stampedDeploy', () => {
  const build = () => ({ id: '0485faa1c2d3', commit: '0485faa1c2d3', dirty: false, head: SHA });

  it('runs wrangler deploy with the caller’s arguments and the HANA_BUILD var', () => {
    expect(stampedDeployArgv('0485faa1c2d3', ['-c', 'wrangler.vault.jsonc'])).toEqual(['deploy', '-c', 'wrangler.vault.jsonc', '--var', 'HANA_BUILD:0485faa1c2d3']);
    const wrangler = vi.fn(() => 0);
    const lines: string[] = [];
    expect(stampedDeploy([], { build, wrangler, log: (l) => lines.push(l) })).toBe(0);
    expect(wrangler).toHaveBeenCalledWith(['deploy', '--var', 'HANA_BUILD:0485faa1c2d3']);
    expect(lines.join('\n')).toContain('0485faa1c2d3');
  });

  it('passes wrangler’s failure on, and says when the tree is dirty', () => {
    const lines: string[] = [];
    const dirty = () => ({ id: '0485faa1c2d3-dirty', commit: '0485faa1c2d3', dirty: true, head: SHA });
    expect(stampedDeploy([], { build: dirty, wrangler: () => 3, log: (l) => lines.push(l) })).toBe(3);
    expect(lines.join('\n')).toMatch(/uncommitted changes/u);
  });

  it('refuses a HANA_BUILD from the command line (only git sets it)', () => {
    const wrangler = vi.fn(() => 0);
    expect(() => stampedDeploy(['--var', 'HANA_BUILD:aaaaaaaaaaaa'], { build, wrangler, log: () => undefined })).toThrow(/HANA_BUILD/u);
    expect(wrangler).not.toHaveBeenCalled();
    expect(() => stampedDeployArgv('nope', [])).toThrow();
  });
});
