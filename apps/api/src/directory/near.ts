// The wallet directory's NEAR lookup for the gasless relayer (D757): is this NEAR implicit account recorded for a user of
// this scope? The relayer (`/v1/near/relay`, `/v1/near/activate`) serves only such an account, and keys its per-user
// limits on the answer.
//
// The row exists only after the vault's background wallet record (POST /v1/wallets/record) for an SDK 0.4.0+ session
// landed, which is not part of the login's answer (D317): a fresh login's record usually lands within a second of it,
// but can lag (up to the vault's 15 s abort) or be missing (an outage, migration 0019 not applied). A caller treats null
// as retryable for a while after the user's login, never as proof that the account isn't the user's.
//
// SECURITY: one indexed SELECT (end_user_wallets_address, then end_users' primary key); nothing here logs the account
// or the answer. The internal id is the usage ledger's pseudonym: use it for limits only, never put it in an answer.
import { canonicalWalletAddress } from '@hana-id/core/identity';
import { log } from '../log.ts';

/**
 * The internal id (`hu_…`, `end_users.user_id`) of the one user of `scopeId` whose wallet directory lists `accountId`
 * as a NEAR wallet (`end_user_wallets.chain = 'near'`, `address = accountId`). Null when none does, when
 * `accountId` isn't an implicit account id (64 lowercase hex characters), and when two or more users of the scope list
 * it (ambiguous: no honest pair of users of one scope derives one account, so it is never a client's choice whose
 * limits are charged; logged `near_account_ambiguous`). Never ordered by a time a client chose. A failed read throws
 * (the caller answers it as unavailable, not as "unknown account").
 *
 * "Listed" means: a session of that user's account root, live on chain on that path when the record arrived, sent a
 * record whose NEAR entry was signed by that account's key (D755). It proves the session's holder also held the key, not
 * that Hana derived it (the API can't derive); one NEAR account per user and key index, one user per account in a scope
 * (D762), bound what a client can list.
 */
export async function nearAccountUser(db: D1Database, scopeId: string, accountId: string): Promise<string | null> {
  if (typeof accountId !== 'string' || canonicalWalletAddress('near', accountId) === null || typeof scopeId !== 'string' || scopeId.length === 0) return null;
  const { results } = await db
    .prepare(
      `SELECT w.user_id FROM end_user_wallets w JOIN end_users u ON u.user_id = w.user_id
        WHERE w.address = ?1 AND w.chain = 'near' AND u.scope_id = ?2
        ORDER BY w.first_seen_at ASC, w.user_id LIMIT 2`,
    )
    .bind(accountId, scopeId)
    .all<{ user_id: string }>();
  if (results.length > 1) {
    log({ event: 'near_account_ambiguous', code: 'two_users' }, 'error');
    return null;
  }
  return results[0]?.user_id ?? null;
}
