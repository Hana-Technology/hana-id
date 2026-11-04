// A fresh sign-in's page (`/actions/:id`, docs/batch-c-spec.md "Fresh sign-in"): the action exactly as the server built
// it (the decoded view: what will be applied), a "Confirm with Google" button while it is pending, and its outcome
// after the callback sends the browser back here. The confirmation is a Google sign-in whose nonce commits to this one
// action, so it can't be used for anything else.
import { Link } from 'react-router-dom';
import { useParams } from 'react-router-dom';
import { confirmWithGoogle } from '../api.ts';
import { ErrorNote, OriginText, Section, WriteNote, duration, useApi, useWrite, when } from '../lib.tsx';
import { ConsentPreview } from './Consent.tsx';

interface ActionAnswer {
  id: string;
  kind: string;
  status: 'pending' | 'ok' | 'failed' | 'expired';
  decoded: Record<string, unknown>;
  expiresAt: number;
  outcome?: { status: string; code?: string; message?: string; nearTx?: string; [k: string]: unknown };
}

const TITLES: Record<string, string> = {
  'origin.add': 'Add origins',
  'policy.set': 'Set the auto-approve policy',
  'raw_sign.on': 'Turn raw signing on',
  'app.resume': 'Resume the app',
  'app.settings': 'Change the app’s session settings',
  owner_action: 'On-chain owner action',
  'member.invite': 'Invite a member',
  'member.role': 'Change a member’s role',
  'member.remove': 'Remove a member',
  'org.policy': 'Require a Google Workspace domain',
};

type O = { origin: string; display: string; idn: boolean };
const str = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

function OwnerChange({ change }: { change: Record<string, unknown> }) {
  if (change.kind === 'AddClient') return <p>Add the Google client <span className="mono">{str(change.aud)}</span> to the scope (timelocked).</p>;
  if (change.kind === 'SetAllowShared') return <p>Turn on shared login: users may sign in through Hana’s shared Google clients (timelocked).</p>;
  if (change.kind === 'SetOwners') {
    const owners = (change.owners as Record<string, unknown>[]) ?? [];
    return (
      <>
        <p>Replace the scope’s on-chain owners with (timelocked):</p>
        <ul>
          {owners.map((o, i) => (
            <li key={i}>{o.kind === 'member' ? `${str(o.email)} (member)` : o.kind === 'near' ? `NEAR account ${str(o.accountId)}` : 'a Google account that isn’t a member of this organisation'}</li>
          ))}
        </ul>
      </>
    );
  }
  return <p className="mono">{JSON.stringify(change)}</p>;
}

export function Decoded({ kind, d }: { kind: string; d: Record<string, unknown> }) {
  switch (kind) {
    case 'origin.add': {
      const add = (d.add as O[]) ?? [];
      const remove = (d.remove as O[]) ?? [];
      return (
        <>
          <p>
            App <strong>{str(d.appName)}</strong>. The new origins are announced to your security contacts and become active after the delay; any owner can cancel them until then.
          </p>
          <ul>
            {add.map((o) => (
              <li key={o.origin}>
                Add <OriginText {...o} />
              </li>
            ))}
            {remove.map((o) => (
              <li key={o.origin}>
                Remove at once <OriginText {...o} />
              </li>
            ))}
          </ul>
          {add.some((o) => o.idn) && <p className="note note-warn">An origin above uses an internationalised (punycode) name: check the ASCII form is the domain you own.</p>}
        </>
      );
    }
    case 'policy.set':
      return (
        <>
          <p>
            App <strong>{str(d.appName)}</strong>: policy “{str(d.label)}” <span className="mono small">{str(d.policyId)}</span>. It is announced, then active after the delay; users are asked to consent to it.
          </p>
          <ConsentPreview policy={d.policy} appName={str(d.appName)} parentOrigin={typeof d.parentOrigin === 'string' ? d.parentOrigin : null} sessionTtlMs={Number(d.sessionTtlMs)} />
        </>
      );
    case 'raw_sign.on':
      return (
        <p className="note note-warn">
          App <strong>{str(d.appName)}</strong>: users will be asked to approve raw signatures (messages Hana can’t decode). Announced, then active after the delay.
        </p>
      );
    case 'app.resume':
      return (
        <p>
          Resume <strong>{str(d.appName)}</strong> (clears your organisation’s suspension).{d.otherSuspensions === true && ' Hana’s suspension stays: the app stays suspended until Hana lifts it.'}
        </p>
      );
    case 'app.settings': {
      const c = (d.changes as Record<string, unknown>) ?? {};
      return (
        <ul>
          {'persistence' in c && <li>Session persistence: {c.persistence === 'session' ? 'kept across reloads' : 'none'}</li>}
          {'sessionTtlMs' in c && <li>Session length: {duration(Number(c.sessionTtlMs))}</li>}
          {'idleTtlMs' in c && <li>Idle timeout: {duration(Number(c.idleTtlMs))}</li>}
          {'googleWebClientId' in c && <li>Google web client: {c.googleWebClientId === null ? 'Hana’s shared client' : str(c.googleWebClientId)}</li>}
        </ul>
      );
    }
    case 'owner_action':
      return (
        <>
          <p>
            Scope <span className="mono">{str(d.scopeId)}</span> (action nonce {str(d.actionNonce)}), method <span className="mono">{str(d.method)}</span>. Relayed to the hana-signer contract by Hana; the
            confirmation token becomes public on chain (it carries no email address).
          </p>
          {d.change !== undefined && d.method === 'propose_change' && <OwnerChange change={d.change as Record<string, unknown>} />}
          {d.method === 'cancel_change' && (
            <>
              <p>Cancel pending change #{str(d.changeId)}:</p>
              <OwnerChange change={d.change as Record<string, unknown>} />
            </>
          )}
          {d.method === 'remove_client' && <p className="note note-warn">Remove the Google client {str(d.aud)} from the scope, at once.</p>}
          {d.method === 'disable_shared_login' && <p className="note note-warn">Turn shared login off, at once: users of Hana’s shared clients can’t sign in to this scope any more.</p>}
        </>
      );
    case 'member.invite':
      return (
        <p>
          Invite <strong>{str(d.email)}</strong> as {str(d.role)}. The link is emailed after the notice to every owner and your security contacts.
          {d.ownerWait === true && ' A new owner is a viewer for the first 24 hours; any owner can cancel that.'}
        </p>
      );
    case 'member.role':
      return (
        <p>
          Make <strong>{str(d.email)}</strong> {d.role === 'owner' ? 'an owner (a viewer for 24 hours first, cancellable by any owner)' : 'a viewer'}.
        </p>
      );
    case 'member.remove':
      return (
        <p>
          Remove <strong>{str(d.email)}</strong> from the organisation, at once.
        </p>
      );
    case 'org.policy':
      return <p>{d.requiredHd === null ? 'Stop requiring a Google Workspace domain.' : `Only Google accounts of ${str(d.requiredHd)} can use the organisation.`}</p>;
    default:
      return <p className="mono">{JSON.stringify(d)}</p>;
  }
}

const OUTCOME_TEXT: Record<string, string> = {
  sub_mismatch: 'You confirmed with another Google account than the one signed in to the console. Nothing was changed.',
  session_ended: 'Your console session ended before the confirmation. Nothing was changed: sign in and start again.',
  step_up_expired: 'The confirmation took longer than 5 minutes. Nothing was changed: start again.',
  nonce_moved: 'Another owner action ran on the scope meanwhile. Nothing was sent: build the action again.',
  not_owner: 'Your Google account isn’t an on-chain owner of this scope. Nothing was changed.',
  version_conflict: 'The app changed meanwhile. Nothing was changed: start again from the app’s page.',
};

export function ActionPage() {
  const { id } = useParams();
  const r = useApi<ActionAnswer>(`/api/actions/${id}`);
  const w = useWrite();
  if (r.error) return <main><ErrorNote error={r.error} /></main>;
  if (!r.data) return <main><p className="muted">Loading…</p></main>;
  const a = r.data;
  return (
    <main>
      <h1>{TITLES[a.kind] ?? a.kind}</h1>
      <Section title="What will be applied">
        <Decoded kind={a.kind} d={a.decoded} />
      </Section>
      {a.status === 'pending' && (
        <>
          <p className="muted">Confirm with a fresh Google sign-in (your console account). The confirmation is good for this change only, until {when(a.expiresAt)}.</p>
          <button type="button" className="primary" disabled={w.busy} onClick={() => void w.run(() => confirmWithGoogle(a.id))}>
            Confirm with Google
          </button>
          <WriteNote error={w.error} />
        </>
      )}
      {a.status === 'expired' && <p className="note note-warn">This confirmation expired. Nothing was changed: start again.</p>}
      {a.status === 'ok' && (
        <p className="note" role="status">
          Done.{a.outcome?.nearTx ? ` NEAR transaction ${a.outcome.nearTx}.` : ''}
          {a.outcome?.noChange === true ? ' It was already so: nothing changed.' : ''}
        </p>
      )}
      {a.status === 'failed' && (
        <p className="note note-error" role="alert">
          {OUTCOME_TEXT[a.outcome?.code ?? ''] ?? `Refused (${a.outcome?.code ?? 'internal'}).`} {a.outcome?.message && !OUTCOME_TEXT[a.outcome.code ?? ''] ? a.outcome.message : ''}
          {a.outcome?.code === 'rate_limited' && a.kind === 'owner_action' ? ' If this is urgent, send Hana security the action from this page.' : ''}
        </p>
      )}
      <p>
        <Link to="/">Back to the console</Link>
      </p>
    </main>
  );
}
