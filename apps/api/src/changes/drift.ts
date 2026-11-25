// Drift detection (docs/batch-c-spec.md "Drift detection", API hourly cron): every origin in force must be explained by
// an announced origin_add whose clock had passed when the row came into force, or by the 0006 baseline (a migrated
// row, `active_from = 0`, listed in the app's `migration.baseline`); every stored or pending policy and every raw-signing
// enable by an announced policy_set / raw_sign_on change (a stored value: one in force by then; a pending value: one
// whose clock is no earlier than the pending value's effective time), or by the baseline. A mismatch is a direct D1
// write (manual SQL, a buggy script): it writes a `drift` security event, once per finding (the event id is derived
// from it), which the admin feed emails. It doesn't catch an insider who also forges `guarded_changes` rows.
//
// A baseline explains a value only while no later `app_changes` row ended it (an origin removed, by removeOrigins or by
// the removes a member's changeOrigins sent with its adds (`origin.proposed` detail `removed`), the policy removed,
// replaced or its pending value dropped, raw signing off), so a value put back by hand after a kill switch is drift.
//
// D915 (H3): an auto-approve policy on an app of a shared scope (`scopes.app_user_ids`) or created by the platform is
// drift whatever explains it: no writer may put one there. Each is its own finding (`what` `shared_wallet_policy`, with
// `source` `policy`, `policy_pending` or the open change `change`), so it is reported even when a forged
// announced change would explain the value to the checks above. After PR 145's review: a scope counts as shared when its
// column says so, when its row is missing, or when the append-only ledger has a `scope.app_user_ids` row for it (a mark
// undone by a direct write still counts), and an app counts when its creator isn't `hana`; a scope the ledger says is
// marked while its column doesn't is a finding of its own (`shared_scope_unmarked`). A finding is new per app, source
// and `settings_version` (a policy forged again after the kill switch, which bumps the version, is reported again) or
// per change id; findings already recorded are left out of the read, in a fixed order, so they never crowd out new ones.
//
// An `app.created` row explains nothing on its own (D228): the origins it lists are guarded changes since 0006, and
// counting the row would let a forged in-force row for an unannounced initial origin pass.
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { eventId } from './guard.ts';
import { storedPolicy } from './policy.ts';

/** At most this many findings per kind per run. */
export const DRIFT_BATCH = 100;

/** Ledger kinds that end what the baseline held (a CLI settings write lists several under `parts`). */
const POLICY_ENDS = ['policy.removed', 'policy.activated', 'policy.pending_dropped'];
const RAW_ENDS = ['raw_sign.off'];
/** Ledger kinds that end a baseline origin (the removes of `origin.proposed` are in its detail's `removed`). */
const ORIGIN_ENDS = ['origin.removed', 'origin.proposed'];
/**
 * Every `app_changes` kind this check reads: the 0006 baseline and what ends its values. The retention purge
 * (changes/retention.ts) keeps these rows, and any row whose `parts` name one, for a live app that has a baseline, so a
 * value the baseline explains never turns into a false drift finding when its row turns 60 months old (D364).
 */
export const DRIFT_LEDGER_KINDS: readonly string[] = ['migration.baseline', ...ORIGIN_ENDS, ...POLICY_ENDS, ...RAW_ENDS];
/**
 * D915: a scope's mark (`app_id` NULL). Drift reads every such row, for every scope, for as long as the scope exists
 * (scopes are never deleted), so the retention purge never deletes one (D364).
 */
export const SHARED_SCOPE_LEDGER_KIND = 'scope.app_user_ids';
const kindIn = (kinds: readonly string[]) => kinds.map((k) => `'${k}'`).join(', ');
/** No row after the baseline `b` of app `a` ended it. */
const NOT_ENDED = (kinds: readonly string[]) =>
  `NOT EXISTS (SELECT 1 FROM app_changes e WHERE e.app_id = a.id AND e.seq > b.seq
                AND (e.kind IN (${kindIn(kinds)}) OR EXISTS (SELECT 1 FROM json_each(e.detail_json, '$.parts') pp WHERE json_extract(pp.value, '$.kind') IN (${kindIn(kinds)}))))`;
/** The 0006 baseline of app `a` held `value` in `field`, and nothing has ended it since (a kill switch, a newer value). */
const BASELINE = (field: string, value: string, ends: readonly string[]) =>
  `EXISTS (SELECT 1 FROM app_changes b WHERE b.kind = 'migration.baseline' AND b.app_id = a.id AND json_extract(b.detail_json, '$.${field}') = ${value}
             AND ${NOT_ENDED(ends)})`;

/** An announced change of `kind` on app `a` with `value` (`g.policy_json = …` or none), status open, and `clock`. */
const ANNOUNCED = (kind: string, value: string | null, clock: string) =>
  `EXISTS (SELECT 1 FROM guarded_changes g WHERE g.app_id = a.id AND g.kind = '${kind}' ${value ? `AND g.policy_json = ${value}` : ''}
             AND g.notified_at IS NOT NULL AND g.active_from IS NOT NULL AND g.status IN ('pending', 'active') AND ${clock})`;

interface OriginFinding {
  app_id: string;
  org_id: string;
  scope_id: string;
  origin: string;
  active_from: number;
  change_id: string | null;
}

interface SharedWalletFinding {
  app_id: string;
  org_id: string;
  scope_id: string;
  settings_version: number;
  source: 'policy' | 'policy_pending' | 'change';
  /** The policy text (`policy`, `policy_pending`) or the guarded change's id (`change`). */
  value: string;
}

/** App `a` (joined with its scope `s`) may never have an auto-approve policy (D915). */
const SHARED_WALLET = "(COALESCE(s.app_user_ids, 1) <> 0 OR a.created_by_kind <> 'hana' OR a.scope_id IN (SELECT scope_id FROM marked))";
/** Scopes the ledger says were marked (the mark's rows are append-only and kept past 60 months: retention.ts). */
const MARKED = "WITH marked AS (SELECT DISTINCT scope_id FROM app_changes WHERE kind = 'scope.app_user_ids' AND scope_id IS NOT NULL)";

interface SettingFinding {
  app_id: string;
  org_id: string;
  scope_id: string;
  what: 'policy' | 'policy_pending' | 'raw_sign' | 'raw_sign_pending';
  value: string | null;
}

export interface DriftRun {
  found: number;
  recorded: number;
}

export async function detectDrift(env: Pick<Env, 'DB'>, now = Date.now()): Promise<DriftRun> {
  const db = env.DB;
  const { results: origins } = await db
    .prepare(
      `SELECT o.app_id, a.org_id, a.scope_id, o.origin, o.active_from, o.change_id
         FROM app_origins o JOIN apps a ON a.id = o.app_id
        WHERE o.active_from IS NOT NULL AND o.active_from <= ?1 AND a.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM guarded_changes g WHERE g.id = o.change_id AND g.app_id = o.app_id AND g.kind = 'origin_add' AND g.origin = o.origin
                           AND g.notified_at IS NOT NULL AND g.active_from IS NOT NULL AND g.active_from <= o.active_from AND g.status IN ('pending', 'active'))
          AND NOT (o.active_from = 0 AND EXISTS (SELECT 1 FROM app_changes b, json_each(b.detail_json, '$.origins') j
                                                 WHERE b.kind = 'migration.baseline' AND b.app_id = o.app_id AND j.value = o.origin
                                                   AND NOT EXISTS (SELECT 1 FROM app_changes e, json_each(e.detail_json, CASE WHEN e.kind = 'origin.removed' THEN '$.origins' ELSE '$.removed' END) r
                                                                    WHERE e.app_id = o.app_id AND e.seq > b.seq AND e.kind IN (${kindIn(ORIGIN_ENDS)})
                                                                      AND json_extract(r.value, '$.origin') = o.origin)))
        ORDER BY o.app_id, o.origin LIMIT ?2`,
    )
    .bind(now, DRIFT_BATCH)
    .all<OriginFinding>();
  const inForceClock = `(g.status = 'active' OR g.active_from <= ${Number(now)})`;
  const { results: settings } = await db
    .prepare(
      `SELECT a.id AS app_id, a.org_id, a.scope_id, 'policy' AS what, a.auto_approve_policy AS value FROM apps a
        WHERE a.deleted_at IS NULL AND a.auto_approve_policy IS NOT NULL
          AND NOT ${ANNOUNCED('policy_set', 'a.auto_approve_policy', inForceClock)}
          AND NOT ${BASELINE('autoApprovePolicy', 'a.auto_approve_policy', POLICY_ENDS)} AND NOT ${BASELINE('autoApprovePending', 'a.auto_approve_policy', POLICY_ENDS)}
       UNION ALL
       SELECT a.id, a.org_id, a.scope_id, 'policy_pending', a.auto_approve_pending FROM apps a
        WHERE a.deleted_at IS NULL AND a.auto_approve_pending IS NOT NULL
          AND NOT ${ANNOUNCED('policy_set', 'a.auto_approve_pending', 'g.active_from <= a.auto_approve_effective_at')}
          AND NOT ${BASELINE('autoApprovePending', 'a.auto_approve_pending', POLICY_ENDS)}
       UNION ALL
       SELECT a.id, a.org_id, a.scope_id, 'raw_sign', NULL FROM apps a
        WHERE a.deleted_at IS NULL AND a.raw_sign = 'approval'
          AND NOT ${ANNOUNCED('raw_sign_on', null, inForceClock)}
          AND NOT ${BASELINE('rawSign', "'approval'", RAW_ENDS)} AND NOT ${BASELINE('rawSignPending', "'approval'", RAW_ENDS)}
       UNION ALL
       SELECT a.id, a.org_id, a.scope_id, 'raw_sign_pending', NULL FROM apps a
        WHERE a.deleted_at IS NULL AND a.raw_sign_pending = 'approval'
          AND NOT ${ANNOUNCED('raw_sign_on', null, 'g.active_from <= a.raw_sign_effective_at')}
          AND NOT ${BASELINE('rawSignPending', "'approval'", RAW_ENDS)}
       LIMIT ?1`,
    )
    .bind(DRIFT_BATCH)
    .all<SettingFinding>();

  const { results: shared } = await db
    .prepare(
      `${MARKED}
       SELECT f.* FROM (
         SELECT a.id AS app_id, a.org_id, a.scope_id, a.settings_version, 'policy' AS source, a.auto_approve_policy AS value FROM apps a LEFT JOIN scopes s ON s.scope_id = a.scope_id
          WHERE a.deleted_at IS NULL AND ${SHARED_WALLET} AND a.auto_approve_policy IS NOT NULL
         UNION ALL
         SELECT a.id, a.org_id, a.scope_id, a.settings_version, 'policy_pending', a.auto_approve_pending FROM apps a LEFT JOIN scopes s ON s.scope_id = a.scope_id
          WHERE a.deleted_at IS NULL AND ${SHARED_WALLET} AND a.auto_approve_pending IS NOT NULL
         UNION ALL
         SELECT a.id, a.org_id, a.scope_id, a.settings_version, 'change', g.id FROM guarded_changes g JOIN apps a ON a.id = g.app_id LEFT JOIN scopes s ON s.scope_id = a.scope_id
          WHERE a.deleted_at IS NULL AND ${SHARED_WALLET} AND g.kind = 'policy_set' AND g.status IN ('pending', 'active')
       ) f
       WHERE NOT EXISTS (SELECT 1 FROM security_events e WHERE e.kind = 'drift' AND e.app_id = f.app_id
                           AND json_extract(e.detail_json, '$.what') = 'shared_wallet_policy' AND json_extract(e.detail_json, '$.source') = f.source
                           AND CASE WHEN f.source = 'change' THEN json_extract(e.detail_json, '$.changeId') = f.value
                                    ELSE json_extract(e.detail_json, '$.settingsVersion') = f.settings_version END)
       ORDER BY f.app_id, f.source, f.value
       LIMIT ?1`,
    )
    .bind(DRIFT_BATCH)
    .all<SharedWalletFinding>();
  // A scope whose latest mark in the ledger isn't in its column (or whose row is gone): the mark was undone by hand.
  const { results: unmarked } = await db
    .prepare(
      `SELECT m.scope_id, m.org_id, m.seq, s.scope_id IS NOT NULL AS has_row FROM app_changes m LEFT JOIN scopes s ON s.scope_id = m.scope_id
        WHERE m.kind = 'scope.app_user_ids' AND m.scope_id IS NOT NULL
          AND m.seq = (SELECT MAX(x.seq) FROM app_changes x WHERE x.kind = 'scope.app_user_ids' AND x.scope_id = m.scope_id)
          AND COALESCE(s.app_user_ids, 0) <> 1
          AND NOT EXISTS (SELECT 1 FROM security_events e WHERE e.kind = 'drift' AND e.scope_id = m.scope_id
                            AND json_extract(e.detail_json, '$.what') = 'shared_scope_unmarked' AND json_extract(e.detail_json, '$.markSeq') = m.seq)
        ORDER BY m.scope_id LIMIT ?1`,
    )
    .bind(DRIFT_BATCH)
    .all<{ scope_id: string; org_id: string; seq: number; has_row: number }>();

  const events: D1PreparedStatement[] = [];
  const insert = 'INSERT OR IGNORE INTO security_events (id, detected_at, kind, org_id, app_id, scope_id, detail_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)';
  for (const f of origins) {
    const detail = { what: 'origin', origin: f.origin, activeFrom: f.active_from, changeId: f.change_id };
    events.push(db.prepare(insert).bind(await eventId('drift', f.app_id, 'origin', f.origin, String(f.active_from)), now, 'drift', f.org_id, f.app_id, f.scope_id, JSON.stringify(detail)));
  }
  for (const f of settings) {
    // A policy's id (when it validates) names it in the email; its text (the partner's own config) stays in D1.
    const policyId = f.value === null ? null : ((await storedPolicy(f.value))?.id ?? 'invalid');
    const detail = { what: f.what, ...(policyId === null ? {} : { policyId }) };
    events.push(db.prepare(insert).bind(await eventId('drift', f.app_id, f.what, f.value ?? ''), now, 'drift', f.org_id, f.app_id, f.scope_id, JSON.stringify(detail)));
  }
  for (const f of shared) {
    const policyId = f.source === 'change' ? undefined : ((await storedPolicy(f.value))?.id ?? 'invalid');
    const detail = { what: 'shared_wallet_policy', source: f.source, ...(f.source === 'change' ? { changeId: f.value } : { policyId, settingsVersion: f.settings_version }) };
    const key = f.source === 'change' ? f.value : String(f.settings_version);
    events.push(db.prepare(insert).bind(await eventId('drift', f.app_id, 'shared_wallet_policy', f.source, key), now, 'drift', f.org_id, f.app_id, f.scope_id, JSON.stringify(detail)));
  }
  for (const u of unmarked) {
    const detail = { what: 'shared_scope_unmarked', markSeq: u.seq, scopeRow: u.has_row ? 'present' : 'missing' };
    events.push(db.prepare(insert).bind(await eventId('drift', 'scope', u.scope_id, 'shared_scope_unmarked', String(u.seq)), now, 'drift', u.org_id, null, u.scope_id, JSON.stringify(detail)));
  }
  let recorded = 0;
  if (events.length) {
    const results = await db.batch(events);
    recorded = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  }
  const run = { found: events.length, recorded };
  if (recorded) log({ event: 'drift_detection', outcome: 'ok', added: recorded });
  return run;
}
