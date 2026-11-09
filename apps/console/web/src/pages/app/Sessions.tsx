// An app's login and session settings (persistence, session length, idle timeout, the Google web client, email sharing,
// D411): the values in force and, for an owner, the form that sends only the changed ones through a fresh sign-in
// (`app.settings`). The form checks the limits the console checks (1 h to 23 h 50 min; idle 15 min up to the session
// length) before sending.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { duration, useStepUp } from '../../lib.tsx';
import { Panel, StepUpHint, Why, WriteNote } from '../../ui.tsx';
import { useApp } from '../Apps.tsx';

const H = 3_600_000;
const MIN = 60_000;
const TTL_MIN = H;
const TTL_MAX = 23 * H + 50 * MIN;
const IDLE_MIN = 15 * MIN;

type IdentityEmail = 'off' | 'on_request' | 'at_login';

/** D411's `identity_email`: when Hana asks users to share their email with the app (the select's options, in order). */
export const IDENTITY_EMAIL: readonly (readonly [IdentityEmail, string, string])[] = [
  ['off', 'Off', 'Off: never asked (default)'],
  ['on_request', 'When the app asks', 'When the app asks: requestEmailSharing()'],
  ['at_login', 'At first login', 'At first login'],
];

export const identityEmailLabel = (v: unknown): string => IDENTITY_EMAIL.find(([k]) => k === v)?.[1] ?? 'Off';

export function Sessions() {
  const ctl = useApp();
  const { app, owner, frozen, org } = ctl;
  const s = app.settings;
  // An API before migration 0014's build omits the setting: it is off there.
  const shareNow: IdentityEmail = s.identityEmail ?? 'off';
  const step = useStepUp(org);
  const [persistence, setPersistence] = useState(s.persistence);
  const [hours, setHours] = useState(String(s.sessionTtlMs / H));
  const [idle, setIdle] = useState(String(s.idleTtlMs / MIN));
  const [client, setClient] = useState(s.googleWebClientId ?? '');
  const [share, setShare] = useState<IdentityEmail>(shareNow);
  const ttl = Math.round(Number(hours) * H);
  const idl = Math.round(Number(idle) * MIN);
  const ttlBad = !Number.isFinite(ttl) || hours.trim() === '' || ttl < TTL_MIN || ttl > TTL_MAX;
  const idleBad = !Number.isFinite(idl) || idle.trim() === '' || idl < IDLE_MIN || (!ttlBad && idl > ttl);
  const params = () => {
    const out: Record<string, unknown> = { appId: app.id };
    if (persistence !== s.persistence) out.persistence = persistence;
    if (ttl !== s.sessionTtlMs) out.sessionTtlMs = ttl;
    if (idl !== s.idleTtlMs) out.idleTtlMs = idl;
    const c = client.trim() || null;
    if (c !== s.googleWebClientId) out.googleWebClientId = c;
    if (share !== shareNow) out.identityEmail = share;
    return out;
  };
  const changed = Object.keys(params()).length > 1;
  return (
    <div className="stack">
      <Panel title="Login & sessions" description="How long a user stays signed in to this app once they log in with Google.">
        <dl className="facts">
          <dt>Session persistence</dt>
          <dd>{s.persistence === 'session' ? 'Kept across reloads' : 'None (log in on every load)'}</dd>
          <dt>Session length</dt>
          <dd>{duration(s.sessionTtlMs)}</dd>
          <dt>Idle timeout</dt>
          <dd>{duration(s.idleTtlMs)}</dd>
          <dt>Google web client</dt>
          <dd className="mono small">{s.googleWebClientId ?? 'Hana’s shared client'}</dd>
          <dt>Email sharing</dt>
          <dd>{identityEmailLabel(shareNow)}</dd>
        </dl>
        <p className="muted small">
          The Google clients and on-chain owners of this app’s scope are on <Link to={`/orgs/${org}/scopes/${app.scopeId}`}>the scope’s page</Link>.
        </p>
      </Panel>
      <Panel title="Change these settings">
        {!owner ? (
          <Why>Only owners can change the session settings.</Why>
        ) : frozen ? (
          <Why>Settings can’t be changed while Hana has frozen the organisation.</Why>
        ) : (
          <form
            className="form form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              if (!ttlBad && !idleBad) void step.start('app.settings', params());
            }}
          >
            <label className="field">
              <span className="field-label">Persistence</span>
              <select value={persistence} onChange={(e) => setPersistence(e.target.value as 'session' | 'none')}>
                <option value="session">Kept across reloads</option>
                <option value="none">None</option>
              </select>
              <span className="field-hint">Kept: the wallet survives a reload or a new tab. None: users log in on every page load.</span>
            </label>
            <label className="field">
              <span className="field-label">Session length (hours)</span>
              <input type="number" min="1" max="23.83" step="0.25" value={hours} onChange={(e) => setHours(e.target.value)} aria-invalid={ttlBad} />
              <span className={ttlBad ? 'field-error' : 'field-hint'}>From 1 h to 23 h 50 min. Default 12.</span>
            </label>
            <label className="field">
              <span className="field-label">Idle timeout (minutes)</span>
              <input type="number" min="15" step="5" value={idle} onChange={(e) => setIdle(e.target.value)} aria-invalid={idleBad} />
              <span className={idleBad ? 'field-error' : 'field-hint'}>At least 15 min, and no longer than the session. Default 120.</span>
            </label>
            <label className="field field-wide">
              <span className="field-label">Google web client (empty: Hana’s shared client)</span>
              <input value={client} onChange={(e) => setClient(e.target.value)} placeholder="Hana’s shared client" className="mono" />
              <span className="field-hint">Only needed when your scope has several Google web clients: pick the one this app signs in with (partner guide, section 6).</span>
            </label>
            <label className="field field-wide">
              <span className="field-label">Email sharing</span>
              <select value={share} onChange={(e) => setShare(e.target.value as IdentityEmail)}>
                {IDENTITY_EMAIL.map(([k, , help]) => (
                  <option key={k} value={k}>
                    {help}
                  </option>
                ))}
              </select>
              <span className="field-hint">Users see their email address and choose Share email or Not now; you see it only once they share it, and they can stop sharing at any time.</span>
            </label>
            <div className="form-actions field-wide">
              <button type="submit" className="btn btn-primary" disabled={step.busy || !changed || ttlBad || idleBad}>
                Review and confirm with Google
              </button>
              {!changed && <span className="muted small">Change a value to continue.</span>}
            </div>
            <div className="field-wide">
              <StepUpHint email={ctl.email} />
              <WriteNote error={step.error} />
            </div>
          </form>
        )}
      </Panel>
    </div>
  );
}
