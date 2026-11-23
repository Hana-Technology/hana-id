// An app's Request labels tab (D899): the request labels of the app's scope, the words a partner declares for its own
// requests, which the approval window shows as "{App} says: …". The list: each entry with its state (live, waiting with
// its go-live time, held for Journear's review, blocked with Journear's note, lapsed, removed, switched off by Journear)
// and what users see now; the owner's Cancel of a waiting change (immediate) and Remove (a fresh sign-in, immediate and
// final). The editor (labels/Editor.tsx): a form, never JSON by hand, with core's own problems beside each field and the
// approval window's own preview; "Review the change" builds the `labels.set` action, whose page is the review (what
// changes against what users see now) and the fresh sign-in (D894's guarded path, unchanged).
//
// Everything a member reads here is `GET /api/orgs/:org/scopes/:scope/labels` (ConsoleRpc.listLabels), judged on the
// server's clock (D701). Partner text is always rendered as text.
import type { AppSummary, LabelChangeView, LabelEntryView, LabelListAnswer } from '@hana-id/console-core';
import { type LabelDocument, parseLabelDocument, previewLabelDocument } from '@hana-id/core/partner-labels';
import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, getJson, postJson } from '../../api.ts';
import { clockTime, relative, useApi, useNow, useStepUp, useWrite, when } from '../../lib.tsx';
import { Badge, Callout, ConfirmButton, Empty, ErrorNote, Loading, Panel, StepUpHint, Why, WriteNote } from '../../ui.tsx';
import { DiffList, afterEmail } from '../../labels/Diff.tsx';
import { LabelsEditor, type NearCodeAnswer } from '../../labels/Editor.tsx';

/** D900: a NEAR or Soroban entry shows only while the program runs the code its labels name. */
export const CODE_TIED_NOTE = 'Users see these words only while your program runs the code these labels name.';
import { problemsOfApi } from '../../labels/problems.ts';
import { clockOffset, useApp, useReloadAt } from '../Apps.tsx';
import { type ChainOwner, ChainOwnerGate, useChainOwner } from './ChainOwner.tsx';

// ---- the sentences (D899, to confirm) ----

export const LABELS_INTRO =
  'Request labels are your own words for your app’s requests. When a user approves a request that matches one exactly, the approval window adds “{App} says: …” under everything Journear says, with “These are {App}’s words. Journear hasn’t checked them.” Your words never replace or soften Journear’s warnings.';
export const NOT_ENABLED = 'Request labels aren’t switched on here yet. You can prepare and preview them.';
export const NOT_ENABLED_PROPOSE = 'Proposing them isn’t possible until Journear switches request labels on here.';
export const ORG_OFF: Readonly<Record<'org' | 'all', string>> = Object.freeze({
  org: 'Journear has switched request labels off for your organisation: your users see the plain approval window. Ask Journear security before proposing new ones.',
  all: 'Journear has switched request labels off for now: your users see the plain approval window. Ask Journear security before proposing new ones.',
});
export const ENTRY_OFF = 'Journear switched these request labels off: your users see the plain approval window for these requests. Ask Journear security why before changing them.';
export const reviewOn = (delayMs: number | null | undefined): string => `Journear reviews your organisation’s changes before they go live: a change goes live only after Journear allows it, at the earliest ${afterEmail(delayMs)}.`;
export const guardedWait = (delayMs: number | null | undefined): string =>
  `Each change is emailed to your organisation’s security contacts and goes live ${afterEmail(delayMs)} unless someone cancels it. Journear may block it if it would mislead users. Removing labels is immediate.`;

type View = LabelListAnswer & { now?: number };

/** What an entry describes, from its document: "Payments to your Stellar accounts", "NEAR program x.testnet". */
function describes(doc: LabelDocument | null): string {
  if (!doc) return 'Request labels';
  const c = doc.context;
  if (c.chain === 'near') return `NEAR program ${c.account}`;
  if (c.chain === 'soroban') return `Soroban contract ${c.contract}`;
  return 'Payments to your Stellar accounts';
}

const parsed = (text: string | undefined): LabelDocument | null => {
  if (text === undefined) return null;
  const r = parseLabelDocument(text);
  return r.ok ? r.document : null;
};

/** The app named in a version's lines: the first attached app, as the API names it (by sorted id). */
const appNameOf = (v: LabelChangeView): string => [...v.apps].sort((a, b) => (a.id < b.id ? -1 : 1))[0]?.name ?? 'Your app';

/** The sentences a version makes users see, with example values (core's own preview, as the API's). */
function Lines({ v }: { v: LabelChangeView }) {
  const doc = parsed(v.text);
  if (!doc) return <p className="muted small">Its words can’t be shown here.</p>;
  const lines = previewLabelDocument(doc, appNameOf(v));
  return (
    <ul className="labels-lines">
      {lines.map((f) => (
        <li key={f.key}>
          <span className="labels-line">{f.line}</span>
          {f.fields.map((x) => (
            <span key={x.label} className="labels-line-row muted small">
              {x.label}: {x.value}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

/**
 * A waiting version's state, in a badge and a line: whether Journear reviews it first decides the sentence in every
 * state, then the state (`proposed` before the email, `announced` its time ahead, `waiting_review` its time passed).
 */
export function waitingState(v: Pick<LabelChangeView, 'state' | 'reviewRequired' | 'activeFrom' | 'lapsesAt'>, now: number, delayMs: number | null | undefined): { badge: string; line: string } {
  const at = v.activeFrom ?? now;
  const lapse = v.lapsesAt ? ` If Journear hasn’t allowed it by ${when(v.lapsesAt)}, it lapses and nothing changes.` : '';
  if (v.state === 'waiting_review') return { badge: 'Held for Journear’s review', line: `Its time has come: Journear reviews it before it goes live.${lapse}` };
  if (v.reviewRequired) {
    if (v.state === 'proposed') return { badge: 'Waiting for the email', line: `Journear is about to email your security contacts. Journear reviews it first: it goes live only after Journear allows it, at the earliest ${afterEmail(delayMs).replace('the email', 'that email')}.` };
    return { badge: 'Held for Journear’s review', line: `It goes live only after Journear allows it, at the earliest ${clockTime(at, now)} (${relative(at, now)}).` };
  }
  if (v.state === 'proposed') return { badge: 'Waiting for the email', line: `Journear is about to email your security contacts. It goes live ${afterEmail(delayMs).replace('the email', 'that email')} unless someone cancels it.` };
  return { badge: `Goes live ${clockTime(at, now)}`, line: `It goes live ${relative(at, now)} unless someone cancels it.` };
}

/** A version that ended, in one line (newest first). */
function endedLine(v: LabelChangeView): { badge: string; tone: 'danger' | 'neutral' | 'warn'; line: string } {
  const at = when(v.blockedAt ?? v.endedAt);
  switch (v.state) {
    case 'blocked':
      return { badge: 'Blocked by Journear', tone: 'danger', line: `Journear blocked this change on ${at}. Your users don’t see it.` };
    case 'cancelled':
      return { badge: 'Cancelled', tone: 'neutral', line: `Cancelled on ${at}. It never went live.` };
    case 'lapsed':
      return { badge: 'Lapsed', tone: 'warn', line: v.endReason === 'not_reviewed' ? `Lapsed on ${at}: Journear didn’t allow it within 7 days of its time. It never went live.` : `Lapsed on ${at}: it wasn’t announced within 7 days. It never went live.` };
    case 'removed':
      return { badge: 'Removed', tone: 'neutral', line: `Removed on ${at}.` };
    default:
      return v.endReason === 'blocked_successor'
        ? { badge: 'Ended', tone: 'neutral', line: `Ended on ${at}, when Journear blocked the newer version: neither shows.` }
        : { badge: 'Replaced', tone: 'neutral', line: `Replaced by a newer version on ${at}.` };
  }
}

interface Ctl {
  org: string;
  scopeId: string;
  appId: string;
  owner: boolean;
  /** An owner, frozen org or not (the server keeps cancels open there), whatever the app: labels are the scope's. */
  canCancel: boolean;
  canPropose: boolean;
  now: number;
  delayMs: number | null;
  reload: () => void;
}

function Entry({ e, ctl, chain }: { e: LabelEntryView; ctl: Ctl; chain: ChainOwner }) {
  const w = useWrite();
  const step = useStepUp(ctl.org, { page: 'labels', appId: ctl.appId });
  const doc = parsed(e.current?.text ?? e.waiting?.text);
  const nearOrSoroban = doc !== null && doc.context.chain !== 'stellar';
  const v = e.current ?? e.waiting;
  const removed = e.removedAt !== null;
  return (
    <li className="labels-entry" data-entry={e.id}>
      <div className="labels-entry-head">
        <h3>{describes(doc)}</h3>
        <span className="badges">
          {removed && <Badge tone="neutral">Removed</Badge>}
          {!removed && e.off && <Badge tone="danger">Switched off by Journear</Badge>}
          {!removed && !e.off && e.current && <Badge tone="ok">Live</Badge>}
          {!removed && e.waiting && <Badge tone="warn">{waitingState(e.waiting, ctl.now, ctl.delayMs).badge}</Badge>}
        </span>
      </div>
      {v && <p className="muted small">For {v.apps.map((a) => a.name ?? a.id).join(', ')}</p>}
      {removed && <p>Removed on {when(e.removedAt)}. Your users see the plain approval window for these requests.</p>}
      {!removed && e.off && <Callout tone="danger">{e.off === 'entry' ? ENTRY_OFF : ORG_OFF[e.off]}</Callout>}
      {e.current && (
        <div className="labels-version">
          <h4>What users see now</h4>
          {nearOrSoroban && <p className="muted small">{CODE_TIED_NOTE}</p>}
          <Lines v={e.current} />
          <p className="muted small">Live since {when(e.current.activeFrom)}.</p>
        </div>
      )}
      {!e.current && !removed && !e.waiting && <p className="muted">Nothing of these labels is live: your users see the plain approval window for these requests.</p>}
      {e.waiting && (
        <div className="labels-version labels-waiting" data-change={e.waiting.id}>
          <h4>Waiting to go live</h4>
          <p>{waitingState(e.waiting, ctl.now, ctl.delayMs).line}</p>
          <h5 className="labels-sub-h">What changes for users</h5>
          {e.waiting.diff ? <DiffList diff={e.waiting.diff} /> : <Lines v={e.waiting} />}
          {e.waiting.diff && (
            <details className="labels-all-lines">
              <summary>All its lines</summary>
              <Lines v={e.waiting} />
            </details>
          )}
          {ctl.canCancel && (
            <ConfirmButton
              label="Cancel this change"
              confirm="Cancel it now"
              detail="It never goes live. What users see now stays as it is."
              busy={w.busy}
              onConfirm={() =>
                void w.run(async () => {
                  await postJson(`/api/orgs/${ctl.org}/changes/${e.waiting!.id}/cancel`, {});
                  ctl.reload();
                  return 'Cancelled. It won’t go live.';
                })
              }
            />
          )}
        </div>
      )}
      {e.recent.length > 0 && (
        <div className="labels-recent">
          <h4>Earlier changes</h4>
          <ul className="plain-list">
            {e.recent.map((r) => {
              const x = endedLine(r);
              return (
                <li key={r.id} data-change={r.id}>
                  <Badge tone={x.tone}>{x.badge}</Badge> {x.line}
                  {r.state === 'blocked' && r.blockNote && <span className="labels-note"> Journear’s note: “{r.blockNote}”</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {!removed && ctl.owner && (
        <div className="labels-entry-actions">
          {ctl.canPropose && chain.state === 'yes' && !e.waiting && !e.off && doc && (
            <Link className="jp-btn jp-btn-secondary jp-btn-sm" to={`/orgs/${ctl.org}/apps/${ctl.appId}/labels/${e.id}`}>
              Change these labels
            </Link>
          )}
          {e.waiting && <Why>A change is already waiting: cancel it to propose another.</Why>}
          {chain.state === 'yes' && (
            <ConfirmButton
              label="Remove these labels"
              confirm="Remove (confirm with Google)"
              detail="At once and for good: your users see the plain approval window for these requests from then on. To use labels again you propose new ones, which wait again."
              busy={step.busy}
              onConfirm={() => void step.start('labels.remove', { scopeId: ctl.scopeId, labelId: e.id })}
            />
          )}
        </div>
      )}
      <WriteNote error={w.error ?? step.error} />
    </li>
  );
}

/** A proposal's refusal in plain words: the ones the page knows, else the console's own text for the code. */
export function labelRefusal(e: ApiError): { text: string; reload: boolean } | null {
  if (e.code === 'env_mismatch') return { text: `${NOT_ENABLED} ${NOT_ENABLED_PROPOSE}`, reload: false };
  if (e.code === 'forbidden' && /^Journear (?:has )?switched/u.test(e.message)) return { text: `${e.message}.`, reload: false };
  if (e.code === 'version_conflict') return { text: 'Your request labels changed while you were working (another change, or Journear). Reload to see them; what you typed here stays.', reload: true };
  if (e.code === 'conflict') return { text: e.message.endsWith('.') ? e.message : `${e.message}.`, reload: false };
  return null;
}

function ListView({ data, ctl, chain, scopeApps }: { data: View; ctl: Ctl; chain: ChainOwner; scopeApps: AppSummary[] }) {
  const live = data.entries.filter((e) => e.removedAt === null);
  const removed = data.entries.filter((e) => e.removedAt !== null);
  return (
    <>
      <Panel
        title="Your request labels"
        description={guardedWait(data.delayMs)}
        actions={
          ctl.owner && chain.state === 'yes' && !data.orgOff ? (
            <Link className="jp-btn jp-btn-primary jp-btn-sm" to={`/orgs/${ctl.org}/apps/${ctl.appId}/labels/new`}>
              New request labels
            </Link>
          ) : undefined
        }
      >
        {live.length === 0 ? (
          <Empty title="No request labels yet">
            <p>Users see Journear’s plain approval window for your app’s requests. {ctl.owner ? 'Add labels to say, in your words, what a request is for.' : ''}</p>
            <p className="muted small">The scope’s apps: {scopeApps.map((a) => a.name).join(', ')}.</p>
          </Empty>
        ) : (
          <ul className="labels-entries">
            {live.map((e) => (
              <Entry key={e.id} e={e} ctl={ctl} chain={chain} />
            ))}
          </ul>
        )}
      </Panel>
      {removed.length > 0 && (
        <Panel title="Removed in the last 14 days">
          <ul className="labels-entries">
            {removed.map((e) => (
              <Entry key={e.id} e={e} ctl={ctl} chain={chain} />
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}

export function Labels() {
  const ctx = useApp();
  const { app, org } = ctx;
  const { labelId } = useParams();
  const navigate = useNavigate();
  const r = useApi<View>(`/api/orgs/${org}/scopes/${app.scopeId}/labels`);
  const apps = useApi<{ apps: AppSummary[] }>(`/api/orgs/${org}/apps`);
  const owner = ctx.role === 'owner' && !ctx.frozen && !app.deleted;
  const chain = useChainOwner(org, app.scopeId, owner);
  const step = useStepUp(org, { page: 'labels', appId: app.id });
  useNow(30_000);
  const offset = useMemo(() => clockOffset(r.data?.now, Date.now()), [r.data]);
  const next = (r.data?.entries ?? []).flatMap((e) => (e.waiting?.activeFrom && e.waiting.activeFrom > (r.data?.now ?? 0) ? [e.waiting.activeFrom] : []));
  useReloadAt(next.length ? Math.min(...next) : null, r.reload, offset);
  if (r.error) return <ErrorNote error={r.error} onRetry={r.reload} />;
  if (!r.data || !apps.data) return apps.error ? <ErrorNote error={apps.error} onRetry={apps.reload} /> : <Loading />;
  const data = r.data;
  const scopeApps = apps.data.apps.filter((a) => a.scopeId === app.scopeId && !a.deleted);
  const now = Date.now() + offset;
  const canPropose = owner && data.enabled && data.orgOff === null && chain.state === 'yes';
  const ctl: Ctl = { org, scopeId: app.scopeId, appId: app.id, owner, canCancel: ctx.role === 'owner', canPropose, now, reload: r.reload, delayMs: data.delayMs ?? null };
  const editing = labelId !== undefined;
  const entry = editing && labelId !== 'new' ? data.entries.find((e) => e.id === labelId) : undefined;
  const base = `/orgs/${org}/apps/${app.id}/labels`;

  const notes = (
    <>
      {!data.enabled && (
        <Callout tone="info" role="status" title={NOT_ENABLED}>
          <p>{NOT_ENABLED_PROPOSE}</p>
        </Callout>
      )}
      {data.orgOff && <Callout tone="danger">{ORG_OFF[data.orgOff]}</Callout>}
      {data.reviewRequired && <Callout tone="info">{reviewOn(data.delayMs)}</Callout>}
      {ctx.role !== 'owner' && <Why>You’re a viewer: only owners can propose, cancel or remove request labels.</Why>}
      {ctx.role === 'owner' && ctx.frozen && <Why>Proposing is paused while Journear has frozen the organisation; cancelling still works.</Why>}
      {owner && chain.state !== 'yes' && chain.state !== 'off' && <ChainOwnerGate chain={chain} org={org} scopeId={app.scopeId} what="Proposing or removing request labels" />}
    </>
  );

  if (editing) {
    if (labelId !== 'new' && !entry) return <ErrorNote error={new ApiError(404, 'not_found', 'No such request labels in this scope')} />;
    const startText = entry?.waiting?.text ?? entry?.current?.text;
    const startApps = (entry?.current ?? entry?.waiting)?.apps.map((a) => a.id) ?? [app.id];
    const whyNot = !owner ? 'Only owners can propose request labels.' : !data.enabled ? `${NOT_ENABLED} ${NOT_ENABLED_PROPOSE}` : data.orgOff ? ORG_OFF[data.orgOff] : chain.state !== 'yes' ? 'Proposing needs an on-chain owner of this app’s scope.' : undefined;
    return (
      <div className="labels-page">
        <p>
          <Link to={base}>Back to request labels</Link>
        </p>
        <h2>{entry ? 'Change request labels' : 'New request labels'}</h2>
        {notes}
        <LabelsEditor
          key={labelId}
          environment={app.environment}
          apps={scopeApps.map((a) => ({ id: a.id, name: a.name }))}
          initialApps={startApps}
          initialText={startText}
          existing={entry !== undefined}
          canPropose={canPropose}
          whyNot={whyNot}
          busy={step.busy}
          onCancel={() => navigate(base)}
          readNearCode={(account) => getJson<NearCodeAnswer>(`/api/orgs/${org}/near-code/${encodeURIComponent(account)}`)}
          onReview={(text, appIds) => {
            void step.start('labels.set', { scopeId: app.scopeId, ...(entry ? { labelId: entry.id } : {}), document: text, appIds });
          }}
        />
        {canPropose && <StepUpHint email={ctx.email} />}
        <ProposeError error={step.error} onReload={r.reload} />
      </div>
    );
  }

  return (
    <div className="labels-page">
      <p className="labels-intro">{LABELS_INTRO.replaceAll('{App}', app.name)}</p>
      {notes}
      <ListView data={data} ctl={ctl} chain={chain} scopeApps={scopeApps} />
    </div>
  );
}

/** A refused "Review the change": the problems beside their fields (label_invalid), else one plain line. */
function ProposeError({ error, onReload }: { error: ApiError | undefined; onReload: () => void }) {
  if (!error) return null;
  if (error.code === 'label_invalid') {
    const list = problemsOfApi(error.message, null);
    return (
      <Callout tone="danger" role="alert" title="Journear can’t take these labels yet:">
        <ul className="problems">
          {list.map((p, i) => (
            <li key={i}>{p.message}</li>
          ))}
        </ul>
      </Callout>
    );
  }
  const known = labelRefusal(error);
  if (!known) return <ErrorNote error={error} />;
  return (
    <Callout tone="danger" role="alert" title={known.text}>
      {known.reload && (
        <button type="button" className="jp-btn jp-btn-secondary jp-btn-sm" onClick={onReload}>
          Reload
        </button>
      )}
    </Callout>
  );
}
