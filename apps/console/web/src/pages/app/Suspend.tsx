// Suspending an app: the kill switch for the whole app (immediate, open in a frozen org), and resuming your own
// suspension through a fresh sign-in (`app.resume`). Journear's suspension (bits 1 and 2) only Journear lifts. Who holds
// your organisation's suspension (D930): an owner, or your backend with its platform key, which may lift only its own;
// an owner can take a backend's suspension over, so the backend can't lift it (docs/partner-platform-spec.md A4.6).
import { postJson } from '../../api.ts';
import { useStepUp, useWrite } from '../../lib.tsx';
import { Badge, Callout, ConfirmButton, Panel, StepUpHint, Why, WriteNote } from '../../ui.tsx';
import { suspension, useApp } from '../Apps.tsx';

export function Suspend() {
  const ctl = useApp();
  const { app, owner, frozen, org } = ctl;
  const w = useWrite();
  const step = useStepUp(org, { page: 'suspend', appId: app.id });
  const ours = (app.suspendedBy & 4) !== 0;
  const hanas = (app.suspendedBy & 3) !== 0;
  const s = suspension(app.suspendedBy, app.partnerBitBy);
  const backends = ours && app.partnerBitBy === 'platform';
  return (
    <div className="stack">
      <Panel title="Suspend the app" description="Suspending stops every login and new session in this app at once. Users’ wallets aren’t touched: they come back when the app is resumed. Use it if a key or a web address is misused.">
        <p>{s ? <Badge tone="danger">{s}</Badge> : <Badge tone="ok">Active</Badge>}</p>
        {hanas && (
          <Callout tone="warn">
            <p>Journear suspended this app{(app.suspendedBy & 2) !== 0 ? ' together with your organisation' : ''}. It stays suspended until Journear lifts that, whatever you do here. Contact Journear to find out why.</p>
          </Callout>
        )}
        {backends && (
          <Callout tone="info">
            <p>Your organisation’s backend suspended this app with its platform key. Your backend can resume it, and so can an owner here. To make sure only an owner can resume it, take the suspension over.</p>
          </Callout>
        )}
        {ours && !backends && app.createdByKind === 'platform' && <p className="muted small">An owner of your organisation suspended it, so your backend can’t resume it: only an owner can.</p>}
        {!owner && <Why>Only owners can suspend or resume the app.</Why>}
        {owner && backends && (
          <ConfirmButton
            label="Take the suspension over"
            confirm="Take it over (only owners can resume)"
            detail="The app stays suspended. Your backend can no longer resume it: only an owner can, with a fresh Google sign-in."
            busy={w.busy}
            onConfirm={() =>
              void w.run(async () => {
                await postJson(`/api/orgs/${org}/apps/${app.id}/suspend`, {});
                ctl.reload();
                return 'Taken over: only an owner can resume it now.';
              })
            }
          />
        )}
        {owner && !ours && (
          <ConfirmButton
            label="Suspend the app"
            confirm="Suspend now (logins stop)"
            detail="Every login and new session in this app stops at once. Resuming needs a fresh Google sign-in."
            busy={w.busy}
            onConfirm={() =>
              void w.run(async () => {
                await postJson(`/api/orgs/${org}/apps/${app.id}/suspend`, {});
                ctl.reload();
                return 'Suspended: logins have stopped.';
              })
            }
          />
        )}
        {owner && ours && !frozen && (
          <>
            <button type="button" className="jp-btn jp-btn-primary" disabled={step.busy} onClick={() => void step.start('app.resume', { appId: app.id })}>
              Resume (confirm with Google)
            </button>
            {hanas && <p className="muted small">This clears your organisation’s suspension only.</p>}
            <StepUpHint email={ctl.email} />
          </>
        )}
        {owner && ours && frozen && <Why>Resuming is paused while Journear has frozen the organisation.</Why>}
        <WriteNote error={w.error ?? step.error} />
      </Panel>
    </div>
  );
}
