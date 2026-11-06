// uid-erase.ts <env> --scope <scope id> --provider <provider> --sub <sub | -> --ticket <ref> [--remote] [--no-ledger] [--yes]
//
// An end user's erasure request for one scope (D90; batch C13, D361) across the usage ledger, the wallet directory
// (with the user's user_events, D432) and the issuer's user directory; see lib/uid-erase.ts and docs/operations.md
// "Retention". The ledger is reached as usage_admin over .secrets/<env>/neon-usage-admin.url (written by `usage-setup
// <env> roles`), USER_ID_KEY is read from .secrets/<env>/user-id-key: neither is ever printed, and a driver error has
// the URL and password removed.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadEnv } from '@hana-id/env';
import pg from 'pg';
import { cliActor } from './lib/admin-apps.ts';
import { run } from './lib/cli.ts';
import { apiPrivateD1Execute, issuerD1Execute } from './lib/d1.ts';
import { NearRpc } from './lib/near.ts';
import { assertPrivate, secretsDir } from './lib/secrets.ts';
import { ROLE_FILES, USER_ID_KEY_FILE, readRoleUrl } from './lib/usage-setup.ts';
import { redact } from './lib/usage-migrate.ts';
import { UID_ERASE_USAGE, uidErase } from './lib/uid-erase.ts';

run(async () => {
  await uidErase(process.argv.slice(2), {
    loadManifest: loadEnv,
    view: (m, method, args) => new NearRpc(m.rpc).view(m.signer, method, args),
    userIdKey(env) {
      const file = join(secretsDir(env), USER_ID_KEY_FILE);
      if (!existsSync(file)) throw new Error(`No .secrets/${env}/${USER_ID_KEY_FILE}: the uid can't be computed (docs/operations.md "Usage capture")`);
      assertPrivate(file);
      const value = readFileSync(file, 'utf8').trim();
      const key = Buffer.from(value, 'base64');
      if (!/^[A-Za-z0-9+/]{43}=$/u.test(value) || key.length !== 32) throw new Error(`.secrets/${env}/${USER_ID_KEY_FILE} is not base64 of 32 bytes`);
      return new Uint8Array(key);
    },
    async ledger(env) {
      const file = join(secretsDir(env), ROLE_FILES.usage_admin);
      if (!existsSync(file)) return null;
      const { url } = readRoleUrl(file, 'usage_admin', `.secrets/${env}/${ROLE_FILES.usage_admin}`);
      const client = new pg.Client({ connectionString: url, application_name: 'hana-id uid-erase' });
      try {
        await client.connect();
      } catch (e) {
        throw new Error(redact(e instanceof Error ? e.message : String(e), url));
      }
      return {
        async query<T>(sql: string, params: unknown[] = []) {
          try {
            return (await client.query(sql, params)).rows as T[];
          } catch (e) {
            throw new Error(redact(e instanceof Error ? e.message : String(e), url));
          }
        },
        close: () => client.end(),
      };
    },
    apiD1: (m, statement, remote) => apiPrivateD1Execute(m, statement, { remote }),
    issuerD1: (m, statement, remote) => issuerD1Execute(m, statement, { remote }),
    readLine: async (prompt) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
    operator: cliActor().id,
    log: (line) => console.log(line),
  });
}, UID_ERASE_USAGE);
