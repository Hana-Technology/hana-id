// An app's Email login (build plan batch 9, D444, D447; `GET …/apps/:app/email`): whether users can sign in with email,
// the steps to turn it on (a fresh sign-in for the app's setting; an on-chain owner adds the scope's email client,
// timelocked, then anyone executes it), turning it off at once, and the app's own mail deliverability. A viewer sees the
// state and the numbers; every control says why it isn't offered.
import type { AppEmailAnswer, DeliverabilityDay } from '@hana-id/console-core';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { postJson } from '../../api.ts';
import { relative, useApi, useStepUp, useWrite, when } from '../../lib.tsx';
import { Badge, Callout, ConfirmButton, Empty, ErrorNote, Loading, Panel, StepUpHint, Why, WriteNote } from '../../ui.tsx';
import { useApp } from '../Apps.tsx';

const pct = (a: number, b: number): string => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');

function Deliverability({ d }: { d: AppEmailAnswer['deliverability'] }) {
  if ('unavailable' in d) return <Why>Mail numbers are unavailable right now. The email issuer didn’t answer; try again in a moment.</Why>;
  const days = d.days.filter((x) => x.sent + x.bounced + x.complained + x.refused > 0);
  if (days.length === 0) return <Empty title="No mail sent yet"><p>Sent, bounced and complained codes appear here per day once users sign in with email. Addresses are never shown.</p></Empty>;
  const total = days.reduce<Omit<DeliverabilityDay, 'day'>>((t, x) => ({ sent: t.sent + x.sent, bounced: t.bounced + x.bounced, complained: t.complained + x.complained, refused: t.refused + x.refused }), { sent: 0, bounced: 0, complained: 0, refused: 0 });
  return (
    <>
      <dl className="facts">
        <dt>Bounced</dt>
        <dd>{pct(total.bounced, total.sent)}</dd>
        <dt>Spam complaints</dt>
        <dd>{pct(total.complained, total.sent)}</dd>
      </dl>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Day (UTC)</th>
              <th className="num">Sent</th>
              <th className="num">Bounced</th>
              <th className="num">Complaints</th>
              <th className="num">Refused by limits</th>
            </tr>
          </thead>
          <tbody>
            {days.map((x) => (
              <tr key={x.day}>
                <td className="mono">{x.day}</td>
                <td className="num">{x.sent}</td>
                <td className="num">{x.bounced}</td>
                <td className="num">{x.complained}</td>
                <td className="num">{x.refused}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">The last 14 days. A bounce or complaint counts when the mail provider reports it, usually within minutes.</p>
    </>
  );
}

export function EmailLogin() {
  const { org } = useParams();
  const ctl = useApp();
  const { app, owner, frozen } = ctl;
  const r = useApi<AppEmailAnswer>(`/api/orgs/${org}/apps/${app.id}/email`);
  const step = useStepUp(org!);
  const off = useWrite();
  const exec = useWrite();
  const [done, setDone] = useState<string | undefined>();
  const a = r.data;
  const base = `/api/orgs/${org}/apps/${app.id}`;

  if (r.error) return <ErrorNote error={r.error} onRetry={r.reload} />;
  if (!a) return <Loading />;
  if (!a.available)
    return (
      <Panel title="Email login">
        <Callout tone="info">Email login isn’t offered in this environment yet.</Callout>
      </Panel>
    );

  const scope = 'unavailable' in a.scope ? null : a.scope;
  const state = !a.emailOn ? 'off' : !scope ? 'unknown' : scope.clientOnChain ? 'on' : scope.pending ? 'waiting' : 'almost';
  const label =
    state === 'on' ? <Badge tone="ok">On</Badge> : state === 'off' ? <Badge tone="neutral">Off</Badge> : state === 'waiting' ? <Badge tone="warn">Waiting for the chain</Badge> : state === 'almost' ? <Badge tone="warn">One step left</Badge> : <Badge tone="neutral">Unknown</Badge>;
  const scopeLink = <Link to={`/orgs/${org}/scopes/${a.scopeId}`}>scope</Link>;
  const executing = exec.busy;

  return (
    <div className="stack">
      <Panel title="Email login" description="Let users sign in with a code sent to their email, as well as with Google.">
        <dl className="facts">
          <dt>Status</dt>
          <dd>{label}</dd>
          <dt>Scope</dt>
          <dd className="mono small">{a.scopeId}</dd>
        </dl>
        {!scope && <Why>The scope’s on-chain state can’t be read right now: try reloading.</Why>}
        {a.otherAppsEmailOn > 0 && <p className="muted small">{`${a.otherAppsEmailOn} other ${a.otherAppsEmailOn === 1 ? 'app' : 'apps'} of this scope also ${a.otherAppsEmailOn === 1 ? 'uses' : 'use'} email login.`}</p>}
        {state !== 'on' && (
          <ol className="checklist">
            <li className={`step-item step-${a.emailOn ? 'done' : 'todo'}`}>
              <span className="check-n" aria-hidden="true">
                {a.emailOn ? '✓' : 1}
              </span>
              <div className="check-body">
                <p className="check-title">Turn email login on for this app</p>
                <p>The app starts offering email next to Google once the scope has its email client. Takes a fresh sign-in.</p>
                {!a.emailOn &&
                  (!owner ? (
                    <Why>Only owners can turn email login on.</Why>
                  ) : frozen ? (
                    <Why>Email login can’t be turned on while Hana has frozen the organisation.</Why>
                  ) : (
                    <>
                      <button type="button" className="btn btn-primary" disabled={step.busy} onClick={() => void step.start('app.settings', { appId: app.id, loginMethods: 'google,email' })}>
                        Review and confirm with Google
                      </button>
                      <StepUpHint email={ctl.email} />
                      <WriteNote error={step.error} />
                    </>
                  ))}
              </div>
            </li>
            <li className={`step-item step-${scope?.clientOnChain ? 'done' : scope?.pending ? 'partly' : 'todo'}`}>
              <span className="check-n" aria-hidden="true">
                {scope?.clientOnChain ? '✓' : 2}
              </span>
              <div className="check-body">
                <p className="check-title">Add the scope’s email client on chain</p>
                <p>
                  Adds the client <span className="mono small">email:{a.scopeId}</span> to the {scopeLink}. An on-chain owner proposes it; it waits out the scope’s timelock, then anyone can execute it.
                </p>
                {a.emailOn && scope && !scope.clientOnChain && !scope.pending && (
                  !owner ? (
                    <Why>Only owners can propose this.</Why>
                  ) : frozen ? (
                    <Why>This can’t be proposed while Hana has frozen the organisation.</Why>
                  ) : !scope.youAreOnChainOwner ? (
                    <Why>Your Google account isn’t an on-chain owner of this scope: ask one of its owners (see the {scopeLink} page).</Why>
                  ) : (
                    <>
                      <button type="button" className="btn btn-primary" disabled={step.busy} onClick={() => void step.start('owner_action', { scopeId: a.scopeId, method: 'propose_change', change: { kind: 'AddEmailClient' } })}>
                        Review and confirm with Google
                      </button>
                      <StepUpHint email={ctl.email} />
                      <WriteNote error={step.error} />
                    </>
                  )
                )}
                {scope?.pending && (
                  <>
                    <p>
                      {scope.pending.executable ? 'The timelock has passed: anyone can execute it now.' : `Proposed; it unlocks ${relative(scope.pending.unlockAt, Date.now())} (${when(scope.pending.unlockAt)}).`}
                    </p>
                    {owner && !frozen && scope.pending.executable && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={executing}
                        onClick={() =>
                          void exec.run(async () => {
                            await postJson(`/api/orgs/${org}/scopes/${a.scopeId}/execute`, { changeId: scope.pending!.changeId });
                            setDone('Executed. Email login is on once the chain confirms.');
                            r.reload();
                          })
                        }
                      >
                        {executing ? 'Executing…' : 'Execute the change'}
                      </button>
                    )}
                    <WriteNote error={exec.error} done={done} />
                  </>
                )}
              </div>
            </li>
          </ol>
        )}
        {state === 'on' && <p>Users of this app can sign in with email. Partners can see a shared address only when the user shares it (Login &amp; sessions).</p>}
        {a.emailOn && (
          <div className="form-actions">
            {!owner ? (
              <Why>Only owners can turn email login off.</Why>
            ) : (
              <ConfirmButton
                label="Turn email login off for this app"
                confirm="Turn off"
                detail="Users stop being offered email at once; those signed in stay signed in until their session ends."
                busy={off.busy}
                onConfirm={() =>
                  void off.run(async () => {
                    await postJson(`${base}/off`, { what: 'email', expectedVersion: app.settingsVersion });
                    setDone('Email login is off for this app.');
                    r.reload();
                    ctl.reload();
                  })
                }
              />
            )}
            <WriteNote error={off.error} done={done} />
          </div>
        )}
        {!a.emailOn && scope?.clientOnChain && (
          <div className="form-actions">
            {a.otherAppsEmailOn > 0 ? (
              <Why>The scope’s email client stays while another app of this scope uses email login.</Why>
            ) : !owner ? (
              <Why>Only owners can remove the scope’s email client.</Why>
            ) : !scope.youAreOnChainOwner ? (
              <Why>Only an on-chain owner of this scope can remove its email client.</Why>
            ) : (
              <>
                <ConfirmButton label="Remove the scope’s email client from the chain" confirm="Continue" detail="At once, for every app of this scope. Adding it back takes the timelock again." busy={step.busy} onConfirm={() => void step.start('owner_action', { scopeId: a.scopeId, method: 'remove_client', aud: `email:${a.scopeId}` })} />
                <WriteNote error={step.error} />
              </>
            )}
          </div>
        )}
      </Panel>
      <Panel title="Email deliverability" description="Your app’s own mail per day: only counts, never an address.">
        <Deliverability d={a.deliverability} />
      </Panel>
    </div>
  );
}
