// The wallet directory's writes (migration 0011, D310, D312–D314): users, their wallets and their accounts'
// identities in the hot DB. Every statement is an upsert that only moves forward in time, so a write that lands late
// (the record and the login's sync race, `waitUntil` order isn't kept) never undoes a newer one, and a repeated write
// changes nothing:
//
// - users: `created_at` is the MIN and `last_seen_at` the MAX of every write's time;
// - wallets: `first_seen_at` MIN, `last_used_at` MAX;
// - identities: a row is rewritten only by a write whose `observed_at` (its chain read's time) is no older than the
//   row's; `first_seen_at` MIN.
//
// The user id is the uid's (D312): it needs USER_ID_KEY, and without it nothing is written (`directory_unavailable`).
//
// SECURITY: the rows hold subs and wallet addresses (personal data, D269's cost): nothing here logs a row, a sub, a key
// or an address; failures log the endpoint, the app and a code.
import { supportCodeOf, uid, userIdOf } from '@hana-id/console-core';
import { hex } from '../bytes.ts';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { identityKey } from '../session-crypto.ts';
import { userIdKey } from '../usage/uid-key.ts';

export interface IdentityRef {
  provider: string;
  sub: string;
}

export interface DirectoryUser {
  userId: string;
  supportCode: string;
}

/** The user of the account rooted at `root` in `scopeId` (D312), or null without a usable USER_ID_KEY. */
export async function directoryUser(env: Pick<Env, 'USER_ID_KEY'>, scopeId: string, root: IdentityRef): Promise<DirectoryUser | null> {
  const key = userIdKey(env);
  if (!key) return null;
  const userId = userIdOf(await uid(key, { scopeId, provider: root.provider, sub: root.sub }));
  return { userId, supportCode: supportCodeOf(userId) };
}

/** The contract's identity key of `ref` in `scopeId`, hex. */
export const identityKeyHex = async (scopeId: string, ref: IdentityRef): Promise<string> => hex(await identityKey(scopeId, ref.provider, ref.sub));

export function upsertUser(db: D1Database, u: DirectoryUser, scopeId: string, at: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO end_users (user_id, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT (user_id) DO UPDATE SET created_at = MIN(created_at, excluded.created_at), last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`,
    )
    .bind(u.userId, u.supportCode, scopeId, at);
}

export function upsertWallet(db: D1Database, userId: string, w: { chain: 'stellar' | 'evm'; address: string; keyIndex: number }, at: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO end_user_wallets (user_id, chain, address, key_index, first_seen_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT (user_id, chain, address) DO UPDATE SET first_seen_at = MIN(first_seen_at, excluded.first_seen_at), last_used_at = MAX(last_used_at, excluded.last_used_at)`,
    )
    .bind(userId, w.chain, w.address, w.keyIndex, at);
}

export interface IdentityRow {
  scopeId: string;
  identityKey: string;
  userId: string;
  provider: string;
  /** Null when only the chain named it (a member without a token Hana saw); an existing sub is kept. */
  sub: string | null;
  role: 'root' | 'member';
  status: 'active' | 'pending';
  effectiveAt: number | null;
}

/** The identity's row as of `at`: a write older than the row's `observed_at` changes nothing. */
export function upsertIdentity(db: D1Database, r: IdentityRow, at: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO end_user_identities (scope_id, identity_key, user_id, provider, sub, role, status, effective_at, first_seen_at, observed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
       ON CONFLICT (scope_id, identity_key) DO UPDATE SET
         user_id = excluded.user_id, provider = excluded.provider, sub = COALESCE(excluded.sub, end_user_identities.sub),
         role = excluded.role, status = excluded.status, effective_at = excluded.effective_at,
         first_seen_at = MIN(end_user_identities.first_seen_at, excluded.first_seen_at), observed_at = excluded.observed_at
       WHERE excluded.observed_at >= end_user_identities.observed_at`,
    )
    .bind(r.scopeId, r.identityKey, r.userId, r.provider, r.sub, r.role, r.status, r.effectiveAt, at);
}

/**
 * Members of `userId`'s account that the chain no longer lists (`keep`: the account's member keys as read at `at`):
 * `cancelled` if still pending at `at`, else `unlinked`; `hint` names the change a relay just made for one member
 * (cancel → cancelled, unlink → unlinked), which wins. Rows written after `at`, and rows already removed, stay.
 */
export function markRemovedMembers(db: D1Database, scopeId: string, userId: string, keep: readonly string[], at: number, hint?: { memberKey: string; action: 'cancel' | 'unlink' }): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE end_user_identities SET
         status = CASE
           WHEN identity_key = ?5 THEN ?6
           WHEN status = 'pending' AND (effective_at IS NULL OR effective_at > ?4) THEN 'cancelled'
           ELSE 'unlinked' END,
         observed_at = ?4
       WHERE scope_id = ?1 AND user_id = ?2 AND role = 'member' AND status IN ('active', 'pending') AND observed_at <= ?4
         AND identity_key NOT IN (SELECT value FROM json_each(?3))`,
    )
    .bind(scopeId, userId, JSON.stringify(keep), at, hint?.memberKey ?? '', hint ? (hint.action === 'cancel' ? 'cancelled' : 'unlinked') : '');
}

/** Runs one directory batch; a failure is logged with its code and never thrown (the directory is best effort). */
export async function writeDirectory(env: Env, stmts: D1PreparedStatement[], at: { requestId: string; endpoint: string; appId?: string }): Promise<boolean> {
  if (stmts.length === 0) return true;
  try {
    await env.DB.batch(stmts);
    return true;
  } catch (e) {
    const code = /no such table/u.test(String(e)) ? 'no_table' : 'internal';
    log({ event: 'directory_write_failed', requestId: at.requestId, endpoint: at.endpoint, appId: at.appId, code }, 'error');
    return false;
  }
}

/** Logs, at most once per isolate per 10 minutes, that the directory can't be written (no USER_ID_KEY). */
let lastUnavailableLog = 0;
export function noteDirectoryUnavailable(at: { requestId: string; endpoint: string; appId?: string }, now = Date.now()): void {
  if (now - lastUnavailableLog < 10 * 60_000) return;
  lastUnavailableLog = now;
  log({ event: 'directory_unavailable', requestId: at.requestId, endpoint: at.endpoint, appId: at.appId, code: 'missing_key' }, 'warn');
}
