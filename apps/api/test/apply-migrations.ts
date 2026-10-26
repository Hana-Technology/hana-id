import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';
import { clearJwksCache } from '../src/jwks.ts';
import { clearViewCaches } from '../src/views.ts';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Per-isolate caches (JWKS, chain views) must not leak between tests: each test installs its own mock chain/JWKS.
beforeEach(() => {
  clearJwksCache();
  clearViewCaches();
});
