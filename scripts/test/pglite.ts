// The budgets and the shared ledger of the scripts' PGlite tests. PGlite boots a WASM Postgres: ~0.5 s alone, but
// several seconds when `pnpm -r test` runs every package's suite at once, over vitest's defaults (5 s a test, 10 s a
// hook). The describes and hooks that touch PGlite take the budgets apps/api's PGlite suite has (vitest.usage.config.ts);
// the rest of the scripts' tests keep the defaults. A file that needs a migrated ledger per test builds it once
// (`migratedLedger` in a `beforeAll`) and gives each test a `clone()` of it, which costs a fraction of a boot.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { repoRoot } from '@hana-id/env';

/** A describe's options when its tests boot, clone or query PGlite. */
export const PGLITE = { timeout: 30_000 };
/** The timeout of a hook that boots, clones or migrates PGlite. */
export const PGLITE_HOOK_MS = 60_000;

/** A fresh PGlite with every migration in apps/api/migrations-usage applied, as the ledger's owner. */
export async function migratedLedger(): Promise<PGlite> {
  const db = new PGlite();
  const dir = join(repoRoot, 'apps', 'api', 'migrations-usage');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) await db.exec(readFileSync(join(dir, f), 'utf8'));
  return db;
}
