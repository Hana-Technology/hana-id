// Issuer signing-key lead time (D33 "Open", docs/security.md open issue (e)): when each kid first and last appears in
// the issuer's JWKS, when it leaves it, and when a token signed with it first and last reaches the API (the last one
// also keeps the JWKS cron from removing a key in use, D422). D1 table `issuer_key_observations` (migrations 0004,
// 0012); read with `admin.ts <env> issuer-keys:lead-times`. Public data only:
// kids, timestamps and the JWKS max-age, never a token, `sub` or anything about a user. Writes never fail a caller.
import type { KeyObserver } from '@hana-id/oidc';
import type { Env } from './env.ts';
import { log } from './log.ts';

// Parsed in @hana-id/oidc (the token check reports each fetch's max-age to the observer); the JWKS cron uses it too.
export { cacheMaxAgeS } from '@hana-id/oidc';

/** Bound on the per-isolate map of kids whose token sighting was written (only verified kids reach it). */
const NOTED_CAP = 256;
/** A kid's token sighting is written at most once per isolate this often (`last_token_ms` is minutes-accurate). */
export const TOKEN_SIGHTING_EVERY_MS = 10 * 60_000;

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
 * Records a verified token signed with `kid`: `first_token_ms` keeps the earliest across isolates, `last_token_ms` the
 * latest. Never throws.
 */
export async function recordTokenKid(db: D1Database, provider: string, kid: string, now: number): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT INTO issuer_key_observations (provider, kid, first_token_ms, last_token_ms) VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT (provider, kid) DO UPDATE SET
           first_token_ms = COALESCE(MIN(first_token_ms, excluded.first_token_ms), excluded.first_token_ms),
           last_token_ms  = COALESCE(MAX(last_token_ms, excluded.last_token_ms), excluded.last_token_ms)`,
      )
      .bind(provider, kid, now)
      .run();
    return true;
  } catch {
    log({ event: 'key_observation_failed', code: 'token' }, 'warn');
    return false;
  }
}

/** provider + kid → when this isolate last wrote (or tried to write) its token sighting. */
const notedTokenKids = new Map<string, number>();

/**
 * Observer (@hana-id/oidc `KeyObserver`) for a request's token verification: the D1 writes run after the response
 * (`exec.waitUntil`), and a kid's token sighting is written at most once per isolate every TOKEN_SIGHTING_EVERY_MS.
 * Without an execution context
 * nothing is recorded (the write would be cut off with the response, and the request must not wait for it).
 */
export function keyObserver(env: Env, exec?: ExecutionContext): KeyObserver | undefined {
  if (!exec) return undefined;
  return {
    jwks(provider, kids, maxAgeS, now) {
      exec.waitUntil(recordJwksObservation(env.DB, provider, kids, maxAgeS, now));
    },
    token(provider, kid, now) {
      const key = `${provider}\u0000${kid}`;
      const last = notedTokenKids.get(key);
      if (last !== undefined && now - last < TOKEN_SIGHTING_EVERY_MS) return;
      if (notedTokenKids.size >= NOTED_CAP && last === undefined) notedTokenKids.clear();
      notedTokenKids.set(key, now);
      exec.waitUntil(recordTokenKid(env.DB, provider, kid, now));
    },
  };
}

/** Tests only. */
export function clearNotedTokenKids(): void {
  notedTokenKids.clear();
}
