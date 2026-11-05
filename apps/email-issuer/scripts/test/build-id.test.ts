// D384: the issuer is deployed stamped with the build id (HANA_BUILD), which only the deploy script sets.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '@hana-id/env';
import { BUILD_VAR } from '@hana-id/env/build-id';
import { describe, expect, it } from 'vitest';
import { wranglerConfig } from '../gen-wrangler.ts';

const appDir = join(import.meta.dirname, '..', '..');
const scripts = (JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

describe('build id (D384)', () => {
  it('deploy stamps the Worker; no script deploys it unstamped', () => {
    expect(scripts.deploy).toBe('tsx scripts/deploy.ts');
    expect(Object.values(scripts).join('\n')).not.toMatch(/(^|&& )wrangler deploy/mu);
  });

  it('gen never writes HANA_BUILD (only a deploy stamps it)', () => {
    const config = wranglerConfig(loadEnv('sandbox-dev'), '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002');
    expect(Object.keys(config.vars as Record<string, string>)).not.toContain(BUILD_VAR);
  });
});
