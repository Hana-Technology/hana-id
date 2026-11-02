import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await applyD1Migrations(env.APP_DB, env.TEST_API_MIGRATIONS);
await applyD1Migrations(env.APP_DB_OLD, env.TEST_API_MIGRATIONS);
// The API's batch 6 migration, as the issuer expects it (comma-separated methods, default 'google').
try {
  await env.APP_DB.prepare("ALTER TABLE apps ADD COLUMN login_methods TEXT NOT NULL DEFAULT 'google'").run();
} catch {
  // Already added (the setup file runs once per test file against the same database).
}

beforeEach(async () => {
  await env.DB.batch(['email_issuance', 'email_hints', 'email_suppressions', 'email_admin_audit'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
