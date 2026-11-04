// Batch C3 source checks (docs/batch-c-spec.md tests "Hot DB and gate"): after migration 0006 the gate reads keys from
// app_keys and scopes, so no code reads `apps.publishable_key` outside the migration and its triggers (it stays only
// as the legacy column every new app still fills); and the API's copy of the guarded-change delay bounds equals the
// manifest package's.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MAX_APP_CHANGE_DELAY_MS, MIN_APP_CHANGE_DELAY_MS, PRODUCTION_APP_CHANGE_DELAY_MS, repoRoot } from '@hana-id/env';
import { describe, expect, it } from 'vitest';
import * as apiConfig from '../../src/guarded/config.ts';

/** Every .ts source file under `dir`, tests and dependencies excluded. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|mts|tsx)$/u.test(name) && !/\.test\.ts$/u.test(name)) out.push(p);
  }
  return out;
}

/** A read of the legacy column: qualified, compared, or selected from `apps`. Writes (INSERT INTO apps) are fine. */
const READS = [/\b(?:a|l|apps)\.publishable_key\b/u, /\bpublishable_key\s*(?:=|LIKE\b|IS\b|IN\b)/iu, /SELECT\b[^`'";]*\bpublishable_key\b[^`'";]*\bFROM\s+apps\b/iu];
/**
 * The only expressions allowed to name the column outside an INSERT: the alias of app_keys.key in the gate, and the
 * RPC's two assignments that keep the legacy column on a valid key or a tombstone (changes/keys.ts syncLegacyKey,
 * changes/suspension.ts deleteApp; D225). Both write it; neither reads it.
 */
const ALLOWED = ['k.key AS publishable_key', 'UPDATE apps SET publishable_key = COALESCE(', 'publishable_key = ${legacyKeyTombstone('];

/**
 * Packages still allowed to read the legacy column, each with the batch that must remove it. None: `apps/email-issuer`
 * moved to the gate's model (`app_keys` revoked or in its grace, `deleted_at IS NULL`, `suspended_by = 0`) in email
 * login batch 6 (D206, D225), so it is scanned like every other package.
 */
const ALLOWLIST = new Set<string>();

describe('no code reads apps.publishable_key (it stays only for the legacy column)', () => {
  it('every apps/*/src and scripts', () => {
    const apps = readdirSync(join(repoRoot, 'apps')).filter((d) => !ALLOWLIST.has(`apps/${d}`));
    const roots = [...apps.map((d) => `apps/${d}/src`), 'scripts'].map((d) => join(repoRoot, d));
    const offenders: string[] = [];
    let scanned = 0;
    for (const root of roots) {
      let files: string[];
      try {
        files = sources(root);
      } catch {
        continue; // a package this checkout doesn't have
      }
      for (const file of files) {
        scanned++;
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            // Comments may name the column (to say it isn't read).
            if (/^\s*(\/\/|\/\*|\*)/u.test(line)) return;
            const text = ALLOWED.reduce((t, a) => t.replaceAll(a, ''), line);
            if (READS.some((re) => re.test(text))) offenders.push(`${relative(repoRoot, file)}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(scanned).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
    // The email issuer is scanned too (it reads the API's D1).
    expect(roots.some((r) => r.endsWith(join('apps', 'email-issuer', 'src')))).toBe(true);
  });

  it('the check catches the batch B reads it replaced', () => {
    for (const old of [
      "WHERE a.publishable_key = ?1",
      "AND a.publishable_key LIKE 'pk\\\\_test\\\\_%'",
      "SELECT id, name, scope_id, publishable_key, status, plan FROM apps WHERE id = ${idOrKey}",
      "SELECT id FROM apps WHERE publishable_key = ?",
    ]) {
      expect(READS.some((re) => re.test(old)), old).toBe(true);
    }
    expect(READS.some((re) => re.test('INSERT INTO apps (id, name, scope_id, org_id, publishable_key, status) VALUES'))).toBe(false);
  });
});

/** SQL on the legacy D1 `usage` table (its own name, not `usage.` of the Neon schema nor `identity_usage`). */
const LEGACY_USAGE = [/\b(?:FROM|INTO|UPDATE|JOIN)\s+usage\b(?!\.)/iu];

describe('no code reads or writes the legacy D1 usage table (batch C4: usage goes to the Neon ledger; C4b drops it)', () => {
  it('every apps/*/src and scripts', () => {
    const roots = [...readdirSync(join(repoRoot, 'apps')).map((d) => `apps/${d}/src`), 'scripts'].map((d) => join(repoRoot, d));
    const offenders: string[] = [];
    for (const root of roots) {
      let files: string[];
      try {
        files = sources(root);
      } catch {
        continue;
      }
      for (const file of files) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (/^\s*(\/\/|\/\*|\*|--)/u.test(line)) return;
            if (LEGACY_USAGE.some((re) => re.test(line))) offenders.push(`${relative(repoRoot, file)}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the check catches the batch B writes and the waiver read it replaced, and not the Neon schema', () => {
    for (const old of ['INSERT INTO usage (app_id, day, sessions, derives)', 'AND NOT EXISTS (SELECT 1 FROM usage WHERE app_id IN x)', 'UPDATE usage SET unlocks = unlocks + 1']) {
      expect(LEGACY_USAGE.some((re) => re.test(old)), old).toBe(true);
    }
    for (const fine of ['SELECT usage.record_event($1::jsonb)', 'FROM usage.events', 'FROM identity_usage u JOIN apps a']) expect(LEGACY_USAGE.some((re) => re.test(fine)), fine).toBe(false);
  });
});

describe('guarded/config.ts', () => {
  it('has the manifest package’s appChangeDelayMs bounds', () => {
    expect(apiConfig.MIN_APP_CHANGE_DELAY_MS).toBe(MIN_APP_CHANGE_DELAY_MS);
    expect(apiConfig.MAX_APP_CHANGE_DELAY_MS).toBe(MAX_APP_CHANGE_DELAY_MS);
    expect(apiConfig.PRODUCTION_APP_CHANGE_DELAY_MS).toBe(PRODUCTION_APP_CHANGE_DELAY_MS);
  });
});
