// The apps of the stack's two built sites, the hosted demo and the stamps site: each bakes its key in at build time
// (src/build.ts DEMO_CONFIG, STAMPS_CONFIG), so `POST /__e2e/apps` with that key creates the app once and returns it
// after that (the first create wins). Shared by the specs (tests/fixtures.ts) and the hand-test browser (D880).
import type { AppSpec } from './server/api.ts';
import { DEMO_ORIGIN, DEMO_PK, STAMPS_ORIGIN, STAMPS_PK } from './stack.ts';

/**
 * The hosted demo's app, with email sign-in on (its "Sign in with email" button; as docs/operations.md's local hand
 * tests create it, and the hand browser needs it: one definition, so whichever creates it first creates the same app).
 * Its sponsorship allowlist is the exact demo check-in (src/server/api.ts, D867).
 */
export const DEMO_APP: Readonly<Partial<AppSpec>> = Object.freeze({ name: 'Journear demo', origins: [DEMO_ORIGIN], publishableKey: DEMO_PK, loginMethods: 'google,email' });

/** The stamps site's app, with email sign-in on. */
export const STAMPS_APP: Readonly<Partial<AppSpec>> = Object.freeze({ name: 'Stamp Trail', origins: [STAMPS_ORIGIN], publishableKey: STAMPS_PK, loginMethods: 'google,email' });
