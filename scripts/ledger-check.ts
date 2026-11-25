// ledger-check.ts <env> snapshot|compare [--before <file>] [--remote] [--out <file>]
//
// The before-and-after comparison of the hot DB's ledger tables around migration 0027 (D916; docs/operations.md
// "Ledger rebuild (hot-DB migration 0027)"): every row read in key order through `wrangler d1 execute --json` and
// hashed locally (D1 has no hash function). See lib/ledger-check.ts. Never prints or writes a row.
import { readFileSync } from 'node:fs';
import { loadEnv } from '@hana-id/env';
import { run } from './lib/cli.ts';
import { d1Execute } from './lib/d1.ts';
import { LEDGER_CHECK_USAGE, ledgerCheck } from './lib/ledger-check.ts';
import { assertPrivate, parseSecretJson, secretsDir, writeSecretJson } from './lib/secrets.ts';

run(async () => {
  process.exitCode = await ledgerCheck(process.argv.slice(2), {
    read: (env, statement, remote) => d1Execute(loadEnv(env), statement, { remote }),
    secretsEnvDir: secretsDir,
    writeJson: writeSecretJson,
    readJson(file) {
      assertPrivate(file);
      return parseSecretJson<unknown>(readFileSync(file, 'utf8'), file);
    },
    log: (line) => console.log(line),
    now: () => new Date(),
  });
}, LEDGER_CHECK_USAGE);
