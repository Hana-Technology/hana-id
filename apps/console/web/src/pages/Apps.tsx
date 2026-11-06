// An org's apps (`GET /api/orgs/:org/apps`) and one app (`/apps/:app`): origins (with the Unicode form and an IDN flag
// for punycode hosts), pending and active guarded changes, publishable keys, settings, the name and the logo. Owners
// get the write controls (batch C10): what the spec marks "fresh sign-in" (origin adds, the policy, raw signing on,
// settings, resume) goes through an action reviewed on `/actions/:id` and confirmed with Google; the immediate ones
// (removing an origin, turning the policy or raw signing off, cancelling a pending change, suspending, keys, the name and
// the logo) are a second click. A frozen org shows only the cancels and the kill switches.
import type { AppDetail, AppSummary, GuardedChange, KeyView } from '@hana-id/console-core';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, postBytes, postJson } from '../api.ts';
import { ConfirmButton, ErrorNote, OriginText, Section, WriteNote, duration, useApi, useOrg, useStepUp, useWrite, when } from '../lib.tsx';
import { ConsentPreview } from './Consent.tsx';

const SUSPENDED = [
  [1, 'by Hana'],
  [2, 'with the organisation'],
  [4, 'by your organisation'],
] as const;

export function suspension(bits: number): string | null {
  const why = SUSPENDED.filter(([b]) => (bits & b) !== 0).map(([, w]) => w);
  return why.length ? `Suspended ${why.join(', ')}` : null;
}

export function AppsList() {
  const { org } = useParams();
  const apps = useApi<{ apps: AppSummary[] }>(`/api/orgs/${org}/apps`);
  if (apps.error) return <ErrorNote error={apps.error} />;
  if (!apps.data) return <p className="muted">Loading…</p>;
  if (apps.data.apps.length === 0) return <p className="note">No apps yet. Hana creates apps for your organisation.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>App</th>
          <th>Environment</th>
          <th>Status</th>
          <th>Origins</th>
          <th>Pending changes</th>
        </tr>
      </thead>
      <tbody>
        {apps.data.apps.map((a) => (
          <tr key={a.id}>
            <td>
              <Link to={`/orgs/${org}/apps/${a.id}`}>{a.name}</Link>
              <div className="muted mono">{a.id}</div>
            </td>
            <td>{a.environment}</td>
            <td>{a.deleted ? 'Deleted' : (suspension(a.suspendedBy) ?? 'Active')}</td>
            <td>{a.activeOrigins}</td>
            <td>{a.pendingChanges}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const CHANGE_LABEL: Record<GuardedChange['kind'], string> = { origin_add: 'Add origin', policy_set: 'Set auto-approve policy', raw_sign_on: 'Turn raw signing on' };

function changeWhat(c: GuardedChange): string {
  if (c.kind === 'origin_add') return c.display && c.display !== c.origin ? `${c.display} (${c.origin})` : (c.origin ?? '');
  if (c.kind === 'policy_set') return c.policyId ? `policy ${c.policyId.slice(0, 12)}…` : '';
  return '';
}

function changeState(c: GuardedChange): string {
  if (c.status === 'pending') return c.notifiedAt === undefined ? 'Pending: notice not sent yet' : `Pending: active from ${when(c.activeFrom)}`;
  if (c.status === 'active') return `Active since ${when(c.activeFrom)}`;
  return c.status === 'cancelled' ? `Cancelled ${when(c.cancelledAt)}` : 'Ended';
}

interface AppCtl {
  org: string;
  app: AppDetail;
  owner: boolean;
  frozen: boolean;
  reload: () => void;
}

function Origins({ org, app, owner, frozen, reload }: AppCtl) {
  const w = useWrite();
  const step = useStepUp(org);
  const [text, setText] = useState('');
  const base = `/api/orgs/${org}/apps/${app.id}`;
  const add = text
    .split(/[\s,]+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    <Section title="Origins">
      {app.origins.length === 0 ? (
        <p className="muted">No origins.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Origin</th>
              <th>State</th>
              {owner && <th />}
            </tr>
          </thead>
          <tbody>
            {app.origins.map((o) => (
              <tr key={o.origin}>
                <td>
                  <OriginText {...o} />
                </td>
                <td>{o.activeFrom === null ? 'Pending' : o.activeFrom <= Date.now() ? 'Active' : `Active from ${when(o.activeFrom)}`}</td>
                {owner && (
                  <td>
                    {o.activeFrom !== null && (
                      <ConfirmButton
                        label="Remove"
                        confirm="Remove now"
                        busy={w.busy}
                        onConfirm={() =>
                          void w.run(async () => {
                            await postJson(`${base}/origins/remove`, { remove: [o.origin], expectedVersion: app.originsVersion });
                            reload();
                            return `Removed ${o.display}.`;
                          })
                        }
                      />
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <WriteNote error={w.error} done={w.done} />
      {owner && !frozen && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void step.start('origin.add', { appId: app.id, add });
          }}
        >
          <label>
            Add origins (one per line): <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="https://app.example.com" />
          </label>
          <button type="submit" disabled={step.busy || add.length === 0}>
            Review and confirm with Google
          </button>
          <WriteNote error={step.error} />
        </form>
      )}
    </Section>
  );
}

function Changes({ org, app, owner, reload }: AppCtl) {
  const w = useWrite();
  return (
    <Section title="Guarded changes">
      {app.changes.length === 0 ? (
        <p className="muted">No pending or active changes.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Change</th>
              <th>Proposed</th>
              <th>State</th>
              {owner && <th />}
            </tr>
          </thead>
          <tbody>
            {app.changes.map((c) => (
              <tr key={c.id}>
                <td>
                  {CHANGE_LABEL[c.kind]} <span className="mono">{changeWhat(c)}</span>
                  {c.idn && <span className="badge badge-warn">IDN</span>}
                </td>
                <td>
                  {when(c.proposedAt)} by {c.proposedByKind === 'hana' ? 'Hana' : c.proposedByKind}
                  {c.requestCountry ? ` (${c.requestCountry})` : ''}
                </td>
                <td>{changeState(c)}</td>
                {owner && (
                  <td>
                    {c.status === 'pending' && (
                      <ConfirmButton
                        label="Cancel"
                        confirm="Cancel this change"
                        busy={w.busy}
                        onConfirm={() =>
                          void w.run(async () => {
                            await postJson(`/api/orgs/${org}/changes/${c.id}/cancel`, {});
                            reload();
                            return 'Cancelled.';
                          })
                        }
                      />
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <WriteNote error={w.error} done={w.done} />
    </Section>
  );
}

interface Checked {
  policyId: string;
  label: string;
  policy: unknown;
}

function Policy({ org, app, owner, frozen, reload }: AppCtl) {
  const s = app.settings;
  const w = useWrite();
  const step = useStepUp(org);
  const [text, setText] = useState(s.policy ? JSON.stringify(s.policy.json, null, 2) : '');
  const [checked, setChecked] = useState<Checked | undefined>();
  const base = `/api/orgs/${org}/apps/${app.id}`;
  const parentOrigin = app.origins.find((o) => o.activeFrom !== null && o.activeFrom <= Date.now())?.display ?? null;
  const pending = app.changes.some((c) => c.kind === 'policy_set' && c.status === 'pending');
  return (
    <Section title="Auto-approve policy">
      <p>{s.policy ? `${s.policy.label} (${s.policy.policyId.slice(0, 12)}…)` : 'None'}</p>
      {owner && s.policy && (
        <ConfirmButton
          label="Remove the policy"
          confirm="Remove it now"
          busy={w.busy}
          onConfirm={() =>
            void w.run(async () => {
              await postJson(`${base}/off`, { what: 'policy', expectedVersion: app.settingsVersion });
              reload();
              return 'The policy is off: open tabs stop auto-signing within seconds.';
            })
          }
        />
      )}
      <WriteNote error={w.error} done={w.done} />
      {owner && !frozen && (
        <div className="editor">
          <label>
            Policy (JSON, `v: 1`, validated as the vault does):
            <textarea className="mono" rows={12} value={text} onChange={(e) => (setText(e.target.value), setChecked(undefined))} />
          </label>
          <button
            type="button"
            disabled={w.busy || !text.trim()}
            onClick={() =>
              void w.run(async () => {
                let policy: unknown;
                try {
                  policy = JSON.parse(text);
                } catch {
                  throw new ApiError(400, 'bad_json', 'That isn’t valid JSON');
                }
                setChecked(await postJson<Checked>(`${base}/policy/check`, { policy }));
              })
            }
          >
            Check and preview
          </button>
          {checked && (
            <>
              <ConsentPreview policy={checked.policy} appName={app.name} parentOrigin={parentOrigin} sessionTtlMs={s.sessionTtlMs} />
              <p className="muted mono small">policyId {checked.policyId}</p>
              <button type="button" disabled={step.busy || pending} onClick={() => void step.start('policy.set', { appId: app.id, policy: checked.policy })}>
                Propose this policy (confirm with Google)
              </button>
              {pending && <p className="muted">A policy change is already pending: cancel it first.</p>}
              <WriteNote error={step.error} />
            </>
          )}
        </div>
      )}
    </Section>
  );
}

function RawSigning({ org, app, owner, frozen, reload }: AppCtl) {
  const w = useWrite();
  const step = useStepUp(org);
  const on = app.settings.rawSign === 'approval';
  return (
    <Section title="Raw signing">
      <p>{on ? 'On, with approval' : 'Off'}</p>
      {owner && on && (
        <ConfirmButton
          label="Turn raw signing off"
          confirm="Turn it off now"
          busy={w.busy}
          onConfirm={() =>
            void w.run(async () => {
              await postJson(`/api/orgs/${org}/apps/${app.id}/off`, { what: 'raw_sign', expectedVersion: app.settingsVersion });
              reload();
              return 'Raw signing is off.';
            })
          }
        />
      )}
      {owner && !on && !frozen && app.environment === 'live' && (
        <button type="button" disabled={step.busy} onClick={() => void step.start('raw_sign.on', { appId: app.id })}>
          Turn raw signing on (confirm with Google)
        </button>
      )}
      {!on && app.environment === 'test' && <p className="muted">Test apps never sign raw.</p>}
      <WriteNote error={w.error ?? step.error} done={w.done} />
    </Section>
  );
}

type IdentityEmail = 'off' | 'on_request' | 'at_login';

/** D411's `identity_email`: when Hana asks users to share their email with the app (the select's options, in order). */
export const IDENTITY_EMAIL: readonly (readonly [IdentityEmail, string, string])[] = [
  ['off', 'Off', 'Off: never asked (default)'],
  ['on_request', 'When the app asks', 'When the app asks: requestEmailSharing()'],
  ['at_login', 'At first login', 'At first login'],
];

export const identityEmailLabel = (v: unknown): string => IDENTITY_EMAIL.find(([k]) => k === v)?.[1] ?? 'Off';

function Settings({ org, app, owner, frozen }: AppCtl) {
  const s = app.settings;
  // An API before migration 0012's build omits the setting: it is off there.
  const shareNow: IdentityEmail = s.identityEmail ?? 'off';
  const step = useStepUp(org);
  const [persistence, setPersistence] = useState(s.persistence);
  const [hours, setHours] = useState(String(s.sessionTtlMs / 3_600_000));
  const [idle, setIdle] = useState(String(s.idleTtlMs / 60_000));
  const [client, setClient] = useState(s.googleWebClientId ?? '');
  const [share, setShare] = useState<IdentityEmail>(shareNow);
  const params = () => {
    const out: Record<string, unknown> = { appId: app.id };
    if (persistence !== s.persistence) out.persistence = persistence;
    const ttl = Math.round(Number(hours) * 3_600_000);
    if (ttl !== s.sessionTtlMs) out.sessionTtlMs = ttl;
    const idl = Math.round(Number(idle) * 60_000);
    if (idl !== s.idleTtlMs) out.idleTtlMs = idl;
    const c = client.trim() || null;
    if (c !== s.googleWebClientId) out.googleWebClientId = c;
    if (share !== shareNow) out.identityEmail = share;
    return out;
  };
  return (
    <Section title="Settings">
      <dl className="settings">
        <dt>Session persistence</dt>
        <dd>{s.persistence === 'session' ? 'Kept across reloads' : 'None (log in on every load)'}</dd>
        <dt>Session length</dt>
        <dd>{duration(s.sessionTtlMs)}</dd>
        <dt>Idle timeout</dt>
        <dd>{duration(s.idleTtlMs)}</dd>
        <dt>Google web client</dt>
        <dd className="mono">{s.googleWebClientId ?? 'Hana’s shared client'}</dd>
        <dt>Email sharing</dt>
        <dd>{identityEmailLabel(shareNow)}</dd>
      </dl>
      {owner && !frozen && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void step.start('app.settings', params());
          }}
        >
          <label>
            Persistence{' '}
            <select value={persistence} onChange={(e) => setPersistence(e.target.value as 'session' | 'none')}>
              <option value="session">Kept across reloads</option>
              <option value="none">None</option>
            </select>
          </label>
          <label>
            Session length (hours) <input type="number" min="1" max="23.83" step="0.25" value={hours} onChange={(e) => setHours(e.target.value)} />
          </label>
          <label>
            Idle timeout (minutes) <input type="number" min="15" step="5" value={idle} onChange={(e) => setIdle(e.target.value)} />
          </label>
          <label>
            Google web client (empty: Hana’s shared client) <input value={client} onChange={(e) => setClient(e.target.value)} />
          </label>
          <label>
            Email sharing{' '}
            <select value={share} onChange={(e) => setShare(e.target.value as IdentityEmail)}>
              {IDENTITY_EMAIL.map(([k, , help]) => (
                <option key={k} value={k}>
                  {help}
                </option>
              ))}
            </select>
          </label>
          <p className="muted small">Users see their email address and choose Share email or Not now; you see it only once they share it, and they can stop sharing at any time.</p>
          <button type="submit" disabled={step.busy || Object.keys(params()).length === 1}>
            Review and confirm with Google
          </button>
          <WriteNote error={step.error} />
        </form>
      )}
    </Section>
  );
}

function Profile({ org, app, owner, frozen, reload }: AppCtl) {
  const w = useWrite();
  const [name, setName] = useState(app.name);
  const [file, setFile] = useState<File | null>(null);
  const base = `/api/orgs/${org}/apps/${app.id}`;
  if (!owner || frozen) return null;
  return (
    <Section title="Name and logo">
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void w.run(async () => {
            await postJson(`${base}/profile`, { name, expectedVersion: app.settingsVersion });
            reload();
            return 'Renamed.';
          });
        }}
      >
        <label>
          Name <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" disabled={w.busy || name.trim() === app.name || !name.trim()}>
          Save the name
        </button>
      </form>
      <p className="muted">Logo: a PNG, JPEG or WebP, at most 512 KiB, 128 to 2048 px a side, nearly square. Hana stores it as a 256 × 256 PNG.</p>
      {app.logoUrl && <img className="logo" src={app.logoUrl} alt="" width={64} height={64} />}
      <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Logo file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <button
        type="button"
        disabled={w.busy || !file}
        onClick={() =>
          void w.run(async () => {
            const bytes = new Uint8Array(await file!.arrayBuffer());
            await postBytes(`${base}/logo?expectedVersion=${app.settingsVersion}`, bytes);
            reload();
            return 'Logo uploaded.';
          })
        }
      >
        Upload the logo
      </button>
      {app.logoUrl && (
        <ConfirmButton
          label="Remove the logo"
          confirm="Remove it"
          busy={w.busy}
          onConfirm={() =>
            void w.run(async () => {
              await postJson(`${base}/logo/remove`, { expectedVersion: app.settingsVersion });
              reload();
              return 'Logo removed.';
            })
          }
        />
      )}
      <WriteNote error={w.error} done={w.done} />
    </Section>
  );
}

function Keys({ org, app, owner, frozen, reload }: AppCtl) {
  const w = useWrite();
  const base = `/api/orgs/${org}/apps/${app.id}/keys`;
  const live = (k: KeyView) => k.revokedAt === undefined || k.revokedAt > Date.now();
  const active = app.keys.filter((k) => k.revokedAt === undefined);
  return (
    <Section title="Publishable keys">
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Created</th>
            <th>Revoked</th>
            {owner && <th />}
          </tr>
        </thead>
        <tbody>
          {app.keys.map((k) => (
            <tr key={k.id}>
              <td className="mono">{k.key}</td>
              <td>{when(k.createdAt)}</td>
              <td>{k.revokedAt === undefined ? '—' : when(k.revokedAt)}</td>
              {owner && (
                <td>
                  {k.revokedAt === undefined && !frozen && (
                    <ConfirmButton
                      label="Rotate"
                      confirm="Rotate (the old key works 24 h more)"
                      busy={w.busy}
                      onConfirm={() =>
                        void w.run(async () => {
                          await postJson(`${base}/${k.id}/rotate`, {});
                          reload();
                          return 'Rotated: ship the new key within 24 hours.';
                        })
                      }
                    />
                  )}
                  {live(k) && (
                    <ConfirmButton
                      label="Revoke"
                      confirm={active.length <= 1 && k.revokedAt === undefined ? 'Revoke the last key (the app stops working)' : 'Revoke now'}
                      busy={w.busy}
                      onConfirm={() =>
                        void w.run(async () => {
                          await postJson(`${base}/${k.id}/revoke`, {});
                          reload();
                          return 'Revoked.';
                        })
                      }
                    />
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {owner && !frozen && (
        <button
          type="button"
          disabled={w.busy}
          onClick={() =>
            void w.run(async () => {
              await postJson(base, {});
              reload();
              return 'Key created.';
            })
          }
        >
          Create a key
        </button>
      )}
      <WriteNote error={w.error} done={w.done} />
    </Section>
  );
}

function Suspension({ org, app, owner, frozen, reload }: AppCtl) {
  const w = useWrite();
  const step = useStepUp(org);
  if (!owner) return null;
  const ours = (app.suspendedBy & 4) !== 0;
  return (
    <Section title="Suspend">
      {!ours && (
        <ConfirmButton
          label="Suspend the app"
          confirm="Suspend now (logins stop)"
          busy={w.busy}
          onConfirm={() =>
            void w.run(async () => {
              await postJson(`/api/orgs/${org}/apps/${app.id}/suspend`, {});
              reload();
              return 'Suspended.';
            })
          }
        />
      )}
      {ours && !frozen && (
        <button type="button" disabled={step.busy} onClick={() => void step.start('app.resume', { appId: app.id })}>
          Resume (confirm with Google)
        </button>
      )}
      <WriteNote error={w.error ?? step.error} done={w.done} />
    </Section>
  );
}

export function AppPage() {
  const { org, app } = useParams();
  const ctx = useOrg();
  const r = useApi<{ app: AppDetail }>(`/api/orgs/${org}/apps/${app}`);
  if (r.error) return <ErrorNote error={r.error} />;
  if (!r.data) return <p className="muted">Loading…</p>;
  const a = r.data.app;
  const ctl: AppCtl = { org: org!, app: a, owner: ctx?.role === 'owner' && !a.deleted, frozen: ctx?.frozen ?? false, reload: r.reload };
  return (
    <>
      <p>
        <Link to={`/orgs/${org}`}>← Apps</Link>
      </p>
      <h2 className="app-title">
        {a.name} <span className="badge">{a.environment}</span>
      </h2>
      <p className="muted mono">
        {a.id} · scope <Link to={`/orgs/${org}/scopes/${a.scopeId}`}>{a.scopeId}</Link>
      </p>
      {suspension(a.suspendedBy) && <p className="note note-warn">{suspension(a.suspendedBy)}</p>}
      <Origins {...ctl} />
      <Changes {...ctl} />
      <Keys {...ctl} />
      <Settings {...ctl} />
      <Policy {...ctl} />
      <RawSigning {...ctl} />
      <Profile {...ctl} />
      <Suspension {...ctl} />
    </>
  );
}
