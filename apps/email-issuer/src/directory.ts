// The user directory (D269, migrations/0002_user_emails.sql): the verified address of each identity that logs in, for
// Hana staff only. Recording is best effort and runs after the answer: a D1 failure is logged (never the address or
// the sub) and never fails or slows a login.
import { log } from './log.ts';

export type DirectoryProvider = 'email' | 'google';

export interface UserEmailRecord {
  provider: DirectoryProvider;
  /** The identity's sub as on chain: `e1.…` for email, Google's `sub`. */
  sub: string;
  /** Email: the normalized login address. Google: userinfo's address (lowercased here). */
  email: string;
  emailVerified: boolean;
  /** Google: whether the address is Google-hosted (D158); null for email. */
  hosted: boolean | null;
  appId: string;
  scopeId: string;
  nowMs: number;
}

const MAX_EMAIL_LENGTH = 320;
const MAX_SUB_LENGTH = 255;

/**
 * The two upserts of one record (identity row, then its app row). Throws on a malformed record.
 *
 * Writes run after the answer (`waitUntil`), so two logins' writes can land out of order. A row's fields follow the
 * write with the newest `nowMs` (a tie goes to the later write): an older write landing late widens the seen window
 * (`first_seen_ms` MIN, `last_seen_ms` MAX) but never restores an older address, `email_verified`, `hosted` or
 * `scope_id`. SQLite evaluates every SET expression against the row as it was, so their order doesn't matter.
 */
export function userEmailStatements(db: D1Database, r: UserEmailRecord): D1PreparedStatement[] {
  if (r.provider !== 'email' && r.provider !== 'google') throw new TypeError('directory: unknown provider');
  if (r.sub.length === 0 || r.sub.length > MAX_SUB_LENGTH) throw new TypeError('directory: malformed sub');
  const email = r.provider === 'google' ? r.email.toLowerCase() : r.email;
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !email.includes('@')) throw new TypeError('directory: malformed address');
  if (!Number.isSafeInteger(r.nowMs) || r.nowMs <= 0) throw new TypeError('directory: malformed time');
  return [
    db
      .prepare(
        `INSERT INTO user_emails (provider, sub, email, email_verified, hosted, first_seen_ms, last_seen_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT (provider, sub) DO UPDATE SET
           email = CASE WHEN excluded.last_seen_ms >= user_emails.last_seen_ms THEN excluded.email ELSE user_emails.email END,
           email_verified = CASE WHEN excluded.last_seen_ms >= user_emails.last_seen_ms
             THEN excluded.email_verified ELSE user_emails.email_verified END,
           hosted = CASE WHEN excluded.last_seen_ms >= user_emails.last_seen_ms THEN excluded.hosted ELSE user_emails.hosted END,
           first_seen_ms = MIN(user_emails.first_seen_ms, excluded.first_seen_ms),
           last_seen_ms = MAX(user_emails.last_seen_ms, excluded.last_seen_ms)`,
      )
      .bind(r.provider, r.sub, email, r.emailVerified ? 1 : 0, r.hosted === null ? null : r.hosted ? 1 : 0, r.nowMs),
    db
      .prepare(
        `INSERT INTO user_email_apps (provider, sub, app_id, scope_id, first_seen_ms, last_seen_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT (provider, sub, app_id) DO UPDATE SET
           scope_id = CASE WHEN excluded.last_seen_ms >= user_email_apps.last_seen_ms
             THEN excluded.scope_id ELSE user_email_apps.scope_id END,
           first_seen_ms = MIN(user_email_apps.first_seen_ms, excluded.first_seen_ms),
           last_seen_ms = MAX(user_email_apps.last_seen_ms, excluded.last_seen_ms)`,
      )
      .bind(r.provider, r.sub, r.appId, r.scopeId, r.nowMs),
  ];
}

/** Writes one record; throws on a D1 failure (callers use recordUserEmailLater). */
export async function recordUserEmail(db: D1Database, r: UserEmailRecord): Promise<void> {
  await db.batch(userEmailStatements(db, r));
}

/**
 * Records after the answer (`waitUntil`), never throwing into the login: a failure logs `directory_write_failed` with
 * the app and scope only.
 */
export function recordUserEmailLater(db: D1Database, waitUntil: (p: Promise<unknown>) => void, r: UserEmailRecord): void {
  const fail = (): void => log({ event: 'directory_write_failed', outcome: 'error', appId: r.appId, scopeId: r.scopeId }, 'warn');
  let p: Promise<void>;
  try {
    p = recordUserEmail(db, r);
  } catch {
    fail();
    return;
  }
  waitUntil(p.catch(fail));
}
