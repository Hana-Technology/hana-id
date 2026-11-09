// D1 access to `vault_shares` (migration 0003). Every read and write is scoped to the gate app's id, so one app's
// request can never see or move another app's share. The counter rule (counter = n + 1 only while the share is live)
// is one atomic UPDATE, so of concurrent requests with the same counter exactly one wins.

export interface ShareRow {
  share_id: Uint8Array;
  session_pk: Uint8Array;
  path_hash: Uint8Array;
  partner_origin: string;
  share_enc: Uint8Array;
  kek_id: number;
  counter: number;
  created_at: number;
  idle_until: number;
  abs_expires_at: number;
  revoked_at: number | null;
}

/** D1 returns BLOBs as number arrays or ArrayBuffers depending on the runtime version; this accepts both. */
export function blob(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new Error('Expected a BLOB');
}

const SHARE_COLUMNS = 'share_id, session_pk, path_hash, partner_origin, share_enc, kek_id, counter, created_at, idle_until, abs_expires_at, revoked_at';

function toShareRow(r: Record<string, unknown>): ShareRow {
  return {
    share_id: blob(r.share_id),
    session_pk: blob(r.session_pk),
    path_hash: blob(r.path_hash),
    partner_origin: r.partner_origin as string,
    share_enc: blob(r.share_enc),
    kek_id: r.kek_id as number,
    counter: r.counter as number,
    created_at: r.created_at as number,
    idle_until: r.idle_until as number,
    abs_expires_at: r.abs_expires_at as number,
    revoked_at: (r.revoked_at as number | null) ?? null,
  };
}

export interface NewShare {
  shareId: Uint8Array;
  appId: string;
  sessionPk: Uint8Array;
  pathHash: Uint8Array;
  partnerOrigin: string;
  shareEnc: Uint8Array;
  kekId: number;
  createdAt: number;
  idleUntil: number;
  absExpiresAt: number;
  /** A coarse "Chrome on macOS" from the vault (D98 item 10), or null. Deleted with the share. */
  deviceLabel: string | null;
}

/** Inserts a share; false if the session key already has one (the UNIQUE `session_pk`). */
export async function insertShare(db: D1Database, s: NewShare): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO vault_shares (share_id, app_id, session_pk, path_hash, partner_origin, share_enc, kek_id, counter, created_at, idle_until, abs_expires_at, device_label)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, ?11)
       ON CONFLICT (session_pk) DO NOTHING`,
    )
    .bind(s.shareId, s.appId, s.sessionPk, s.pathHash, s.partnerOrigin, s.shareEnc, s.kekId, s.createdAt, s.idleUntil, s.absExpiresAt, s.deviceLabel)
    .run();
  return res.meta.changes === 1;
}

export async function getShare(db: D1Database, appId: string, shareId: Uint8Array): Promise<ShareRow | null> {
  const row = await db.prepare(`SELECT ${SHARE_COLUMNS} FROM vault_shares WHERE share_id = ?1 AND app_id = ?2`).bind(shareId, appId).first<Record<string, unknown>>();
  return row ? toShareRow(row) : null;
}

/**
 * The share of a session key in any app, with its app id, or null (POST /v1/identity/token judges a session's share
 * without moving it, and refuses a key whose share is another app's). `session_pk` is UNIQUE, so there is at most one.
 */
export async function getShareBySessionPk(db: D1Database, sessionPk: Uint8Array): Promise<(ShareRow & { app_id: string }) | null> {
  const row = await db.prepare(`SELECT app_id, ${SHARE_COLUMNS} FROM vault_shares WHERE session_pk = ?1`).bind(sessionPk).first<Record<string, unknown>>();
  return row ? { ...toShareRow(row), app_id: row.app_id as string } : null;
}

/** Marks a share revoked (no-op if it already is). */
export async function markRevoked(db: D1Database, appId: string, shareId: Uint8Array, now: number): Promise<void> {
  await db.prepare('UPDATE vault_shares SET revoked_at = ?3 WHERE share_id = ?1 AND app_id = ?2 AND revoked_at IS NULL').bind(shareId, appId, now).run();
}

/** Lowers a share's absolute expiry to `capAt` (never raises it), so the hourly cron prunes it on time. */
export async function capExpiry(db: D1Database, appId: string, shareId: Uint8Array, capAt: number): Promise<void> {
  await db.prepare('UPDATE vault_shares SET abs_expires_at = MIN(abs_expires_at, ?3) WHERE share_id = ?1 AND app_id = ?2').bind(shareId, appId, capAt).run();
}

export interface Advanced {
  counter: number;
  idleUntil: number;
  absExpiresAt: number;
}

/** created_at + the app's current session TTL: a lowered TTL shortens live shares too (it never lengthens them). */
const CAPPED_ABS = 'created_at + (SELECT session_ttl_ms FROM apps WHERE id = ?2)';

export type ShareUpdate =
  /**
   * unlock, touch: only while the app's persistence is 'session'; caps `abs_expires_at` at created_at + the app's
   * current session_ttl_ms, then slides `idle_until` to min(now + its idle_ttl_ms, that cap); unlock may re-wrap.
   */
  | { kind: 'slide'; rewrap?: { shareEnc: Uint8Array; kekId: number } }
  /** revoke: end the share. (revoke-all goes through revokeAllFrom.) */
  | { kind: 'revoke' };

/**
 * Sets the share's counter to `counter` if it is `counter - 1` and the share is live at `now`, with the action's
 * other changes, in one statement. Null when nothing changed (wrong counter, expired, revoked, or gone).
 */
export async function advanceShare(db: D1Database, appId: string, shareId: Uint8Array, counter: number, now: number, update: ShareUpdate): Promise<Advanced | null> {
  const sets = ['counter = ?3'];
  const binds: unknown[] = [shareId, appId, counter, now];
  const where = ['share_id = ?1', 'app_id = ?2', 'counter = ?3 - 1', '?4 < idle_until', '?4 < abs_expires_at', 'revoked_at IS NULL'];
  if (update.kind === 'slide') {
    // The app's settings as they are now, in the same statement (so a change made after the caller's check still
    // applies): only while it keeps logins, and never past created_at + the current session TTL. SQLite evaluates
    // every SET expression against the row as it was, so idle_until is capped by the old and the new limit alike.
    sets.push(
      `abs_expires_at = MIN(abs_expires_at, ${CAPPED_ABS})`,
      `idle_until = MIN(?4 + (SELECT idle_ttl_ms FROM apps WHERE id = ?2), abs_expires_at, ${CAPPED_ABS})`,
    );
    where.push(`?4 < ${CAPPED_ABS}`, "(SELECT persistence FROM apps WHERE id = ?2) = 'session'");
    if (update.rewrap) {
      sets.push('share_enc = ?5', 'kek_id = ?6');
      binds.push(update.rewrap.shareEnc, update.rewrap.kekId);
    }
  } else if (update.kind === 'revoke') {
    sets.push('revoked_at = ?4');
  }
  const row = await db
    .prepare(`UPDATE vault_shares SET ${sets.join(', ')} WHERE ${where.join(' AND ')} RETURNING counter, idle_until, abs_expires_at`)
    .bind(...binds)
    .first<{ counter: number; idle_until: number; abs_expires_at: number }>();
  return row ? { counter: row.counter, idleUntil: row.idle_until, absExpiresAt: row.abs_expires_at } : null;
}

/**
 * revoke-all: moves the share's counter to `counter` and revokes every other live share of the same user (app, path),
 * in one D1 batch (one transaction), or does neither. The revoke runs first, on the condition the counter move then
 * meets (the share is live with `counter - 1`), so a replayed request revokes nothing. Null when nothing changed.
 */
export async function revokeAllFrom(
  db: D1Database,
  appId: string,
  keepShareId: Uint8Array,
  pathHash: Uint8Array,
  counter: number,
  now: number,
): Promise<{ counter: number; revoked: number } | null> {
  const [revoke, advance] = await db.batch<{ counter: number }>([
    db
      .prepare(
        `UPDATE vault_shares SET revoked_at = ?3
          WHERE app_id = ?1 AND path_hash = ?2 AND share_id != ?4 AND revoked_at IS NULL AND ?3 < idle_until AND ?3 < abs_expires_at
            AND EXISTS (SELECT 1 FROM vault_shares k
                         WHERE k.share_id = ?4 AND k.app_id = ?1 AND k.counter = ?5 - 1 AND k.revoked_at IS NULL AND ?3 < k.idle_until AND ?3 < k.abs_expires_at)`,
      )
      .bind(appId, pathHash, now, keepShareId, counter),
    db
      .prepare(
        `UPDATE vault_shares SET counter = ?3
          WHERE share_id = ?1 AND app_id = ?2 AND counter = ?3 - 1 AND ?4 < idle_until AND ?4 < abs_expires_at AND revoked_at IS NULL
          RETURNING counter`,
      )
      .bind(keepShareId, appId, counter, now),
  ]);
  const row = advance?.results[0];
  return row ? { counter: row.counter, revoked: revoke?.meta.changes ?? 0 } : null;
}
