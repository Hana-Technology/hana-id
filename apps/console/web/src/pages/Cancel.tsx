// The emailed cancel links (docs/batch-c-spec.md "Notice and cancel", "Invites and owner grants"): `/cancel/:changeId#t=`
// (a guarded change) and `/cancel-owner/:grantId#t=` (an owner grant). No session. The token is read from the fragment
// (which no server sees), dropped from the address bar at once, and sent only in a POST body after the person presses
// the button: a GET never cancels, so a mail scanner that opens the link changes nothing. The token is single use: the
// server answers a second confirm `not_pending`.
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, postJson } from '../api.ts';
import { useFragmentToken } from '../lib.tsx';
import { Callout } from '../ui.tsx';
import { AuthCard } from './SignIn.tsx';

const MESSAGES: Record<string, string> = {
  not_pending: 'Nothing to cancel any more: it was already cancelled, or it has already taken effect. If it is in force and shouldn’t be, contact Journear security at once.',
  forbidden: 'This link isn’t valid. Use the exact link from the email, or contact Journear security.',
  rate_limited: 'Too many attempts from your network. Wait a minute and try again, or contact Journear security.',
};

function CancelPage({ what, explain, idOk, post }: { what: string; explain: string; idOk: boolean; post: (token: string) => Promise<unknown> }) {
  const token = useFragmentToken('t');
  const [state, setState] = useState<'ready' | 'busy' | 'done' | { error: string; code: string }>('ready');
  if (token === undefined) return null;
  if (!token || !idOk)
    return (
      <AuthCard title={`Cancel ${what}`}>
        <Callout tone="danger" role="alert">
          This link is incomplete. Open the whole link from the email, or contact Journear security.
        </Callout>
      </AuthCard>
    );
  return (
    <AuthCard title={`Cancel ${what}`}>
      {state === 'done' ? (
        <Callout tone="ok" role="status" title="Cancelled.">
          Journear and the organisation’s owners have a record of it.
        </Callout>
      ) : (
        <>
          <p className="lede">{explain}</p>
          <p>Press the button to cancel it. Nothing happens until you do.</p>
          <button
            type="button"
            className="jp-btn jp-btn-primary jp-btn-lg block"
            disabled={state === 'busy'}
            onClick={() => {
              setState('busy');
              post(token).then(
                () => setState('done'),
                (err: unknown) =>
                  setState(
                    err instanceof ApiError
                      ? { error: MESSAGES[err.code] ?? err.message, code: err.code }
                      : { error: 'The console could not be reached. Try again, or contact Journear security.', code: 'network' },
                  ),
              );
            }}
          >
            Cancel {what}
          </button>
          {typeof state === 'object' && (
            <Callout tone="danger" role="alert" title={state.error}>
              <p className="support-code">
                Error code <code>{state.code}</code>
              </p>
            </Callout>
          )}
        </>
      )}
    </AuthCard>
  );
}

export function CancelChange() {
  const { changeId } = useParams();
  const ok = /^gc_[A-Za-z0-9]{1,64}$/u.test(changeId ?? '');
  return (
    <CancelPage
      what="this change"
      explain="This cancels the app change announced in the email (a new origin, an auto-approve policy or raw signing). It never takes effect. You don’t need to sign in."
      idOk={ok}
      post={(token) => postJson('/api/cancel', { changeId, token })}
    />
  );
}

export function CancelOwner() {
  const { grantId } = useParams();
  const ok = /^og_[A-Za-z0-9]{1,64}$/u.test(grantId ?? '');
  return (
    <CancelPage
      what="this new owner"
      explain="This stops the person named in the email from becoming an owner of the organisation. They stay a viewer. You don’t need to sign in."
      idOk={ok}
      post={(token) => postJson('/api/owner-grants/cancel', { grantId, token })}
    />
  );
}
