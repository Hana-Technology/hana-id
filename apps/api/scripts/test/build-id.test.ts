// D384: the API and page Workers are deployed stamped with the build id, in the format and at the path deploy-check
// reads (@hana-id/env/build-id), and the page Workers are deployed only after the pages are built.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILD_ID_RE as ENV_BUILD_ID_RE, BUILD_PATH as ENV_BUILD_PATH, BUILD_VAR } from '@hana-id/env/build-id';
import { describe, expect, it } from 'vitest';
import { BUILD_ID_RE, BUILD_PATH, deployedBuild } from '../../src/build.ts';
import { TEST_MANIFEST, wranglerConfig } from '../gen-wrangler.ts';
import { pagesWranglerConfig } from '../pages-wrangler.ts';

const apiDir = join(import.meta.dirname, '..', '..');
const scripts = (JSON.parse(readFileSync(join(apiDir, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

describe('build id (D384)', () => {
  it('uses @hana-id/env’s format and path', () => {
    expect(BUILD_ID_RE.source).toBe(ENV_BUILD_ID_RE.source);
    expect(BUILD_PATH).toBe(ENV_BUILD_PATH);
  });

  it('reports only a well-formed id', () => {
    expect(deployedBuild('0485faa1c2d3')).toBe('0485faa1c2d3');
    expect(deployedBuild('0485faa1c2d3-dirty')).toBe('0485faa1c2d3-dirty');
    for (const v of [undefined, '', 'dev', '0485faa1c2d3\n', '0485FAA1C2D3']) expect(deployedBuild(v)).toBeNull();
  });

  it('deploy and deploy:pages stamp every Worker; deploy:pages builds the pages first', () => {
    expect(scripts.deploy).toBe('tsx ../../packages/env/src/stamped-deploy.ts');
    const steps = scripts['deploy:pages']!.split(' && ');
    expect(steps).toEqual(['pnpm --filter @hana-id/web build', 'tsx ../../packages/env/src/stamped-deploy.ts -c wrangler.vault.jsonc', 'tsx ../../packages/env/src/stamped-deploy.ts -c wrangler.auth.jsonc']);
    expect(Object.values(scripts).join('\n')).not.toMatch(/(^|&& )wrangler deploy/mu);
  });

  it('gen never writes HANA_BUILD: only a deploy stamps it, so a stale config can’t carry an old id', () => {
    const vars = (c: Record<string, unknown>) => Object.keys((c.vars as Record<string, string>) ?? {});
    const m = { ...TEST_MANIFEST, vaultOrigin: 'https://vault.example.com', authOrigin: 'https://auth.example.com', apiUrl: 'https://api.example.com' };
    expect(vars(wranglerConfig(m, '00000000-0000-0000-0000-000000000000'))).not.toContain(BUILD_VAR);
    expect(vars(pagesWranglerConfig(m, 'vault', '2025-01-01'))).not.toContain(BUILD_VAR);
    expect(vars(pagesWranglerConfig(m, 'auth', '2025-01-01'))).not.toContain(BUILD_VAR);
  });
});
