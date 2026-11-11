// An app's signing settings. The auto-approve policy: the one in force, Remove (immediate, a kill switch), and the
// editor, which checks the JSON with the console (`policy/check`, the vault's validator) and shows the consent screen
// users will see before proposing it with a fresh sign-in (`policy.set`, announced, then active after the delay). Raw
// signing: off at once (a kill switch), on through a fresh sign-in (live apps only: test apps never sign raw). Proposing
// a policy or turning raw signing on needs an on-chain owner of the app's scope (the API refuses anyone else,
// `not_owner`): for an owner who isn't one, ChainOwner.tsx's line stands in for the editor and the button.
import { useState } from 'react';
import { ApiError, postJson } from '../../api.ts';
import { useStepUp, useWrite } from '../../lib.tsx';
import { Badge, ConfirmButton, CopyButton, Panel, StepUpHint, Why, WriteNote } from '../../ui.tsx';
import { useApp } from '../Apps.tsx';
import { ConsentPreview } from '../Consent.tsx';
import { type ChainOwner, ChainOwnerGate, useChainOwner } from './ChainOwner.tsx';
import { PendingChanges, isWaiting } from './Changes.tsx';

interface Checked {
  policyId: string;
  label: string;
  policy: unknown;
}

function Policy({ chain }: { chain: ChainOwner }) {
  const ctl = useApp();
  const { app, owner, frozen, org } = ctl;
  const s = app.settings;
  const w = useWrite();
  const chk = useWrite();
  const step = useStepUp(org);
  const [text, setText] = useState(s.policy ? JSON.stringify(s.policy.json, null, 2) : '');
  const [checked, setChecked] = useState<Checked | undefined>();
  const base = `/api/orgs/${org}/apps/${app.id}`;
  const parentOrigin = app.origins.find((o) => o.activeFrom !== null && o.activeFrom <= ctl.serverNow())?.display ?? null;
  const pending = app.changes.some((c) => c.kind === 'policy_set' && isWaiting(c, ctl.serverNow()));
  return (
    <Panel
      title="Auto-approve policy"
      description="Lets users allow some signatures without a popup each time: only the contracts, functions and limits the policy lists. Users see what it allows and consent to it once per session."
    >
      <div className="current">
        {s.policy ? (
          <>
            <p>
              <Badge tone="ok">In effect</Badge> <strong>“{s.policy.label}”</strong>
            </p>
            <p className="muted small">
              Policy ID <code>{s.policy.policyId.slice(0, 16)}…</code> <CopyButton value={s.policy.policyId} label="policy ID" />
            </p>
          </>
        ) : (
          <p>
            <Badge>None</Badge> Users approve every request in the Hana popup.
          </p>
        )}
        {owner && s.policy && (
          <ConfirmButton
            label="Remove the policy"
            confirm="Remove it now"
            detail="Takes effect at once: open tabs stop auto-signing within seconds, and users approve every request again."
            busy={w.busy}
            onConfirm={() =>
              void w.run(async () => {
                await postJson(`${base}/off`, { what: 'policy', expectedVersion: app.settingsVersion });
                ctl.reload();
                return 'The policy is off: open tabs stop auto-signing within seconds.';
              })
            }
          />
        )}
        <WriteNote error={w.error} done={w.done} />
      </div>
      <PendingChanges ctl={ctl} kinds={['policy_set']} title="Policy waiting to take effect" />
      {!owner ? (
        <Why>Only owners can set or remove the policy.</Why>
      ) : frozen ? (
        <Why>A new policy can’t be proposed while Hana has frozen the organisation. Removing the policy still works.</Why>
      ) : chain.state !== 'yes' ? (
        <ChainOwnerGate chain={chain} org={org} scopeId={app.scopeId} what="Setting a policy" />
      ) : (
        <div className="editor">
          <label className="field">
            <span className="field-label">Policy (JSON, v: 1)</span>
            <textarea className="mono code-input" rows={12} spellCheck={false} value={text} onChange={(e) => (setText(e.target.value), setChecked(undefined))} />
            <span className="field-hint">Checked exactly as the wallet checks it. The format is in the partner guide, section 9.</span>
          </label>
          <div className="form-actions">
            <button
              type="button"
              className="btn"
              disabled={chk.busy || !text.trim()}
              onClick={() =>
                void chk.run(async () => {
                  let policy: unknown;
                  try {
                    policy = JSON.parse(text);
                  } catch {
                    throw new ApiError(400, 'bad_request', 'That isn’t valid JSON: check for a missing comma, quote or bracket.');
                  }
                  setChecked(await postJson<Checked>(`${base}/policy/check`, { policy }));
                })
              }
            >
              Check and preview
            </button>
          </div>
          <WriteNote error={chk.error} />
          {checked && (
            <div className="checked">
              <ConsentPreview policy={checked.policy} appName={app.name} parentOrigin={parentOrigin} sessionTtlMs={s.sessionTtlMs} />
              <p className="muted mono small">policyId {checked.policyId}</p>
              {pending ? (
                <Why>A policy change is already waiting: cancel it above to propose this one.</Why>
              ) : (
                <>
                  <button type="button" className="btn btn-primary" disabled={step.busy} onClick={() => void step.start('policy.set', { appId: app.id, policy: checked.policy })}>
                    Propose this policy (confirm with Google)
                  </button>
                  <p className="muted small">It is announced to your security contacts, then takes effect after the security delay. Any owner can cancel it until then.</p>
                  <StepUpHint email={ctl.email} />
                </>
              )}
              <WriteNote error={step.error} />
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function RawSigning({ chain }: { chain: ChainOwner }) {
  const ctl = useApp();
  const { app, owner, frozen, org } = ctl;
  const w = useWrite();
  const step = useStepUp(org);
  const on = app.settings.rawSign === 'approval';
  const pending = app.changes.some((c) => c.kind === 'raw_sign_on' && isWaiting(c, ctl.serverNow()));
  return (
    <Panel title="Raw signing" description="Signing messages Hana can’t decode (raw bytes). Users approve each one in the Hana popup, with a warning that Hana can’t show what it is. Leave it off unless your app needs it.">
      <div className="current">
        <p>{on ? <Badge tone="warn">On, with approval</Badge> : <Badge>Off</Badge>}</p>
        {owner && on && (
          <ConfirmButton
            label="Turn raw signing off"
            confirm="Turn it off now"
            detail="Takes effect at once: raw requests are refused, in open tabs within seconds."
            busy={w.busy}
            onConfirm={() =>
              void w.run(async () => {
                await postJson(`/api/orgs/${org}/apps/${app.id}/off`, { what: 'raw_sign', expectedVersion: app.settingsVersion });
                ctl.reload();
                return 'Raw signing is off.';
              })
            }
          />
        )}
      </div>
      <PendingChanges ctl={ctl} kinds={['raw_sign_on']} title="Waiting to take effect" />
      {!on && app.environment === 'test' && <Why>Test apps never sign raw: their keys come from the testnet MPC, so Hana refuses anything that could move real funds.</Why>}
      {!on && app.environment === 'live' && owner && frozen && <Why>Raw signing can’t be turned on while Hana has frozen the organisation.</Why>}
      {!on && app.environment === 'live' && !owner && <Why>Only owners can turn raw signing on or off.</Why>}
      {owner && !on && !frozen && app.environment === 'live' && !pending && chain.state !== 'yes' && <ChainOwnerGate chain={chain} org={org} scopeId={app.scopeId} what="Turning raw signing on" />}
      {owner && !on && !frozen && app.environment === 'live' && !pending && chain.state === 'yes' && (
        <>
          <button type="button" className="btn" disabled={step.busy} onClick={() => void step.start('raw_sign.on', { appId: app.id })}>
            Turn raw signing on (confirm with Google)
          </button>
          <p className="muted small">It is announced to your security contacts, then takes effect after the security delay. Turning it off is immediate.</p>
          <StepUpHint email={ctl.email} />
        </>
      )}
      <WriteNote error={w.error ?? step.error} done={w.done} />
    </Panel>
  );
}

export function Signing() {
  const { app, owner, frozen, org } = useApp();
  // One read for both panels: whether this owner can sign the scope's guarded changes on chain.
  const chain = useChainOwner(org, app.scopeId, owner && !frozen);
  return (
    <div className="stack">
      <Policy chain={chain} />
      <RawSigning chain={chain} />
    </div>
  );
}
