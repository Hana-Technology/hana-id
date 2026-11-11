// Suspending an app: the kill switch for the whole app (immediate, open in a frozen org), and resuming your own
// suspension through a fresh sign-in (`app.resume`). Hana's suspension (bits 1 and 2) only Hana lifts.
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
  const s = suspension(app.suspendedBy);
  return (
    <div className="stack">
      <Panel title="Suspend the app" description="Suspending stops every login and new session in this app at once. Users’ wallets aren’t touched: they come back when the app is resumed. Use it if a key or an origin is misused.">
        <p>{s ? <Badge tone="danger">{s}</Badge> : <Badge tone="ok">Active</Badge>}</p>
        {hanas && (
          <Callout tone="warn">
            <p>Hana suspended this app{(app.suspendedBy & 2) !== 0 ? ' together with your organisation' : ''}. It stays suspended until Hana lifts that, whatever you do here. Contact Hana to find out why.</p>
          </Callout>
        )}
        {!owner && <Why>Only owners can suspend or resume the app.</Why>}
        {owner && !ours && (
          <ConfirmButton
            label="Suspend the app"
            confirm="Suspend now (logins stop)"
            detail="Every login and new session in this app stops at once. Resuming needs a fresh Google sign-in."
            className="btn btn-danger-quiet"
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
            <button type="button" className="btn btn-primary" disabled={step.busy} onClick={() => void step.start('app.resume', { appId: app.id })}>
              Resume (confirm with Google)
            </button>
            {hanas && <p className="muted small">This clears your organisation’s suspension only.</p>}
            <StepUpHint email={ctl.email} />
          </>
        )}
        {owner && ours && frozen && <Why>Resuming is paused while Hana has frozen the organisation.</Why>}
        <WriteNote error={w.error ?? step.error} done={w.done} />
      </Panel>
    </div>
  );
}
