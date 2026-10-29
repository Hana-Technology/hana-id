// Issuer signing-key lead time (D33 "Open", docs/security.md open issue (e)): when each kid first and last appears in
// the issuer's JWKS, when it leaves it, and when a token signed with it first reaches the API. D1 table
// `issuer_key_observations` (migration 0004); read with `admin.ts <env> issuer-keys:lead-times`. Public data only:
// kids, timestamps and the JWKS max-age, never a token, `sub` or anything about a user. Writes never fail a caller.
import type { Env } from './env.ts';
import { log } from './log.ts';

/** Largest max-age stored (an INTEGER column; a silly header must not become a float). */
const MAX_AGE_CAP_S = 2 ** 31 - 1;
/** Bound on the per-isolate set of kids whose first token was already written (only verified kids reach it). */
const NOTED_CAP = 256;

/** The `max-age` directive of a Cache-Control header in seconds, or null without one. */
export function cacheMaxAgeS(cacheControl: string | null): number | null {
  const m = /(?:^|[\s,])max-age=(\d+)/iu.exec(cacheControl ?? '');
  return m?.[1] ? Math.min(MAX_AGE_CAP_S, Number(m[1])) : null;
}

/**
 * Records one successful JWKS fetch at `now`: every listed kid gets `first_seen_jwks_ms` (kept if earlier),
 * `last_seen_jwks_ms` and `max_age_s_last` (only when this fetch is the newest), and a `removed_jwks_ms` it carried is
 * cleared (it was back); every kid listed before but not in this fetch and not yet marked gets `removed_jwks_ms`.
 * An empty list records nothing (a broken response must not mark every key removed). Writes arriving out of order
 * (concurrent isolates) keep the earliest first sighting and the latest last sighting. Never throws.
 */
export async function recordJwksObservation(db: D1Database, provider: string, kids: readonly string[], maxAgeS: number | null, now: number): Promise<boolean> {
  const listed = [...new Set(kids)];
  if (listed.length === 0) return false;
  try {
    const upsert = db.prepare(
      `INSERT INTO issuer_key_observations (provider, kid, first_seen_jwks_ms, last_seen_jwks_ms, max_age_s_last)
       VALUES (?1, ?2, ?3, ?3, ?4)
       ON CONFLICT (provider, kid) DO UPDATE SET
         first_seen_jwks_ms = COALESCE(MIN(first_seen_jwks_ms, excluded.first_seen_jwks_ms), excluded.first_seen_jwks_ms),
         last_seen_jwks_ms  = COALESCE(MAX(last_seen_jwks_ms, excluded.last_seen_jwks_ms), excluded.last_seen_jwks_ms),
         removed_jwks_ms    = CASE WHEN removed_jwks_ms <= excluded.last_seen_jwks_ms THEN NULL ELSE removed_jwks_ms END,
         max_age_s_last     = CASE WHEN last_seen_jwks_ms IS NULL OR last_seen_jwks_ms <= excluded.last_seen_jwks_ms
                                   THEN excluded.max_age_s_last ELSE max_age_s_last END`,
    );
    const removed = db
      .prepare(
        `UPDATE issuer_key_observations SET removed_jwks_ms = ?2
         WHERE provider = ?1 AND removed_jwks_ms IS NULL AND last_seen_jwks_ms < ?2
           AND kid NOT IN (SELECT value FROM json_each(?3))`,
      )
      .bind(provider, now, JSON.stringify(listed));
    await db.batch([...listed.map((kid) => upsert.bind(provider, kid, now, maxAgeS)), removed]);
    return true;
  } catch {
    log({ event: 'key_observation_failed', code: 'jwks' }, 'warn');
    return false;
  }
}

/**
 * Records the first verified token signed with `kid` (the earliest wins across isolates; a later one writes
 * nothing). Never throws.
 */
export async function recordTokenKid(db: D1Database, provider: string, kid: string, now: number): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT INTO issuer_key_observations (provider, kid, first_token_ms) VALUES (?1, ?2, ?3)
         ON CONFLICT (provider, kid) DO UPDATE SET first_token_ms = excluded.first_token_ms
         WHERE first_token_ms IS NULL OR first_token_ms > excluded.first_token_ms`,
      )
      .bind(provider, kid, now)
      .run();
    return true;
  } catch {
    log({ event: 'key_observation_failed', code: 'token' }, 'warn');
    return false;
  }
}

/** What token verification reports (jwks.ts `VerifyOptions.observer`). Both calls return at once. */
export interface KeyObserver {
  /** A successful JWKS fetch listing `kids`. */
  jwks(provider: string, kids: readonly string[], maxAgeS: number | null, now: number): void;
  /** A token with a valid signature by `kid`. */
  token(provider: string, kid: string, now: number): void;
}

/** provider + kid pairs whose first token this isolate has already written (or tried to). */
const notedTokenKids = new Set<string>();

/**
 * Observer for a request's token verification: the D1 writes run after the response (`exec.waitUntil`), and a kid's
 * first token is written at most once per isolate. Without an execution context nothing is recorded (the write
 * would be cut off with the response, and the request must not wait for it).
 */
export function keyObserver(env: Env, exec?: ExecutionContext): KeyObserver | undefined {
  if (!exec) return undefined;
  return {
    jwks(provider, kids, maxAgeS, now) {
      exec.waitUntil(recordJwksObservation(env.DB, provider, kids, maxAgeS, now));
    },
    token(provider, kid, now) {
      const key = `${provider}\u0000${kid}`;
      if (notedTokenKids.has(key)) return;
      if (notedTokenKids.size >= NOTED_CAP) notedTokenKids.clear();
      notedTokenKids.add(key);
      exec.waitUntil(recordTokenKid(env.DB, provider, kid, now));
    },
  };
}

/** Tests only. */
export function clearNotedTokenKids(): void {
  notedTokenKids.clear();
}
