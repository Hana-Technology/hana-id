// Platform keys' share of the hourly job (D918), as the guarded changes' (guarded/cron.ts):
// - records each announced key whose date has passed, once (`active`, `activated_recorded_at`, `platform.key_active`).
//   Nothing waits for this: a key is in force by the predicate (keys.ts KEY_IN_FORCE);
// - ends a key a year after it came into force (`expired`, `platform.key_expired`), and in the same batch cancels every
//   web address it proposed that is still waiting (actor `system`, reason `key_expired`; A3);
// - lapses a key not accepted, or not announced, within 7 days of its registration, or of the end of its hold after a
//   security-contact change, and at the latest 28 days after its registration (`cancelled` by `system`).
// Each key is one D1 batch; every write after the first only if the first happened in this run, and each ledger row has
// a request id derived from the key, so two overlapping runs record a key once.
import { PLATFORM_KEY_CONTACT_WAIT_MS, PLATFORM_KEY_HOLD_MAX_MS, PLATFORM_KEY_LAPSE_MS } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { type Writer, runWrite } from '../changes/cas.ts';
import { HotDb } from '../changes/db.ts';
import { prepare, q, raw } from '../changes/sql.ts';
import { cancelPlatformProposals } from './keys.ts';

/**
 * A waiting key's lapse is due (D918 after the second review): 7 days from its registration, or from the end of the
 * hold after a security-contact change when that is later (the hold refuses its announcement and its acceptance), and
 * never later than 28 days after its registration however often the contacts change. Over `platform_keys` unaliased.
 */
const LAPSE_DUE = (now: number): string =>
  `MIN(MAX(platform_keys.proposed_at, COALESCE((SELECT MAX(c.at) FROM app_changes c WHERE c.org_id = platform_keys.org_id AND c.kind = 'org.security_contacts'), 0) + ${PLATFORM_KEY_CONTACT_WAIT_MS})` +
  ` + ${PLATFORM_KEY_LAPSE_MS}, platform_keys.proposed_at + ${PLATFORM_KEY_HOLD_MAX_MS}) <= ${Math.floor(now)}`;

export const PLATFORM_CRON_BATCH = 100;

export interface PlatformKeysRun {
  activated: number;
  expired: number;
  lapsed: number;
}

/** Whether migration 0028 is applied (an env deployed before it runs the rest of the hourly job unchanged). */
async function tableExists(db: D1Database): Promise<boolean> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'platform_keys'").first<{ n: number }>();
  return (r?.n ?? 0) === 1;
}

async function apply(db: D1Database, stmts: D1PreparedStatement[], id: string, what: string): Promise<boolean> {
  try {
    const results = await db.batch(stmts);
    return (results[0]?.meta.changes ?? 0) === 1;
  } catch {
    log({ event: 'platform_keys_cron', outcome: 'error', code: 'write_failed', platformKeyId: id, what }, 'error');
    return false;
  }
}

export async function platformKeysMaintenance(env: Pick<Env, 'DB'>, now = Date.now()): Promise<PlatformKeysRun> {
  const db = env.DB;
  const run: PlatformKeysRun = { activated: 0, expired: 0, lapsed: 0 };
  if (!(await tableExists(db))) return run;

  const { results: due } = await db
    .prepare("SELECT id, org_id, active_from FROM platform_keys WHERE status = 'pending' AND notified_at IS NOT NULL AND active_from <= ?1 ORDER BY active_from, id LIMIT ?2")
    .bind(now, PLATFORM_CRON_BATCH)
    .all<{ id: string; org_id: string; active_from: number }>();
  for (const k of due) {
    const recorded = "EXISTS (SELECT 1 FROM platform_keys WHERE id = ?1 AND status = 'active' AND activated_recorded_at = ?2)";
    const stmts = [
      db.prepare("UPDATE platform_keys SET status = 'active', activated_recorded_at = ?2 WHERE id = ?1 AND status = 'pending' AND notified_at IS NOT NULL AND active_from <= ?2").bind(k.id, now),
      db
        .prepare(
          `INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id)
           SELECT ?2, ?3, NULL, NULL, 'platform.key_active', json_object('keyId', ?1, 'activeFrom', ?4), 'system', 'cron', ?5 WHERE ${recorded}`,
        )
        .bind(k.id, now, k.org_id, k.active_from, `cron:platform:active:${k.id}`),
    ];
    if (await apply(db, stmts, k.id, 'activate')) run.activated++;
  }

  // Expiry: through the writers' batch builder, so the waiting web addresses go in the same batch as the key.
  const { results: old } = await db
    .prepare("SELECT id, org_id, expires_at FROM platform_keys WHERE status = 'active' AND expires_at <= ?1 ORDER BY expires_at, id LIMIT ?2")
    .bind(now, PLATFORM_CRON_BATCH)
    .all<{ id: string; org_id: string; expires_at: number }>();
  for (const k of old) {
    const w: Writer = { actor: { kind: 'system', id: 'cron' }, requestId: `cron:platform:expired:${k.id}`, now };
    try {
      await runWrite(new HotDb(db), w, [
        q`INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id)
          SELECT ${now}, ${k.org_id}, NULL, NULL, 'platform.key_expired', json_object('keyId', ${k.id}, 'expiresAt', ${k.expires_at}), 'system', 'cron', ${w.requestId}
           WHERE EXISTS (SELECT 1 FROM platform_keys WHERE id = ${k.id} AND status = 'active' AND expires_at <= ${now})`,
        q`UPDATE platform_keys SET status = 'expired', end_request_id = ${w.requestId} WHERE id = ${k.id} AND status = 'active' AND EXISTS (SELECT 1 FROM app_changes WHERE request_id = ${w.requestId})`,
        ...cancelPlatformProposals(w, { orgId: k.org_id, keyId: k.id, reason: 'key_expired' }),
      ]);
      run.expired++;
    } catch {
      // version_conflict (another run, or a revocation, got there first) or a failed batch: nothing written.
      log({ event: 'platform_keys_cron', outcome: 'rejected', platformKeyId: k.id, what: 'expire' }, 'warn');
    }
  }

  const { results: stale } = await db
    .prepare(
      `SELECT id, org_id, CASE WHEN status = 'awaiting_acceptance' THEN 'not_accepted' ELSE 'not_announced' END AS reason FROM platform_keys
        WHERE proposed_at <= ?1 AND (status = 'awaiting_acceptance' OR (status = 'pending' AND notified_at IS NULL)) AND ${LAPSE_DUE(now)} ORDER BY proposed_at, id LIMIT ?2`,
    )
    .bind(now - PLATFORM_KEY_LAPSE_MS, PLATFORM_CRON_BATCH)
    .all<{ id: string; org_id: string; reason: 'not_accepted' | 'not_announced' }>();
  for (const k of stale) {
    const lapsed = "EXISTS (SELECT 1 FROM platform_keys WHERE id = ?1 AND status = 'cancelled' AND cancelled_at = ?2 AND cancelled_by_kind = 'system')";
    const stmts = [
      prepare(
        db,
        q`UPDATE platform_keys SET status = 'cancelled', cancelled_at = ${now}, cancelled_by_kind = 'system', cancelled_by = 'cron', cancel_reason = ${k.reason}
           WHERE id = ${k.id} AND proposed_at <= ${now - PLATFORM_KEY_LAPSE_MS} AND (status = 'awaiting_acceptance' OR (status = 'pending' AND notified_at IS NULL)) AND ${raw(LAPSE_DUE(now))}`,
      ),
      db
        .prepare(
          `INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id)
           SELECT ?2, ?3, NULL, NULL, 'platform.key_cancelled', json_object('keyId', ?1, 'by', 'system', 'reason', ?4), 'system', 'cron', ?5 WHERE ${lapsed}`,
        )
        .bind(k.id, now, k.org_id, k.reason, `cron:platform:lapsed:${k.id}`),
    ];
    if (await apply(db, stmts, k.id, 'lapse')) run.lapsed++;
  }
  if (run.activated || run.expired || run.lapsed) log({ event: 'platform_keys_cron', outcome: 'ok', ...run });
  return run;
}
