// usage-setup.ts <env> <roles | hyperdrive | user-id-key> [--yes]
//
// The usage ledger's credentials and the API's uid key (batch C4): role passwords (LOGIN as the Neon owner over the
// direct URL in .secrets/<env>/neon.json, the passwords reset through Neon's API with .secrets/<env>/neon-api-key,
// D403), the two Hyperdrive configs, USER_ID_KEY. Dry run by default. Never prints a password, a URL or a key. See
// lib/usage-setup.ts and docs/operations.md "Usage capture (batch C4)".
import { join } from 'node:path';
import pg from 'pg';
import { run } from './lib/cli.ts';
import { readSecretJson, secretsDir } from './lib/secrets.ts';
import { type NeonSecrets, USAGE_SETUP_USAGE, defaultUsageSetupDeps, usageSetup } from './lib/usage-setup.ts';

run(async () => {
  await usageSetup(
    process.argv.slice(2),
    defaultUsageSetupDeps(
      async (url) => {
        const client = new pg.Client({ connectionString: url, application_name: 'hana-id usage-setup' });
        await client.connect();
        return {
          exec: async (sql) => void (await client.query(sql)),
          query: async <T>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[],
          close: () => client.end(),
        };
      },
      (env) => readSecretJson<NeonSecrets>(join(secretsDir(env), 'neon.json')),
    ),
  );
}, USAGE_SETUP_USAGE);
