// Runs SQL against the env's D1 database with `wrangler d1 execute`, from apps/api so local state is the same one
// `wrangler dev` uses (apps/api/.wrangler/state). Needs apps/api/wrangler.jsonc (apps/api/scripts/gen-wrangler.ts).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Manifest, repoRoot } from '@hana-id/env';

export const apiDir = join(repoRoot, 'apps', 'api');

export interface D1Options {
  remote: boolean;
}

/** wrangler d1 execute argv (exported for tests). */
export function d1Argv(m: Manifest, statement: string, opts: D1Options): string[] {
  return ['exec', 'wrangler', 'd1', 'execute', m.cloudflare.d1Name, opts.remote ? '--remote' : '--local', '--json', '--command', statement];
}

/** Executes the statement(s); returns the rows of every statement's result, concatenated. */
export function d1Execute<Row = Record<string, unknown>>(m: Manifest, statement: string, opts: D1Options): Row[] {
  const config = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].find((f) => existsSync(join(apiDir, f)));
  if (!config) throw new Error(`No wrangler config in apps/api. Generate it first: pnpm --filter @hana-id/api gen ${m.name}`);
  // argv array, no shell: the SQL is passed as one argument.
  const res = spawnSync('pnpm', d1Argv(m, statement, opts), { cwd: apiDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
    throw new Error(`wrangler d1 execute failed (exit ${res.status}):\n${text.slice(-2000)}`);
  }
  return parseD1Json<Row>(res.stdout);
}

/** Parses `wrangler d1 execute --json` output: an array of `{results, success}` (tolerates leading log lines). */
export function parseD1Json<Row>(stdout: string): Row[] {
  type Result = { results?: Row[]; success?: boolean; error?: unknown };
  let parsed: Result[] | undefined;
  // The JSON array starts at the beginning of a line; earlier lines may be logs (some contain '[').
  for (const m of stdout.matchAll(/^\[/gmu)) {
    try {
      const value = JSON.parse(stdout.slice(m.index)) as unknown;
      if (Array.isArray(value)) {
        parsed = value as Result[];
        break;
      }
    } catch {
      // not the JSON block
    }
  }
  if (!parsed) throw new Error('wrangler returned no JSON');
  const failed = parsed.find((r) => r.success === false);
  if (failed) throw new Error(`D1 error: ${JSON.stringify(failed.error ?? failed)}`);
  return parsed.flatMap((r) => r.results ?? []);
}
