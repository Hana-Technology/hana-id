import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// The API's hot DB, the console's CONSOLE_DB and the email issuer's D1 (behind the auxiliary Workers) at their latest
// migrations.
await applyD1Migrations(env.HOT_DB, env.TEST_API_MIGRATIONS);
await applyD1Migrations(env.CONSOLE_TEST_DB, env.TEST_CONSOLE_MIGRATIONS);
await applyD1Migrations(env.ISSUER_TEST_DB, env.TEST_ISSUER_MIGRATIONS);
