// The secret scan (.gitleaks.toml, used by the pre-commit hook and CI) catches this repo's own secret shapes (security
// sweep OPER-2). scripts/secret-scan-selftest.mjs generates fake secrets at run time and scans them; the CI `secrets`
// job runs it too, with the pinned gitleaks binary. Here it needs gitleaks on PATH (the hook requires it anyway);
// without it the suite is skipped and CI is the gate.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '@hana-id/env';
import { describe, expect, it } from 'vitest';

const SELFTEST = join(repoRoot, 'scripts', 'secret-scan-selftest.mjs');
const hasGitleaks = spawnSync('gitleaks', ['version'], { encoding: 'utf8' }).status === 0;
const run = (env: Record<string, string> = {}) => spawnSync(process.execPath, [SELFTEST], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000 });

describe.skipIf(!hasGitleaks)('secret scan self-test', () => {
  it('catches every Hana secret shape and passes the public look-alikes', () => {
    const res = run();
    expect(res.stdout).not.toMatch(/^FAIL/mu);
    expect(res.status, res.stdout).toBe(0);
    expect(res.stdout.match(/^ok /gmu)?.length).toBeGreaterThanOrEqual(13);
  });

  it('fails with gitleaks’ default rules alone (the finding it fixes), so it really tests the custom rules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hana-scan-config-'));
    try {
      const config = join(dir, 'default-only.toml');
      // The config as it was: defaults and the allowlists, no custom rules.
      const text = readFileSync(join(repoRoot, '.gitleaks.toml'), 'utf8');
      writeFileSync(config, text.replace(/\[\[rules\]\][\s\S]*?(?=\n# [^\n]*\n\[\[(?:rules|allowlists)\]\]|\n\[\[allowlists\]\])/gu, ''));
      expect(readFileSync(config, 'utf8')).not.toContain('[[rules]]');
      const res = run({ SECRET_SCAN_CONFIG: config });
      expect(res.status).toBe(1);
      expect(res.stdout).toMatch(/^FAIL {2}ed25519 secret key as a TS constant/mu);
      expect(res.stdout).toMatch(/^FAIL {2}KEK value in an innocent file/mu);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never prints a generated secret (only rule ids)', () => {
    const res = run();
    expect(res.stdout + res.stderr).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/u);
    expect(res.stdout + res.stderr).not.toMatch(/\d:[A-Za-z0-9+/]{43}=/u);
  });
});

describe('the hook and CI use the same config', () => {
  it('pre-commit scans staged changes with .gitleaks.toml; CI scans the full history with it and runs the self-test', () => {
    expect(readFileSync(join(repoRoot, '.githooks', 'pre-commit'), 'utf8')).toMatch(/gitleaks git --staged .*--config \.gitleaks\.toml/u);
    const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toMatch(/gitleaks git .*--config \.gitleaks\.toml/u);
    expect(ci).toContain('node scripts/secret-scan-selftest.mjs ./gitleaks');
  });
});
