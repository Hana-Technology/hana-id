// An app's login and session settings (persistence, session length, idle timeout, the Google web client, email sharing,
// D411), as setting rows. An owner edits them in place: the save bar slides up at the first change, counts the changes
// and offers Discard, or Save, which sends only the changed ones through a fresh sign-in (`app.settings`) as before.
// The rows check the limits the console checks (1 h to 23 h 50 min; idle 15 min up to the session length) when a field
// is left, and Save stays off while one is out of range. A viewer, or an owner of a frozen org, sees the values in force.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { duration, useStepUp, useTouched } from '../../lib.tsx';
import { type Choice, ChoiceCards, Panel, SaveBar, SettingRow, StepUpHint, ToggleRow, Why, WriteNote } from '../../ui.tsx';
import { useApp } from '../Apps.tsx';

const H = 3_600_000;
const MIN = 60_000;
const TTL_MIN = H;
const TTL_MAX = 23 * H + 50 * MIN;
const IDLE_MIN = 15 * MIN;

type IdentityEmail = 'off' | 'on_request' | 'at_login';

/** D411's `identity_email`: when Journear asks users to share their email with the app (the choices, in order). */
export const IDENTITY_EMAIL: readonly (readonly [IdentityEmail, string, string])[] = [
  ['off', 'Off', 'Users are never asked, and you never see their email. The default.'],
  ['on_request', 'When the app asks', 'Users are asked when your app calls requestEmailSharing().'],
  ['at_login', 'At first login', 'Users are asked once, the first time they sign in to this app.'],
];

export const identityEmailLabel = (v: unknown): string => IDENTITY_EMAIL.find(([k]) => k === v)?.[1] ?? 'Off';

const SHARE_CHOICES: readonly Choice<IdentityEmail>[] = IDENTITY_EMAIL.map(([value, title, detail]) => ({ value, title, detail }));

export function Sessions() {
  const ctl = useApp();
  const { app, owner, frozen, org } = ctl;
  const s = app.settings;
  // An API before migration 0014's build omits the setting: it is off there.
  const shareNow: IdentityEmail = s.identityEmail ?? 'off';
  const step = useStepUp(org, { page: 'sessions', appId: app.id });
  const touched = useTouched<'hours' | 'idle'>();
  const saved = { persistence: s.persistence, hours: String(s.sessionTtlMs / H), idle: String(s.idleTtlMs / MIN), client: s.googleWebClientId ?? '', share: shareNow };
  const [persistence, setPersistence] = useState(saved.persistence);
  const [hours, setHours] = useState(saved.hours);
  const [idle, setIdle] = useState(saved.idle);
  const [client, setClient] = useState(saved.client);
  const [share, setShare] = useState<IdentityEmail>(saved.share);
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
  // What the save bar counts: every row that differs from the saved value (an out-of-range one included).
  const edited = [
    persistence !== saved.persistence,
    hours !== saved.hours && (ttlBad || ttl !== s.sessionTtlMs),
    idle !== saved.idle && (idleBad || idl !== s.idleTtlMs),
    (client.trim() || null) !== s.googleWebClientId,
    share !== shareNow,
  ].filter(Boolean).length;
  const discard = () => {
    setPersistence(saved.persistence);
    setHours(saved.hours);
    setIdle(saved.idle);
    setClient(saved.client);
    setShare(saved.share);
    touched.reset();
  };
  const scopeLine = (
    <p className="muted small">
      The Google clients and on-chain owners of this app’s scope are on <Link to={`/orgs/${org}/scopes/${app.scopeId}`}>the scope’s page</Link>.
    </p>
  );

  if (!owner || frozen)
    return (
      <div className="stack">
        <Panel title="Login & sessions" description="How long a user stays signed in to this app once they log in.">
          <dl className="facts">
            <dt>Session persistence</dt>
            <dd>{s.persistence === 'session' ? 'Kept across reloads' : 'None (log in on every load)'}</dd>
            <dt>Session length</dt>
            <dd>{duration(s.sessionTtlMs)}</dd>
            <dt>Idle timeout</dt>
            <dd>{duration(s.idleTtlMs)}</dd>
            <dt>Google web client</dt>
            <dd className="mono small">{s.googleWebClientId ?? 'Journear’s shared client'}</dd>
            <dt>Email sharing</dt>
            <dd>{identityEmailLabel(shareNow)}</dd>
          </dl>
          {scopeLine}
          <Why>{!owner ? 'Only owners can change the session settings.' : 'Settings can’t be changed while Journear has frozen the organisation.'}</Why>
        </Panel>
      </div>
    );

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        touched.all();
        if (!ttlBad && !idleBad && edited > 0) void step.start('app.settings', params());
      }}
    >
      <Panel title="Login & sessions" description="How long a user stays signed in to this app once they log in. A change takes effect once you confirm it with Google.">
        <div className="setting-list">
          <ToggleRow
            title="Stay signed in across reloads"
            description="On: the wallet survives a reload or a new tab. Off: users log in on every page load."
            checked={persistence === 'session'}
            onChange={(on) => setPersistence(on ? 'session' : 'none')}
          />
          <SettingRow title="Session length" description="From 1 h to 23 h 50 min. The default is 12 h." error={touched.seen('hours') && ttlBad ? 'Enter 1 to 23.83 hours.' : undefined}>
            {(c) => (
              <>
                <input {...c} className="jp-input" type="number" inputMode="decimal" min="1" max="23.83" step="0.25" value={hours} onChange={(e) => setHours(e.target.value)} onBlur={touched.blur('hours')} />
                <span className="unit">hours</span>
              </>
            )}
          </SettingRow>
          <SettingRow
            title="Idle timeout"
            description="Signed out after this long without use: at least 15 min, and no longer than the session. The default is 120."
            error={touched.seen('idle') && idleBad ? 'Enter at least 15 minutes, and no more than the session length.' : undefined}
          >
            {(c) => (
              <>
                <input {...c} className="jp-input" type="number" inputMode="numeric" min="15" step="5" value={idle} onChange={(e) => setIdle(e.target.value)} onBlur={touched.blur('idle')} />
                <span className="unit">minutes</span>
              </>
            )}
          </SettingRow>
          <SettingRow title="Google web client" optional description="Only when your scope has several Google web clients: the one this app signs in with (partner guide, section 6). Empty: Journear’s shared client.">
            {(c) => <input {...c} className="jp-input mono wide" value={client} onChange={(e) => setClient(e.target.value)} placeholder="Journear’s shared client" />}
          </SettingRow>
          <div className="setting-block">
            <ChoiceCards
              legend="Email sharing"
              name="identity-email"
              value={share}
              options={SHARE_CHOICES}
              onChange={setShare}
              hint="Users see their address and choose Share email or Not now. You see it only once they share it, and they can stop sharing at any time."
            />
          </div>
        </div>
      </Panel>
      {scopeLine}
      <StepUpHint email={ctl.email} />
      <WriteNote error={step.error} />
      <SaveBar count={edited} onDiscard={discard} saveLabel="Review and confirm with Google" busy={step.busy} invalid={ttlBad || idleBad} note="Next you review the change, then confirm it with Google." />
    </form>
  );
}
