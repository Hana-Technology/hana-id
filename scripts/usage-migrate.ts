// usage-migrate.ts <env> [--yes]
//
// Applies apps/api/migrations-usage to the env's Neon usage ledger (batch C, D73) as the project's owner role over the
// direct URL in .secrets/<env>/neon.json. Dry run by default. Never prints the URL or its password. See
// lib/usage-migrate.ts and docs/operations.md "Usage ledger (Neon)".
import { join } from 'node:path';
import { loadEnv, repoRoot } from '@hana-id/env';
import pg from 'pg';
import { run } from './lib/cli.ts';
import { readSecretJson, secretsDir } from './lib/secrets.ts';
import { USAGE_MIGRATE_USAGE, usageMigrate } from './lib/usage-migrate.ts';

run(async () => {
  await usageMigrate(
    process.argv.slice(2),
    {
      readNeonSecrets: (env) => readSecretJson<{ DATABASE_URL_DIRECT?: unknown }>(join(secretsDir(env), 'neon.json')),
      async connect(url) {
        const client = new pg.Client({ connectionString: url, application_name: 'hana-id usage-migrate' });
        await client.connect();
        return {
          exec: async (sql) => void (await client.query(sql)),
          query: async <T>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[],
          close: () => client.end(),
        };
      },
      migrationsDir: join(repoRoot, 'apps', 'api', 'migrations-usage'),
      log: (line) => console.log(line),
    },
    (env) => void loadEnv(env),
  );
}, USAGE_MIGRATE_USAGE);
