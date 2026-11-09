import type { D1Migration } from 'cloudflare:test';
import type { Env as AppEnv } from '../src/env.ts';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_API_MIGRATIONS: D1Migration[];
      /** The standby key's private JWK: published, never on the Worker; tests use it as a second signer. */
      TEST_STANDBY_KEY: string;
      /**
       * The API's D1, which the auxiliary API Worker's IssuerRpc reads (vitest.config.ts): the tests seed and change
       * apps through it. Test-only: the issuer Worker itself binds no API D1 (D434).
       */
      API_TEST_DB: D1Database;
    }
  }
}
