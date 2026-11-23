// A label version's life after its proposal (D894), the guarded changes' rules (changes/lifecycle.ts) for a version of
// its own table: the admin Worker's blocking notice (labelNotices → send → ackLabelNotice, which starts the clock), the
// cancel by an owner, by staff or by the emailed link (ConsoleRpc.cancelChange / cancelChangeByLink take an `lc_` id
// too). No waiver ever: a label version always waits the full `appChangeDelayMs` after its notice. Activation and the
// 7-day lapses are the hourly job's (labels/cron.ts).
import { type LabelChangeView, type LabelDiffLine, type LabelPreview, bytesEqual, fromB64url, hex, sha256 } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { type Writer, actorId, commitOn, committed, expectReplay, refuse, refuseReplay, replayRow, runWrite } from '../changes/cas.ts';
import type { HotDb } from '../changes/db.ts';
import { requireChangeConfig } from '../changes/origins.ts';
import { type Q, q } from '../changes/sql.ts';
import { diffOf, previewOf, storedDocument } from './document.ts';
import { WAITING } from './sql.ts';
import { type LabelRow, VIEW_FROM, VIEW_SELECT, labelView } from './store.ts';

/** The version's view, a waiting one's preview and its diff against the version it would replace (staff and notices). */
export interface LabelNotice {
  change: LabelChangeView;
  contacts: string[];
  preview: LabelPreview | null;
  diff: LabelDiffLine[];
}

/** The preview and the diff of a version (its stored text parsed again; a text that no longer parses has neither). */
export function previewAndDiff(r: Pick<LabelRow, 'doc_text' | 'apps_named'>, previousText: string | null): { preview: LabelPreview | null; diff: LabelDiffLine[] } {
  const doc = storedDocument(r.doc_text);
  if (!doc) return { preview: null, diff: [] };
  const apps = JSON.parse(r.apps_named) as { id: string; name: string | null }[];
  const appName = apps[0]?.name ?? apps[0]?.id ?? 'the app';
  const before = previousText === null ? null : storedDocument(previousText);
  return { preview: previewOf(doc, appName), diff: diffOf(before, doc, appName) };
}

/** AdminRpc.labelNotices: every version proposed and not yet announced (oldest first), with its org's security contacts. */
export async function labelNotices(db: HotDb, limit: number, now: number): Promise<LabelNotice[]> {
  const rows = await db.all<LabelRow & { contacts: string; previous_text: string | null }>(
    q`SELECT ${VIEW_SELECT(now)},
             (SELECT json_group_array(email) FROM (SELECT email FROM org_security_contacts WHERE org_id = c.org_id ORDER BY email)) AS contacts,
             (SELECT p.doc_text FROM label_changes p WHERE p.id = c.previous_id) AS previous_text
        FROM ${VIEW_FROM}
       WHERE c.status = 'pending' AND c.notified_at IS NULL AND l.removed_at IS NULL
       ORDER BY c.proposed_at, c.id LIMIT ${limit}`,
  );
  return rows.map((r) => ({ change: labelView(r, now), contacts: JSON.parse(r.contacts) as string[], ...previewAndDiff(r, r.previous_text) }));
}

interface ChangePlan {
  replay: string | null;
  id: string | null;
  label_id: string;
  org_id: string;
  scope_id: string;
  status: string;
  notified_at: number | null;
  waiting: number;
  removed_at: number | null;
  token_hash_hex: string | null;
}

async function planChange(db: HotDb, w: Writer, changeId: string, orgId: string | null): Promise<ChangePlan> {
  const org = orgId === null ? q`1` : q`c.org_id = ${orgId}`;
  const r = await db.first<ChangePlan>(
    q`SELECT ${replayRow(w.requestId)} AS replay, c.id, c.label_id, c.org_id, c.scope_id, c.status, c.notified_at, ${WAITING('c', w.now)} AS waiting, l.removed_at, hex(c.cancel_token_hash) AS token_hash_hex
        FROM (SELECT 1) LEFT JOIN label_changes c ON c.id = ${changeId} AND ${org} LEFT JOIN partner_labels l ON l.id = c.label_id`,
  );
  refuseReplay(r?.replay, w);
  if (!r || r.id === null) return refuse('not_found', 'No such change');
  return r;
}

/**
 * AdminRpc.ackLabelNotice: the admin Worker's notice was accepted for every recipient. In one batch: `notified_at`,
 * `active_from` (now + appChangeDelayMs, never a waiver) and the cancel link's token hash. No version bump.
 */
export async function ackLabelNotice(db: HotDb, env: Env, w: Writer, i: { changeId: string; cancelTokenHash: string }): Promise<{ change: { id: string; activeFrom: number } }> {
  expectReplay(w, ['change.announced']);
  const config = requireChangeConfig(env);
  const c = await planChange(db, w, i.changeId, null);
  if (c.removed_at !== null) refuse('not_found', 'These request labels were removed');
  if (c.status !== 'pending' || c.notified_at !== null) refuse('not_pending', c.status === 'pending' ? 'The change is already announced' : `The change is ${c.status}`);
  const hash = fromB64url(i.cancelTokenHash);
  const blob = hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength) as ArrayBuffer;
  const activeFrom = w.now + config.delayMs;
  await runWrite(db, w, [
    commitOn(
      w,
      { kind: 'change.announced', detail: { changeId: c.id, kind: 'label_set', labelId: c.label_id, activeFrom, channel: 'email' } },
      { orgId: c.org_id, scopeId: c.scope_id },
      q`EXISTS (SELECT 1 FROM label_changes g JOIN partner_labels l ON l.id = g.label_id WHERE g.id = ${c.id} AND g.status = 'pending' AND g.notified_at IS NULL AND l.removed_at IS NULL)`,
    ),
    q`UPDATE label_changes SET notified_at = ${w.now}, active_from = ${activeFrom}, cancel_token_hash = ${blob} WHERE id = ${c.id} AND status = 'pending' AND notified_at IS NULL AND ${committed(w.requestId)}`,
  ]);
  return { change: { id: c.id!, activeFrom } };
}

/** The cancel's batch; the link's actor is the change itself (`{kind: 'link', id: changeId}`, the input's). */
function cancelBatch(w: Writer, c: ChangePlan, reason: 'owner' | 'link', extra: Q): Q[] {
  return [
    commitOn(
      reason === 'link' ? ({ ...w, actor: { kind: 'link', id: c.id! }, sub: undefined } as Writer) : w,
      { kind: 'change.cancelled', detail: { changeId: c.id, kind: 'label_set', labelId: c.label_id, by: reason === 'link' ? 'link' : w.actor.kind } },
      { orgId: c.org_id, scopeId: c.scope_id },
      q`EXISTS (SELECT 1 FROM label_changes g JOIN partner_labels l ON l.id = g.label_id WHERE g.id = ${c.id} AND ${WAITING('g', w.now)} AND l.removed_at IS NULL AND ${extra})`,
    ),
    q`UPDATE scopes SET labels_version = labels_version + 1 WHERE scope_id = ${c.scope_id} AND ${committed(w.requestId)}`,
    q`UPDATE label_changes SET status = 'cancelled', end_reason = ${reason}, cancelled_at = ${w.now}, cancelled_by = ${reason === 'link' ? 'link' : actorId(w.actor)} WHERE id = ${c.id} AND status = 'pending' AND ${committed(w.requestId)}`,
  ];
}

/** ConsoleRpc.cancelChange / AdminRpc.cancelChange with an `lc_` id: any waiting version of the org's (not one in force: remove it). */
export async function cancelLabelChange(db: HotDb, w: Writer, i: { orgId: string; changeId: string }): Promise<{ change: { id: string; state: 'cancelled' } }> {
  expectReplay(w, ['change.cancelled']);
  const c = await planChange(db, w, i.changeId, i.orgId);
  if (c.removed_at !== null) refuse('not_found', 'These request labels were removed');
  if (!c.waiting) refuse('not_pending', c.status === 'pending' || c.status === 'active' ? 'The change is already in force: remove the request labels instead' : `The change is ${c.status}`);
  await runWrite(db, w, cancelBatch(w, c, 'owner', q`1`));
  return { change: { id: c.id!, state: 'cancelled' } };
}

/** ConsoleRpc.cancelChangeByLink with an `lc_` id: the emailed link's token against the stored hash, while the version waits. */
export async function cancelLabelChangeByLink(db: HotDb, w: Writer, i: { changeId: string; token: string }): Promise<{ change: { id: string; state: 'cancelled' } }> {
  expectReplay(w, ['change.cancelled'], undefined, { kind: 'link', id: i.changeId });
  const c = await planChange(db, w, i.changeId, null);
  let presented: Uint8Array;
  try {
    presented = await sha256(fromB64url(i.token));
  } catch {
    return refuse('forbidden', 'This cancel link is not valid for this change');
  }
  if (c.token_hash_hex === null || !bytesEqual(presented, hexBytes(c.token_hash_hex))) refuse('forbidden', 'This cancel link is not valid for this change');
  if (c.removed_at !== null) refuse('not_found', 'These request labels were removed');
  if (!c.waiting) refuse('not_pending', c.status === 'pending' || c.status === 'active' ? 'The change is already in force' : `The change is ${c.status}`);
  await runWrite(db, w, cancelBatch(w, c, 'link', q`hex(g.cancel_token_hash) = ${hex(presented).toUpperCase()}`));
  return { change: { id: c.id!, state: 'cancelled' } };
}

function hexBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let k = 0; k < out.length; k++) out[k] = Number.parseInt(h.slice(2 * k, 2 * k + 2), 16);
  return out;
}
