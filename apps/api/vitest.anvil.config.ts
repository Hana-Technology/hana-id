// The anvil lane (D868): EVM gas sponsorship's REAL relayer object, REAL handlers and the REAL delegate bytecode against
// a real EVM node, `anvil --hardfork prague` (chain 31337), started on a free loopback port by the global setup
// (test-anvil/setup/global.ts, Node) and stopped after the run, also when it fails. The same Workers pool, bindings and
// D1 migrations as the unit tests (vitest.config.ts); one file at a time (they share the one node). Run by
// `pnpm --filter @hana-id/api test:anvil` and by `pnpm verify`'s `anvil` lane; without anvil on the PATH every test
// skips and says so, unless HANA_ANVIL_REQUIRED=1 (then the setup fails).
import { defineConfig, type ViteUserConfig } from 'vitest/config';
import unitConfig from './vitest.config.ts';

export default defineConfig(async (env) => {
  const base = await (unitConfig as unknown as (e: typeof env) => Promise<ViteUserConfig>)(env);
  return {
    ...base,
    test: {
      ...base.test,
      include: ['test-anvil/**/*.test.ts'],
      globalSetup: ['./test-anvil/setup/global.ts'],
      fileParallelism: false,
      // A real node: mined-block waits, not sleeps, but a send's receipt wait and the alarms' RPC rounds add up.
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  };
});
