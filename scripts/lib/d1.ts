// Runs SQL against an env's D1 databases with `wrangler d1 execute`: the API's from apps/api (local state is the one
// `wrangler dev` uses, apps/api/.wrangler/state; needs apps/api/wrangler.jsonc from apps/api/scripts/gen-wrangler.ts),
// and the email issuer's own D1 from apps/email-issuer (needs its wrangler.jsonc from apps/email-issuer's `gen`).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Manifest, repoRoot } from '@hana-id/env';

export const apiDir = join(repoRoot, 'apps', 'api');
export const emailIssuerDir = join(repoRoot, 'apps', 'email-issuer');

export interface D1Options {
  remote: boolean;
}

/** wrangler d1 execute argv (exported for tests). */
export function d1Argv(m: Pick<Manifest, 'cloudflare'>, statement: string, opts: D1Options): string[] {
  return d1ArgvFor(m.cloudflare.d1Name, statement, opts);
}

/** wrangler d1 execute argv for the email issuer's own D1 (`emailIssuer.cloudflare.d1Name`). */
export function issuerD1Argv(m: Pick<Manifest, 'name' | 'emailIssuer'>, statement: string, opts: D1Options): string[] {
  if (!m.emailIssuer) throw new Error(`envs/${m.name}.json has no emailIssuer`);
  return d1ArgvFor(m.emailIssuer.cloudflare.d1Name, statement, opts);
}

const d1ArgvFor = (d1Name: string, statement: string, opts: D1Options): string[] => ['exec', 'wrangler', 'd1', 'execute', d1Name, opts.remote ? '--remote' : '--local', '--json', '--command', statement];

/**
 * wrangler's environment for a statement or result that holds personal data (the issuer's user directory, D269):
 * no debug log file (wrangler otherwise copies every message, its JSON result included, to ~/.wrangler/logs), no usage
 * metrics, no error reports.
 */
export const PRIVATE_WRANGLER_ENV: Readonly<Record<string, string>> = { WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false' };

function runD1<Row>(dir: string, genHint: string, argv: string[], env?: Readonly<Record<string, string>>): Row[] {
  const config = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].find((f) => existsSync(join(dir, f)));
  if (!config) throw new Error(`No wrangler config in ${dir.slice(repoRoot.length + 1)}. Generate it first: ${genHint}`);
  // argv array, no shell: the SQL is passed as one argument.
  const res = spawnSync('pnpm', argv, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
    throw new Error(`wrangler d1 execute failed (exit ${res.status}):\n${text.slice(-2000)}`);
  }
  return parseD1Json<Row>(res.stdout);
}

/** Executes the statement(s) on the API's D1; returns the rows of every statement's result, concatenated. */
export function d1Execute<Row = Record<string, unknown>>(m: Manifest, statement: string, opts: D1Options): Row[] {
  return runD1<Row>(apiDir, `pnpm --filter @hana-id/api gen ${m.name}`, d1Argv(m, statement, opts));
}

/**
 * Executes the statement(s) on the email issuer's own D1, with wrangler's log file, metrics and error reports off
 * (`PRIVATE_WRANGLER_ENV`): its tables hold users' addresses.
 */
export function issuerD1Execute<Row = Record<string, unknown>>(m: Manifest, statement: string, opts: D1Options): Row[] {
  return runD1<Row>(emailIssuerDir, `pnpm --filter @hana-id/email-issuer gen ${m.name} --d1-id <uuid> --app-d1-id <uuid>`, issuerD1Argv(m, statement, opts), PRIVATE_WRANGLER_ENV);
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
