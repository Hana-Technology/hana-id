// Partner labels through ConsoleRpc (D894): a scope's entries, the preview (every check, no write), a member's proposal
// and a member's removal. Who may: exactly who may propose an origin or a policy today, an on-chain `Owner::Oidc` of
// the scope, proven by a Google step-up the API verifies itself (changes/step-up.ts) whose nonce is the label-change
// layout over this exact change (console-core `labelChangeDigest`: the scope, the entry, the document's sha256, the
// attached apps and the scope's `labels_version`). A proposal is a guarded change: in force only once the admin
// Worker's notice is accepted and `appChangeDelayMs` later (labels/lifecycle.ts), and staff may block it meanwhile
// (labels/staff.ts). A removal is immediate.
import { LABEL_RECENT_MS, LABEL_RECENT_PER_ENTRY, LABEL_STORE_LIMITS, type LabelChangeView, type LabelEntryView, type LabelListAnswer, type LabelPreview, type LabelPreviewAnswer, labelChangeDigest, newId, nonceOf } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { expectVersion } from '../changes/apps.ts';
import { type Writer, actorId, commitOn, committed, expectReplay, refuse, refuseReplay, runWrite } from '../changes/cas.ts';
import type { HotDb } from '../changes/db.ts';
import { requireChangeConfig } from '../changes/origins.ts';
import { changeConfig } from '../guarded/config.ts';
import { type Q, q, raw } from '../changes/sql.ts';
import { type StepUpToken, confirmStepUp, releaseStepUp, verifyStepUpToken } from '../changes/step-up.ts';
import { type CheckedDocument, type LabelProblem, diffOf, networkProblem, parseDocument, previewOf, storedDocument } from './document.ts';
import { CURRENT, IN_FORCE, OPEN, labelsOn } from './sql.ts';
import { type LabelPlan, type LabelRow, REVIEW_ON, VIEW_FROM, VIEW_SELECT, contextKey, labelEvent, labelView, limitProblem, planLabels } from './store.ts';

const OFF_MESSAGE = 'Request labels are not turned on in this environment';

function requireOn(env: Env): void {
  if (!labelsOn(env)) refuse('env_mismatch', OFF_MESSAGE);
}

/** The problems as one `label_invalid` message: "code at path: message; …" (at most 20, the parser's own cap). */
const problemText = (ps: readonly LabelProblem[]): string => ps.map((p) => `${p.code} at ${p.path}: ${p.message}`).join('; ');

/** The environment's guarded-change delay (the one `ackLabelNotice` adds), or null when it isn't configured. */
function delayOf(env: Env): number | null {
  const c = changeConfig(env);
  return c.ok ? c.config.delayMs : null;
}

/** When a version ended: its end, its cancel (or lapse) or its block, whichever is set. */
const ENDED_AT = raw('MAX(COALESCE(c.ended_at, 0), COALESCE(c.cancelled_at, 0), COALESCE(c.blocked_at, 0))');

/**
 * ConsoleRpc.listLabels: the scope's entries, each with its version in force and its waiting one (with their text), and
 * the versions that ended in the last LABEL_RECENT_MS (with Journear's note on a blocked one); an entry removed in that
 * time is listed too. And what the console needs to say whether it can propose: whether labels are on in this
 * environment, Journear's switch over the org's labels, and whether Journear reviews its changes (D899). Two statements.
 */
export async function listLabels(db: HotDb, env: Env, i: { orgId: string; scopeId: string }, now: number): Promise<LabelListAnswer> {
  const cut = now - LABEL_RECENT_MS;
  const head = await db.first<{ v: number; org_off: 'org' | 'all' | null; review_required: number }>(
    q`SELECT s.labels_version AS v,
             (CASE WHEN EXISTS (SELECT 1 FROM label_controls k WHERE k.target = ${i.orgId} AND k.labels_off = 1) THEN 'org'
                   WHEN EXISTS (SELECT 1 FROM label_controls k WHERE k.target = '*' AND k.labels_off = 1) THEN 'all' END) AS org_off,
             ${REVIEW_ON(i.orgId)} AS review_required
        FROM scopes s WHERE s.scope_id = ${i.scopeId} AND s.org_id = ${i.orgId}`,
  );
  if (!head) return refuse('not_found', 'No such scope in this organisation');
  const rows = await db.all<LabelRow & { is_open: number }>(
    q`SELECT ${VIEW_SELECT(now)}, (c.id IS ${OPEN('l', now)}) AS is_open FROM ${VIEW_FROM}
       WHERE l.scope_id = ${i.scopeId} AND l.org_id = ${i.orgId} AND (l.removed_at IS NULL OR l.removed_at > ${cut})
         AND (c.id = ${CURRENT('l', now)} OR c.id = ${OPEN('l', now)}
              OR (c.status IN ('cancelled', 'lapsed', 'blocked', 'ended') AND ${ENDED_AT} > ${cut}))
       ORDER BY l.created_at, l.id, ${ENDED_AT} DESC, c.proposed_at DESC`,
  );
  const entries = new Map<string, LabelEntryView>();
  const texts = new Map<string, string>();
  for (const r of rows) {
    const e = entries.get(r.label_id) ?? { id: r.label_id, current: null, waiting: null, off: r.off_by, removedAt: r.removed_at, recent: [] };
    const v = labelView(r, now);
    if (r.is_current) {
      e.current = { ...v, text: r.doc_text };
      texts.set(r.label_id, r.doc_text);
    }
    else if (r.is_open) e.waiting = { ...v, text: r.doc_text };
    else if (e.recent.length < LABEL_RECENT_PER_ENTRY) e.recent.push(v);
    entries.set(r.label_id, e);
  }
  // A waiting version's diff against the version in force (D899: the list shows what it changes, as the review did).
  for (const e of entries.values()) {
    const w = e.waiting;
    const after = w?.text === undefined ? null : storedDocument(w.text);
    if (!w || !after) continue;
    const cur = texts.get(e.id);
    const before = cur === undefined ? null : storedDocument(cur);
    const name = [...w.apps].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    w.diff = diffOf(before, after, name?.name ?? name?.id ?? 'Your app');
  }
  return { labelsVersion: head.v, entries: [...entries.values()], enabled: labelsOn(env), orgOff: head.org_off, reviewRequired: !!head.review_required, delayMs: delayOf(env) };
}

interface Checked {
  plan: LabelPlan;
  doc: Extract<CheckedDocument, { ok: true }>;
  apps: string[];
  appName: string;
  /** The same document on the same apps is already in force. */
  same: boolean;
}

/**
 * Every check a proposal gets, in order (each refusal before the step-up's reservation, so a refused proposal never
 * uses the token up): the switch, the document (core's parser and text rules, then the scope's network), the scope and
 * the entry, the apps, one waiting version per entry, one entry per contract, the limits.
 */
async function check(db: HotDb, env: Env, w: Writer, i: { orgId: string; scopeId: string; labelId?: string | undefined; document: string; appIds: readonly string[] }): Promise<Checked> {
  requireOn(env);
  const apps = [...new Set(i.appIds)].sort();
  if (apps.length !== i.appIds.length) refuse('bad_request', 'An app is listed twice');
  // Core's parser first (no read); the scope's network rule needs the plan read's environment.
  const doc = await parseDocument(i.document);
  if (!doc.ok) return refuse('label_invalid', problemText(doc.problems));
  const plan = await planLabels(db, w, { orgId: i.orgId, scopeId: i.scopeId, labelId: i.labelId ?? null, appIds: apps, contextKey: contextKey(doc.doc.context) });
  refuseReplay(plan.replay, w);
  if (plan.scope_id === null || plan.environment === null) return refuse('not_found', 'No such scope in this organisation');
  const wrong = networkProblem(doc.doc, plan.environment);
  if (wrong) return refuse('label_invalid', problemText([wrong]));
  // D894 after review: no proposal while Journear has the org's (or every partner's) labels switched off: an org
  // switched off for abuse can't keep mailing its contacts and filling the staff feed, and nothing waits to go live the
  // moment the switch comes back on.
  if (plan.org_off !== null) refuse('forbidden', plan.org_off === 'org' ? 'Journear has switched request labels off for your organisation: ask Journear security before proposing new ones' : 'Journear has switched request labels off for now: ask Journear security before proposing new ones');
  if (i.labelId !== undefined) {
    if (plan.label_id === null) refuse('not_found', 'No such request labels in this scope');
    if (plan.removed_at !== null) refuse('not_found', 'These request labels were removed: propose new ones');
    if (plan.off_at !== null) refuse('forbidden', 'Journear switched these request labels off: ask Journear security why before changing them');
  }
  const scopeApps = new Map((JSON.parse(plan.apps ?? '[]') as { id: string; name: string }[]).map((a) => [a.id, a.name]));
  const foreign = apps.filter((a) => !scopeApps.has(a));
  if (foreign.length) refuse('bad_request', `Not a live app of this scope in this organisation: ${foreign.join(', ')}`);
  if (plan.open_id !== null) refuse('conflict', `A change of these request labels is already waiting (${plan.open_id}): cancel it first`);
  if (plan.same_context > 0) refuse('conflict', 'Other request labels of this scope already describe this contract: change those instead');
  const limit = limitProblem(plan, { newEntry: i.labelId === undefined, bytes: doc.bytes, appIds: apps });
  if (limit) refuse('conflict', limit);
  const same = plan.cur_sha === doc.sha256 && plan.cur_apps === JSON.stringify(apps);
  return { plan, doc, apps, appName: scopeApps.get(apps[0]!) ?? apps[0]!, same };
}

/**
 * ConsoleRpc.previewLabels: the proposal's checks without the step-up and without writing. Answers the preview (what
 * users would see, with example values) or `label_invalid` with the problems; `noChange` when it is what's in force.
 */
export async function previewLabels(db: HotDb, env: Env, w: Writer, i: { orgId: string; scopeId: string; labelId?: string | undefined; document: string; appIds: readonly string[] }): Promise<LabelPreviewAnswer> {
  const c = await check(db, env, w, i);
  // D899: what changes against the version in force (none for a new entry: every line added), for the console's review.
  const before = c.plan.cur_text === null ? null : storedDocument(c.plan.cur_text);
  return {
    preview: previewOf(c.doc.doc, c.appName),
    sha256: c.doc.sha256,
    bytes: c.doc.bytes,
    labelsVersion: c.plan.labels_version!,
    noChange: c.same,
    diff: diffOf(before, c.doc.doc, c.appName),
    reviewRequired: !!c.plan.review_required,
    delayMs: delayOf(env),
  };
}

/** ConsoleRpc.proposeLabels: a new entry or a new version, a pending guarded change; the same document again is a no-op. */
export async function proposeLabels(
  db: HotDb,
  env: Env,
  w: Writer,
  i: { orgId: string; scopeId: string; labelId?: string | undefined; document: string; appIds: readonly string[]; expectedVersion: number; stepUpJwt: string },
): Promise<{ version: number; change: LabelChangeView | null; preview: LabelPreview; noChange: boolean }> {
  requireOn(env);
  requireChangeConfig(env);
  expectReplay(w, ['labels.proposed']);
  const token = await verifyStepUpToken(env, i.stepUpJwt, w.actor, w.now);
  const c = await check(db, env, w, i);
  const preview = previewOf(c.doc.doc, c.appName);
  expectVersion(c.plan.labels_version!, i.expectedVersion);
  if (c.same) return { version: i.expectedVersion, change: null, preview, noChange: true };
  const labelId = i.labelId ?? newId('partnerLabel');
  const expectedNonce = nonceOf(await labelChangeDigest({ signer: env.SIGNER_ACCOUNT, scopeId: i.scopeId, kind: 'labels_set', labelId: i.labelId ?? '', docSha256: c.doc.sha256, appIds: c.apps, labelsVersion: c.plan.labels_version! }));
  await confirmStepUp(env, token, { expectedNonce, scopeId: i.scopeId });
  w.sub = token.sub;
  const changeId = newId('labelChange');
  const ids = { orgId: i.orgId, scopeId: i.scopeId };
  const stmts: Q[] = [
    commitOn(
      w,
      { kind: 'labels.proposed', detail: { changeId, labelId, newEntry: i.labelId === undefined, sha256: c.doc.sha256, bytes: c.doc.bytes, apps: c.apps, previousId: c.plan.cur_id } },
      ids,
      // The scope's version serialises everything within the scope (an app is in one scope, so its bytes too); the
      // org's limits span scopes, so they are checked again here, in the write's own transaction (D894 after review).
      q`EXISTS (SELECT 1 FROM scopes WHERE scope_id = ${i.scopeId} AND org_id = ${i.orgId} AND labels_version = ${i.expectedVersion})
        AND (SELECT COUNT(*) FROM partner_labels WHERE org_id = ${i.orgId} AND removed_at IS NULL) + ${i.labelId === undefined ? 1 : 0} <= ${LABEL_STORE_LIMITS.entriesPerOrg}
        AND (SELECT COUNT(*) FROM label_changes WHERE org_id = ${i.orgId} AND proposed_at > ${w.now - 24 * 3_600_000}) + 1 <= ${LABEL_STORE_LIMITS.proposalsPerDay}
        AND (SELECT COALESCE(SUM(c.doc_bytes), 0) FROM label_changes c JOIN partner_labels pl ON pl.id = c.label_id
              WHERE c.org_id = ${i.orgId} AND c.status IN ('pending', 'active') AND pl.removed_at IS NULL AND c.label_id IS NOT ${i.labelId ?? null}) + ${c.doc.bytes} <= ${LABEL_STORE_LIMITS.orgBytes}`,
    ),
    q`UPDATE scopes SET labels_version = labels_version + 1 WHERE scope_id = ${i.scopeId} AND ${committed(w.requestId)}`,
  ];
  if (i.labelId === undefined) {
    stmts.push(q`INSERT INTO partner_labels (id, org_id, scope_id, created_at, created_by) SELECT ${labelId}, ${i.orgId}, ${i.scopeId}, ${w.now}, ${actorId(w.actor)} WHERE ${committed(w.requestId)}`);
  }
  stmts.push(
    q`INSERT INTO label_changes (id, label_id, org_id, scope_id, doc_text, doc_schema, doc_sha256, doc_bytes, context_key, apps_json, previous_id, status, proposed_by, proposer_sub, proposed_at, request_id)
      SELECT ${changeId}, ${labelId}, ${i.orgId}, ${i.scopeId}, ${c.doc.text}, ${c.doc.schema}, ${c.doc.sha256}, ${c.doc.bytes}, ${contextKey(c.doc.doc.context)}, ${JSON.stringify(c.apps)}, ${c.plan.cur_id}, 'pending', ${actorId(w.actor)}, ${token.sub}, ${w.now}, ${w.requestId}
       WHERE ${committed(w.requestId)}`,
    await labelEvent(w, 'label_proposed', { id: changeId, labelId, orgId: i.orgId, scopeId: i.scopeId }, { apps: c.apps, sha256: c.doc.sha256, newEntry: i.labelId === undefined }),
  );
  try {
    await runWrite(db, w, stmts);
  } catch (err) {
    // Nothing was written (the batch is all or nothing): the token may be used again.
    if (!w.wrote) await releaseStepUp(env, token);
    throw err;
  }
  const change: LabelChangeView = {
    id: changeId,
    labelId,
    orgId: i.orgId,
    scopeId: i.scopeId,
    environment: c.plan.environment!,
    apps: c.apps.map((id) => ({ id, name: (JSON.parse(c.plan.apps ?? '[]') as { id: string; name: string }[]).find((a) => a.id === id)?.name ?? null })),
    schema: c.doc.schema,
    sha256: c.doc.sha256,
    bytes: c.doc.bytes,
    state: 'proposed',
    proposedAt: w.now,
    notifiedAt: null,
    activeFrom: null,
    lapsesAt: w.now + 7 * 24 * 3_600_000,
    reviewRequired: false,
    allowedAt: null,
    blockedAt: null,
    endedAt: null,
    endReason: null,
    previousId: c.plan.cur_id,
    off: null,
    served: false,
  };
  return { version: i.expectedVersion + 1, change, preview, noChange: false };
}

/**
 * ConsoleRpc.removeLabels: the entry ends at once (its version in force ends, a waiting one is cancelled), bound to the
 * step-up as a proposal is. Removing only ever returns the window to the plain view.
 */
export async function removeLabels(db: HotDb, env: Env, w: Writer, i: { orgId: string; scopeId: string; labelId: string; expectedVersion: number; stepUpJwt: string }): Promise<{ version: number }> {
  expectReplay(w, ['labels.removed']);
  const token: StepUpToken = await verifyStepUpToken(env, i.stepUpJwt, w.actor, w.now);
  const plan = await planLabels(db, w, { orgId: i.orgId, scopeId: i.scopeId, labelId: i.labelId, appIds: [], contextKey: null });
  refuseReplay(plan.replay, w);
  if (plan.scope_id === null) return refuse('not_found', 'No such scope in this organisation');
  if (plan.label_id === null || plan.removed_at !== null) return refuse('not_found', 'No such request labels in this scope');
  expectVersion(plan.labels_version!, i.expectedVersion);
  const expectedNonce = nonceOf(await labelChangeDigest({ signer: env.SIGNER_ACCOUNT, scopeId: i.scopeId, kind: 'labels_remove', labelId: i.labelId, appIds: [], labelsVersion: plan.labels_version! }));
  await confirmStepUp(env, token, { expectedNonce, scopeId: i.scopeId });
  w.sub = token.sub;
  const f = IN_FORCE('label_changes', w.now);
  try {
    await runWrite(db, w, [
      commitOn(
        w,
        { kind: 'labels.removed', detail: { labelId: i.labelId, ended: plan.cur_id, cancelled: plan.open_id } },
        { orgId: i.orgId, scopeId: i.scopeId },
        q`EXISTS (SELECT 1 FROM scopes WHERE scope_id = ${i.scopeId} AND org_id = ${i.orgId} AND labels_version = ${i.expectedVersion})
          AND EXISTS (SELECT 1 FROM partner_labels WHERE id = ${i.labelId} AND removed_at IS NULL)`,
      ),
      q`UPDATE scopes SET labels_version = labels_version + 1 WHERE scope_id = ${i.scopeId} AND ${committed(w.requestId)}`,
      q`UPDATE partner_labels SET removed_at = ${w.now}, removed_by = ${actorId(w.actor)} WHERE id = ${i.labelId} AND removed_at IS NULL AND ${committed(w.requestId)}`,
      q`UPDATE label_changes SET status = CASE WHEN ${f} THEN 'ended' ELSE 'cancelled' END, end_reason = 'removed',
               ended_at = CASE WHEN ${f} THEN ${w.now} END, cancelled_at = CASE WHEN ${f} THEN NULL ELSE ${w.now} END,
               cancelled_by = CASE WHEN ${f} THEN NULL ELSE ${actorId(w.actor)} END
         WHERE label_id = ${i.labelId} AND status IN ('pending', 'active') AND ${committed(w.requestId)}`,
    ]);
  } catch (err) {
    if (!w.wrote) await releaseStepUp(env, token);
    throw err;
  }
  return { version: i.expectedVersion + 1 };
}

export { LABEL_STORE_LIMITS };
