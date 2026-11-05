import type { D1Migration } from 'cloudflare:test';
import type { Env as AdminEnv } from '../src/env.ts';

declare global {
  namespace Cloudflare {
    interface Env extends AdminEnv {
      TEST_API_MIGRATIONS: D1Migration[];
      TEST_CONSOLE_MIGRATIONS: D1Migration[];
      /** The API's hot DB (shared with the auxiliary API Worker), for seeding apps and reading app_changes. */
      HOT_DB: D1Database;
      /** The console's CONSOLE_DB (shared with the auxiliary console Worker), for seeding orgs and members. */
      CONSOLE_TEST_DB: D1Database;
      TEST_ISSUER_MIGRATIONS: D1Migration[];
      /** The email issuer's own D1 (shared with the auxiliary issuer Worker), for seeding the user directory. */
      ISSUER_TEST_DB: D1Database;
      /** The suite's Access signing key (private JWK, JSON): the issuer's fake Access team serves its public half. */
      TEST_ACCESS_JWK: string;
    }
  }
}
