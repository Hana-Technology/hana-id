// Platform keys (D918; docs/partner-platform-spec.md A3, A11): what registration, acceptance, confirmation and
// stopping strictly need. The org's keys (`GET /api/orgs/:org/platform-keys`); one key's page, which the announcement's
// Confirm link opens (`/confirm-platform-key/:id` finds the org, then `/orgs/:org/platform-keys/:id`); registering,
// accepting and confirming are fresh sign-ins (the action page shows the fingerprint); stopping and cancelling are at
// once. Reading a page never changes anything. Plain words: "platform key" is the term partners' developers use; a
// scope is "wallet settings".
import type { PlatformKeyView } from '@hana-id/console-core';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, getJson, postJson } from '../api.ts';
import { relative, useApi, useOrg, useStepUp, useWrite, when } from '../lib.tsx';
import { Badge, Callout, ConfirmButton, Empty, ErrorNote, Field, Loading, PageHeader, Panel, StepUpHint, Why, WriteNote } from '../ui.tsx';

interface ListAnswer {
  keys: PlatformKeyView[];
  platform: { enabled: boolean; frozen: boolean };
  scopes: string[];
  people: Record<string, string>;
  role: 'owner' | 'viewer';
  now: number;
}
type Ability = { allowed: true } | { allowed: false; reason: string };
interface KeyAnswer {
  key: PlatformKeyView;
  people: Record<string, string>;
  role: 'owner' | 'viewer';
  accept: Ability;
  confirm: Ability;
  now: number;
}

const PER_ORG = 2;

/** A key's state in words, with the date that matters. */
export function stateWords(k: PlatformKeyView, now: number): { label: string; tone: 'ok' | 'warn' | 'neutral' | 'danger' | 'accent'; line?: string } {
  switch (k.state) {
    case 'awaiting_acceptance':
      return { label: 'Waiting for your acceptance', tone: 'warn', line: 'Journear registered it. An owner accepts it here.' };
    case 'waiting':
      if (k.notifiedAt === undefined) return { label: 'Waiting', tone: 'warn', line: 'Journear is emailing your security contacts and owners about it.' };
      return {
        label: k.fourEyes ? 'Waiting for another owner' : 'Waiting',
        tone: 'warn',
        line: `Starts working on ${when(k.activeFrom)} (${relative(k.activeFrom ?? now, now)}) if nobody confirms it.`,
      };
    case 'in_force':
      return { label: 'Working', tone: 'ok', line: `Works until ${when(k.expiresAt)}.` };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral' };
    case 'revoked':
      return { label: 'Stopped', tone: 'danger', ...(k.revokedAt !== undefined ? { line: `Stopped ${when(k.revokedAt)}.` } : {}) };
    case 'expired':
      return { label: 'Expired', tone: 'neutral', ...(k.expiresAt !== undefined ? { line: `Expired ${when(k.expiresAt)}.` } : {}) };
  }
}

/** Who a key names: a current member by their address, staff as Journear staff, anyone else (someone who left the org) as a former member. */
export const personOf = (kind: string | undefined, id: string | undefined, people: Record<string, string>): string => (kind === 'hana' || id === 'hana' ? 'Journear staff' : id ? (people[id] ?? 'a former member') : '—');

export function PlatformKeys() {
  const { org } = useParams();
  const ctx = useOrg();
  const r = useApi<ListAnswer>(`/api/orgs/${org}/platform-keys`);
  const w = useWrite();
  const step = useStepUp(org!, { page: 'platform-keys' });
  const [label, setLabel] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const head = (
    <PageHeader
      title="Platform keys"
      description="Keys your organisation’s backend uses to manage its test apps on Journear Passport. Journear holds only the public half of each key. A new key starts working when an owner confirms it, or 24 hours after Journear emails your security contacts and owners about it."
    />
  );
  if (r.error)
    return (
      <>
        {head}
        <ErrorNote error={r.error} onRetry={r.reload} />
      </>
    );
  if (!r.data)
    return (
      <>
        {head}
        <Loading />
      </>
    );
  const { keys, platform, people, now } = r.data;
  const owner = ctx?.role === 'owner';
  const writes = owner && !ctx?.frozen;
  const counted = keys.filter((k) => k.state === 'awaiting_acceptance' || k.state === 'waiting' || k.state === 'in_force').length;
  const pasted = publicKey.trim();
  const looksPrivate = /PRIVATE KEY|"d"\s*:/u.test(pasted);
  const ready = label.trim().length > 0 && pasted.length > 0 && !looksPrivate && scopes.length >= 1 && scopes.length <= 2;
  const act = (path: string, msg: string) =>
    void w.run(async () => {
      await postJson(path, {});
      r.reload();
      return msg;
    });
  return (
    <>
      {head}
      <div className="stack">
        {!platform.enabled && <Callout tone="info">Journear hasn’t switched platform keys on for your organisation yet. You can register a key now: your backend can use it once Journear switches them on.</Callout>}
        <Panel title="Keys">
          {keys.length === 0 ? (
            <Empty title="No platform keys yet">Register your backend’s public key below, or send it to Journear.</Empty>
          ) : (
            <div className="jp-table-wrap">
              <table className="jp-table">
                <thead>
                  <tr>
                    <th scope="col">Key</th>
                    <th scope="col">State</th>
                    <th scope="col">Registered by</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => {
                    const s = stateWords(k, now);
                    const live = k.state === 'awaiting_acceptance' || k.state === 'waiting' || k.state === 'in_force';
                    return (
                      <tr key={k.id}>
                        <td>
                          <Link to={`/orgs/${org}/platform-keys/${k.id}`}>{k.label}</Link>
                          <div className="muted small mono">{k.thumbprint.slice(0, 16)}…</div>
                        </td>
                        <td>
                          <Badge tone={s.tone}>{s.label}</Badge>
                          {s.line && <div className="muted small">{s.line}</div>}
                        </td>
                        <td>
                          {personOf(k.proposedByKind, k.proposedBy, people)}
                          <div className="muted small">{when(k.proposedAt)}</div>
                        </td>
                        <td className="cell-actions">
                          <Link className="jp-btn jp-btn-secondary jp-btn-sm" to={`/orgs/${org}/platform-keys/${k.id}`}>
                            {k.state === 'awaiting_acceptance' || (k.state === 'waiting' && k.notifiedAt !== undefined) ? 'Review' : 'Open'}
                          </Link>
                          {owner && live && <ConfirmButton label="Stop" confirm="Stop the key" detail="It stops working at once, for good." busy={w.busy} onConfirm={() => act(`/api/orgs/${org}/platform-keys/${k.id}/revoke`, 'Key stopped.')} />}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <WriteNote error={w.error} />
        </Panel>

        <Panel title="Register a key" description={`Your organisation can have ${PER_ORG} keys at a time. Keeping a second key working as a standby makes changing keys quick.`}>
          {!owner && <Why>You’re a viewer: only an owner can register a key.</Why>}
          {owner && ctx?.frozen && <Why>Registering keys is paused while Journear has frozen your organisation. Stopping a key still works.</Why>}
          {writes && counted >= PER_ORG && <Why>Your organisation already has {PER_ORG} keys working or waiting. Stop or cancel one to register another.</Why>}
          {writes && counted < PER_ORG && r.data.scopes.length === 0 && <Why>Your organisation has no test app yet, so there are no wallet settings to name.</Why>}
          {writes && counted < PER_ORG && r.data.scopes.length > 0 && (
            <form
              className="form editor"
              onSubmit={(e) => {
                e.preventDefault();
                if (ready) void step.start('platform.key_add', { scopeIds: scopes, label: label.trim(), publicKey: pasted });
              }}
            >
              <Field label="Label" hint="A name for you and your security contacts, like “Production backend”. Up to 40 characters.">
                {(c) => <input {...c} className="jp-input" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} autoComplete="off" />}
              </Field>
              <fieldset className="choice-group key-scopes">
                <legend className="jp-label">Wallet settings it is for (one or two)</legend>
                {r.data.scopes.map((s) => (
                  <label key={s} className="jp-check">
                    <input
                      type="checkbox"
                      checked={scopes.includes(s)}
                      disabled={!scopes.includes(s) && scopes.length >= 2}
                      onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))}
                    />
                    <span className="mono">{s}</span>
                  </label>
                ))}
              </fieldset>
              <Field
                label="Public key"
                hint="Paste the public key as a PEM block (-----BEGIN PUBLIC KEY-----) or as a JWK. Only ECDSA P-256 keys. Never paste a private key."
                error={looksPrivate ? 'This looks like a private key. Never send it to anyone: paste only the public key.' : undefined}
              >
                {(c) => <textarea {...c} className="jp-input mono" rows={5} value={publicKey} onChange={(e) => setPublicKey(e.target.value)} spellCheck={false} autoComplete="off" />}
              </Field>
              <div className="form-actions">
                <button type="submit" className="jp-btn jp-btn-primary" disabled={step.busy || !ready}>
                  Review and confirm with Google
                </button>
              </div>
              <StepUpHint email={ctx?.email} />
              <WriteNote error={step.error} />
            </form>
          )}
        </Panel>
      </div>
    </>
  );
}

/** One key: what it is, its state, who registered, accepted and confirmed it; Accept, Confirm, Cancel or Stop. */
export function PlatformKeyPage() {
  const { org, keyId } = useParams();
  const ctx = useOrg();
  const r = useApi<KeyAnswer>(`/api/orgs/${org}/platform-keys/${keyId}`);
  const w = useWrite();
  const step = useStepUp(org!, { page: 'platform-keys' });
  const back = { to: `/orgs/${org}/platform-keys`, label: 'Platform keys' };
  if (r.error)
    return (
      <>
        <PageHeader title="Platform key" back={back} />
        <ErrorNote error={r.error} onRetry={r.reload} />
      </>
    );
  if (!r.data)
    return (
      <>
        <PageHeader title="Platform key" back={back} />
        <Loading />
      </>
    );
  const { key: k, people, accept, confirm, now } = r.data;
  const owner = ctx?.role === 'owner';
  const s = stateWords(k, now);
  const act = (path: string, msg: string) =>
    void w.run(async () => {
      await postJson(path, {});
      r.reload();
      return msg;
    });
  const waiting = k.state === 'waiting' || k.state === 'awaiting_acceptance';
  const live = waiting || k.state === 'in_force';
  return (
    <>
      <PageHeader title={k.label} back={back} description="A key your organisation’s backend uses to manage its test apps. Check the fingerprint with your backend team." />
      <div className="stack">
        <Panel>
          <dl className="facts jp-kv">
            <dt>State</dt>
            <dd>
              <Badge tone={s.tone}>{s.label}</Badge>
              {s.line && <div className="muted small">{s.line}</div>}
            </dd>
            <dt>Fingerprint</dt>
            <dd className="mono">{k.thumbprint}</dd>
            <dt>{k.scopes.length > 1 ? 'Wallet settings (scopes)' : 'Wallet settings (scope)'}</dt>
            <dd className="mono">{k.scopes.join(', ')}</dd>
            <dt>Registered by</dt>
            <dd>
              {personOf(k.proposedByKind, k.proposedBy, people)}, {when(k.proposedAt)}
            </dd>
            {k.acceptedByKind && (
              <>
                <dt>{k.acceptedByKind === 'hana' ? 'Approved by' : 'Accepted by'}</dt>
                <dd>
                  {personOf(k.acceptedByKind, k.acceptedBy, people)}
                  {k.acceptedAt !== undefined ? `, ${when(k.acceptedAt)}` : ''}
                </dd>
              </>
            )}
            {k.confirmedKind === 'confirm' && (
              <>
                <dt>Confirmed by</dt>
                <dd>
                  {personOf('member', k.confirmedBy, people)}, {when(k.confirmedAt)}
                </dd>
              </>
            )}
          </dl>
        </Panel>

        {k.state === 'awaiting_acceptance' && (
          <Panel title="Accept this key">
            <p>Journear registered this key for your organisation. Accept it only if your backend team sent Journear this key: check the fingerprint with them first. Once Journear has emailed your security contacts and owners, it starts working.</p>
            {accept.allowed ? (
              <>
                <button type="button" className="jp-btn jp-btn-primary" disabled={step.busy} onClick={() => void step.start('platform.key_accept', { keyId: k.id })}>
                  Accept with Google
                </button>
                <StepUpHint email={ctx?.email} />
              </>
            ) : (
              <Why>{accept.reason}</Why>
            )}
            <WriteNote error={step.error} />
          </Panel>
        )}

        {k.state === 'waiting' && (
          <Panel title="Confirm this key">
            <p>Only confirm a key you know is your organisation’s. Once you confirm, your backend can use it straight away.</p>
            {confirm.allowed ? (
              <>
                <button type="button" className="jp-btn jp-btn-primary" disabled={step.busy} onClick={() => void step.start('platform.key_confirm', { keyId: k.id })}>
                  Confirm with Google
                </button>
                <StepUpHint email={ctx?.email} />
              </>
            ) : (
              <Why>{confirm.reason}</Why>
            )}
            <WriteNote error={step.error} />
          </Panel>
        )}

        {owner && live && (
          <Panel title={waiting ? 'Not yours?' : 'Stop this key'}>
            {waiting ? (
              <>
                <p>Not yours? Cancel it. It never starts working.</p>
                <ConfirmButton label="Cancel this key" confirm="Cancel the key" detail="It never starts working." busy={w.busy} onConfirm={() => act(`/api/orgs/${org}/platform-keys/${k.id}/cancel`, 'Key cancelled.')} />
              </>
            ) : (
              <>
                <p>Stopping a key works at once and can’t be undone. Web addresses your backend asked for that are still waiting are cancelled with it.</p>
                <ConfirmButton label="Stop this key" confirm="Stop the key" detail="It stops working at once, for good." busy={w.busy} onConfirm={() => act(`/api/orgs/${org}/platform-keys/${k.id}/revoke`, 'Key stopped.')} />
              </>
            )}
            <WriteNote error={w.error} />
          </Panel>
        )}
      </div>
    </>
  );
}

/** `/confirm-platform-key/:id` (the announcement's Confirm link): finds the key's organisation, then opens its page. A GET only. */
export function ConfirmPlatformKey() {
  const { keyId } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    let live = true;
    getJson<{ orgId: string }>(`/api/platform-keys/${encodeURIComponent(keyId ?? '')}/org`).then(
      (r) => live && navigate(`/orgs/${r.orgId}/platform-keys/${keyId}`, { replace: true }),
      (err: unknown) => {
        if (!live) return;
        const e = err instanceof ApiError ? err : new ApiError(0, 'network', 'The console could not be reached');
        if (e.status === 401) navigate('/signin', { replace: true });
        else setError(e);
      },
    );
    return () => {
      live = false;
    };
  }, [keyId, navigate]);
  if (error)
    return (
      <Callout tone="danger" role="alert" title={error.code === 'not_found' ? 'No such key in your organisations' : 'Something went wrong'}>
        {error.code === 'not_found' ? 'Sign in with the Google account of an owner of the organisation the email was about.' : error.message}
      </Callout>
    );
  return <Loading label="Opening the key…" />;
}
