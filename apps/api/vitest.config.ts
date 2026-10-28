import { randomBytes } from 'node:crypto';
import { KeyPair } from '@near-js/crypto';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Fresh throwaway keys per run: tests never touch a real account (all RPC is mocked).
const relayerKeys = [KeyPair.fromRandom('ed25519').toString(), KeyPair.fromRandom('ed25519').toString()];
const ownerRelayerKeys = [KeyPair.fromRandom('ed25519').toString(), KeyPair.fromRandom('ed25519').toString()];
const keysUpdaterKey = KeyPair.fromRandom('ed25519').toString();
const vaultKek = `1:${randomBytes(32).toString('base64')}`;

export default defineConfig(async () => {
  const migrations = await readD1Migrations(new URL('./migrations', import.meta.url).pathname);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            NEAR_RPC: 'https://rpc.test.invalid',
            SIGNER_ACCOUNT: 'signer.test.near',
            RELAYER_ACCOUNT: 'relayer.test.near',
            // A dev env (sandbox*): partner-origin calls and loopback origins for pk_test_ keys, as apps/smoke uses them.
            // Tests of the production rules override ENV_NAME per request.
            ENV_NAME: 'sandbox-test',
            MPC_ACCOUNT: 'mpc.test.near',
            BLS_PRECHECK: '0',
            REJECT_PII_ON_SESSIONS: '0',
            // The generated wrangler.jsonc may carry an env's hint; tests use unplaced objects unless they set one.
            DO_LOCATION_HINT: '',
            RELAYER_KEYS: JSON.stringify(relayerKeys),
            OWNER_RELAYER_KEYS: JSON.stringify(ownerRelayerKeys),
            // A gas override (gas.ts) for a method no endpoint relays, so the default gas of the others stays tested.
            GAS_PRUNE_SESSIONS_TGAS: '70',
            KEYS_UPDATER_KEY: keysUpdaterKey,
            VAULT_ORIGIN: 'https://vault.test',
            AUTH_ORIGIN: 'https://auth.test',
            API_URL: 'https://api.test',
            VAULT_KEK: vaultKek,
            TEST_MIGRATIONS: migrations,
          },
          // A second, empty database: migration tests apply 0001–0002, seed rows, then 0003.
          d1Databases: { DB: 'hana-id-test', MIGRATION_DB: 'migration-db' },
        },
      }),
    ],
    resolve: {
      alias: { secp256k1: new URL('./src/shims/secp256k1.ts', import.meta.url).pathname },
    },
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/apply-migrations.ts'],
      // The worker's structured JSON logs are noise in test output (set LOG=1 to see them).
      onConsoleLog: (log: string) => (process.env.LOG || !log.startsWith('{"level"') ? undefined : false),
    },
  };
});
