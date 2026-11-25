// ledger-check.ts <env> snapshot|compare|feed-cursor [--before <file>] [--remote] [--d1-name <rehearsal>] [--out <file>] [--yes]
//
// The before-and-after comparison of the hot DB's ledger tables around migration 0027 (D916; docs/operations.md
// "Ledger rebuild (hot-DB migration 0027, D916)"), and the rollback's feed cursor step. See lib/ledger-check.ts. Rows
// are read with apiPrivateD1Execute (remote: D1's REST API, the statement in the HTTPS body; local: a 0600 file, with
// wrangler's log file off), so no row reaches wrangler's logs; never prints or writes a row.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, repoRoot } from '@hana-id/env';
import pg from 'pg';
import { withRehearsalD1 } from './lib/admin-apps.ts';
import { invocationDir } from './lib/admin-settings.ts';
import { run } from './lib/cli.ts';
import { apiPrivateD1Execute } from './lib/d1.ts';
import { LEDGER_CHECK_USAGE, ledgerCheck, referenceSchema } from './lib/ledger-check.ts';
import { assertPrivate, parseSecretJson, secretsDir, writeSecretJson } from './lib/secrets.ts';
import { ROLE_FILES, readRoleUrl } from './lib/usage-setup.ts';
import { redact } from './lib/usage-migrate.ts';

run(async () => {
  process.exitCode = await ledgerCheck(process.argv.slice(2), {
    manifest(env) {
      const m = loadEnv(env);
      return { network: m.network, d1Name: m.cloudflare.d1Name };
    },
    read: (env, d1Name, statement, remote) => {
      const m = loadEnv(env);
      return apiPrivateD1Execute(d1Name === m.cloudflare.d1Name ? m : withRehearsalD1(m, d1Name), statement, { remote });
    },
    async feedState(env) {
      const file = join(secretsDir(env), ROLE_FILES.usage_admin);
      if (!existsSync(file)) throw new Error(`No .secrets/${env}/${ROLE_FILES.usage_admin}: the admin feed's cursor can't be reached (docs/operations.md "Usage ledger")`);
      const { url } = readRoleUrl(file, 'usage_admin', `.secrets/${env}/${ROLE_FILES.usage_admin}`);
      const client = new pg.Client({ connectionString: url, application_name: 'hana-id ledger-check' });
      const safe = async <T>(f: () => Promise<T>): Promise<T> => {
        try {
          return await f();
        } catch (e) {
          throw new Error(redact(e instanceof Error ? e.message : String(e), url));
        }
      };
      await safe(() => client.connect());
      return {
        get: (keys) => safe(async () => new Map((await client.query<{ key: string; value: string }>('SELECT key, value FROM ops.state WHERE key = ANY($1::text[])', [keys])).rows.map((r) => [r.key, r.value]))),
        set: (key, value) => safe(async () => void (await client.query('UPDATE ops.state SET value = $2, updated_at = now() WHERE key = $1', [key, value]))),
        close: () => client.end(),
      };
    },
    secretsEnvDir: secretsDir,
    writeJson: writeSecretJson,
    readJson(file) {
      assertPrivate(file);
      return parseSecretJson<unknown>(readFileSync(file, 'utf8'), file);
    },
    log: (line) => console.log(line),
    now: () => new Date(),
    // A relative --before or --out is relative to where pnpm was run (INIT_CWD), not scripts/ (D924).
    cwd: invocationDir(),
    // What an index or trigger new since the snapshot must be: as this checkout's migrations create it (D924).
    referenceSchema: () => referenceSchema(join(repoRoot, 'apps', 'api', 'migrations')),
  });
}, LEDGER_CHECK_USAGE);
