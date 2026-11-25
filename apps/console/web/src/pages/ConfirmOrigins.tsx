// D931 (docs/partner-platform-spec.md A11 "Confirm a web address", A15): the page the email's Confirm link opens.
// `/confirm/:changeId` finds which of the member's organisations the change is in (`GET /api/confirmations/:id/org`)
// and opens `/orgs/:org/apps/:app/confirm/:changeId`: the app, who asked and when, every web address of that one
// request with its state, and, for a member who may confirm, one tick box per waiting web address (none ticked at
// first, no "confirm all"). Confirm builds the `origin.confirm` action for exactly the ticked ones and goes to its
// review page, where the fresh Google sign-in confirms them. Reading the page never confirms anything; the server
// checks everything again at the confirmation. Beside each waiting one, an owner's Cancel (the Web addresses tab's).
import type { ConfirmationChange, ConfirmationView } from '@hana-id/console-core';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, getJson, postJson } from '../api.ts';
import { CONFIRM_WORDS, appNames } from '../confirm-words.ts';
import { useApi, useOrg, useStepUp, useWrite, when } from '../lib.tsx';
import { Badge, Callout, ConfirmButton, ErrorNote, IdnWarning, Loading, OriginText, PageHeader, Panel, StepUpHint, Why, WriteNote } from '../ui.tsx';
import { Framed } from './Shell.tsx';
import { AuthCard, SignInButton } from './SignIn.tsx';

type Ability = { allowed: true } | { allowed: false; reason: string; code: string };
interface Answer {
  confirmation: ConfirmationView;
  ability: Ability;
  role: 'owner' | 'viewer';
  now: number;
}

const CHANGE_ID = /^gc_[A-Za-z0-9]{1,64}$/u;

/** Who asked for the request, in words: the platform key by its label (else its id), or Journear staff. */
export function askedBy(v: Pick<ConfirmationView, 'proposedByKind' | 'keyId' | 'keyLabel'>): string {
  if (v.proposedByKind === 'hana') return 'Journear staff';
  if (v.keyLabel) return `Your backend (platform key “${v.keyLabel}”)`;
  return v.keyId ? `Your backend (platform key ${v.keyId})` : 'Your backend';
}

/** One web address's state on the page: a badge and the line under it. */
function stateOf(c: ConfirmationChange): { badge: string; tone: 'warn' | 'ok' | 'neutral'; line?: string } {
  switch (c.state) {
    case 'waiting':
      return { badge: 'Waiting', tone: 'warn', ...(c.activeFrom !== null ? { line: CONFIRM_WORDS.waitLine(when(c.activeFrom)) } : {}) };
    case 'waiting_announcement':
      return { badge: 'Not emailed yet', tone: 'warn', line: CONFIRM_WORDS.notAnnounced };
    case 'in_force':
      return { badge: 'Working', tone: 'ok', line: c.confirmedAt !== undefined ? `Confirmed on ${when(c.confirmedAt)}.` : `Working since ${when(c.activeFrom)}.` };
    case 'cancelled':
      return { badge: 'Cancelled', tone: 'neutral', line: 'It never starts working.' };
    case 'ended':
      return { badge: 'Removed', tone: 'neutral', line: 'It doesn’t work any more.' };
  }
}

/** `/confirm/:changeId` (the email's Confirm link): finds the organisation, then opens the page. A GET only. */
export function FindConfirmation() {
  const { changeId } = useParams();
  const navigate = useNavigate();
  const ok = CHANGE_ID.test(changeId ?? '');
  const [state, setState] = useState<'loading' | 'signed-out' | ApiError>('loading');
  useEffect(() => {
    if (!ok) return;
    let live = true;
    getJson<{ orgId: string; appId: string }>(`/api/confirmations/${encodeURIComponent(changeId!)}/org`).then(
      (r) => live && navigate(`/orgs/${r.orgId}/apps/${r.appId}/confirm/${changeId}`, { replace: true }),
      (err: unknown) => {
        if (!live) return;
        const e = err instanceof ApiError ? err : new ApiError(0, 'network', 'The console could not be reached');
        setState(e.status === 401 ? 'signed-out' : e);
      },
    );
    return () => {
      live = false;
    };
  }, [ok, changeId, navigate]);
  if (!ok)
    return (
      <AuthCard title={CONFIRM_WORDS.pageTitle}>
        <Callout tone="danger" role="alert">
          This link is incomplete. Open the whole Confirm link from the email again.
        </Callout>
      </AuthCard>
    );
  // Signed out: sign-in always lands on the console's start page, so the visitor is told to come back by the link.
  if (state === 'signed-out')
    return (
      <AuthCard title={CONFIRM_WORDS.pageTitle}>
        <p className="lede">Sign in to the partner portal first, with the Google account you use for it.</p>
        <SignInButton label="Sign in with Google" />
        <p className="auth-foot">After you sign in, open the Confirm link in the email again. You can also find the web addresses on the app’s Web addresses tab.</p>
      </AuthCard>
    );
  if (state === 'loading') return <Loading label="Opening the web addresses…" />;
  return (
    <Framed>
      {() => (
        <Callout tone="danger" role="alert" title={state.code === 'not_found' ? 'We couldn’t find these web addresses in your organisations' : 'Something went wrong'}>
          {state.code === 'not_found' ? 'Sign in with the Google account of a member of the organisation the email was about.' : state.message}
        </Callout>
      )}
    </Framed>
  );
}

/** `/orgs/:org/apps/:app/confirm/:changeId`: the request's web addresses, and Confirm for a member who may. */
export function ConfirmOrigins() {
  const { org, app, changeId } = useParams();
  const ctx = useOrg();
  const r = useApi<Answer>(`/api/orgs/${org}/confirmations/${changeId}`);
  const appId = r.data?.confirmation.app.id ?? app!;
  const step = useStepUp(org!, { page: 'origins', appId });
  const w = useWrite();
  const [ticked, setTicked] = useState<string[]>([]);
  const back = { to: `/orgs/${org}/apps/${appId}/origins`, label: 'Web addresses' };
  if (r.error)
    return (
      <>
        <PageHeader title={CONFIRM_WORDS.pageTitle} back={back} />
        <ErrorNote error={r.error} onRetry={r.reload} />
      </>
    );
  if (!r.data)
    return (
      <>
        <PageHeader title={CONFIRM_WORDS.pageTitle} back={back} />
        <Loading />
      </>
    );
  const { confirmation: v, ability } = r.data;
  const owner = ctx?.role === 'owner';
  const canTick = (c: ConfirmationChange) => ability.allowed && c.confirmable;
  // Only what can still be confirmed counts (a web address cancelled since it was ticked drops out).
  const chosen = v.changes.filter((c) => canTick(c) && ticked.includes(c.changeId)).map((c) => c.changeId);
  const others = v.app.otherAppsTotal > 0 ? appNames(v.app.otherApps, v.app.otherAppsTotal) : null;
  return (
    <>
      <PageHeader title={CONFIRM_WORDS.pageTitle} back={back} description={CONFIRM_WORDS.intro(v.app.name)} />
      <div className="stack">
        <Panel>
          <dl className="facts jp-kv key-facts">
            <dt>App</dt>
            <dd>
              <strong>{v.app.name}</strong>
            </dd>
            <dt>Asked for by</dt>
            <dd>{askedBy(v)}</dd>
            <dt>Asked for on</dt>
            <dd>{when(v.proposedAt)}</dd>
          </dl>
          {others && (
            <Callout tone="info" className="oc-shared">
              This wallet is also used on {others}.
            </Callout>
          )}
        </Panel>

        <Panel title={v.changes.length === 1 ? 'Web address asked for' : 'Web addresses asked for'}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              if (ability.allowed && chosen.length > 0) void step.start('origin.confirm', { appId: v.app.id, changeIds: chosen });
            }}
          >
            <ul className="oc-list">
              {v.changes.map((c) => {
                const s = stateOf(c);
                const waiting = c.state === 'waiting' || c.state === 'waiting_announcement';
                return (
                  <li key={c.changeId} className="oc-item">
                    {canTick(c) ? (
                      <label className="jp-check oc-check">
                        <input type="checkbox" checked={ticked.includes(c.changeId)} onChange={(e) => setTicked(e.target.checked ? [...ticked, c.changeId] : ticked.filter((x) => x !== c.changeId))} />
                        <span className="oc-origin">
                          <OriginText origin={c.origin} display={c.display} idn={c.idn} />
                        </span>
                      </label>
                    ) : (
                      <div className="oc-origin">
                        <OriginText origin={c.origin} display={c.display} idn={c.idn} />
                      </div>
                    )}
                    <p className="oc-state small">
                      <Badge tone={s.tone}>{s.badge}</Badge>
                      {s.line && <span className="muted">{s.line}</span>}
                    </p>
                    {owner && waiting && (
                      <div className="oc-cancel">
                        <span className="small">{CONFIRM_WORDS.notYours}</span>
                        <ConfirmButton
                          label="Cancel"
                          confirm="Cancel this web address"
                          detail="It never starts working."
                          busy={w.busy}
                          onConfirm={() =>
                            void w.run(async () => {
                              await postJson(`/api/orgs/${org}/changes/${c.changeId}/cancel`, {});
                              setTicked((t) => t.filter((x) => x !== c.changeId));
                              r.reload();
                              return 'Cancelled. It won’t start working.';
                            })
                          }
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {v.changes.some((c) => c.idn) && <IdnWarning />}
            <WriteNote error={w.error} />
            {ability.allowed ? (
              <>
                <div className="form-actions">
                  <button type="submit" className="jp-btn jp-btn-primary" disabled={step.busy || chosen.length === 0}>
                    {CONFIRM_WORDS.confirmButton}
                  </button>
                </div>
                {chosen.length === 0 && <p className="muted small">{CONFIRM_WORDS.noneTicked}</p>}
                <StepUpHint email={ctx?.email} />
                <WriteNote error={step.error} />
              </>
            ) : (
              <Why>{ability.reason}</Why>
            )}
          </form>
        </Panel>
      </div>
    </>
  );
}
