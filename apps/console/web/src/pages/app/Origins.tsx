// An app's allowed origins: each with its state (active, or waiting with its timeline and Cancel), Remove for an owner
// (immediate, a kill switch: open in a frozen org), and the add form (a fresh sign-in: `origin.add`, announced, then
// active after the delay; at most 20 per request), shown only to an on-chain owner of the app's scope (the API refuses
// anyone else, `not_owner`; ChainOwner.tsx says who can instead).
import { useState } from 'react';
import { postJson } from '../../api.ts';
import { useNow, useStepUp, useWrite, when } from '../../lib.tsx';
import { Badge, ConfirmButton, Empty, OriginText, Panel, StepUpHint, Why, WriteNote } from '../../ui.tsx';
import { useApp } from '../Apps.tsx';
import { ChainOwnerGate, useChainOwner } from './ChainOwner.tsx';
import { PendingChanges } from './Changes.tsx';

const MAX_PER_REQUEST = 20;

export function Origins() {
  const ctl = useApp();
  const { app, owner, frozen, org } = ctl;
  const now = useNow(30_000);
  const w = useWrite();
  const step = useStepUp(org);
  const chain = useChainOwner(org, app.scopeId, owner && !frozen);
  const [text, setText] = useState('');
  const base = `/api/orgs/${org}/apps/${app.id}`;
  const add = text
    .split(/[\s,]+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const pathy = add.filter((o) => /^https?:\/\/[^/]+\/./u.test(o));
  const tooMany = add.length > MAX_PER_REQUEST;
  return (
    <div className="stack">
      <Panel
        title="Allowed origins"
        description={
          <>
            Hana’s wallet loads only on pages served from one of these exact origins (scheme, host and port, no path). Removing one signs out the users who signed in there.
            {app.environment === 'live' ? ' Live apps can’t use http://localhost.' : ' Test apps may add http://localhost:<port> for development.'}
          </>
        }
      >
        {app.origins.length === 0 ? (
          <Empty title="No origins yet">
            <p>{chain.state === 'yes' ? 'Add the origin your app runs on below.' : chain.state === 'no' ? 'An on-chain owner of the app’s scope adds the origins your app runs on.' : 'An owner adds the origins your app runs on.'} Until one is active, the wallet won’t load anywhere.</p>
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Origin</th>
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
                  </td>
                  <td>
                    {o.activeFrom === null ? (
                      <Badge tone="warn">Waiting</Badge>
                    ) : o.activeFrom <= now ? (
                      <Badge tone="ok">Active</Badge>
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
        )}
        <WriteNote error={w.error} done={w.done} />
        <PendingChanges ctl={ctl} kinds={['origin_add']} title="Origins waiting to take effect" />
      </Panel>

      <Panel title="Add origins" description="A new origin is announced by email to your organisation’s security contacts and becomes active after the security delay (24 hours on production deployments). Any owner can cancel it until then.">
        {!owner ? (
          <Why>Only owners can add or remove origins.</Why>
        ) : frozen ? (
          <Why>Adding origins is paused while Hana has frozen the organisation. Removing one still works.</Why>
        ) : chain.state !== 'yes' ? (
          <ChainOwnerGate chain={chain} org={org} scopeId={app.scopeId} what="Adding origins" />
        ) : (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void step.start('origin.add', { appId: app.id, add });
            }}
          >
            <label className="field">
              <span className="field-label">Origins to add</span>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="https://app.example.com" />
              <span className="field-hint">
                One per line, like <code>https://app.example.com</code>. Up to {MAX_PER_REQUEST} at a time.
              </span>
            </label>
            {pathy.length > 0 && <p className="field-error">An origin has no path: {pathy[0]} would be added as its origin only.</p>}
            {tooMany && <p className="field-error">That is more than {MAX_PER_REQUEST}: add them in two goes.</p>}
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={step.busy || add.length === 0 || tooMany}>
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
