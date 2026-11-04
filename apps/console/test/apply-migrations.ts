import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// CONSOLE_DB at its latest migration, and the API's hot DB (behind the auxiliary API Worker) at its own.
await applyD1Migrations(env.CONSOLE_DB, env.TEST_MIGRATIONS);
await applyD1Migrations(env.HOT_DB, env.TEST_API_MIGRATIONS);
await env.FAKE_UPSTREAM.prepare('CREATE TABLE IF NOT EXISTS upstream (key TEXT PRIMARY KEY, json TEXT NOT NULL)').run();
