// Hourly vault maintenance (the existing cron trigger): prune dead shares and re-wrap shares still under
// VAULT_KEK_PREVIOUS, so a KEK rotation completes even for shares nobody unlocks.
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { type Keks, loadKeks, unwrapShareKey, wrapShareKey } from './kek.ts';
import { pruneConsents } from './consent-store.ts';
import { blob } from './shares.ts';

/** Rows re-wrapped per run, in pages of REWRAP_PAGE (bounds one run's CPU and D1 time). */
export const REWRAP_PER_RUN = 2000;
const REWRAP_PAGE = 100;

export interface VaultMaintenance {
  pruned: number;
  /** Consents past their expiry, or revoked over an hour ago (consent-store.ts `pruneConsents`). */
  prunedConsents: number;
  rewrapped: number;
  /** Rows under a KEK id neither configured key has (they can't be unlocked until that key is configured again). */
  unknownKek: number;
}

/** The contract's longest session (`MAX_SESSION_MS`, sessions.rs): no session outlives its share row by more. */
export const SHARE_TOMBSTONE_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes shares that are revoked or past their absolute expiry, once they are older than SHARE_TOMBSTONE_MS (D178).
 * Until then the row is a tombstone: the session key's on-chain session may still be live, and the identity token's
 * mint refuses a session key whose share is dead or belongs to another app (identity/token.ts), which it can only do
 * while the row exists.
 */
export async function pruneShares(db: D1Database, now: number): Promise<number> {
  const res = await db
    .prepare('DELETE FROM vault_shares WHERE (abs_expires_at < ?1 OR revoked_at IS NOT NULL) AND created_at < ?2')
    .bind(now, now - SHARE_TOMBSTONE_MS)
    .run();
  return res.meta.changes;
}

/** Re-wraps up to `limit` rows from the previous KEK to the current one. Each row is updated only if still unchanged. */
export async function rewrapShares(db: D1Database, keks: Keks, limit = REWRAP_PER_RUN): Promise<number> {
  const previous = keks.previous;
  if (!previous) return 0;
  let processed = 0;
  let failed = 0;
  let rewrapped = 0;
  while (processed + failed < limit) {
    const { results } = await db
      .prepare('SELECT share_id, app_id, session_pk, share_enc FROM vault_shares WHERE kek_id = ?1 LIMIT ?2 OFFSET ?3')
      .bind(previous.id, Math.min(REWRAP_PAGE, limit - processed - failed), failed)
      .all<Record<string, unknown>>();
    if (results.length === 0) break;
    const updates: D1PreparedStatement[] = [];
    for (const r of results) {
      const shareId = blob(r.share_id);
      const binding = { shareId, appId: r.app_id as string, sessionPk: blob(r.session_pk) };
      const oldEnc = blob(r.share_enc);
      const ks = await unwrapShareKey(previous, binding, oldEnc);
      if (!ks) {
        // Left in place, and skipped by the OFFSET from now on: an unreadable row is never overwritten.
        failed++;
        continue;
      }
      const shareEnc = await wrapShareKey(keks.current, binding, ks);
      ks.fill(0);
      updates.push(
        db.prepare('UPDATE vault_shares SET share_enc = ?1, kek_id = ?2 WHERE share_id = ?3 AND kek_id = ?4 AND share_enc = ?5').bind(shareEnc, keks.current.id, shareId, previous.id, oldEnc),
      );
    }
    // A row an unlock re-wrapped meanwhile no longer matches: it is under the current KEK either way.
    if (updates.length > 0) rewrapped += (await db.batch(updates)).reduce((n, r) => n + r.meta.changes, 0);
    processed += updates.length;
  }
  if (failed > 0) log({ event: 'vault_rewrap_unreadable', unreadable: failed }, 'error');
  return rewrapped;
}

export async function vaultMaintenance(env: Env, now: number = Date.now()): Promise<VaultMaintenance> {
  const pruned = await pruneShares(env.DB, now);
  const prunedConsents = await pruneConsents(env.DB, now);
  const keks = await loadKeks(env);
  let rewrapped = 0;
  let unknownKek = 0;
  if (keks) {
    rewrapped = await rewrapShares(env.DB, keks);
    const ids = [keks.current.id, ...(keks.previous ? [keks.previous.id] : [])];
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM vault_shares WHERE kek_id NOT IN (${ids.map((_, i) => `?${i + 1}`).join(', ')})`)
      .bind(...ids)
      .first<{ n: number }>();
    unknownKek = row?.n ?? 0;
  }
  // No VAULT_KEK yet (an env that doesn't serve the vault) is a warning; shares nobody can unlock are an error.
  const level = unknownKek > 0 ? 'error' : keks ? 'info' : 'warn';
  log({ event: 'vault_maintenance', outcome: keks ? 'ok' : 'error', code: keks ? undefined : 'vault_key_unavailable', pruned, prunedConsents, rewrapped, unknownKek }, level);
  return { pruned, prunedConsents, rewrapped, unknownKek };
}
