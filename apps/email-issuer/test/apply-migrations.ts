import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
// The API's D1 that the API Worker's IssuerRpc reads (vitest.config.ts): every API migration. The reads before 0010
// (no login_methods column) are the API's own tests (apps/api/test/rpc-issuer.test.ts).
await applyD1Migrations(env.API_TEST_DB, env.TEST_API_MIGRATIONS);

beforeEach(async () => {
  await env.DB.batch(['email_issuance', 'email_hints', 'email_suppressions', 'email_admin_audit', 'user_emails', 'user_email_apps'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
