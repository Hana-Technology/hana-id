// An app's allowed web addresses (origins): each with its state (active, or waiting with its timeline and Cancel), Remove for an owner
// (immediate, a kill switch: open in a frozen org), and the add form (a fresh sign-in: `origin.add`, announced, then
// active after the delay; at most 20 per request), shown only to an on-chain owner of the app's scope (the API refuses
// anyone else, `not_owner`; ChainOwner.tsx says who can instead). The form flags a path or too many origins once the
// field is left (validate on blur), and never sends either.
import type { GuardedChange } from '@hana-id/console-core';
import { useState } from 'react';
import { postJson } from '../../api.ts';
import { useNow, useStepUp, useTouched, useWrite, when } from '../../lib.tsx';
import { Badge, ConfirmButton, Empty, Field, OriginText, Panel, StepUpHint, Why, WriteNote } from '../../ui.tsx';
import { useApp } from '../Apps.tsx';
import { ChainOwnerGate, useChainOwner } from './ChainOwner.tsx';
import { PendingChanges } from './Changes.tsx';

const MAX_PER_REQUEST = 20;

/** D931: "Confirmed on {date} by an owner" (or "by Journear staff"). */
export const confirmedWords = (c: Pick<GuardedChange, 'confirmedAt' | 'confirmedByKind'>): string => `Confirmed on ${when(c.confirmedAt)} ${c.confirmedByKind === 'hana' ? 'by Journear staff' : 'by an owner'}`;

export function Origins() {
  const ctl = useApp();
  const { app, owner, frozen, org } = ctl;
  useNow(30_000); // re-render every 30 s
  const now = ctl.serverNow();
  const w = useWrite();
  const step = useStepUp(org, { page: 'origins', appId: app.id });
  const chain = useChainOwner(org, app.scopeId, owner && !frozen);
  const [text, setText] = useState('');
  const touched = useTouched<'origins'>();
  const base = `/api/orgs/${org}/apps/${app.id}`;
  const add = text
    .split(/[\s,]+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const pathy = add.filter((o) => /^https?:\/\/[^/]+\/./u.test(o));
  const tooMany = add.length > MAX_PER_REQUEST;
  const problem = !touched.seen('origins') ? undefined : tooMany ? `That is more than ${MAX_PER_REQUEST}: add them in two goes.` : pathy.length > 0 ? `A web address has no path: only the start of ${pathy[0]} would be added.` : undefined;
  // D930: which of the app's waiting changes your backend asked for (its platform key), by change id.
  const byBackend = new Set(app.changes.filter((c) => c.proposedByKind === 'platform').map((c) => c.id));
  // D931: who confirmed a web address that came into force by a confirmation, by change id.
  const confirmed = new Map(app.changes.filter((c) => c.confirmedAt !== undefined).map((c) => [c.id, c]));
  return (
    <div className="stack">
      <Panel
        title="Allowed web addresses"
        description={
          <>
            The wallet loads only on pages served from one of these exact web addresses (the start of the address, like https://app.example.com, with no path). Removing one signs out the users who signed in there.
            {app.environment === 'live' ? ' Live apps can’t use http://localhost.' : ' Test apps may add http://localhost:<port> for development.'}
          </>
        }
      >
        {app.origins.length === 0 ? (
          <Empty title="No web addresses yet">
            <p>{chain.state === 'yes' ? 'Add the web address your app runs on below.' : chain.state === 'no' ? 'An on-chain owner of the app’s scope adds the web addresses your app runs on.' : 'An owner adds the web addresses your app runs on.'} Until one is active, the wallet won’t load anywhere.</p>
          </Empty>
        ) : (
          <div className="jp-table-wrap">
          <table className="jp-table compact">
            <thead>
              <tr>
                <th scope="col">Web address</th>
                <th scope="col">State</th>
                {owner && (
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {app.origins.map((o) => (
                <tr key={o.origin}>
                  <td>
                    <OriginText {...o} />
                    {o.changeId !== undefined && byBackend.has(o.changeId) && (
                      <div>
                        <Badge tone="info">Asked for by your backend</Badge>
                      </div>
                    )}
                  </td>
                  <td>
                    {o.activeFrom === null ? (
                      <Badge tone="warn">Waiting</Badge>
                    ) : o.activeFrom <= now ? (
                      <>
                        <Badge tone="ok">Active</Badge>
                        {o.changeId !== undefined && confirmed.has(o.changeId) && <div className="muted small">{confirmedWords(confirmed.get(o.changeId)!)}</div>}
                      </>
                    ) : (
                      <>
                        <Badge tone="warn">Waiting</Badge> <span className="muted small">active from {when(o.activeFrom)}</span>
                      </>
                    )}
                  </td>
                  {owner && (
                    <td className="cell-actions">
                      {o.activeFrom !== null ? (
                        <ConfirmButton
                          label="Remove"
                          confirm="Remove now"
                          detail={`Takes effect at once: users signed in on ${o.display} are signed out.`}
                          busy={w.busy}
                          onConfirm={() =>
                            void w.run(async () => {
                              await postJson(`${base}/origins/remove`, { remove: [o.origin], expectedVersion: app.originsVersion });
                              ctl.reload();
                              return `Removed ${o.display}.`;
                            })
                          }
                        />
                      ) : (
                        <span className="muted small">Cancel it below</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        <WriteNote error={w.error} />
        <PendingChanges ctl={ctl} kinds={['origin_add']} title="Web addresses waiting to take effect" />
      </Panel>

      <Panel title="Add web addresses" description="A new web address is announced by email to your organisation’s security contacts and becomes active after the security delay (24 hours on production deployments). Any owner can cancel it until then.">
        {!owner ? (
          <Why>Only owners can add or remove web addresses.</Why>
        ) : frozen ? (
          <Why>Adding web addresses is paused while Journear has frozen the organisation. Removing one still works.</Why>
        ) : chain.state !== 'yes' ? (
          <ChainOwnerGate chain={chain} org={org} scopeId={app.scopeId} what="Adding web addresses" />
        ) : (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              touched.all();
              if (!tooMany && add.length > 0) void step.start('origin.add', { appId: app.id, add });
            }}
          >
            <Field
              label="Web addresses to add"
              error={problem}
              hint={
                <>
                  One per line, like <code>https://app.example.com</code>. Up to {MAX_PER_REQUEST} at a time.
                </>
              }
            >
              {(c) => <textarea {...c} className="jp-input mono" value={text} onChange={(e) => setText(e.target.value)} onBlur={touched.blur('origins')} rows={3} placeholder="https://app.example.com" />}
            </Field>
            <div className="form-actions">
              <button type="submit" className="jp-btn jp-btn-primary" disabled={step.busy || add.length === 0 || tooMany}>
                Review and confirm with Google
              </button>
            </div>
            <StepUpHint email={ctl.email} />
            <WriteNote error={step.error} />
          </form>
        )}
      </Panel>
    </div>
  );
}
