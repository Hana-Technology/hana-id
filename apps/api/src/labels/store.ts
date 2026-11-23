// Partner labels' reads (D894): a version's view (its state computed from its row, the clock and the controls), the
// plan read a proposal or a removal makes (one statement: the scope, the entry, its versions in force and waiting, the
// org's limits and the replay check), and the shared write pieces (the commit row, the security event).
import { LABEL_STORE_LIMITS, type LabelChangeView, type LabelState } from '@hana-id/console-core';
import { type Writer, committed, replayRow } from '../changes/cas.ts';
import type { HotDb } from '../changes/db.ts';
import { eventId } from '../changes/guard.ts';
import { type Q, q, raw } from '../changes/sql.ts';
import { CURRENT, IN_FORCE, LABEL_LAPSE_MS, OFF_BY, OPEN, REVIEW_HELD } from './sql.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A version's row with what its view needs (see VIEW_SELECT). */
export interface LabelRow {
  id: string;
  label_id: string;
  org_id: string;
  scope_id: string;
  environment: 'test' | 'live';
  doc_text: string;
  doc_schema: string;
  doc_sha256: string;
  doc_bytes: number;
  context_key: string;
  apps_json: string;
  apps_named: string;
  previous_id: string | null;
  status: 'pending' | 'active' | 'cancelled' | 'lapsed' | 'blocked' | 'ended';
  proposed_at: number;
  notified_at: number | null;
  active_from: number | null;
  allowed_at: number | null;
  blocked_at: number | null;
  block_note: string | null;
  cancelled_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
  in_force: number;
  is_current: number;
  held: number;
  review_required: number;
  off_by: 'entry' | 'org' | 'all' | null;
  removed_at: number | null;
  labels_version: number;
  off_version: number;
}

/** Every column a view needs, over `label_changes c JOIN partner_labels l JOIN scopes s`. */
export const VIEW_SELECT = (now: number): Q =>
  q`c.id, c.label_id, c.org_id, c.scope_id, s.environment, c.doc_text, c.doc_schema, c.doc_sha256, c.doc_bytes, c.context_key, c.apps_json,
    (SELECT json_group_array(json_object('id', j.value, 'name', (SELECT name FROM apps WHERE id = j.value))) FROM json_each(c.apps_json) j) AS apps_named,
    c.previous_id, c.status, c.proposed_at, c.notified_at, c.active_from, c.allowed_at, c.blocked_at, c.block_note, c.cancelled_at, c.ended_at, c.end_reason,
    ${IN_FORCE('c', now)} AS in_force, (c.id IS ${CURRENT('l', now)}) AS is_current, ${REVIEW_HELD('c')} AS held,
    EXISTS (SELECT 1 FROM label_controls rq WHERE rq.target IN ('*', c.org_id) AND rq.review_required = 1) AS review_required,
    ${OFF_BY('l')} AS off_by, l.removed_at, s.labels_version, l.off_version`;
export const VIEW_FROM = raw('label_changes c JOIN partner_labels l ON l.id = c.label_id JOIN scopes s ON s.scope_id = c.scope_id');

export function stateOf(r: Pick<LabelRow, 'status' | 'notified_at' | 'active_from' | 'in_force' | 'is_current' | 'end_reason'>, now: number): LabelState {
  switch (r.status) {
    case 'pending':
      if (r.notified_at === null) return 'proposed';
      if (r.in_force) return r.is_current ? 'in_force' : 'replaced';
      return r.active_from !== null && r.active_from > now ? 'announced' : 'waiting_review';
    case 'active':
      return r.is_current ? 'in_force' : 'replaced';
    case 'cancelled':
      return r.end_reason === 'removed' ? 'removed' : 'cancelled';
    case 'lapsed':
      return 'lapsed';
    case 'blocked':
      return 'blocked';
    case 'ended':
      return r.end_reason === 'removed' ? 'removed' : 'replaced';
  }
}

/**
 * A version as the console (`staff: false`) or staff read it. Staff see every note; the partner sees Journear's note on
 * a blocked version only (the note the blocked mail sends its security contacts, D899).
 */
export function labelView(r: LabelRow, now: number, staff = false): LabelChangeView {
  const state = stateOf(r, now);
  const lapsesAt = state === 'proposed' ? r.proposed_at + LABEL_LAPSE_MS : (state === 'waiting_review' || (state === 'announced' && r.held)) && r.active_from !== null ? r.active_from + LABEL_LAPSE_MS : null;
  return {
    id: r.id,
    labelId: r.label_id,
    orgId: r.org_id,
    scopeId: r.scope_id,
    environment: r.environment,
    apps: (JSON.parse(r.apps_named) as { id: string; name: string | null }[]).map((a) => ({ id: a.id, name: a.name ?? null })),
    schema: r.doc_schema,
    sha256: r.doc_sha256,
    bytes: r.doc_bytes,
    state,
    proposedAt: r.proposed_at,
    notifiedAt: r.notified_at,
    activeFrom: r.active_from,
    lapsesAt,
    reviewRequired: r.allowed_at === null && !!r.review_required && (state === 'proposed' || state === 'announced' || state === 'waiting_review'),
    allowedAt: r.allowed_at,
    blockedAt: r.blocked_at,
    ...(staff || state === 'blocked' ? { blockNote: r.block_note } : {}),
    endedAt: r.ended_at ?? r.cancelled_at,
    endReason: r.end_reason,
    previousId: r.previous_id,
    off: r.off_by,
    served: state === 'in_force' && r.removed_at === null && r.off_by === null,
  };
}

/** The plan read of a proposal, a preview or a removal: one statement. */
export interface LabelPlan {
  replay: string | null;
  scope_id: string | null;
  environment: 'test' | 'live' | null;
  labels_version: number | null;
  /** JSON [{id, name}] of the scope's live apps in the org. */
  apps: string | null;
  label_id: string | null;
  removed_at: number | null;
  off_at: number | null;
  cur_id: string | null;
  cur_sha: string | null;
  cur_apps: string | null;
  cur_text: string | null;
  open_id: string | null;
  org_entries: number;
  org_bytes: number;
  /** JSON {appId: bytes} of the other entries' versions attached to each requested app. */
  app_bytes: string;
  day_proposals: number;
  same_context: number;
  /** Which staff switch has the org's labels off ('org', 'all'), or null. */
  org_off: 'org' | 'all' | null;
  /** Journear reviews this org's changes before they go live (its switch or everyone's): what the preview tells the console. */
  review_required: number;
}

export async function planLabels(db: HotDb, w: Writer, i: { orgId: string; scopeId: string; labelId: string | null; appIds: readonly string[]; contextKey: string | null }): Promise<LabelPlan> {
  const now = w.now;
  const other = q`c.label_id IS NOT ${i.labelId}`;
  const live = raw(`c.status IN ('pending', 'active') AND pl.removed_at IS NULL`);
  const r = await db.first<LabelPlan>(
    q`SELECT ${replayRow(w.requestId)} AS replay, s.scope_id, s.environment, s.labels_version,
             (SELECT json_group_array(json_object('id', a.id, 'name', a.name)) FROM apps a WHERE a.scope_id = s.scope_id AND a.org_id = s.org_id AND a.deleted_at IS NULL) AS apps,
             l.id AS label_id, l.removed_at, l.off_at,
             cur.id AS cur_id, cur.doc_sha256 AS cur_sha, cur.apps_json AS cur_apps, cur.doc_text AS cur_text,
             ${OPEN('l', now)} AS open_id,
             (SELECT COUNT(*) FROM partner_labels pl WHERE pl.org_id = ${i.orgId} AND pl.removed_at IS NULL) AS org_entries,
             (SELECT COALESCE(SUM(c.doc_bytes), 0) FROM label_changes c JOIN partner_labels pl ON pl.id = c.label_id WHERE c.org_id = ${i.orgId} AND ${live} AND ${other}) AS org_bytes,
             (SELECT json_group_object(j.value, (SELECT COALESCE(SUM(c.doc_bytes), 0) FROM label_changes c JOIN partner_labels pl ON pl.id = c.label_id
                                                  WHERE c.org_id = ${i.orgId} AND ${live} AND ${other} AND EXISTS (SELECT 1 FROM json_each(c.apps_json) k WHERE k.value = j.value)))
                FROM json_each(${JSON.stringify(i.appIds)}) j) AS app_bytes,
             (SELECT COUNT(*) FROM label_changes c WHERE c.org_id = ${i.orgId} AND c.proposed_at > ${now - DAY_MS}) AS day_proposals,
             (SELECT COUNT(*) FROM label_changes c JOIN partner_labels pl ON pl.id = c.label_id WHERE pl.scope_id = ${i.scopeId} AND pl.org_id = ${i.orgId} AND ${live} AND ${other} AND c.context_key = ${i.contextKey ?? ''}) AS same_context
             , (CASE WHEN EXISTS (SELECT 1 FROM label_controls k WHERE k.target = ${i.orgId} AND k.labels_off = 1) THEN 'org'
                     WHEN EXISTS (SELECT 1 FROM label_controls k WHERE k.target = '*' AND k.labels_off = 1) THEN 'all' END) AS org_off
             , ${REVIEW_ON(i.orgId)} AS review_required
        FROM (SELECT 1) LEFT JOIN scopes s ON s.scope_id = ${i.scopeId} AND s.org_id = ${i.orgId}
        LEFT JOIN partner_labels l ON l.id = ${i.labelId} AND l.org_id = s.org_id AND l.scope_id = s.scope_id
        LEFT JOIN label_changes cur ON cur.id = ${CURRENT('l', now)}`,
  );
  return r!;
}

/** Review is required for the org's changes: its own switch or everyone's. */
export const REVIEW_ON = (orgId: string): Q => q`EXISTS (SELECT 1 FROM label_controls rv WHERE rv.target IN ('*', ${orgId}) AND rv.review_required = 1)`;

/** The limits a proposal must fit (LABEL_STORE_LIMITS): the first one it doesn't, in words, or null. */
export function limitProblem(p: LabelPlan, i: { newEntry: boolean; bytes: number; appIds: readonly string[] }): string | null {
  const L = LABEL_STORE_LIMITS;
  if (i.newEntry && p.org_entries + 1 > L.entriesPerOrg) return `An organisation has at most ${L.entriesPerOrg} sets of request labels: remove one first`;
  if (p.org_bytes + i.bytes > L.orgBytes) return `An organisation's request labels are at most ${L.orgBytes / 1024} KiB together, in force or waiting: remove or shorten one first`;
  const per = JSON.parse(p.app_bytes) as Record<string, number>;
  for (const app of i.appIds) if ((per[app] ?? 0) + i.bytes > L.appBytes) return `The request labels attached to ${app} would be over ${L.appBytes / 1024} KiB together: attach this to fewer apps, or shorten it`;
  if (p.day_proposals + 1 > L.proposalsPerDay) return `An organisation proposes at most ${L.proposalsPerDay} label changes in 24 hours: try again later`;
  return null;
}

/** What a document describes, as one key: two live entries of a scope never describe the same contract. */
export function contextKey(c: { chain: 'near'; network: string; account: string } | { chain: 'soroban'; networkPassphrase: string; contract: string } | { chain: 'stellar'; networkPassphrase: string }): string {
  return c.chain === 'near' ? `near:${c.network}:${c.account}` : c.chain === 'soroban' ? `soroban:${c.networkPassphrase}:${c.contract}` : `stellar:${c.networkPassphrase}`;
}

/**
 * A security event about a version (`label_proposed`, `label_blocked`, `label_live`), once per version and kind (its id
 * derives from both), only if this write committed. No document text: the version, the entry and what happened.
 */
export async function labelEvent(w: Writer, kind: 'label_proposed' | 'label_blocked' | 'label_live', c: { id: string; labelId: string; orgId: string; scopeId: string }, detail: Record<string, unknown>): Promise<Q> {
  const id = await eventId(kind, c.id);
  return q`INSERT OR IGNORE INTO security_events (id, detected_at, kind, org_id, scope_id, detail_json)
           SELECT ${id}, ${w.now}, ${kind}, ${c.orgId}, ${c.scopeId}, ${JSON.stringify({ changeId: c.id, labelId: c.labelId, ...detail })} WHERE ${committed(w.requestId)}`;
}
