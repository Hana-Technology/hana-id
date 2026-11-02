import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';
import { clearGovernanceCache } from '../src/governance-status.ts';
import { clearJwksCache } from '@hana-id/oidc';
import { clearNotedTokenKids } from '../src/key-observations.ts';
import { clearViewCaches } from '../src/views.ts';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Per-isolate caches (JWKS, chain views, kids whose first token was written) must not leak between tests: each test installs its own mock chain/JWKS.
beforeEach(() => {
  clearJwksCache();
  clearNotedTokenKids();
  clearViewCaches();
  clearGovernanceCache();
});
