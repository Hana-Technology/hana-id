import type { D1Migration } from 'cloudflare:test';
import type { Env as AppEnv } from '../src/env.ts';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      MIGRATION_DB: D1Database;
      FRESH_DB: D1Database;
      SNAPSHOT_DB: D1Database;
      BACKFILL_DB: D1Database;
      MIX_DB: D1Database;
      PRE_0010_DB: D1Database;
      /** IssuerRpc's reads on a D1 before migration 0010 (rpc-issuer.test.ts). */
      PRE_0010_ISSUER_DB: D1Database;
      /** Migration 0018's rebuild of user_events (home-login.test.ts). */
      PRE_0018_DB: D1Database;
    }
  }
}
