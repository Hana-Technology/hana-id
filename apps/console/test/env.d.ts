import type { D1Migration } from 'cloudflare:test';
import type { Env as ConsoleEnv } from '../src/env.ts';

declare global {
  namespace Cloudflare {
    interface Env extends ConsoleEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_API_MIGRATIONS: D1Migration[];
      /** The API's hot DB (shared with the auxiliary API Worker), for seeding apps and reading app_changes. */
      HOT_DB: D1Database;
      /** What the fake upstream (test/fake-upstream.js) answers for the API Worker: chain views and Google's JWKS. */
      FAKE_UPSTREAM: D1Database;
      /** Test only: the API's AdminRpc (the admin Worker's binding, C8), to propose and announce changes. */
      API_ADMIN: Fetcher & { [m in "addOrigins" | "ackNotice" | "pendingNotices"]: (c: unknown) => Promise<{ ok: boolean; code?: string; [k: string]: unknown }> };
    }
  }
}
