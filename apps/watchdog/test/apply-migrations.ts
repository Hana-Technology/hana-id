import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const TABLES = ['meta', 'seen_kids', 'absences', 'runs', 'actions', 'alerts', 'deliveries'];

// Every test starts from an empty database (a fresh watchdog).
beforeEach(async () => {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
