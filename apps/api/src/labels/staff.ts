// Partner labels for Journear staff through AdminRpc (D894): the feed of label changes (every one waiting, for its
// whole wait, and those decided lately), one change in detail, the two staff tools on a change ("Block this change"
// and, while review is required, "Allow"), and the switches (an entry's, an org's or every partner label's off and
// back on; review required for an org or for everyone). Nothing here can make a label take effect sooner, and nothing
// here can put a version in force that didn't go through the guarded path: Allow only lifts the review hold once the
// version's own time has come; "back on" only serves versions already in force. Every tool is one batch, applied only
// while the state is what the staff page showed (`seen`); every one is recorded (`app_changes` for an org's and an
// entry's, `label_control_log` for every switch), and the admin Worker writes the staff audit row first.
import type { LabelControlAction, LabelControlTarget, LabelControls, LabelFeedItem, LabelState } from '@hana-id/console-core';
import { type Writer, actorId, commitOn, committed, expectReplay, refuse, refuseReplay, replayRow, runWrite } from '../changes/cas.ts';
import type { HotDb } from '../changes/db.ts';
import { type Q, q } from '../changes/sql.ts';
import { previewAndDiff } from './lifecycle.ts';
import { IN_FORCE } from './sql.ts';
import { type LabelRow, VIEW_FROM, VIEW_SELECT, labelEvent, labelView, stateOf } from './store.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** At most this many changes in the feed (waiting first, then the newest decided). */
export const LABEL_QUEUE_MAX = 200;

type Row = LabelRow & { previous_text: string | null };

const itemOf = (r: Row, now: number): LabelFeedItem => ({ change: labelView(r, now, true), labelsVersion: r.labels_version, entryVersion: r.off_version, ...previewAndDiff(r, r.previous_text) });

const WAITING_STATES: ReadonlySet<LabelState> = new Set(['proposed', 'announced', 'waiting_review']);

/** AdminRpc.labelQueue: every version still waiting (any age), then those proposed or decided in the last `days`. */
export async function labelQueue(db: HotDb, days: number, now: number): Promise<{ items: LabelFeedItem[]; controls: LabelControls }> {
  const since = now - days * DAY_MS;
  const rows = await db.all<Row>(
    q`SELECT ${VIEW_SELECT(now)}, (SELECT p.doc_text FROM label_changes p WHERE p.id = c.previous_id) AS previous_text
        FROM ${VIEW_FROM}
       WHERE c.status = 'pending' OR c.proposed_at > ${since} OR c.blocked_at > ${since} OR c.cancelled_at > ${since} OR c.ended_at > ${since} OR c.activated_recorded_at > ${since}
       ORDER BY (c.status = 'pending') DESC, c.proposed_at DESC, c.id LIMIT ${LABEL_QUEUE_MAX}`,
  );
  const items = rows.map((r) => itemOf(r, now));
  // Waiting first (soonest live first), then the rest newest first.
  items.sort((a, b) => Number(WAITING_STATES.has(b.change.state)) - Number(WAITING_STATES.has(a.change.state)) || (WAITING_STATES.has(a.change.state) ? (a.change.activeFrom ?? Infinity) - (b.change.activeFrom ?? Infinity) : b.change.proposedAt - a.change.proposedAt));
  return { items, controls: await labelControls(db) };
}

/** AdminRpc.labelDetail: one version, with its preview and its diff. */
export async function labelDetail(db: HotDb, changeId: string, now: number): Promise<LabelFeedItem> {
  const r = await db.first<Row>(q`SELECT ${VIEW_SELECT(now)}, (SELECT p.doc_text FROM label_changes p WHERE p.id = c.previous_id) AS previous_text FROM ${VIEW_FROM} WHERE c.id = ${changeId}`);
  if (!r) return refuse('not_found', 'No such change');
  return itemOf(r, now);
}

/** The switches as they are now (the staff page and the System status page's indicator). */
export async function labelControls(db: HotDb): Promise<LabelControls> {
  const r = await db.first<{ controls: string; entries: string }>(
    q`SELECT (SELECT json_group_array(json_object('target', target, 'labelsOff', labels_off, 'reviewRequired', review_required, 'version', version, 'updatedAt', updated_at, 'updatedBy', updated_by, 'note', note)) FROM label_controls) AS controls,
             (SELECT json_group_array(json_object('labelId', id, 'orgId', org_id, 'scopeId', scope_id, 'offAt', off_at, 'offBy', off_by, 'note', off_note, 'version', off_version)) FROM (SELECT * FROM partner_labels WHERE off_at IS NOT NULL AND removed_at IS NULL ORDER BY off_at DESC LIMIT 100)) AS entries`,
  );
  const controls = JSON.parse(r?.controls ?? '[]') as { target: string; labelsOff: number; reviewRequired: number; version: number; updatedAt: number; updatedBy: string; note: string | null }[];
  const all = controls.find((c) => c.target === '*');
  return {
    all: { labelsOff: !!all?.labelsOff, reviewRequired: !!all?.reviewRequired, version: all?.version ?? 0, updatedAt: all?.updatedAt ?? null, updatedBy: all?.updatedBy ?? null, note: all?.note ?? null },
    orgs: controls.filter((c) => c.target !== '*').map((c) => ({ orgId: c.target, labelsOff: !!c.labelsOff, reviewRequired: !!c.reviewRequired, version: c.version, updatedAt: c.updatedAt, updatedBy: c.updatedBy, note: c.note })),
    entries: JSON.parse(r?.entries ?? '[]') as LabelControls['entries'],
  };
}

/** The version a staff tool acts on, as the page saw it (or `version_conflict`). */
async function planAct(db: HotDb, w: Writer, changeId: string, seen: { labelsVersion: number; state: string }): Promise<Row & { replay: string | null }> {
  const r = await db.first<Row & { replay: string | null }>(
    q`SELECT ${replayRow(w.requestId)} AS replay, ${VIEW_SELECT(w.now)}, NULL AS previous_text FROM (SELECT 1) LEFT JOIN (${VIEW_FROM}) ON c.id = ${changeId}`,
  );
  refuseReplay(r?.replay, w);
  if (!r || r.id === null) return refuse('not_found', 'No such change');
  if (r.labels_version !== seen.labelsVersion || stateOf(r, w.now) !== seen.state) refuse('version_conflict', 'This change moved since the page was read: read it again');
  return r;
}

const staffId = (w: Writer): string => (w.actor.kind === 'hana' ? w.actor.email : actorId(w.actor));

/**
 * AdminRpc.labelStaffAct `block`: the version never takes effect, or (in force) stops being served at once; any older
 * version of the entry still in force ends with it, so a block never brings back an earlier document. The partner's
 * security contacts are told (the admin Worker's feed mails `labels.blocked` on its own). `allow`: lifts the review
 * hold of a version review holds or will hold; its own time still applies.
 */
export async function labelStaffAct(db: HotDb, w: Writer, i: { changeId: string; tool: 'block' | 'allow'; note: string; seen: { labelsVersion: number; state: string } }): Promise<{ change: LabelFeedItem['change'] }> {
  expectReplay(w, [i.tool === 'block' ? 'labels.blocked' : 'labels.allowed']);
  const r = await planAct(db, w, i.changeId, i.seen);
  const state = stateOf(r, w.now);
  const ids = { orgId: r.org_id, scopeId: r.scope_id };
  const version = q`EXISTS (SELECT 1 FROM scopes WHERE scope_id = ${r.scope_id} AND labels_version = ${i.seen.labelsVersion})`;
  const by = staffId(w);
  const note = i.note.trim();
  let stmts: Q[];
  if (i.tool === 'block') {
    if (!['proposed', 'announced', 'waiting_review', 'in_force'].includes(state)) refuse('not_pending', `The change is ${state.replace('_', ' ')}: there is nothing to block`);
    const wasLive = state === 'in_force';
    stmts = [
      commitOn(w, { kind: 'labels.blocked', detail: { changeId: r.id, labelId: r.label_id, wasLive, note } }, ids, q`${version} AND EXISTS (SELECT 1 FROM label_changes WHERE id = ${r.id} AND status IN ('pending', 'active'))`),
      q`UPDATE scopes SET labels_version = labels_version + 1 WHERE scope_id = ${r.scope_id} AND ${committed(w.requestId)}`,
      q`UPDATE label_changes SET status = 'blocked', blocked_at = ${w.now}, blocked_by = ${by}, block_note = ${note}, was_live = ${wasLive ? 1 : 0} WHERE id = ${r.id} AND status IN ('pending', 'active') AND ${committed(w.requestId)}`,
      await labelEvent(w, 'label_blocked', { id: r.id, labelId: r.label_id, orgId: r.org_id, scopeId: r.scope_id }, { wasLive }),
    ];
    if (wasLive) {
      stmts.push(
        q`UPDATE label_changes SET status = 'ended', end_reason = 'replaced', ended_at = ${w.now}
           WHERE label_id = ${r.label_id} AND id != ${r.id} AND ${IN_FORCE('label_changes', w.now)} AND ${committed(w.requestId)}`,
      );
    }
  } else {
    if (!['proposed', 'announced', 'waiting_review'].includes(state)) refuse('not_pending', `The change is ${state.replace('_', ' ')}: there is nothing to allow`);
    if (!r.review_required) refuse('conflict', 'Review isn’t switched on for this organisation: the change takes effect at its time without an Allow');
    if (r.allowed_at !== null) refuse('conflict', 'This change was already allowed');
    stmts = [
      commitOn(w, { kind: 'labels.allowed', detail: { changeId: r.id, labelId: r.label_id, note } }, ids, q`${version} AND EXISTS (SELECT 1 FROM label_changes WHERE id = ${r.id} AND status = 'pending' AND allowed_at IS NULL)`),
      q`UPDATE scopes SET labels_version = labels_version + 1 WHERE scope_id = ${r.scope_id} AND ${committed(w.requestId)}`,
      q`UPDATE label_changes SET allowed_at = ${w.now}, allowed_by = ${by}, allow_note = ${note} WHERE id = ${r.id} AND status = 'pending' AND allowed_at IS NULL AND ${committed(w.requestId)}`,
    ];
  }
  await runWrite(db, w, stmts);
  return { change: (await labelDetail(db, r.id, w.now)).change };
}

const KIND_OF: Readonly<Record<LabelControlAction, 'labels.switched_off' | 'labels.switched_on' | 'labels.review_on' | 'labels.review_off'>> = {
  off: 'labels.switched_off',
  on: 'labels.switched_on',
  review_on: 'labels.review_on',
  review_off: 'labels.review_off',
};

/**
 * AdminRpc.labelControl: a switch, applied only while its version is the page's. `off` and `on` for one entry, one org
 * or everyone; `review_on` and `review_off` for one org or everyone. Recorded in `label_control_log` (the commit point
 * here: its unique request id makes a repeated call a refusal, never a second write) and, for an org's or an entry's,
 * in the org's `app_changes`. A switch already as asked writes nothing.
 */
export async function labelControl(db: HotDb, w: Writer, i: { target: LabelControlTarget; what: LabelControlAction; note: string; seenVersion: number }): Promise<{ version: number; changed: boolean }> {
  const note = i.note.trim();
  const by = staffId(w);
  const logged = q`EXISTS (SELECT 1 FROM label_control_log WHERE request_id = ${w.requestId})`;
  const replay = q`(SELECT seq FROM label_control_log WHERE request_id = ${w.requestId})`;
  if (i.target.kind === 'entry') {
    if (i.what !== 'off' && i.what !== 'on') return refuse('bad_request', 'Review is set for an organisation or for everyone');
    const e = await db.first<{ replay: number | null; id: string | null; org_id: string; scope_id: string; off_at: number | null; off_version: number; removed_at: number | null }>(
      q`SELECT ${replay} AS replay, l.id, l.org_id, l.scope_id, l.off_at, l.off_version, l.removed_at FROM (SELECT 1) LEFT JOIN partner_labels l ON l.id = ${i.target.labelId}`,
    );
    if (e?.replay != null) refuse('already_applied', `Request already applied (label_control_log seq ${e.replay})`);
    if (!e || e.id === null) return refuse('not_found', 'No such request labels');
    if (e.removed_at !== null) refuse('not_found', 'These request labels were removed');
    if (e.off_version !== i.seenVersion) refuse('version_conflict', 'This switch moved since the page was read: read it again');
    const off = i.what === 'off';
    if ((e.off_at !== null) === off) return { version: e.off_version, changed: false };
    const pred = q`(SELECT off_version FROM partner_labels WHERE id = ${e.id}) = ${i.seenVersion}`;
    await runControl(db, w, [
      q`INSERT INTO label_control_log (at, target, labels_off, review_required, actor_id, note, request_id) SELECT ${w.now}, ${e.id}, ${off ? 1 : 0}, 0, ${by}, ${note}, ${w.requestId} WHERE ${pred}`,
      q`UPDATE partner_labels SET off_at = ${off ? w.now : null}, off_by = ${off ? by : null}, off_note = ${off ? note : null}, off_version = off_version + 1 WHERE id = ${e.id} AND ${logged}`,
      appChangeRow(w, KIND_OF[i.what], { orgId: e.org_id, scopeId: e.scope_id }, { target: 'entry', labelId: e.id, note }, logged),
    ]);
    return { version: e.off_version + 1, changed: true };
  }
  const target = i.target.kind === 'all' ? '*' : i.target.orgId;
  const c = await db.first<{ replay: number | null; labels_off: number | null; review_required: number | null; version: number | null }>(
    q`SELECT ${replay} AS replay, k.labels_off, k.review_required, k.version FROM (SELECT 1) LEFT JOIN label_controls k ON k.target = ${target}`,
  );
  if (c?.replay != null) refuse('already_applied', `Request already applied (label_control_log seq ${c.replay})`);
  const version = c?.version ?? 0;
  if (version !== i.seenVersion) refuse('version_conflict', 'This switch moved since the page was read: read it again');
  let off = !!c?.labels_off;
  let review = !!c?.review_required;
  const before = `${off}${review}`;
  if (i.what === 'off') off = true;
  else if (i.what === 'on') off = false;
  else review = i.what === 'review_on';
  if (`${off}${review}` === before) return { version, changed: false };
  const pred = q`COALESCE((SELECT version FROM label_controls WHERE target = ${target}), 0) = ${i.seenVersion}`;
  const stmts: Q[] = [
    q`INSERT INTO label_control_log (at, target, labels_off, review_required, actor_id, note, request_id) SELECT ${w.now}, ${target}, ${off ? 1 : 0}, ${review ? 1 : 0}, ${by}, ${note}, ${w.requestId} WHERE ${pred}`,
    q`INSERT INTO label_controls (target, labels_off, review_required, updated_at, updated_by, note, version) SELECT ${target}, ${off ? 1 : 0}, ${review ? 1 : 0}, ${w.now}, ${by}, ${note}, 1 WHERE ${logged}
      ON CONFLICT (target) DO UPDATE SET labels_off = excluded.labels_off, review_required = excluded.review_required, updated_at = excluded.updated_at, updated_by = excluded.updated_by, note = excluded.note, version = label_controls.version + 1`,
  ];
  if (i.target.kind === 'org') stmts.push(appChangeRow(w, KIND_OF[i.what], { orgId: i.target.orgId }, { target: 'org', note }, logged));
  await runControl(db, w, stmts);
  return { version: version + 1, changed: true };
}

/** An org's `app_changes` row for a switch, written only if the switch's log row was. */
const appChangeRow = (w: Writer, kind: (typeof KIND_OF)[LabelControlAction], ids: { orgId: string; scopeId?: string }, detail: Record<string, unknown>, logged: Q): Q =>
  commitOn({ ...w, requestId: `${w.requestId}:org` }, { kind, detail }, ids, logged);

/** A switch's batch: the log row is its commit point (no row: the switch moved since the read). */
async function runControl(db: HotDb, w: Writer, stmts: Q[]): Promise<void> {
  const results = await db.batch(stmts);
  if ((results[0]?.meta.changes ?? 0) !== 1) refuse('version_conflict', 'This switch moved since the page was read: read it again');
  w.wrote = true;
}
