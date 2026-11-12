// A fresh sign-in's page (`/actions/:id`, docs/batch-c-spec.md "Fresh sign-in"): the action exactly as the server built
// it (the decoded view: what will be applied), when it takes effect, what the fresh sign-in is and which account to use,
// a "Confirm with Google" button while it is pending, and its outcome after the callback sends the browser back here.
// The confirmation is a Google sign-in whose nonce commits to this one action, so it can't be used for anything else.
import type { MeAnswer } from '@hana-id/console-core';
import { Link, useParams } from 'react-router-dom';
import { confirmWithGoogle } from '../api.ts';
import { duration, relative, useApi, useNow, useWrite, when } from '../lib.tsx';
import { explain } from '../messages.ts';
import { Callout, ErrorNote, IconShield, Loading, OriginText, PageHeader, Panel, WriteNote } from '../ui.tsx';
import { identityEmailLabel } from './app/Sessions.tsx';
import { ConsentPreview } from './Consent.tsx';

interface ActionAnswer {
  id: string;
  kind: string;
  status: 'pending' | 'ok' | 'failed' | 'expired';
  decoded: Record<string, unknown>;
  expiresAt: number;
  /** The page that started it (D711), a console path the server built from ids; checked again below before use. */
  returnTo?: unknown;
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

const GUARDED = new Set(['origin.add', 'policy.set', 'raw_sign.on']);

type O = { origin: string; display: string; idn: boolean };
const str = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

function OwnerChange({ change }: { change: Record<string, unknown> }) {
  if (change.kind === 'AddClient' && change.provider === 'email') return <p>Add Journear’s email client <span className="mono">{str(change.aud)}</span> to the scope (timelocked): users of this scope can then sign in with email.</p>;
  if (change.kind === 'AddClient') return <p>Add the Google client <span className="mono">{str(change.aud)}</span> to the scope (timelocked).</p>;
  if (change.kind === 'SetAllowShared') return <p>Turn on shared login: users may sign in through Journear’s shared Google clients (timelocked).</p>;
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

function settingText(k: string, v: unknown): string {
  if (k === 'persistence') return v === 'session' ? 'kept across reloads' : 'none';
  if (k === 'sessionTtlMs' || k === 'idleTtlMs') return duration(Number(v));
  if (k === 'googleWebClientId') return v === null || v === undefined ? 'Journear’s shared client' : str(v);
  if (k === 'identityEmail') return identityEmailLabel(v).toLowerCase();
  if (k === 'loginMethods') return v === 'google,email' ? 'on (Google and email)' : 'off (Google only)';
  return str(v);
}
const SETTING_LABEL: Record<string, string> = { loginMethods: 'Email login', persistence: 'Session persistence', sessionTtlMs: 'Session length', idleTtlMs: 'Idle timeout', googleWebClientId: 'Google web client', identityEmail: 'Email sharing' };

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
          <ul className="decoded-list">
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
          {add.some((o) => o.idn) && <Callout tone="warn">An origin above uses an internationalised (punycode) name: check the ASCII form is the domain you own.</Callout>}
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
        <Callout tone="warn">
          App <strong>{str(d.appName)}</strong>: users will be asked to approve raw signatures (messages Journear can’t decode). Announced, then active after the delay.
        </Callout>
      );
    case 'app.resume':
      return (
        <p>
          Resume <strong>{str(d.appName)}</strong> (clears your organisation’s suspension).{d.otherSuspensions === true && ' Journear’s suspension stays: the app stays suspended until Journear lifts it.'}
        </p>
      );
    case 'app.settings': {
      const c = (d.changes as Record<string, unknown>) ?? {};
      const from = (d.from as Record<string, unknown> | undefined) ?? {};
      return (
        <>
          <p>
            App <strong>{str(d.appName)}</strong>:
          </p>
          <div className="jp-table-wrap">
          <table className="jp-table compact">
            <thead>
              <tr>
                <th scope="col">Setting</th>
                <th scope="col">Now</th>
                <th scope="col">Becomes</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(SETTING_LABEL)
                .filter((k) => k in c)
                .map((k) => (
                  <tr key={k}>
                    <td>{SETTING_LABEL[k]}</td>
                    <td className="muted">{k in from ? settingText(k, from[k]) : '—'}</td>
                    <td className="strong">{settingText(k, c[k])}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          </div>
        </>
      );
    }
    case 'owner_action':
      return (
        <>
          <p>
            Scope <span className="mono">{str(d.scopeId)}</span>, method <span className="mono">{str(d.method)}</span>. Journear relays it to the hana-signer contract; the confirmation token becomes public on chain (it carries no
            email address).
          </p>
          {d.change !== undefined && d.method === 'propose_change' && <OwnerChange change={d.change as Record<string, unknown>} />}
          {d.method === 'cancel_change' && (
            <>
              <p>Cancel pending change #{str(d.changeId)}:</p>
              <OwnerChange change={d.change as Record<string, unknown>} />
            </>
          )}
          {d.method === 'remove_client' && <Callout tone="warn">{d.provider === 'email' ? 'Remove Journear’s email client from the scope, at once: users of this scope stop being able to sign in with email.' : `Remove the Google client ${str(d.aud)} from the scope, at once.`}</Callout>}
          {d.method === 'disable_shared_login' && <Callout tone="warn">Turn shared login off, at once: users of Journear’s shared clients can’t sign in to this scope any more.</Callout>}
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

/** When the change takes effect once confirmed, in one line. */
function takesEffect(kind: string, d: Record<string, unknown>): string {
  if (GUARDED.has(kind))
    return 'Not at once. After you confirm, it is announced by email to your organisation’s security contacts and takes effect after the security delay (24 hours on production deployments). Any owner can cancel it until then, from the app’s page or the email.';
  if (kind === 'member.invite') return 'The invite email goes out after every owner and your security contacts have been told. The link works once, for that address only.';
  if (kind === 'member.role' && d.role === 'owner') return 'They become an owner after 24 hours as a viewer; any owner can cancel that meanwhile.';
  if (kind === 'owner_action') return d.immediate === true ? 'At once, when the contract runs it.' : 'After the contract’s timelock. Any on-chain owner can cancel it meanwhile; once it unlocks, any owner can execute it in the console.';
  return 'At once, when you confirm.';
}

const OUTCOME_TEXT: Record<string, string> = {
  sub_mismatch: 'You confirmed with another Google account than the one signed in to the console. Nothing was changed.',
  session_ended: 'Your console session ended before the confirmation. Nothing was changed: sign in and start again.',
  step_up_expired: 'The confirmation took longer than 5 minutes. Nothing was changed: start again.',
  nonce_moved: 'Another owner action ran on the scope meanwhile. Nothing was sent: build the action again.',
  not_owner: 'Your Google account isn’t an on-chain owner of this scope. Nothing was changed.',
  version_conflict: 'The app changed meanwhile. Nothing was changed: start again from the app’s page.',
};

const APP_TAB: Record<string, string> = { 'origin.add': 'origins', 'policy.set': 'signing', 'raw_sign.on': 'signing', 'app.settings': 'sessions', 'app.resume': 'suspend' };
const TAB_LABEL: Record<string, string> = { origins: 'Origins', signing: 'Signing', suspend: 'Suspend', sessions: 'Login & sessions', email: 'Email login' };

/**
 * The server's `returnTo`, only as one of the console's own pages that start actions: an app's tab, a scope's page or
 * the members page. Anything else (another origin, `//host`, a path with `..`, an unknown page) is ignored, so the link
 * can never leave the console whatever the answer says (D711).
 */
const SAFE_RETURN = /^\/orgs\/[A-Za-z0-9_]{1,128}(?:\/apps\/[A-Za-z0-9_]{1,128}\/(origins|signing|suspend|sessions|email)|\/scopes\/([A-Za-z0-9_]{1,128})|\/(members))$/u;

export function safeReturn(v: unknown): { to: string; label: string } | null {
  const m = typeof v === 'string' ? SAFE_RETURN.exec(v) : null;
  if (!m) return null;
  const label = m[1] ? `Back to ${TAB_LABEL[m[1]]}` : m[2] ? 'Back to the scope' : 'Back to members';
  return { to: v as string, label };
}

/** Where "back" goes: the page that started the action (the server's `returnTo`); else, for an older answer, the kind's page when the member has one organisation (else the org list). */
function backTo(a: ActionAnswer, me: MeAnswer | undefined): { to: string; label: string } {
  const own = safeReturn(a.returnTo);
  if (own) return own;
  const only = me?.memberships.length === 1 ? me.memberships[0]!.orgId : undefined;
  if (!only) return { to: '/', label: 'Back to the console' };
  const d = a.decoded;
  if (typeof d.appId === 'string' && /^[A-Za-z0-9_]{1,128}$/u.test(d.appId)) return { to: `/orgs/${only}/apps/${d.appId}/${APP_TAB[a.kind] ?? ''}`.replace(/\/$/u, ''), label: `Back to ${typeof d.appName === 'string' ? d.appName : 'the app'}` };
  if (a.kind.startsWith('member.') || a.kind === 'org.policy') return { to: `/orgs/${only}/members`, label: 'Back to members' };
  if (a.kind === 'owner_action' && typeof d.scopeId === 'string' && /^[A-Za-z0-9_.-]{1,128}$/u.test(d.scopeId)) return { to: `/orgs/${only}/scopes/${d.scopeId}`, label: 'Back to the scope' };
  return { to: `/orgs/${only}`, label: 'Back to the console' };
}

export function ActionPage({ me }: { me?: MeAnswer | undefined }) {
  const { id } = useParams();
  const r = useApi<ActionAnswer>(`/api/actions/${id}`);
  const w = useWrite();
  const now = useNow(1_000);
  if (r.error)
    return (
      <>
        <PageHeader title="Confirm a change" back={{ to: '/', label: 'Back to the console' }} />
        <ErrorNote error={r.error} />
      </>
    );
  if (!r.data) return <Loading />;
  const a = r.data;
  const back = backTo(a, me);
  const lapsed = a.status === 'pending' && a.expiresAt <= now;
  // The confirmation works only while the session that started it lives: one that ends inside the 5 minutes is said.
  const sessionEnd = me?.sessionExpiresAt;
  const sessionFirst = a.status === 'pending' && !lapsed && sessionEnd !== undefined && sessionEnd > now && sessionEnd < a.expiresAt;
  const failedCode = a.outcome?.code ?? 'internal';
  return (
    <div className="action">
      <PageHeader title={TITLES[a.kind] ?? a.kind} back={back} description={a.status === 'pending' ? 'Check the change, then confirm it’s you with Google. Nothing happens until you do.' : undefined} />
      <Panel title="What will be applied">
        <Decoded kind={a.kind} d={a.decoded} />
      </Panel>
      {a.status === 'pending' && (
        <>
          <Panel title="When it takes effect">
            <p>{takesEffect(a.kind, a.decoded)}</p>
          </Panel>
          <Panel className="confirm-panel" title="Confirm it’s you">
            <p>
              Changes like this need a fresh Google sign-in, so a console session on its own can’t make them. You go to Google, choose {me ? <strong>{me.user.email}</strong> : 'the account you use for the console'}, and come straight back here with
              the result.
            </p>
            {lapsed ? (
              <Callout tone="warn">This confirmation expired. Nothing was changed: go back and start the change again.</Callout>
            ) : (
              <>
                <p className="muted">Confirm with a fresh Google sign-in (your console account). The confirmation is good for this change only, until {when(a.expiresAt)} ({relative(a.expiresAt, now)}).</p>
                {sessionFirst && (
                  <Callout tone="warn" title={`Your console session ends ${relative(sessionEnd, now)}, before this confirmation’s time is up`}>
                    <p>Confirm before then: a confirmation counts only with the session that started it. If the session ends first, nothing is changed; sign in again and start the change again.</p>
                  </Callout>
                )}
                <div className="form-actions">
                  <button type="button" className="jp-btn jp-btn-primary jp-btn-lg" disabled={w.busy} onClick={() => void w.run(() => confirmWithGoogle(a.id))}>
                    <IconShield /> Confirm with Google
                  </button>
                  <Link to={back.to} className="jp-btn jp-btn-ghost jp-btn-lg">
                    Not now
                  </Link>
                </div>
              </>
            )}
            <WriteNote error={w.error} />
          </Panel>
        </>
      )}
      {a.status === 'expired' && <Callout tone="warn">This confirmation expired. Nothing was changed: start again.</Callout>}
      {a.status === 'ok' && (
        <Callout tone="ok" role="status">
          Done.{a.outcome?.nearTx ? ` NEAR transaction ${a.outcome.nearTx}.` : ''}
          {a.outcome?.noChange === true ? ' It was already so: nothing changed.' : ''}
          {GUARDED.has(a.kind) && a.outcome?.noChange !== true ? ' It is now announced and takes effect after the security delay; you can follow it, or cancel it, on the app’s page.' : ''}
        </Callout>
      )}
      {a.status === 'failed' && (
        <Callout
          tone="danger"
          role="alert"
          title={
            <>
              {OUTCOME_TEXT[failedCode] ?? `${explain(failedCode, a.outcome?.message ?? '').text} Nothing was changed.`}
              {a.outcome?.message && !OUTCOME_TEXT[failedCode] && explain(failedCode, a.outcome.message).detail ? ` ${a.outcome.message}` : ''}
              {a.outcome?.code === 'rate_limited' && a.kind === 'owner_action' ? ' If this is urgent, send Journear security the action from this page.' : ''}
            </>
          }
        >
          <p className="support-code">
            Error code <code>{failedCode}</code> · action <code>{a.id}</code>
          </p>
        </Callout>
      )}
      {a.status !== 'pending' && (
        <p>
          <Link to={back.to}>{back.label}</Link>
        </p>
      )}
    </div>
  );
}
