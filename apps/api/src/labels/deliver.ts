// What `GET /v1/app` carries of partner labels (D894): for the requesting app, the documents in force now, served only
// when no switch or block keeps them off, read from D1 on every request (no isolate cache: a switch or a block is in the
// very next read), only with the manifest switch on. The vault uses a label only while a read under its freshness
// window confirms it (piece 3); it re-hashes and re-parses each document with its own parser and drops one it can't
// read (packages/web src/vault/partner-labels.ts). Nothing proposed, announced, held for review, blocked or removed is
// ever sent, and nothing of another org: the entry's org and scope must be the app's own, now.
import { LABEL_STORE_LIMITS } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { type Q, prepare, q, raw } from '../changes/sql.ts';
import { CURRENT, labelsOn } from './sql.ts';

/** One document as `GET /v1/app` sends it. */
export interface DeliveredLabel {
  /** The entry (`pl_…`). */
  id: string;
  /** The version (`lc_…`). */
  changeId: string;
  /** The schema version, `journear-labels/1`: a reader that doesn't know it shows the plain view. */
  version: string;
  /** sha256 of the text's UTF-8 bytes, lowercase hex. */
  sha256: string;
  /** The partner's document, exactly as proposed. */
  text: string;
  /** When this version took effect (ms). */
  effectiveSince: number;
  /** When the version it replaced took effect, or null for a first version (piece 3's "changed on {date}" line). */
  previousEffectiveSince: number | null;
}

/** The query: the app's served documents (the entry's newest version in force, the app attached, nothing switched off). */
export function deliveryQuery(appId: string, now: number): Q {
  return q`SELECT l.id, c.id AS change_id, c.doc_schema, c.doc_sha256, c.doc_text, c.active_from, p.active_from AS previous_from
             FROM apps a JOIN partner_labels l ON l.org_id = a.org_id AND l.scope_id = a.scope_id
             JOIN label_changes c ON c.id = ${CURRENT('l', now)}
             LEFT JOIN label_changes p ON p.id = c.previous_id
            WHERE a.id = ${appId} AND a.deleted_at IS NULL AND l.removed_at IS NULL AND l.off_at IS NULL
              AND EXISTS (SELECT 1 FROM json_each(c.apps_json) j WHERE j.value = a.id)
              AND NOT EXISTS (SELECT 1 FROM label_controls k WHERE k.target IN ('*', l.org_id) AND k.labels_off = 1)
            ORDER BY l.id ${raw(`LIMIT ${LABEL_STORE_LIMITS.entriesPerOrg}`)}`;
}

/**
 * The app's documents, or undefined with the switch off (the field is then left out of the answer, as before D894). A
 * failed read is undefined too, logged: no labels is always the safe answer, and the rest of the config still answers.
 */
export async function deliveredLabels(env: Pick<Env, 'DB' | 'PARTNER_LABELS'>, appId: string, now: number): Promise<DeliveredLabel[] | undefined> {
  if (!labelsOn(env)) return undefined;
  try {
    const { results } = await prepare(env.DB, deliveryQuery(appId, now)).all<{ id: string; change_id: string; doc_schema: string; doc_sha256: string; doc_text: string; active_from: number; previous_from: number | null }>();
    return results.map((r) => ({ id: r.id, changeId: r.change_id, version: r.doc_schema, sha256: r.doc_sha256, text: r.doc_text, effectiveSince: r.active_from, previousEffectiveSince: r.previous_from }));
  } catch {
    log({ event: 'partner_labels_unavailable', appId }, 'warn');
    return undefined;
  }
}
