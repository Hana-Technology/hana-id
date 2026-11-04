import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// The API's hot DB and the console's CONSOLE_DB (behind the auxiliary Workers) at their latest migrations.
await applyD1Migrations(env.HOT_DB, env.TEST_API_MIGRATIONS);
await applyD1Migrations(env.CONSOLE_TEST_DB, env.TEST_CONSOLE_MIGRATIONS);
