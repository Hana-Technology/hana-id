// D931 (after PR 159's review, L2): the order "migrations before the code that reads them", enforced before a deploy.
// Each app whose Worker reads D1 tables a migration creates runs this before the shared deploy wrapper
// (`tsx ../../packages/env/src/check-migrations.ts --binding DB --required <file> && tsx …/stamped-deploy.ts`): it
// reads the generated wrangler config in the current directory, asks wrangler which of the app's migrations the
// remote database lacks (`wrangler d1 migrations list <database> --remote`, which reads its `d1_migrations`), and
// refuses the deploy if the required migration, or any migration before it, is among them. It fails closed: a config it
// can't read, a binding it doesn't find, wrangler failing or printing something it doesn't recognise, all refuse.
// The required file is the highest migration the code of this checkout reads (`apps/api`: 0034, the confirmations and
// the staff waits every cancel's plan read now joins); a test holds it to the migrations folder.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RequireMigrationsDeps {
  /** A file's text in `cwd` (throws when missing). */
  read?: (path: string) => string;
  /** `pnpm exec wrangler <argv>` in `cwd`: its exit status and its stdout and stderr together. */
  wrangler?: (argv: string[]) => { status: number; output: string };
  log?: (line: string) => void;
  cwd?: string;
}

const runWrangler = (cwd: string) => (argv: string[]) => {
  const r = spawnSync('pnpm', ['exec', 'wrangler', ...argv], { cwd, encoding: 'utf8' });
  return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

/** The migrations wrangler says are not applied ([] for none), or null when its output isn't one it prints. */
export function pendingFromList(output: string): string[] | null {
  if (output.includes('No migrations to apply')) return [];
  if (!output.includes('Migrations to be applied')) return null;
  return [...new Set([...output.matchAll(/\b\d{4}_[A-Za-z0-9_-]+\.sql\b/gu)].map((m) => m[0]))].sort();
}

/** Why the deploy is refused, or null when the database has every migration up to `required`. */
export function requireMigrations(argv: readonly string[], deps: RequireMigrationsDeps = {}): string | null {
  const cwd = deps.cwd ?? process.cwd();
  const flag = (name: string): string | undefined => {
    const k = argv.indexOf(name);
    return k >= 0 ? argv[k + 1] : undefined;
  };
  const binding = flag('--binding');
  const required = flag('--required');
  const config = flag('--config') ?? 'wrangler.jsonc';
  if (!binding || !required || !/^\d{4}_[A-Za-z0-9_-]+\.sql$/u.test(required)) return 'refused: usage: require-migrations --binding <D1 binding> --required <NNNN_name.sql> [--config <file>]';
  let db: string | undefined;
  try {
    const text = (deps.read ?? ((p: string) => readFileSync(join(cwd, p), 'utf8')))(config)
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    const c = JSON.parse(text) as { d1_databases?: { binding?: unknown; database_name?: unknown }[] };
    const d = c.d1_databases?.find((x) => x.binding === binding);
    db = typeof d?.database_name === 'string' ? d.database_name : undefined;
  } catch {
    return `refused: can't read ${config} to find the ${binding} database (generate it with the app's gen script first)`;
  }
  if (!db) return `refused: ${config} has no D1 database bound as ${binding}`;
  const r = (deps.wrangler ?? runWrangler(cwd))(['d1', 'migrations', 'list', db, '--remote']);
  if (r.status !== 0) return `refused: wrangler d1 migrations list ${db} --remote failed (exit ${r.status}): can't tell whether ${required} is applied`;
  const pending = pendingFromList(r.output);
  if (pending === null) return `refused: wrangler d1 migrations list ${db} --remote printed something unexpected: can't tell whether ${required} is applied`;
  const missing = pending.filter((f) => f <= required);
  if (missing.length) return `refused: ${db} lacks ${missing.join(', ')}: this code reads what they create. Apply the migrations first (docs/operations.md), then deploy`;
  return null;
}
