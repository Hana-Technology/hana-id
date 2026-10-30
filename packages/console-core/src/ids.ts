// Ids (docs/batch-c-spec.md "Data"): a prefix + base58 of 12 random bytes. Prefixes say what an id names, so an id of
// one kind can never be mistaken for another in a log, a URL or an RPC argument.
import { base58, randomBytes } from './bytes.ts';

export const ID_PREFIXES = {
  org: 'org',
  user: 'usr',
  invite: 'inv',
  ownerGrant: 'og',
  action: 'act',
  key: 'key',
  guardedChange: 'gc',
  securityEvent: 'se',
  app: 'app',
} as const;
export type IdKind = keyof typeof ID_PREFIXES;

/** 12 random bytes in base58: 16 or 17 characters (fewer only with leading zero bytes, vanishingly rare). */
const BODY = '[1-9A-HJ-NP-Za-km-z]{12,17}';

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${base58(randomBytes(12))}`;
}

/**
 * Whether `s` is an id of `kind`. Besides generated ids this accepts the ids the 0006 migration and the first
 * `CONSOLE_DB` migration write (`org_legacy`, `key_legacy_<app id>`), and apps' existing `app_<base58>` ids.
 */
export function isId(kind: IdKind, s: string): boolean {
  if (kind === 'org' && s === LEGACY_ORG_ID) return true;
  if (kind === 'key' && /^key_legacy_app_[1-9A-HJ-NP-Za-km-z]{1,44}$/u.test(s)) return true;
  if (kind === 'app') return /^app_[1-9A-HJ-NP-Za-km-z]{1,44}$/u.test(s);
  return new RegExp(`^${ID_PREFIXES[kind]}_${BODY}$`, 'u').test(s);
}

/** The org every existing scope belongs to after the hot-DB migration 0006, until Hana assigns it (`assignScopeOrg`). */
export const LEGACY_ORG_ID = 'org_legacy';

export type Environment = 'test' | 'live';

/** A publishable key for a scope of `environment`: `pk_test_`/`pk_live_` + base58(24 random bytes). Public by design. */
export function newPublishableKey(environment: Environment): string {
  return `pk_${environment}_${base58(randomBytes(24))}`;
}

/** The environment a publishable key's prefix names, or null when it isn't a publishable key. */
export function publishableKeyEnvironment(key: string): Environment | null {
  const m = /^pk_(test|live)_[1-9A-HJ-NP-Za-km-z]{16,64}$/u.exec(key);
  return m ? (m[1] as Environment) : null;
}
