import type { D1Migration } from 'cloudflare:test';
import type { Env as AppEnv } from '../src/env.ts';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_API_MIGRATIONS: D1Migration[];
      /** The standby key's private JWK: published, never on the Worker; tests use it as a second signer. */
      TEST_STANDBY_KEY: string;
      /** The API's D1 before its login_methods migration (batch 6). */
      APP_DB_OLD: D1Database;
    }
  }
}
