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
 * Packages still allowed to read the legacy column, each with the batch that must remove it.
 * - `apps/email-issuer` (branch `feat/email-login-4`): finds apps by `apps.publishable_key` and checks only `status`.
 *   It must move to `app_keys` (unrevoked key), `deleted_at IS NULL` and `suspended_by = 0` (D206). Until then batch C5
 *   keeps the column on a valid key or a tombstone and deleted apps suspended, so it never serves a revoked, rotating
 *   or deleted app's key, though it gives a rotated key no grace (D225).
 */
const ALLOWLIST = new Set(['apps/email-issuer']);

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

describe('guarded/config.ts', () => {
  it('has the manifest package’s appChangeDelayMs bounds', () => {
    expect(apiConfig.MIN_APP_CHANGE_DELAY_MS).toBe(MIN_APP_CHANGE_DELAY_MS);
    expect(apiConfig.MAX_APP_CHANGE_DELAY_MS).toBe(MAX_APP_CHANGE_DELAY_MS);
    expect(apiConfig.PRODUCTION_APP_CHANGE_DELAY_MS).toBe(PRODUCTION_APP_CHANGE_DELAY_MS);
  });
});
