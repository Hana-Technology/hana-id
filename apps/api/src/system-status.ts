// `AdminRpc.systemStatus` (D425; apps/admin/README.md "System status"): the API's own view of itself in one call, for
// the admin console's landing page. Read-only, staff only (rpc/admin.ts), no user data: the build id, a timed
// `SELECT 1` on the hot DB, the Google-key sync's last run per provider (every `*/15` cron run writes it), the blocking
// notices not yet sent (a count and the oldest time), both relayer pools' public keys, and the governance snapshot
// `GET /v1/governance` serves (its 10 s per-isolate cache, so a status read doesn't add NEAR reads beyond it). Each part
// fails on its own: a D1 or NEAR failure leaves the others standing.
import { type ApiSystemStatus, type CronRunView, type DbProbe, NOTICE_BACKLOG_LIMIT, type NoticeBacklog } from '@hana-id/console-core';
import { deployedBuild } from './build.ts';
import { relayerPools } from './changes/admin.ts';
import { RpcRefusal } from './changes/cas.ts';
import type { HotDb } from './changes/db.ts';
import { q } from './changes/sql.ts';
import type { Env } from './env.ts';
import { governanceSnapshot } from './governance-status.ts';
import { log } from './log.ts';

const OUTCOMES = new Set(['ok', 'error', 'skipped']);

async function probe(env: Env): Promise<DbProbe> {
  const start = Date.now();
  try {
    await env.DB.prepare('SELECT 1 AS one').first();
    return { ok: true, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

async function jwksSync(db: HotDb): Promise<CronRunView[] | null> {
  try {
    const rows = await db.all<{ provider: string; at_ms: number; outcome: string; code: string | null }>(q`SELECT provider, at_ms, outcome, code FROM issuer_key_sync_runs ORDER BY provider LIMIT 10`);
    return rows.map((r) => ({ job: `jwks_sync:${r.provider}`, atMs: Number(r.at_ms), outcome: OUTCOMES.has(r.outcome) ? (r.outcome as CronRunView['outcome']) : 'error', detail: r.code ?? null }));
  } catch {
    return null;
  }
}

/** The pending guarded-change notices (lifecycle.ts `pendingNotices`' rows: pending, unannounced, app not deleted). */
async function noticeBacklog(db: HotDb): Promise<NoticeBacklog | null> {
  try {
    const rows = await db.all<{ proposed_at: number }>(
      q`SELECT g.proposed_at FROM guarded_changes g JOIN apps a ON a.id = g.app_id
         WHERE g.status = 'pending' AND g.notified_at IS NULL AND a.deleted_at IS NULL
         ORDER BY g.proposed_at, g.id LIMIT ${NOTICE_BACKLOG_LIMIT + 1}`,
    );
    const shown = rows.slice(0, NOTICE_BACKLOG_LIMIT);
    return { pending: shown.length, oldestAt: shown[0] ? Number(shown[0].proposed_at) : null, truncated: rows.length > NOTICE_BACKLOG_LIMIT };
  } catch {
    return null;
  }
}

function poolKeys(env: Env): ApiSystemStatus['relayerKeys'] {
  try {
    return relayerPools(env).keys;
  } catch {
    return null;
  }
}

async function governance(env: Env): Promise<ApiSystemStatus['governance']> {
  try {
    return { ok: true, snapshot: { ...(await governanceSnapshot(env)) } as Record<string, unknown> };
  } catch (err) {
    const code = err instanceof RpcRefusal ? err.code : 'internal';
    if (!(err instanceof RpcRefusal)) log({ event: 'system_status', outcome: 'error', code: 'governance_failed' }, 'error');
    return { ok: false, code };
  }
}

export async function systemStatus(env: Env, db: HotDb): Promise<ApiSystemStatus> {
  const [hotDb, sync, notices, gov] = await Promise.all([probe(env), jwksSync(db), noticeBacklog(db), governance(env)]);
  return { build: deployedBuild(env.HANA_BUILD), hotDb, jwksSync: sync, notices, relayerKeys: poolKeys(env), usageCapture: env.USAGE_DB !== undefined, governance: gov };
}
