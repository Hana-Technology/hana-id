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

/**
 * The internal id (`hu_…`, `end_users.user_id`) of the user of `scopeId` whose wallet directory lists `accountId` as a
 * NEAR wallet (`end_user_wallets.chain = 'near'`, `address = accountId`), the most recently used if several do; null
 * when none does or `accountId` isn't an implicit account id (64 lowercase hex characters). A failed read throws (the
 * caller answers it as unavailable, not as "unknown account").
 */
export async function nearAccountUser(db: D1Database, scopeId: string, accountId: string): Promise<string | null> {
  if (typeof accountId !== 'string' || canonicalWalletAddress('near', accountId) === null || typeof scopeId !== 'string' || scopeId.length === 0) return null;
  const row = await db
    .prepare(
      `SELECT w.user_id FROM end_user_wallets w JOIN end_users u ON u.user_id = w.user_id
        WHERE w.address = ?1 AND w.chain = 'near' AND u.scope_id = ?2
        ORDER BY w.last_used_at DESC, w.user_id LIMIT 1`,
    )
    .bind(accountId, scopeId)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}
