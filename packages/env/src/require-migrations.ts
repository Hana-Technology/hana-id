// D931 (after PR 159's reviews, L2): the order "migrations before the code that reads them", enforced before a deploy.
// The shared deploy wrapper (./local-build.ts `stampedDeploy`) runs this when an app's deploy script asks
// (`--require-migrations <D1 binding>:<NNNN_name.sql>`), on the SAME config it then deploys: it finds the binding's
// database in that config, asks wrangler which migrations that database lacks (`wrangler d1 migrations list <database>
// --remote -c <that config>`, which reads its `d1_migrations`), and refuses the deploy if the required migration, or any
// before it, is among them. It fails closed: a binding it doesn't find, wrangler failing or printing something it
// doesn't recognise, all refuse. The required file is the latest migration the app's code reads (the API's 0034, the
// console's 0007); a test holds each to its migrations folder.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface RequireMigrationsInput {
  /** The config the deploy uses (absolute) and its parsed content. */
  configPath: string;
  config: Record<string, unknown>;
  binding: string;
  required: string;
  /** The environment wrangler runs with (the wrapper's, without the variables it refuses). */
  env?: NodeJS.ProcessEnv;
  /** Whether a file exists (the required migration in the config's migrations folder). */
  exists?: (path: string) => boolean;
  /** `pnpm exec wrangler <argv>` in the config's directory: its exit status and its stdout and stderr together. */
  wrangler?: (argv: string[]) => { status: number; output: string };
}

const runWrangler = (cwd: string, env: NodeJS.ProcessEnv | undefined) => (argv: string[]) => {
  const r = spawnSync('pnpm', ['exec', 'wrangler', ...argv], { cwd, encoding: 'utf8', ...(env ? { env } : {}) });
  return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

/** The migrations wrangler says are not applied ([] for none), or null when its output isn't one it prints. */
export function pendingFromList(output: string): string[] | null {
  if (output.includes('No migrations to apply')) return [];
  if (!output.includes('Migrations to be applied')) return null;
  return [...new Set([...output.matchAll(/\b\d{4}_[A-Za-z0-9_-]+\.sql\b/gu)].map((m) => m[0]))].sort();
}

/** Why the deploy is refused, or null when the database has every migration up to `required`. */
export function requireMigrations(i: RequireMigrationsInput): string | null {
  if (!/^\d{4}_[A-Za-z0-9_-]+\.sql$/u.test(i.required)) return 'refused: --require-migrations names no migration file';
  const dbs = i.config.d1_databases as { binding?: unknown; database_name?: unknown }[] | undefined;
  const d = Array.isArray(dbs) ? (dbs as { binding?: unknown; database_name?: unknown; migrations_dir?: unknown }[]).find((x) => x?.binding === i.binding) : undefined;
  const db = typeof d?.database_name === 'string' ? d.database_name : undefined;
  if (!db) return `refused: ${i.configPath} has no D1 database bound as ${i.binding}`;
  // After PR 159's third review: wrangler answers "No migrations to apply" for a file it doesn't know, so the required
  // file must be in the folder wrangler reads (`migrations_dir`, default `migrations`, beside the config).
  const folder = resolve(dirname(i.configPath), typeof d?.migrations_dir === 'string' ? d.migrations_dir : 'migrations');
  if (!(i.exists ?? existsSync)(join(folder, i.required))) return `refused: ${i.required} is not in ${folder}, the migrations folder wrangler reads for ${i.binding}: can't tell whether it is applied`;
  const r = (i.wrangler ?? runWrangler(dirname(i.configPath), i.env))(['d1', 'migrations', 'list', db, '--remote', '-c', i.configPath]);
  if (r.status !== 0) return `refused: wrangler d1 migrations list ${db} --remote failed (exit ${r.status}): can't tell whether ${i.required} is applied`;
  const pending = pendingFromList(r.output);
  if (pending === null) return `refused: wrangler d1 migrations list ${db} --remote printed something unexpected: can't tell whether ${i.required} is applied`;
  const missing = pending.filter((f) => f <= i.required);
  if (missing.length) return `refused: ${db} lacks ${missing.join(', ')}: this code reads what they create. Apply the migrations first (docs/operations.md), then deploy`;
  return null;
}
