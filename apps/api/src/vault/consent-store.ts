// D1 access to `vault_consents` (migration 0017; docs/hana-home-spec.md "Consents and devices"). Every read and write is
// scoped to the gate app's id, so one app's request can never see or move another app's consent. A consent is active
// when `revoked_at IS NULL`, `now < expires_at` and its share (if any) is live.
//
// Kept apart from consents.ts (the endpoints) so `handlers.ts` (GET /v1/app's status) and `cron.ts` can use it without
// an import cycle through vault/endpoints.ts.
import { CONSENT_ID_BYTES } from '@hana-id/core/home';
import { base64UrlDecode } from '../bytes.ts';
import { blob } from './shares.ts';

/** Sent by the vault on GET /v1/app (`Origin: VAULT_ORIGIN` only); carries the 128-bit consent id. */
export const CONSENT_HEADER = 'x-hana-consent';
/** Revoked rows are kept this long, then pruned (a share-mode row's replay is stopped by the share's counter). */
export const CONSENT_REVOKED_KEEP_MS = 60 * 60 * 1000;

export type ConsentStatus = 'active' | 'revoked' | 'unknown';

export interface ConsentRow {
  consent_id: Uint8Array;
  share_id: Uint8Array | null;
  session_pk: Uint8Array;
  revoked_at: number | null;
}

export async function getConsent(db: D1Database, appId: string, consentId: Uint8Array): Promise<ConsentRow | null> {
  const r = await db.prepare('SELECT consent_id, share_id, session_pk, revoked_at FROM vault_consents WHERE consent_id = ?1 AND app_id = ?2').bind(consentId, appId).first<Record<string, unknown>>();
  if (!r) return null;
  return { consent_id: blob(r.consent_id), share_id: r.share_id === null ? null : blob(r.share_id), session_pk: blob(r.session_pk), revoked_at: (r.revoked_at as number | null) ?? null };
}

/** True when any app already used this id. A consent id is 128 random bits: a hit is a repeat, not a collision. */
export async function consentExists(db: D1Database, consentId: Uint8Array): Promise<boolean> {
  return (await db.prepare('SELECT 1 AS hit FROM vault_consents WHERE consent_id = ?1').bind(consentId).first<{ hit: number }>()) !== null;
}

export interface NewConsent {
  consentId: Uint8Array;
  appId: string;
  shareId: Uint8Array | null;
  sessionPk: Uint8Array;
  pathHash: Uint8Array;
  partnerOrigin: string;
  policyId: Uint8Array;
  label: string;
  grantedAt: number;
  expiresAt: number;
}

/** The share is live and its counter is `counter - 1`: the condition of a signed, in-order use (shares.ts). */
const liveAt = (share: string, app: string, counter: string, now: string): string =>
  `EXISTS (SELECT 1 FROM vault_shares s WHERE s.share_id = ${share} AND s.app_id = ${app} AND s.counter = ${counter} - 1 AND s.revoked_at IS NULL AND ${now} < s.idle_until AND ${now} < s.abs_expires_at)`;

const advance = (db: D1Database, appId: string, shareId: Uint8Array, counter: number, now: number): D1PreparedStatement =>
  db
    .prepare('UPDATE vault_shares SET counter = ?3 WHERE share_id = ?1 AND app_id = ?2 AND counter = ?3 - 1 AND ?4 < idle_until AND ?4 < abs_expires_at AND revoked_at IS NULL RETURNING counter')
    .bind(shareId, appId, counter, now);

/**
 * Registers a consent and revokes the session key's previous one (`revoked_by = 'device'`), in one D1 batch (one
 * transaction). In 'session' mode the share's counter moves in the same batch and every statement is conditional on the
 * share being live at `counter - 1`, so a replayed request changes nothing. In 'none' mode there is no counter: the
 * primary key is the replay check, and prune keeps those rows until they expire (D510). `advanced` is null when the
 * counter did not move (a 'session'-mode refusal).
 */
export async function registerConsent(db: D1Database, c: NewConsent, counter: number, now: number): Promise<{ created: boolean; advanced: number | null }> {
  if (c.shareId) {
    const [, inserted, advanced] = await db.batch<{ counter: number }>([
      db
        .prepare(`UPDATE vault_consents SET revoked_at = ?1, revoked_by = 'device' WHERE session_pk = ?2 AND revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM vault_consents x WHERE x.consent_id = ?3) AND ${liveAt('?4', '?5', '?6', '?1')}`)
        .bind(now, c.sessionPk, c.consentId, c.shareId, c.appId, counter),
      db
        .prepare(
          `INSERT INTO vault_consents (consent_id, app_id, share_id, session_pk, path_hash, partner_origin, policy_id, label, granted_at, expires_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE ${liveAt('?3', '?2', '?11', '?9')}
           ON CONFLICT (consent_id) DO NOTHING`,
        )
        .bind(c.consentId, c.appId, c.shareId, c.sessionPk, c.pathHash, c.partnerOrigin, c.policyId, c.label, c.grantedAt, c.expiresAt, counter),
      advance(db, c.appId, c.shareId, counter, now),
    ]);
    const row = advanced?.results[0];
    return { created: (inserted?.meta.changes ?? 0) === 1, advanced: row ? row.counter : null };
  }
  const [, inserted] = await db.batch([
    db.prepare(`UPDATE vault_consents SET revoked_at = ?1, revoked_by = 'device' WHERE session_pk = ?2 AND revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM vault_consents x WHERE x.consent_id = ?3)`).bind(now, c.sessionPk, c.consentId),
    db
      .prepare(
        `INSERT INTO vault_consents (consent_id, app_id, share_id, session_pk, path_hash, partner_origin, policy_id, label, granted_at, expires_at)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (consent_id) DO NOTHING`,
      )
      .bind(c.consentId, c.appId, c.sessionPk, c.pathHash, c.partnerOrigin, c.policyId, c.label, c.grantedAt, c.expiresAt),
  ]);
  return { created: (inserted?.meta.changes ?? 0) === 1, advanced: 0 };
}

/**
 * The device's revoke. 'session' mode: moves the share's counter and revokes in one batch, the revoke conditional on the
 * same check, so a replay revokes nothing; `advanced` is null when the counter did not move. 'none' mode: no counter
 * (a repeat changes nothing). `revoked` is false when the consent was already revoked.
 */
export async function revokeConsent(
  db: D1Database,
  appId: string,
  consentId: Uint8Array,
  share: { shareId: Uint8Array; counter: number } | null,
  now: number,
): Promise<{ revoked: boolean; advanced: number | null }> {
  const revoke = `UPDATE vault_consents SET revoked_at = ?3, revoked_by = 'device' WHERE consent_id = ?1 AND app_id = ?2 AND revoked_at IS NULL`;
  if (!share) {
    const res = await db.prepare(revoke).bind(consentId, appId, now).run();
    return { revoked: res.meta.changes === 1, advanced: 0 };
  }
  const [revoked, advanced] = await db.batch<{ counter: number }>([
    db.prepare(`${revoke} AND ${liveAt('?4', '?2', '?5', '?3')}`).bind(consentId, appId, now, share.shareId, share.counter),
    advance(db, appId, share.shareId, share.counter, now),
  ]);
  const row = advanced?.results[0];
  return { revoked: (revoked?.meta.changes ?? 0) === 1, advanced: row ? row.counter : null };
}

/** The consent id from the header's base64url, or null when it isn't exactly 16 bytes. */
export function parseConsentHeader(value: string): Uint8Array | null {
  try {
    const bytes = base64UrlDecode(value);
    return bytes.length === CONSENT_ID_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

interface StatusRow {
  revoked_at: number | null;
  expires_at: number;
  share_id: unknown;
  live_share: unknown;
  share_revoked_at: number | null;
  idle_until: number | null;
  abs_expires_at: number | null;
  created_at: number | null;
  partner_origin: string | null;
  persistence: string;
  session_ttl_ms: number;
}

/**
 * The consent's status for GET /v1/app (D465): one uncached D1 statement, never a chain read. 'unknown' when this app
 * has no such row. A consent under a share is active only while that share is live, as unlock judges it: not revoked,
 * before `idle_until`, before min(`abs_expires_at`, `created_at` + the app's current session TTL), the app still keeping
 * logins and the share's origin still allowed. A share row already pruned reads 'revoked'.
 */
export async function consentStatus(db: D1Database, appId: string, consentId: Uint8Array, now: number, originAllowed: (origin: string) => boolean): Promise<ConsentStatus> {
  const r = await db
    .prepare(
      `SELECT c.revoked_at, c.expires_at, c.share_id, s.share_id AS live_share, s.revoked_at AS share_revoked_at, s.idle_until, s.abs_expires_at, s.created_at, s.partner_origin,
              a.persistence, a.session_ttl_ms
         FROM vault_consents c
         JOIN apps a ON a.id = c.app_id
         LEFT JOIN vault_shares s ON s.share_id = c.share_id AND s.app_id = c.app_id
        WHERE c.consent_id = ?1 AND c.app_id = ?2`,
    )
    .bind(consentId, appId)
    .first<StatusRow>();
  if (!r) return 'unknown';
  if (r.revoked_at !== null || now >= r.expires_at) return 'revoked';
  if (r.share_id === null) return 'active';
  if (r.live_share === null || r.share_revoked_at !== null || r.persistence !== 'session') return 'revoked';
  if (now >= r.idle_until! || now >= Math.min(r.abs_expires_at!, r.created_at! + r.session_ttl_ms)) return 'revoked';
  return originAllowed(r.partner_origin!) ? 'active' : 'revoked';
}

/**
 * Deletes consents past their expiry and revoked ones an hour on. A revoked 'none'-mode row stays until its expiry: it is
 * that consent's replay check, since its signed message carries no counter (D510). The row lives no longer than the
 * session it was granted in either way.
 */
export async function pruneConsents(db: D1Database, now: number): Promise<number> {
  const res = await db
    .prepare('DELETE FROM vault_consents WHERE expires_at < ?1 OR (revoked_at < ?2 AND share_id IS NOT NULL)')
    .bind(now, now - CONSENT_REVOKED_KEEP_MS)
    .run();
  return res.meta.changes;
}
