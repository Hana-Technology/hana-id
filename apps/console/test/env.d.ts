import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      CONSOLE_DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
