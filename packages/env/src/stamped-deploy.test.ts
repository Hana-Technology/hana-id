// D406: one deploy wrapper for every Worker. It runs `wrangler deploy <args> --var HANA_BUILD:<this checkout's id>`
// and passes wrangler's exit status on; every app that deploys a Worker of an env runs it, none runs a raw
// `wrangler deploy`, and no app keeps its own copy.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILD_PATH, buildBody, deployedBuild } from './build-id.ts';
import { repoRoot } from './index.ts';
import { localBuild } from './local-build.ts';

const WRAPPER = join(repoRoot, 'packages', 'env', 'src', 'stamped-deploy.ts');
const RUN = 'tsx ../../packages/env/src/stamped-deploy.ts';
/** The apps whose Worker is part of an env (the manifest names each); the hosted demo deploys on its own (apps/demo). */
const WORKER_APPS = ['admin', 'api', 'console', 'console-auth', 'email-issuer', 'files', 'watchdog'];

const scriptsOf = (app: string): Record<string, string> => (JSON.parse(readFileSync(join(repoRoot, 'apps', app, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the build endpoint body', () => {
  it('is `{"build": <id>}` for a build id and `{"build": null}` for anything else', () => {
    expect(BUILD_PATH).toBe('/.well-known/hana-build');
    expect(buildBody('0485faa1c2d3-dirty')).toBe('{"build":"0485faa1c2d3-dirty"}\n');
    for (const v of [undefined, null, '', 'latest', '0485faa1c2d3\n', '0485FAA1C2D3', 7]) {
      expect(deployedBuild(v), String(v)).toBeNull();
      expect(buildBody(v)).toBe('{"build":null}\n');
    }
  });
});

describe('the shared deploy wrapper', () => {
  it('runs `wrangler deploy <args> --var HANA_BUILD:<id>` in the current directory and exits with wrangler’s status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hana-stamped-deploy-'));
    dirs.push(dir);
    // A stand-in wrangler first on PATH: it records its arguments and exits 3.
    writeFileSync(join(dir, 'wrangler'), '#!/bin/sh\nprintf "%s\\n" "$@" > args.txt\nexit 3\n');
    chmodSync(join(dir, 'wrangler'), 0o755);
    const res = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', WRAPPER, '-c', 'wrangler.vault.jsonc'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    });
    expect(res.status).toBe(3);
    const id = localBuild().id;
    expect(readFileSync(join(dir, 'args.txt'), 'utf8').trim().split('\n')).toEqual(['deploy', '-c', 'wrangler.vault.jsonc', '--var', `HANA_BUILD:${id}`]);
    expect(res.stdout).toContain(`Build ${id}`);
  });

  it('is what every env Worker’s deploy runs; no script deploys unstamped; no app keeps a copy', () => {
    const apps = readdirSync(join(repoRoot, 'apps')).filter((a) => existsSync(join(repoRoot, 'apps', a, 'package.json')) && 'deploy' in scriptsOf(a) && a !== 'demo');
    expect(apps.sort()).toEqual(WORKER_APPS);
    for (const app of WORKER_APPS) {
      const scripts = scriptsOf(app);
      const steps = scripts.deploy!.split(' && ');
      expect(steps.at(-1), app).toBe(RUN);
      expect(Object.values(scripts).join('\n'), app).not.toMatch(/(^|&& )wrangler deploy/mu);
      expect(existsSync(join(repoRoot, 'apps', app, 'scripts', 'deploy.ts')), app).toBe(false);
    }
    expect(scriptsOf('console').deploy).toBe(`vite build && ${RUN}`);
    expect(scriptsOf('api')['deploy:pages']).toBe(`pnpm --filter @hana-id/web build && ${RUN} -c wrangler.vault.jsonc && ${RUN} -c wrangler.auth.jsonc`);
  });
});
