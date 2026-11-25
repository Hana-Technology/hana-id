// D931 (after PR 159's reviews, L2): the pre-deploy migration check refuses a deploy whose database lacks a migration
// the code reads, and whenever it can't tell (fail closed); it reads the database from the config being deployed and
// hands wrangler that same config; the required file is each app's latest migration.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './index.ts';
import { pendingFromList, requireMigrations } from './require-migrations.ts';

const CONFIG = { name: 'hana-api', d1_databases: [{ binding: 'DB', database_name: 'hana-x', database_id: 'id', migrations_dir: 'migrations' }] };
const base = { configPath: '/w/wrangler.jsonc', config: CONFIG, binding: 'DB', required: '0034_origin_confirmations.sql' };
const LIST_NONE = '✅ No migrations to apply!';
const listOf = (files: string[]) => `Migrations to be applied:\n┌──────┐\n${files.map((f) => `│ ${f} │`).join('\n')}\n└──────┘`;

describe('requireMigrations', () => {
  it('passes when the database has every migration up to the required one (later ones may wait); asks about the deployed config', () => {
    const calls: string[][] = [];
    expect(requireMigrations({ ...base, wrangler: (argv) => (calls.push(argv), { status: 0, output: LIST_NONE }) })).toBeNull();
    expect(calls).toEqual([['d1', 'migrations', 'list', 'hana-x', '--remote', '-c', '/w/wrangler.jsonc']]);
    expect(requireMigrations({ ...base, wrangler: () => ({ status: 0, output: listOf(['0035_later.sql']) }) })).toBeNull();
  });

  it('refuses when the required migration, or one before it, is not applied', () => {
    expect(requireMigrations({ ...base, wrangler: () => ({ status: 0, output: listOf(['0034_origin_confirmations.sql']) }) })).toMatch(/lacks 0034_origin_confirmations\.sql/u);
    expect(requireMigrations({ ...base, wrangler: () => ({ status: 0, output: listOf(['0033_platform_ops.sql', '0034_origin_confirmations.sql']) }) })).toMatch(/lacks 0033_platform_ops\.sql, 0034_origin_confirmations\.sql/u);
  });

  it('fails closed: no such binding, wrangler failing or printing something else, a bad file name', () => {
    const ok = () => ({ status: 0, output: LIST_NONE });
    expect(requireMigrations({ ...base, binding: 'OTHER', wrangler: ok })).toMatch(/no D1 database bound as OTHER/u);
    expect(requireMigrations({ ...base, config: {}, wrangler: ok })).toMatch(/no D1 database bound as DB/u);
    expect(requireMigrations({ ...base, wrangler: () => ({ status: 1, output: 'Authentication error' }) })).toMatch(/failed \(exit 1\)/u);
    expect(requireMigrations({ ...base, wrangler: () => ({ status: 0, output: 'something new' }) })).toMatch(/printed something unexpected/u);
    expect(requireMigrations({ ...base, required: 'latest', wrangler: ok })).toMatch(/names no migration file/u);
    expect(pendingFromList('')).toBeNull();
  });

  it('each app’s deploy requires its latest migration, through the one wrapper', () => {
    for (const [app, binding, prefix] of [
      ['api', 'DB', ''],
      ['console', 'CONSOLE_DB', 'vite build && '],
    ] as const) {
      const deploy = (JSON.parse(readFileSync(join(repoRoot, 'apps', app, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts.deploy!;
      const latest = readdirSync(join(repoRoot, 'apps', app, 'migrations')).filter((f) => f.endsWith('.sql')).sort().at(-1);
      expect(deploy, app).toBe(`${prefix}tsx ../../packages/env/src/stamped-deploy.ts --require-migrations ${binding}:${latest}`);
    }
  });
});
