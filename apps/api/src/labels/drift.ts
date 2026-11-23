// Partner labels' drift detection (D894), in the hourly job beside changes/drift.ts: what `GET /v1/app` would serve, and
// every staff decision, must be explained by the append-only ledgers (`app_changes`, `label_control_log`). A mismatch
// is a direct D1 write that skipped the guarded path (manual SQL, a buggy script): one `drift` security event per
// finding (its id derives from the finding), which the admin feed emails, exactly as for origins and policies. Like
// that check, it can't catch someone who also forges the ledger rows (a D1 compromise: the same residual as today).
//
// Findings (`detail.finding`):
//   unannounced   a version in force with no `labels.proposed` row of this exact text and apps, or no announcement whose
//                 time is no later than the version's (`change.announced`): it skipped the notice or the delay;
//   text_changed  a version in force whose text no longer hashes to the sha256 it was proposed with;
//   not_allowed   a version marked allowed with no staff `labels.allowed` row;
//   unblocked     a version staff blocked (`labels.blocked`) that is no longer blocked;
//   not_removed   an entry an owner removed (`labels.removed`) that is back;
//   control       a switch (every org's, an org's, an entry's) that isn't what its last `label_control_log` row set.
import type { Env } from '../env.ts';
import { eventId } from '../changes/guard.ts';
import { DRIFT_BATCH } from '../changes/drift.ts';
import { log } from '../log.ts';
import { sha256Hex } from '../owner-actions.ts';
import { IN_FORCE } from './sql.ts';

/** At most this many versions in force are hashed per run (the newest first). */
export const LABEL_HASH_BATCH = 500;

interface Finding {
  finding: 'unannounced' | 'text_changed' | 'not_allowed' | 'unblocked' | 'not_removed' | 'control';
  org_id: string | null;
  scope_id: string | null;
  change_id: string | null;
  label_id: string | null;
  target: string | null;
}

const ledger = (kind: string, extra = '') =>
  `EXISTS (SELECT 1 FROM app_changes a WHERE a.kind = '${kind}' AND a.org_id = c.org_id AND json_extract(a.detail_json, '$.changeId') = c.id ${extra})`;

export async function detectLabelDrift(env: Pick<Env, 'DB'>, now = Date.now()): Promise<{ found: number; recorded: number }> {
  const db = env.DB;
  const f = IN_FORCE('c', now);
  const inForce = f.sql.replaceAll('?', String(Number(now)));
  // D1 caps a compound SELECT's terms: each finding is its own statement, in one batch of reads.
  const queries = [
    `SELECT 'unannounced' AS finding, c.org_id, c.scope_id, c.id AS change_id, c.label_id, NULL AS target FROM label_changes c
        WHERE ${inForce}
          AND (NOT ${ledger('labels.proposed', "AND json_extract(a.detail_json, '$.sha256') = c.doc_sha256 AND json_extract(a.detail_json, '$.apps') = c.apps_json")}
               OR c.notified_at IS NULL OR c.active_from IS NULL
               OR NOT ${ledger('change.announced', "AND json_extract(a.detail_json, '$.kind') = 'label_set' AND json_extract(a.detail_json, '$.activeFrom') <= c.active_from")}) LIMIT ?1`,
    `SELECT 'not_allowed' AS finding, c.org_id, c.scope_id, c.id AS change_id, c.label_id, NULL AS target FROM label_changes c
        WHERE c.allowed_at IS NOT NULL AND c.status IN ('pending', 'active') AND NOT ${ledger('labels.allowed')} LIMIT ?1`,
    `SELECT 'unblocked' AS finding, c.org_id, c.scope_id, c.id AS change_id, c.label_id, NULL AS target FROM label_changes c
        WHERE c.status != 'blocked' AND ${ledger('labels.blocked')} LIMIT ?1`,
    `SELECT 'not_removed' AS finding, l.org_id, l.scope_id, NULL AS change_id, l.id AS label_id, NULL AS target FROM partner_labels l
        WHERE l.removed_at IS NULL AND EXISTS (SELECT 1 FROM app_changes a WHERE a.kind = 'labels.removed' AND a.org_id = l.org_id AND json_extract(a.detail_json, '$.labelId') = l.id) LIMIT ?1`,
    `SELECT 'control' AS finding, CASE WHEN g.target = '*' THEN NULL ELSE g.target END AS org_id, NULL AS scope_id, NULL AS change_id, NULL AS label_id, g.target AS target FROM label_control_log g
        WHERE g.seq = (SELECT MAX(seq) FROM label_control_log x WHERE x.target = g.target) AND g.target NOT GLOB 'pl_*'
          AND (g.labels_off != COALESCE((SELECT k.labels_off FROM label_controls k WHERE k.target = g.target), 0)
               OR g.review_required != COALESCE((SELECT k.review_required FROM label_controls k WHERE k.target = g.target), 0)) LIMIT ?1`,
    `SELECT 'control' AS finding, l.org_id, l.scope_id, NULL AS change_id, l.id AS label_id, l.id AS target FROM partner_labels l
        WHERE l.removed_at IS NULL
          AND COALESCE((SELECT g.labels_off FROM label_control_log g WHERE g.target = l.id ORDER BY g.seq DESC LIMIT 1), 0) != (l.off_at IS NOT NULL) LIMIT ?1`,
    `SELECT 'control' AS finding, CASE WHEN k.target = '*' THEN NULL ELSE k.target END AS org_id, NULL AS scope_id, NULL AS change_id, NULL AS label_id, k.target AS target FROM label_controls k
        WHERE (k.labels_off = 1 OR k.review_required = 1) AND NOT EXISTS (SELECT 1 FROM label_control_log x WHERE x.target = k.target) LIMIT ?1`,
  ];
  const answers = await db.batch(queries.map((sql) => db.prepare(sql).bind(DRIFT_BATCH)));
  const results = answers.flatMap((a) => a.results as unknown as Finding[]).slice(0, DRIFT_BATCH);
  const findings: Finding[] = [...results];
  // The text of each version in force, hashed again (SQL can't): a version edited in place is drift.
  const { results: served } = await db
    .prepare(`SELECT c.id, c.org_id, c.scope_id, c.label_id, c.doc_text, c.doc_sha256 FROM label_changes c WHERE ${inForce} ORDER BY c.active_from DESC, c.id LIMIT ?1`)
    .bind(LABEL_HASH_BATCH)
    .all<{ id: string; org_id: string; scope_id: string; label_id: string; doc_text: string; doc_sha256: string }>();
  for (const s of served) {
    if (findings.length >= 2 * DRIFT_BATCH) break;
    if ((await sha256Hex(s.doc_text)) !== s.doc_sha256) findings.push({ finding: 'text_changed', org_id: s.org_id, scope_id: s.scope_id, change_id: s.id, label_id: s.label_id, target: null });
  }
  const insert = 'INSERT OR IGNORE INTO security_events (id, detected_at, kind, org_id, scope_id, detail_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)';
  const events: D1PreparedStatement[] = [];
  for (const x of findings) {
    const detail = { what: 'partner_label', finding: x.finding, ...(x.change_id ? { changeId: x.change_id } : {}), ...(x.label_id ? { labelId: x.label_id } : {}), ...(x.target ? { target: x.target } : {}) };
    events.push(db.prepare(insert).bind(await eventId('drift', 'label', x.finding, x.change_id ?? '', x.label_id ?? '', x.target ?? ''), now, 'drift', x.org_id, x.scope_id, JSON.stringify(detail)));
  }
  let recorded = 0;
  if (events.length) recorded = (await db.batch(events)).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  if (recorded) log({ event: 'label_drift_detection', outcome: 'ok', added: recorded });
  return { found: events.length, recorded };
}
