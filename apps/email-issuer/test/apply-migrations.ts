import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
// The API's D1 as the issuer reads it: every API migration (0010 adds `login_methods`, default 'google'), and one before
// 0010 (no such column: no app has email on).
await applyD1Migrations(env.APP_DB, env.TEST_API_MIGRATIONS);
await applyD1Migrations(env.APP_DB_OLD, env.TEST_API_MIGRATIONS.filter((m) => m.name < '0010'));

beforeEach(async () => {
  await env.DB.batch(['email_issuance', 'email_hints', 'email_suppressions', 'email_admin_audit', 'user_emails', 'user_email_apps'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
