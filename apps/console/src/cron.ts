// The console's hourly cron (docs/batch-c-spec.md "Crons", "Retention"): invite expiry, matured owner grants recorded,
// housekeeping purges of short-lived rows, and logo objects replaced more than 30 days ago. Each step is its own D1
// batch (one transaction) over at most CRON_BATCH rows, so a step that fails leaves the others to run and the next hour
// picks up what is left; nothing here is retention of audit data (that is the admin Worker's monthly job, C13).
import { CRON_BATCH, INVITE_KEEP_MS, LOGO_KEEP_MS, SESSION_IDLE_MS, SESSION_KEEP_MS, SESSION_NETWORK_KEEP_MS, SHORT_LIVED_KEEP_MS } from './config.ts';
import type { Env } from './env.ts';
import { log } from './log.ts';
import { lit } from './sql.ts';

/**
 * Invites that expired unaccepted get one `invite.expired` audit row each (request id `cron-<run>-<invite id>`, so each
 * row has its own commit identity) (`expired_logged_at` marks it) and their
 * owner grant cancelled. One set-based batch: the set can't change between its statements (one transaction).
 */
export async function expireInvites(db: D1Database, now: number): Promise<number> {
  const due = `SELECT id FROM invites WHERE expires_at <= ${lit(now)} AND accepted_at IS NULL AND revoked_at IS NULL AND expired_logged_at IS NULL ORDER BY expires_at, id LIMIT ${CRON_BATCH}`;
  const [audit] = await db.batch([
    db.prepare(
      `INSERT INTO audit_log (at, actor_kind, actor_id, org_id, action, target, details_json, request_id, outcome)
       SELECT ${lit(now)}, 'system', 'console-cron', org_id, 'invite.expired', id, '{}', 'cron-${lit(now)}-' || id, 'ok' FROM invites WHERE id IN (${due})`,
    ),
    db.prepare(`UPDATE owner_grants SET cancelled_at = ${lit(now)}, cancelled_by = 'system:invite_expired' WHERE invite_id IN (${due}) AND cancelled_at IS NULL AND applied_at IS NULL`),
    db.prepare(`UPDATE invites SET expired_logged_at = ${lit(now)} WHERE id IN (${due})`),
  ]);
  return audit!.meta.changes;
}

/**
 * Records matured grants: an announced, uncancelled grant whose `owner_from` has passed already makes its member an
 * owner by predicate; this writes `members.role = 'owner'`, `applied_at` and `member.owner_granted`, once. A grant whose
 * member row is gone (removed meanwhile, which cancels grants, so only by a direct edit) is cancelled instead.
 */
export async function applyGrants(db: D1Database, now: number): Promise<{ applied: number; orphaned: number }> {
  const matured = `g.cancelled_at IS NULL AND g.applied_at IS NULL AND g.notified_at IS NOT NULL AND g.owner_from IS NOT NULL AND g.owner_from <= ${lit(now)} AND g.user_id IS NOT NULL`;
  const withMember = `EXISTS (SELECT 1 FROM members m WHERE m.org_id = g.org_id AND m.user_id = g.user_id)`;
  const due = `SELECT g.id FROM owner_grants g WHERE ${matured} AND ${withMember} ORDER BY g.owner_from, g.id LIMIT ${CRON_BATCH}`;
  const [audit, , , orphans] = await db.batch([
    db.prepare(
      `INSERT INTO audit_log (at, actor_kind, actor_id, org_id, action, target, details_json, request_id, outcome)
       SELECT ${lit(now)}, 'system', 'console-cron', g.org_id, 'member.owner_granted', g.user_id, json_object('grantId', g.id), 'cron-${lit(now)}-' || g.id, 'ok'
         FROM owner_grants g WHERE g.id IN (${due})`,
    ),
    db.prepare(
      `UPDATE members SET role = 'owner', role_since = (SELECT g.owner_from FROM owner_grants g WHERE g.id IN (${due}) AND g.org_id = members.org_id AND g.user_id = members.user_id)
        WHERE role = 'viewer' AND EXISTS (SELECT 1 FROM owner_grants g WHERE g.id IN (${due}) AND g.org_id = members.org_id AND g.user_id = members.user_id)`,
    ),
    db.prepare(`UPDATE owner_grants SET applied_at = ${lit(now)} WHERE id IN (${due})`),
    db.prepare(`UPDATE owner_grants AS g SET cancelled_at = ${lit(now)}, cancelled_by = 'system:not_member' WHERE ${matured} AND NOT ${withMember}`),
  ]);
  return { applied: audit!.meta.changes, orphaned: orphans!.meta.changes };
}

/** Housekeeping purges (§Retention): the rows' own lifetimes, never audit rows or grants. */
export async function purgeShortLived(db: D1Database, now: number): Promise<Record<string, number>> {
  const r = await db.batch([
    // Invites 90 days after acceptance, revocation or expiry (their grants stay: 5 years, with the audit).
    db.prepare(`DELETE FROM invites WHERE COALESCE(accepted_at, revoked_at, expires_at) <= ${lit(now - INVITE_KEEP_MS)} AND (accepted_at IS NOT NULL OR revoked_at IS NOT NULL OR expired_logged_at IS NOT NULL)`),
    // Sessions 30 days after they ended (revoked, idle or absolute expiry, whichever came first).
    db.prepare(`DELETE FROM console_sessions WHERE MIN(COALESCE(revoked_at, absolute_expires_at), absolute_expires_at, last_seen_at + ${lit(SESSION_IDLE_MS)}) <= ${lit(now - SESSION_KEEP_MS)}`),
    // Network data 90 days after sign-in (a session row outlives it only by a direct edit; kept as the rule says).
    db.prepare(`UPDATE console_sessions SET country = NULL, asn = NULL, ip_prefix = NULL WHERE auth_at <= ${lit(now - SESSION_NETWORK_KEEP_MS)} AND (country IS NOT NULL OR asn IS NOT NULL OR ip_prefix IS NOT NULL)`),
    db.prepare(`DELETE FROM auth_flows WHERE expires_at <= ${lit(now - SHORT_LIVED_KEEP_MS)}`),
    db.prepare(`DELETE FROM handoff_codes WHERE expires_at <= ${lit(now - SHORT_LIVED_KEEP_MS)}`),
    db.prepare(`DELETE FROM pending_actions WHERE expires_at <= ${lit(now - SHORT_LIVED_KEEP_MS)}`),
  ]);
  const [invites, sessions, network, authFlows, handoffCodes, pendingActions] = r.map((x) => x.meta.changes);
  return { invites: invites!, sessions: sessions!, network: network!, authFlows: authFlows!, handoffCodes: handoffCodes!, pendingActions: pendingActions! };
}

/** Logo objects replaced more than 30 days ago: deleted from LOGOS, then their rows. */
export async function purgeLogos(env: Pick<Env, 'CONSOLE_DB' | 'LOGOS'>, now: number): Promise<number> {
  if (!env.LOGOS) return 0;
  const { results } = await env.CONSOLE_DB.prepare(`SELECT key FROM logo_objects WHERE replaced_at IS NOT NULL AND replaced_at <= ${lit(now - LOGO_KEEP_MS)} ORDER BY replaced_at LIMIT 100`).all<{ key: string }>();
  if (!results.length) return 0;
  const keys = results.map((r) => r.key);
  await env.LOGOS.delete(keys);
  await env.CONSOLE_DB.prepare('DELETE FROM logo_objects WHERE key IN (SELECT value FROM json_each(?)) AND replaced_at IS NOT NULL').bind(JSON.stringify(keys)).run();
  return keys.length;
}

/** The hourly run: every step, each on its own, logged with counts only. */
export async function hourly(env: Env, now: number): Promise<void> {
  const db = env.CONSOLE_DB;
  const steps: [string, () => Promise<number>][] = [
    ['invites.expired', () => expireInvites(db, now)],
    ['grants.applied', async () => (await applyGrants(db, now)).applied],
    ['purge', async () => Object.values(await purgeShortLived(db, now)).reduce((a, b) => a + b, 0)],
    ['logos', () => purgeLogos(env, now)],
  ];
  for (const [step, run] of steps) {
    try {
      const count = await run();
      log({ event: 'console_cron', step, count, outcome: 'ok' });
    } catch (err) {
      log({ event: 'console_cron', step, outcome: 'error', error: err instanceof Error ? err.name : 'unknown' }, 'error');
    }
  }
}
