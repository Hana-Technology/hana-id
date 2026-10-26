// Publishable keys: `pk_test_` + base58(24 random bytes). Public by design (shipped in partner web pages); they only
// identify an app, its origins do the gating.
import { randomBytes } from 'node:crypto';
import { baseEncode } from '@near-js/utils';

export const PK_TEST_PREFIX = 'pk_test_';
export const PK_RANDOM_BYTES = 24;

const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
/** 24 bytes in base58 is 32 or 33 characters (fewer only with leading zero bytes, which encode as '1'). */
export const PUBLISHABLE_KEY_RE = new RegExp(`^pk_test_${BASE58}{24,33}$`, 'u');

export function publishableKey(bytes: Uint8Array = randomBytes(PK_RANDOM_BYTES)): string {
  if (bytes.length !== PK_RANDOM_BYTES) throw new Error(`Publishable keys use ${PK_RANDOM_BYTES} random bytes`);
  return PK_TEST_PREFIX + baseEncode(bytes);
}

export function isPublishableKey(s: string): boolean {
  return PUBLISHABLE_KEY_RE.test(s);
}

/** App ids: `app_` + base58(12 random bytes). */
export function newAppId(bytes: Uint8Array = randomBytes(12)): string {
  return `app_${baseEncode(bytes)}`;
}
