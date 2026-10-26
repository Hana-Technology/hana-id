import { KeyPair } from '@near-js/crypto';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Fresh throwaway keys per run: tests never touch a real account (all RPC is mocked).
const relayerKeys = [KeyPair.fromRandom('ed25519').toString(), KeyPair.fromRandom('ed25519').toString()];
const keysUpdaterKey = KeyPair.fromRandom('ed25519').toString();

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
            ENV_NAME: 'test',
            RELAYER_KEYS: JSON.stringify(relayerKeys),
            KEYS_UPDATER_KEY: keysUpdaterKey,
            TEST_MIGRATIONS: migrations,
          },
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
